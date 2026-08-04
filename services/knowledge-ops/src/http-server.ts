import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { KnowledgeOpsApi } from "./api.js";

export function createKnowledgeOpsHttpServer(api:KnowledgeOpsApi){return createServer(async(request,response)=>{
  try{const body=await readJson(request);const result=await api.handle({method:request.method??"GET",path:request.url??"/",...(request.headers.authorization?{authorization:request.headers.authorization}:{}),...(body===undefined?{}:{body})});send(response,result.status,result.body);}
  catch(error){send(response,error instanceof PayloadError?error.status:500,{error:error instanceof PayloadError?error.message:"internal_error"});}
});}
function readJson(request:IncomingMessage):Promise<unknown>{return new Promise((resolve,reject)=>{let size=0;const chunks:Buffer[]=[];request.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>1_048_576){reject(new PayloadError(413,"payload_too_large"));request.destroy();return;}chunks.push(chunk);});request.on("end",()=>{if(chunks.length===0){resolve(undefined);return;}try{resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));}catch{reject(new PayloadError(400,"invalid_json"));}});request.on("error",reject);});}
function send(response:ServerResponse,status:number,body:unknown){const bytes=Buffer.from(JSON.stringify(body));response.writeHead(status,{"content-type":"application/json; charset=utf-8","content-length":bytes.length,"cache-control":"no-store","x-content-type-options":"nosniff"});response.end(bytes);}
class PayloadError extends Error{constructor(readonly status:number,message:string){super(message);}}
