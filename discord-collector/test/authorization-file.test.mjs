import test from "node:test";
import assert from "node:assert/strict";
import {chmodSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readAuthorizationFile} from "../src/authorization-file.mjs";

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),"potapoff-discord-auth-"));
  const path=join(directory,"authorization.json");
  return {directory,path,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}

test("authorization file accepts only private regular files",async()=>{
  const f=fixture();
  try{
    writeFileSync(f.path,JSON.stringify({version:2,mode:"collect",guilds:[]}),{mode:0o600});
    const value=await readAuthorizationFile(f.path);
    assert.equal(value.version,2);
    assert.equal(value.mode,"collect");
  }finally{f.cleanup()}
});

test("authorization file rejects relative paths and symlinks",async()=>{
  const f=fixture();
  try{
    writeFileSync(f.path,"{}",{mode:0o600});
    assert.rejects(readAuthorizationFile("relative/authorization.json"),/absolute path/);
    const link=join(f.directory,"link.json");
    symlinkSync(f.path,link);
    await assert.rejects(readAuthorizationFile(link));
  }finally{f.cleanup()}
});

test("authorization file rejects group/world-readable permissions",async()=>{
  const f=fixture();
  try{
    writeFileSync(f.path,"{}",{mode:0o600});
    chmodSync(f.path,0o644);
    await assert.rejects(readAuthorizationFile(f.path),/mode 0600/);
  }finally{f.cleanup()}
});

test("authorization file rejects oversized and malformed documents",async()=>{
  const f=fixture();
  try{
    writeFileSync(f.path,"x".repeat(1_048_577),{mode:0o600});
    await assert.rejects(readAuthorizationFile(f.path),/size/);
    writeFileSync(f.path,"{bad json}",{mode:0o600});
    await assert.rejects(readAuthorizationFile(f.path),SyntaxError);
  }finally{f.cleanup()}
});
