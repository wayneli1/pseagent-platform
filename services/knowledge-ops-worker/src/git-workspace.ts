import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export interface GitFileChange { readonly relativePath:string; readonly content:string; }
const ALLOWED=/^(?:wiki\/(?:queries|concepts)\/[\p{L}\p{N}_.\- ()（）]+\.md|governance\/(?:question-families|regression)\/[A-Za-z0-9_.-]+\.json)$/u;

export class SafeGitWorkspace {
  constructor(private readonly allowlistedRoots:readonly string[],private readonly worktreeRoot:string){}
  async writeRevision(repositoryRoot:string,baseRevision:string,changes:readonly GitFileChange[],message:string):Promise<{revision:string;diff:string}>{
    const root=await this.assertRoot(repositoryRoot);if(!/^[a-f0-9]{40}$/u.test(baseRevision))throw new Error("base_revision_invalid");
    if(changes.length===0)throw new Error("changes_required");for(const change of changes)this.assertRelative(change.relativePath);
    await mkdir(this.worktreeRoot,{recursive:true});const temp=await mkdtemp(path.join(this.worktreeRoot,"knowledge-ops-"));let attached=false;
    try{await git(root,["worktree","add","--detach",temp,baseRevision]);attached=true;
      for(const change of changes){const destination=path.resolve(temp,...change.relativePath.split("/"));if(!inside(temp,destination))throw new Error("path_escape_rejected");await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,change.content,"utf8");}
      await git(temp,["add","--",...changes.map(x=>x.relativePath)]);const diff=await git(temp,["diff","--cached","--no-ext-diff","--"]);
      if(diff.trim()==="")throw new Error("empty_git_diff");await git(temp,["-c","user.name=PSE Knowledge Ops","-c","user.email=knowledge-ops@localhost","commit","-m",message,"--",...changes.map(x=>x.relativePath)]);
      return {revision:(await git(temp,["rev-parse","HEAD"])).trim(),diff};
    }finally{if(attached)await git(root,["worktree","remove","--force",temp]).catch(()=>undefined);}
  }
  async withRevision<T>(repositoryRoot:string,baseRevision:string,changes:readonly GitFileChange[],operation:(worktreeRoot:string)=>Promise<T>):Promise<T>{
    const root=await this.assertRoot(repositoryRoot);if(!/^[a-f0-9]{40}$/u.test(baseRevision))throw new Error("base_revision_invalid");for(const change of changes)this.assertRelative(change.relativePath);
    await mkdir(this.worktreeRoot,{recursive:true});const temp=await mkdtemp(path.join(this.worktreeRoot,"knowledge-ops-inspect-"));let attached=false;
    try{await git(root,["worktree","add","--detach",temp,baseRevision]);attached=true;for(const change of changes){const destination=path.resolve(temp,...change.relativePath.split("/"));if(!inside(temp,destination))throw new Error("path_escape_rejected");await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,change.content,"utf8");}return await operation(temp);}
    finally{if(attached)await git(root,["worktree","remove","--force",temp]).catch(()=>undefined);}
  }
  async assertCleanRevision(repositoryRoot:string,expectedRevision:string):Promise<void>{const root=await this.assertRoot(repositoryRoot);if(!/^[a-f0-9]{40}$/u.test(expectedRevision))throw new Error("revision_invalid");const current=(await git(root,["rev-parse","HEAD"])).trim();if(current!==expectedRevision)throw new Error("knowledge_revision_changed");if((await git(root,["status","--porcelain=v1","--untracked-files=all"])).trim()!=="")throw new Error("knowledge_repository_dirty");}
  async publishRevision(repositoryRoot:string,baseRevision:string,changes:readonly GitFileChange[],message:string):Promise<{revision:string;diff:string}>{
    await this.assertCleanRevision(repositoryRoot,baseRevision);const result=await this.writeRevision(repositoryRoot,baseRevision,changes,message);await this.assertCleanRevision(repositoryRoot,baseRevision);const root=await this.assertRoot(repositoryRoot);await git(root,["merge","--ff-only",result.revision]);return result;
  }
  async revertPublishedRevision(repositoryRoot:string,currentRevision:string,publishedRevision:string,message:string):Promise<{revision:string}>{
    await this.assertCleanRevision(repositoryRoot,currentRevision);if(!/^[a-f0-9]{40}$/u.test(publishedRevision))throw new Error("revision_invalid");const root=await this.assertRoot(repositoryRoot);
    await git(root,["revert","--no-commit",publishedRevision]);await git(root,["-c","user.name=PSE Knowledge Ops","-c","user.email=knowledge-ops@localhost","commit","-m",message]);return{revision:(await git(root,["rev-parse","HEAD"])).trim()};
  }
  async diff(repositoryRoot:string,from:string,to:string):Promise<string>{const root=await this.assertRoot(repositoryRoot);if(!/^[a-f0-9]{40}$/u.test(from)||!/^[a-f0-9]{40}$/u.test(to))throw new Error("revision_invalid");return git(root,["diff","--no-ext-diff",from,to,"--","wiki/queries","governance"]);}
  private async assertRoot(candidate:string){const resolved=await realpath(candidate);const allowed=await Promise.all(this.allowlistedRoots.map(x=>realpath(x)));if(!allowed.some(x=>samePath(x,resolved)))throw new Error("repository_not_allowlisted");return resolved;}
  private assertRelative(value:string){if(value.includes("\\")||path.posix.isAbsolute(value)||value.split("/").includes("..")||!ALLOWED.test(value))throw new Error("knowledge_path_not_allowlisted");}
}
function inside(root:string,candidate:string){const relative=path.relative(root,candidate);return relative!==""&&!relative.startsWith("..")&&!path.isAbsolute(relative);}
function samePath(a:string,b:string){return process.platform==="win32"?a.toLowerCase()===b.toLowerCase():a===b;}
function git(cwd:string,args:string[]):Promise<string>{return new Promise((resolve,reject)=>{const child=spawn("git",["-c",`safe.directory=${cwd}`,"-C",cwd,...args],{shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.setEncoding("utf8").on("data",x=>out+=x);child.stderr.setEncoding("utf8").on("data",x=>err+=x);child.once("error",reject);child.once("exit",code=>code===0?resolve(out):reject(new Error(`git_failed:${err.trim().slice(0,200)}`)));});}
