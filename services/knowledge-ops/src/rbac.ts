import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { KnowledgeDomain } from "@pseagent/knowledge-governance-contracts";
import type { OpsActor, OpsRole } from "./types.js";

export type OpsAction =
  | "dashboard:read"
  | "answer_review:ingest"
  | "answer_review:read"
  | "answer_review:triage"
  | "feedback:ingest"
  | "feedback:read"
  | "feedback:triage"
  | "conversation:write"
  | "issue:read"
  | "issue:triage"
  | "issue:rebuild"
  | "repair:read"
  | "repair:edit"
  | "repair:validate"
  | "repair:publish"
  | "repair:rollback"
  | "card:read"
  | "card:edit"
  | "card:review"
  | "regression:read"
  | "regression:run"
  | "release:read"
  | "release:publish"
  | "release:rollback"
  | "audit:read"
  | "job:read";

const GLOBAL_ACTIONS: Partial<Record<OpsRole, readonly OpsAction[]>> = {
  viewer: ["dashboard:read", "answer_review:read", "feedback:read", "issue:read", "card:read", "regression:read", "release:read"],
  operator: ["dashboard:read", "answer_review:read", "answer_review:triage", "feedback:read", "feedback:triage", "issue:read", "issue:triage", "card:read", "regression:read", "job:read"],
  release_manager: ["dashboard:read", "card:read", "regression:read", "regression:run", "release:read", "release:publish", "release:rollback", "job:read", "audit:read"],
  admin: ["dashboard:read", "answer_review:read", "answer_review:triage", "feedback:read", "feedback:triage", "issue:read", "issue:triage", "issue:rebuild", "repair:read", "repair:edit", "repair:validate", "repair:publish", "repair:rollback", "card:read", "card:edit", "card:review", "regression:read", "regression:run", "release:read", "release:publish", "release:rollback", "audit:read", "job:read"],
  service: ["answer_review:ingest", "feedback:ingest", "conversation:write"],
};

export function assertAuthorized(
  actor: OpsActor,
  action: OpsAction,
  domain?: KnowledgeDomain,
): void {
  if (actor.actorId.trim() === "" || actor.roles.length === 0) {
    throw new OpsAuthorizationError("authentication_required");
  }
  if (actor.roles.some((role) => GLOBAL_ACTIONS[role]?.includes(action))) return;
  if (domain !== undefined && domainRoleAllows(actor.roles, action, domain)) return;
  throw new OpsAuthorizationError("permission_denied");
}

export class OpsAuthorizationError extends Error {
  constructor(readonly code: "authentication_required" | "permission_denied") {
    super(code);
    this.name = "OpsAuthorizationError";
  }
}

export interface TokenActorEntry {
  readonly tokenHash: string;
  readonly actor: OpsActor;
}

export interface AdminLoginConfig {
  readonly username:string;
  readonly passwordHash:string;
  readonly sessionTtlMs:number;
}

export interface AdminSession {
  readonly sessionToken:string;
  readonly expiresAt:string;
  readonly actor:OpsActor;
}

export interface OpsAuthenticator {
  authenticate(token:string|undefined):OpsActor|undefined;
  login?(username:string,password:string):Promise<AdminSession|undefined>;
  logout?(token:string|undefined):void;
}

export class StaticTokenAuthorizer {
  constructor(private readonly entries: readonly TokenActorEntry[]) {}

  authenticate(token: string | undefined): OpsActor | undefined {
    if (token === undefined || token.trim() === "") return undefined;
    const actual = Buffer.from(createHash("sha256").update(token, "utf8").digest("hex"));
    for (const entry of this.entries) {
      const expected = Buffer.from(entry.tokenHash);
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
        return entry.actor;
      }
    }
    return undefined;
  }
}

export class PasswordAdminAuthorizer implements OpsAuthenticator {
  private readonly sessions=new Map<string,{readonly actor:OpsActor;readonly expiresAt:number}>();
  private readonly parsedHash:ParsedPasswordHash;
  constructor(private readonly config:AdminLoginConfig,private readonly now:()=>number=Date.now){
    this.parsedHash=parsePasswordHash(config.passwordHash);
    if(config.username.trim()===""||config.sessionTtlMs<60_000)throw new Error("knowledge_ops_admin_login_config_invalid");
  }
  async login(username:string,password:string):Promise<AdminSession|undefined>{
    const passwordMatches=await verifyPassword(password,this.parsedHash);
    if(!secureStringEqual(username,this.config.username)||!passwordMatches)return undefined;
    this.removeExpired();
    while(this.sessions.size>=64)this.sessions.delete(this.sessions.keys().next().value as string);
    const sessionToken=randomBytes(32).toString("base64url"),expiresAt=this.now()+this.config.sessionTtlMs;
    const actor={actorId:this.config.username,roles:["admin"] as const};
    this.sessions.set(sessionDigest(sessionToken),{actor,expiresAt});
    return{sessionToken,expiresAt:new Date(expiresAt).toISOString(),actor};
  }
  authenticate(token:string|undefined):OpsActor|undefined{
    if(token===undefined||token.trim()==="")return undefined;
    this.removeExpired();
    return this.sessions.get(sessionDigest(token))?.actor;
  }
  logout(token:string|undefined):void{
    if(token!==undefined&&token.trim()!=="")this.sessions.delete(sessionDigest(token));
  }
  private removeExpired(){const current=this.now();for(const [key,value] of this.sessions)if(value.expiresAt<=current)this.sessions.delete(key);}
}

export class KnowledgeOpsAuthorizer implements OpsAuthenticator {
  private readonly staticTokens:StaticTokenAuthorizer;
  private readonly adminSessions:PasswordAdminAuthorizer;
  constructor(entries:readonly TokenActorEntry[],admin:AdminLoginConfig,now?:()=>number){
    this.staticTokens=new StaticTokenAuthorizer(entries);
    this.adminSessions=new PasswordAdminAuthorizer(admin,now);
  }
  authenticate(token:string|undefined):OpsActor|undefined{return this.adminSessions.authenticate(token)??this.staticTokens.authenticate(token);}
  login(username:string,password:string){return this.adminSessions.login(username,password);}
  logout(token:string|undefined){this.adminSessions.logout(token);}
}

export async function createAdminPasswordHash(password:string,salt:Buffer=randomBytes(16)):Promise<string>{
  if(password.length<8||password.length>256)throw new Error("knowledge_ops_admin_password_invalid");
  if(salt.length<16||salt.length>64)throw new Error("knowledge_ops_admin_password_salt_invalid");
  const parameters={cost:16_384,blockSize:8,parallelization:1,keyLength:32};
  const digest=await derivePassword(password,salt,parameters);
  return`scrypt$${parameters.cost}$${parameters.blockSize}$${parameters.parallelization}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

interface ParsedPasswordHash {readonly salt:Buffer;readonly digest:Buffer;readonly cost:number;readonly blockSize:number;readonly parallelization:number;}
function parsePasswordHash(value:string):ParsedPasswordHash{
  const [scheme,costValue,blockSizeValue,parallelizationValue,saltValue,digestValue,...rest]=value.split("$");
  const cost=Number(costValue),blockSize=Number(blockSizeValue),parallelization=Number(parallelizationValue);
  if(scheme!=="scrypt"||rest.length>0||cost!==16_384||blockSize!==8||parallelization!==1||saltValue===undefined||digestValue===undefined)throw new Error("knowledge_ops_admin_password_hash_invalid");
  const salt=decodeBase64Url(saltValue),digest=decodeBase64Url(digestValue);
  if(salt.length<16||salt.length>64||digest.length<32||digest.length>64)throw new Error("knowledge_ops_admin_password_hash_invalid");
  return{salt,digest,cost,blockSize,parallelization};
}
async function verifyPassword(password:string,parsed:ParsedPasswordHash):Promise<boolean>{
  if(password.length>256)return false;
  const actual=await derivePassword(password,parsed.salt,{cost:parsed.cost,blockSize:parsed.blockSize,parallelization:parsed.parallelization,keyLength:parsed.digest.length});
  return actual.length===parsed.digest.length&&timingSafeEqual(actual,parsed.digest);
}
function derivePassword(password:string,salt:Buffer,parameters:{readonly cost:number;readonly blockSize:number;readonly parallelization:number;readonly keyLength:number}):Promise<Buffer>{
  return new Promise((resolve,reject)=>scrypt(password,salt,parameters.keyLength,{N:parameters.cost,r:parameters.blockSize,p:parameters.parallelization,maxmem:128*1024*1024},(error,derived)=>error?reject(error):resolve(derived)));
}
function decodeBase64Url(value:string):Buffer{if(!/^[A-Za-z0-9_-]+$/u.test(value))throw new Error("knowledge_ops_admin_password_hash_invalid");return Buffer.from(value,"base64url");}
function secureStringEqual(left:string,right:string):boolean{const first=createHash("sha256").update(left,"utf8").digest(),second=createHash("sha256").update(right,"utf8").digest();return timingSafeEqual(first,second);}
function sessionDigest(token:string):string{return createHash("sha256").update(token,"utf8").digest("hex");}

function domainRoleAllows(
  roles: readonly OpsRole[],
  action: OpsAction,
  domain: KnowledgeDomain,
): boolean {
  const prefix = domain === "coremail-professional" ? "professional" : "general";
  if (action === "card:edit") return roles.includes(`${prefix}_editor` as OpsRole);
  if (action === "card:review") return roles.includes(`${prefix}_reviewer` as OpsRole);
  return false;
}
