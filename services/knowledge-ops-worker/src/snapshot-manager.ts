import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { answerCardCatalogSchema, releaseManifestSchema, type AnswerCardCatalog, type ReleaseManifest } from "@pseagent/knowledge-governance-contracts";

export class SnapshotManager {
  constructor(private readonly root:string){}
  async publish(manifestSource:unknown,catalogSource:unknown):Promise<{catalogHash:string;snapshotPath:string}>{
    const manifest=releaseManifestSchema.parse(manifestSource);const catalog=answerCardCatalogSchema.parse(catalogSource);
    const catalogJson=stableJson(catalog);const catalogHash=createHash("sha256").update(catalogJson).digest("hex");if(catalogHash!==manifest.cardCatalogHash)throw new Error("catalog_hash_mismatch");
    await mkdir(path.join(this.root,"releases"),{recursive:true});const directory=this.releasePath(manifest.releaseId);await mkdir(directory,{recursive:false});
    const catalogPath=path.join(directory,"answer-card-catalog.json"),manifestPath=path.join(directory,"release-manifest.json");
    await writeFile(catalogPath,`${catalogJson}\n`,{encoding:"utf8",flag:"wx"});await writeFile(manifestPath,`${stableJson(manifest)}\n`,{encoding:"utf8",flag:"wx"});
    await chmod(catalogPath,0o444);await chmod(manifestPath,0o444);await this.activate(manifest.releaseId);return {catalogHash,snapshotPath:directory};
  }
  async rollback(releaseId:string){await readFile(path.join(this.releasePath(releaseId),"release-manifest.json"),"utf8");await this.activate(releaseId);}
  async active():Promise<ReleaseManifest|undefined>{try{const pointer=JSON.parse(await readFile(path.join(this.root,"active.json"),"utf8")) as {releaseId:string};return releaseManifestSchema.parse(JSON.parse(await readFile(path.join(this.releasePath(pointer.releaseId),"release-manifest.json"),"utf8")));}catch{return undefined;}}
  private releasePath(id:string){if(!/^KR-\d{4}-\d{2}-[A-Z0-9-]{3,40}$/u.test(id))throw new Error("release_id_invalid");const value=path.resolve(this.root,"releases",id);const relative=path.relative(path.resolve(this.root),value);if(relative.startsWith("..")||path.isAbsolute(relative))throw new Error("release_path_escape");return value;}
  private async activate(releaseId:string){await mkdir(this.root,{recursive:true});const temporary=path.join(this.root,`.active-${process.pid}-${Date.now()}.json`);await writeFile(temporary,`${JSON.stringify({releaseId,activatedAt:new Date().toISOString()})}\n`,"utf8");await rename(temporary,path.join(this.root,"active.json"));}
}
function stableJson(value:unknown):string{if(Array.isArray(value))return`[${value.map(stableJson).join(",")}]`;if(value!==null&&typeof value==="object"){const r=value as Record<string,unknown>;return`{${Object.keys(r).sort().map(k=>`${JSON.stringify(k)}:${stableJson(r[k])}`).join(",")}}`;}return JSON.stringify(value);}
