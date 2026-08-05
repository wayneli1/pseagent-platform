import { createHash } from "node:crypto";
import { describe,expect,it } from "vitest";
import { loadContentCipher,loadListenConfig,loadTokenActorEntries } from "./runtime-config.js";

describe("knowledge ops runtime configuration",()=>{
  it("loads pre-hashed bearer tokens without retaining plaintext",()=>{
    const token="a-production-token-with-enough-entropy";
    const tokenHash=createHash("sha256").update(token).digest("hex");
    const entries=loadTokenActorEntries({KNOWLEDGE_OPS_TOKEN_HASHES_JSON:JSON.stringify([{
      tokenHash,actor:{actorId:"viewer-1",roles:["viewer"]},
    }])});
    expect(entries).toEqual([{tokenHash,actor:{actorId:"viewer-1",roles:["viewer"]}}]);
    expect(JSON.stringify(entries)).not.toContain(token);
  });
  it("rejects plaintext token configuration unless migration mode is explicit",()=>{
    expect(()=>loadTokenActorEntries({KNOWLEDGE_OPS_TOKENS_JSON:"[]"}))
      .toThrow("KNOWLEDGE_OPS_TOKEN_HASHES_JSON_required");
  });
  it("rejects duplicate hashes and invalid roles",()=>{
    const item={tokenHash:"a".repeat(64),actor:{actorId:"same",roles:["viewer"]}};
    expect(()=>loadTokenActorEntries({KNOWLEDGE_OPS_TOKEN_HASHES_JSON:JSON.stringify([item,item])}))
      .toThrow("knowledge_ops_duplicate_token_hash");
    expect(()=>loadTokenActorEntries({KNOWLEDGE_OPS_TOKEN_HASHES_JSON:JSON.stringify([{...item,actor:{actorId:"x",roles:["root"]}}])}))
      .toThrow("knowledge_ops_token_hashes_invalid");
  });
  it("requires explicit opt-in for a non-loopback bind",()=>{
    expect(()=>loadListenConfig({KNOWLEDGE_OPS_HOST:"0.0.0.0"}))
      .toThrow("knowledge_ops_remote_bind_requires_explicit_opt_in");
    expect(loadListenConfig({KNOWLEDGE_OPS_HOST:"0.0.0.0",KNOWLEDGE_OPS_ALLOW_REMOTE:"true"}))
      .toMatchObject({host:"0.0.0.0",port:19830});
  });
  it("keeps historical decryption keys while encrypting with the current version",()=>{
    const first=Buffer.alloc(32,1).toString("base64"),second=Buffer.alloc(32,2).toString("base64");
    const old=loadContentCipher({KNOWLEDGE_OPS_ENCRYPTION_KEYS_JSON:JSON.stringify({1:first}),KNOWLEDGE_OPS_KEY_VERSION:"1"});
    const payload=old.encrypt({answer:"historical"});
    const current=loadContentCipher({KNOWLEDGE_OPS_ENCRYPTION_KEYS_JSON:JSON.stringify({1:first,2:second}),KNOWLEDGE_OPS_KEY_VERSION:"2"});
    expect(current.decrypt(payload)).toEqual({answer:"historical"});
    expect(current.encrypt({answer:"new"}).keyVersion).toBe(2);
  });
});
