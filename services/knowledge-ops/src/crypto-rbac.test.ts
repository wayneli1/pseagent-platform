import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ContentCipher } from "./crypto.js";
import { assertAuthorized, assertSeparationOfDuties, StaticTokenAuthorizer } from "./rbac.js";

describe("knowledge ops security",()=>{
  it("encrypts content with authenticated encryption and rejects tampering",()=>{const cipher=new ContentCipher(randomBytes(32));const payload=cipher.encrypt({question:"机密问题",answer:"机密答案"});expect(JSON.stringify(payload)).not.toContain("机密");expect(cipher.decrypt(payload)).toEqual({question:"机密问题",answer:"机密答案"});expect(()=>cipher.decrypt({...payload,data:`A${payload.data.slice(1)}`})).toThrow("content_cipher_decryption_failed");});
  it("enforces domain roles and separation of duties",()=>{const editor={actorId:"editor",roles:["professional_editor"] as const};assertAuthorized(editor,"card:edit","coremail-professional");expect(()=>assertAuthorized(editor,"card:edit","presales-general")).toThrow("permission_denied");expect(()=>assertSeparationOfDuties(editor,"editor")).toThrow("creator_cannot_self_approve");});
  it("uses hashed bearer tokens",()=>{const token="service-token-with-more-than-24-characters";const actor={actorId:"lunkr",roles:["service"] as const};const auth=new StaticTokenAuthorizer([{tokenHash:createHash("sha256").update(token).digest("hex"),actor}]);expect(auth.authenticate(token)).toEqual(actor);expect(auth.authenticate("wrong")).toBeUndefined();});
});
