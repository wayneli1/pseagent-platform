import { execFileSync } from "node:child_process";
import { mkdtemp,mkdir,rm,writeFile } from "node:fs/promises";
import os from "node:os";import path from "node:path";
import { afterEach,expect,it } from "vitest";
import { SafeGitWorkspace } from "./git-workspace.js";
const temporary:string[]=[];afterEach(async()=>{for(const item of temporary.splice(0))await rm(item,{recursive:true,force:true});});
it("writes only allowlisted knowledge paths in a detached worktree",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"pse-git-fixture-"));temporary.push(root);await mkdir(path.join(root,"wiki","queries"),{recursive:true});await writeFile(path.join(root,"wiki","queries","old.md"),"old\n");git(root,"init");git(root,"config","user.email","test@example.invalid");git(root,"config","user.name","Test");git(root,"add",".");git(root,"commit","-m","初始提交");const base=git(root,"rev-parse","HEAD").trim();const worktrees=path.join(root,"worktrees");const safe=new SafeGitWorkspace([root],worktrees);const result=await safe.writeRevision(root,base,[{relativePath:"wiki/queries/new.md",content:"new\n"}],"新增答案卡");expect(result.diff).toContain("new.md");expect(git(root,"cat-file","-t",result.revision).trim()).toBe("commit");await expect(safe.writeRevision(root,base,[{relativePath:"../escape.md",content:"bad"}],"非法")).rejects.toThrow("knowledge_path_not_allowlisted");});
function git(root:string,...args:string[]){return execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true});}
