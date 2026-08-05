import { createHash } from "node:crypto";
import { ContentCipher } from "./crypto.js";
import { KnowledgeOpsApi } from "./api.js";
import { createKnowledgeOpsHttpServer } from "./http-server.js";
import { PostgresKnowledgeOpsStore } from "./postgres-store.js";
import { StaticTokenAuthorizer, type TokenActorEntry } from "./rbac.js";
import { KnowledgeOpsService } from "./service.js";
import type { OpsActor } from "./types.js";

const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error(`${name}_required`);return value;};
const store=PostgresKnowledgeOpsStore.connect(required("KNOWLEDGE_OPS_DATABASE_URL"));await store.migrate();
const tokenConfig=JSON.parse(required("KNOWLEDGE_OPS_TOKENS_JSON")) as {token:string;actor:OpsActor}[];
const entries:TokenActorEntry[]=tokenConfig.map(x=>({tokenHash:createHash("sha256").update(x.token).digest("hex"),actor:x.actor}));
const service=new KnowledgeOpsService(store,ContentCipher.fromBase64(required("KNOWLEDGE_OPS_ENCRYPTION_KEY"),Number(process.env.KNOWLEDGE_OPS_KEY_VERSION??"1")));
const server=createKnowledgeOpsHttpServer(new KnowledgeOpsApi(service,new StaticTokenAuthorizer(entries)),{
  ...(process.env.KNOWLEDGE_OPS_ADMIN_ROOT?{staticRoot:process.env.KNOWLEDGE_OPS_ADMIN_ROOT}:{}),
});
const port=Number(process.env.KNOWLEDGE_OPS_PORT??"19830"),host=process.env.KNOWLEDGE_OPS_HOST??"127.0.0.1";
server.listen(port,host,()=>process.stdout.write(`knowledge-ops.ready ${host}:${port}\n`));
const stop=()=>server.close(()=>void store.close());process.once("SIGINT",stop);process.once("SIGTERM",stop);
