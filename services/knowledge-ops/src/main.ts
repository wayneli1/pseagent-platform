import { KnowledgeOpsApi } from "./api.js";
import { createKnowledgeOpsHttpServer } from "./http-server.js";
import { PostgresKnowledgeOpsStore } from "./postgres-store.js";
import { KnowledgeOpsAuthorizer } from "./rbac.js";
import { loadAdminLoginConfig, loadContentCipher, loadListenConfig, loadTokenActorEntries } from "./runtime-config.js";
import { KnowledgeOpsService } from "./service.js";
import { HttpKnowledgeRuntimeStatusProvider } from "./runtime-status.js";

const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error(`${name}_required`);return value;};
const store=PostgresKnowledgeOpsStore.connect(required("KNOWLEDGE_OPS_DATABASE_URL"));await store.migrate();
const entries=loadTokenActorEntries(process.env);
const service=new KnowledgeOpsService(store,loadContentCipher(process.env),undefined,new HttpKnowledgeRuntimeStatusProvider({baseUrl:required("KNOWLEDGE_ENGINE_URL"),token:required("KNOWLEDGE_ENGINE_TOKEN"),snapshotRoot:required("KNOWLEDGE_OPS_SNAPSHOT_ROOT"),timeoutMs:3_000}));
const listen=loadListenConfig(process.env);
const server=createKnowledgeOpsHttpServer(new KnowledgeOpsApi(service,new KnowledgeOpsAuthorizer(entries,loadAdminLoginConfig(process.env))),{
  ...(listen.staticRoot?{staticRoot:listen.staticRoot}:{}),readiness:()=>store.ping(),
});
server.listen(listen.port,listen.host,()=>process.stdout.write(`knowledge-ops.ready ${listen.host}:${listen.port}\n`));
const stop=()=>server.close(()=>void store.close());process.once("SIGINT",stop);process.once("SIGTERM",stop);
