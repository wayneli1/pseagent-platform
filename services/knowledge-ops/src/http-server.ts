import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { KnowledgeOpsApi } from "./api.js";

export interface KnowledgeOpsHttpServerOptions {
  readonly staticRoot?: string;
  readonly readiness?: () => Promise<boolean>;
}

export function createKnowledgeOpsHttpServer(api:Pick<KnowledgeOpsApi,"handle">,options:KnowledgeOpsHttpServerOptions={}){return createServer(async(request,response)=>{
  try{const method=request.method??"GET";const requestUrl=request.url??"/";const pathname=safePathname(requestUrl);if(method==="GET"&&pathname==="/healthz"){send(response,200,{status:"alive"});return;}if(method==="GET"&&pathname==="/readyz"){const ready=await readiness(options.readiness);send(response,ready?200:503,{status:ready?"ready":"not_ready"});return;}if(method==="GET"&&!requestUrl.startsWith("/v1/")&&options.staticRoot){await serveStatic(response,options.staticRoot,requestUrl);return;}const body=await readJson(request);const result=await api.handle({method,path:requestUrl,...(request.headers.authorization?{authorization:request.headers.authorization}:{}),...(body===undefined?{}:{body})});send(response,result.status,result.body);}
  catch(error){send(response,error instanceof PayloadError?error.status:500,{error:error instanceof PayloadError?error.message:"internal_error"});}
});}
function safePathname(value:string){try{return new URL(value,"http://localhost").pathname;}catch{throw new PayloadError(400,"invalid_path");}}
async function readiness(check:(()=>Promise<boolean>)|undefined){if(check===undefined)return false;try{return await check();}catch{return false;}}
function readJson(request:IncomingMessage):Promise<unknown>{return new Promise((resolve,reject)=>{let size=0;const chunks:Buffer[]=[];request.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>1_048_576){reject(new PayloadError(413,"payload_too_large"));request.destroy();return;}chunks.push(chunk);});request.on("end",()=>{if(chunks.length===0){resolve(undefined);return;}try{resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));}catch{reject(new PayloadError(400,"invalid_json"));}});request.on("error",reject);});}
function send(response:ServerResponse,status:number,body:unknown){const bytes=Buffer.from(JSON.stringify(body));response.writeHead(status,{"content-type":"application/json; charset=utf-8","content-length":bytes.length,"cache-control":"no-store","x-content-type-options":"nosniff"});response.end(bytes);}
class PayloadError extends Error{constructor(readonly status:number,message:string){super(message);}}
async function serveStatic(response:ServerResponse,root:string,url:string){let pathname:string;try{pathname=decodeURIComponent(new URL(url,"http://localhost").pathname);}catch{send(response,400,{error:"invalid_path"});return;}const relative=pathname==="/"?"index.html":pathname.replace(/^\/+/,"");const base=path.resolve(root);let candidate=path.resolve(base,relative);if(!inside(base,candidate)){send(response,404,{error:"not_found"});return;}try{if(!(await stat(candidate)).isFile())throw new Error("not_file");}catch{candidate=path.join(base,"index.html");}if(!inside(base,candidate)){send(response,404,{error:"not_found"});return;}try{const bytes=await readFile(candidate);response.writeHead(200,{"content-type":mime(candidate),"content-length":bytes.length,"x-content-type-options":"nosniff","content-security-policy":"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'","cache-control":path.basename(candidate)==="index.html"?"no-cache":"public, max-age=31536000, immutable"});response.end(bytes);}catch{send(response,404,{error:"admin_ui_not_built"});}}
function inside(root:string,candidate:string){const relative=path.relative(root,candidate);return relative===""||(!relative.startsWith("..")&&!path.isAbsolute(relative));}
function mime(file:string){switch(path.extname(file)){case".html":return"text/html; charset=utf-8";case".js":return"text/javascript; charset=utf-8";case".css":return"text/css; charset=utf-8";case".svg":return"image/svg+xml";default:return"application/octet-stream";}}
