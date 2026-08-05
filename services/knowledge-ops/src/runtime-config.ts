import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { AdminLoginConfig, TokenActorEntry } from "./rbac.js";
import { ContentCipher } from "./crypto.js";

const roleSchema = z.enum([
  "viewer",
  "operator",
  "professional_editor",
  "professional_reviewer",
  "general_editor",
  "general_reviewer",
  "release_manager",
  "admin",
  "service",
]);
const actorSchema = z.object({
  actorId: z.string().trim().min(1).max(128),
  roles: z.array(roleSchema).min(1).max(9),
}).strict();
const hashedEntriesSchema = z.array(z.object({
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/u),
  actor: actorSchema,
}).strict()).min(1).max(128);
const plaintextEntriesSchema = z.array(z.object({
  token: z.string().min(24).max(512),
  actor: actorSchema,
}).strict()).min(1).max(128);

export function loadTokenActorEntries(env:NodeJS.ProcessEnv):readonly TokenActorEntry[]{
  const hashed=env.KNOWLEDGE_OPS_TOKEN_HASHES_JSON;
  if(hashed!==undefined){
    const entries=parseConfig(hashed,hashedEntriesSchema,"knowledge_ops_token_hashes_invalid")
      .map(entry=>({tokenHash:entry.tokenHash.toLowerCase(),actor:entry.actor}));
    assertUniqueHashes(entries);return entries;
  }
  if(env.KNOWLEDGE_OPS_ALLOW_PLAINTEXT_TOKENS!=="true")throw new Error("KNOWLEDGE_OPS_TOKEN_HASHES_JSON_required");
  const plaintext=env.KNOWLEDGE_OPS_TOKENS_JSON;
  if(plaintext===undefined)throw new Error("KNOWLEDGE_OPS_TOKENS_JSON_required");
  const entries=parseConfig(plaintext,plaintextEntriesSchema,"knowledge_ops_plaintext_tokens_invalid")
    .map(entry=>({tokenHash:createHash("sha256").update(entry.token,"utf8").digest("hex"),actor:entry.actor}));
  assertUniqueHashes(entries);return entries;
}

export function loadListenConfig(env:NodeJS.ProcessEnv):{
  readonly host:string;readonly port:number;readonly staticRoot?:string;
}{
  const host=(env.KNOWLEDGE_OPS_HOST??"127.0.0.1").trim();
  const port=z.coerce.number().int().min(1).max(65_535).parse(env.KNOWLEDGE_OPS_PORT??"19830");
  const loopback=new Set(["127.0.0.1","localhost","::1","[::1]"]).has(host);
  if(!loopback&&env.KNOWLEDGE_OPS_ALLOW_REMOTE!=="true")throw new Error("knowledge_ops_remote_bind_requires_explicit_opt_in");
  const staticRoot=env.KNOWLEDGE_OPS_ADMIN_ROOT?.trim();
  if(staticRoot!==undefined&&staticRoot!==""&&!path.isAbsolute(staticRoot))throw new Error("knowledge_ops_admin_root_must_be_absolute");
  return{host,port,...(staticRoot?{staticRoot}:{})};
}

export function loadAdminLoginConfig(env:NodeJS.ProcessEnv):AdminLoginConfig{
  const username=z.string().trim().min(1).max(64).parse(env.KNOWLEDGE_OPS_ADMIN_USERNAME);
  const passwordHash=z.string().regex(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/u).parse(env.KNOWLEDGE_OPS_ADMIN_PASSWORD_HASH);
  const sessionTtlSeconds=z.coerce.number().int().min(300).max(86_400).parse(env.KNOWLEDGE_OPS_ADMIN_SESSION_TTL_SECONDS??"43200");
  return{username,passwordHash,sessionTtlMs:sessionTtlSeconds*1000};
}

export function loadContentCipher(env:NodeJS.ProcessEnv):ContentCipher{
  const currentVersion=z.coerce.number().int().positive().parse(env.KNOWLEDGE_OPS_KEY_VERSION??"1");
  const keyring=env.KNOWLEDGE_OPS_ENCRYPTION_KEYS_JSON;
  if(keyring!==undefined){
    const keys=parseConfig(keyring,z.record(z.string().regex(/^[1-9]\d*$/u),z.string().min(1)),"knowledge_ops_encryption_keyring_invalid");
    try{return ContentCipher.fromBase64Keyring(keys,currentVersion);}catch{throw new Error("knowledge_ops_encryption_keyring_invalid");}
  }
  if(env.KNOWLEDGE_OPS_ALLOW_SINGLE_ENCRYPTION_KEY!=="true")throw new Error("KNOWLEDGE_OPS_ENCRYPTION_KEYS_JSON_required");
  const single=env.KNOWLEDGE_OPS_ENCRYPTION_KEY;
  if(single===undefined)throw new Error("KNOWLEDGE_OPS_ENCRYPTION_KEY_required");
  return ContentCipher.fromBase64(single,currentVersion);
}

function parseConfig<T>(value:string,schema:z.ZodType<T>,code:string):T{
  try{return schema.parse(JSON.parse(value));}catch{throw new Error(code);}
}
function assertUniqueHashes(entries:readonly TokenActorEntry[]){
  if(new Set(entries.map(entry=>entry.tokenHash)).size!==entries.length)throw new Error("knowledge_ops_duplicate_token_hash");
}
