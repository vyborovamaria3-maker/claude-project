import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const guard=fileURLToPath(new URL("../.github/scripts/verify-release-sha-drift.sh",import.meta.url));
const workflow=readFileSync(new URL("../.github/workflows/potapoff-production.yml",import.meta.url),"utf8");
const git=(dir,...args)=>execFileSync("git",args,{cwd:dir,encoding:"utf8"}).trim();

function scenario(fn){
  const root=mkdtempSync(join(tmpdir(),"release-sha-review-"));
  try{
    const repo=join(root,"repo"),origin=join(root,"origin.git");
    mkdirSync(repo);
    execFileSync("git",["init","--bare",origin],{stdio:"ignore"});
    git(repo,"init","-b","main");
    git(repo,"config","user.email","ci@example.invalid");
    git(repo,"config","user.name","CI fixture");
    git(repo,"remote","add","origin",origin);
    const write=(name,value)=>{
      const full=join(repo,name);
      mkdirSync(join(full,".."),{recursive:true});
      writeFileSync(full,value);
    };
    const commit=(message)=>{
      git(repo,"add","--all");
      git(repo,"commit","-m",message);
      git(repo,"push","origin","main");
      return git(repo,"rev-parse","HEAD");
    };
    write("app.js","export const release=1;\n");
    write("README.md","# App\n");
    const release=commit("release A");
    const check=(head,mode="docs-only",event=head)=>{
      const result=spawnSync("bash",[guard,release,event,mode],{
        cwd:repo,encoding:"utf8",env:{...process.env,GITHUB_REF:"refs/heads/main"},
      });
      return {status:result.status,stdout:result.stdout,stderr:result.stderr};
    };
    return fn({repo,release,write,commit,check});
  }finally{rmSync(root,{recursive:true,force:true})}
}

test("workflow_run: code A followed by docs B deploys exact A images",()=>{
  scenario(({release,write,commit,check})=>{
    write("docs/architecture/NOTE.json",'{"notes":true}\n');
    write("README.md","# App revised\n");
    const eventB=commit("docs-only B");
    const r=check(eventB);
    assert.equal(r.status,0,r.stderr);
    assert.match(r.stdout,new RegExp("release="+release));
    assert.notEqual(check(eventB,"exact").status,0,
      "manual dispatch must not use images absent for HEAD B");
  });
});

test("workflow_run: later docs C is allowed for same published SHA",()=>{
  scenario(({write,commit,check})=>{
    write("README.md","# B\n");
    const eventB=commit("docs B");
    write("docs/new-note.mdx","documentation\n");
    commit("docs C");
    assert.equal(check(eventB).status,0);
  });
});

test("workflow_run: executable change C after docs B blocks older release",()=>{
  scenario(({write,commit,check})=>{
    write("README.md","# B\n");
    const eventB=commit("docs B");
    write("app.js","export const release=2;\n");
    commit("runtime C");
    const result=check(eventB);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/non-documentation drift/);
  });
});

test("workflow_run: moving a runtime file into docs must fail closed",()=>{
  scenario(({repo,write,commit,check})=>{
    write("README.md","# Documentation update\n");
    const eventB=commit("docs B");
    const from=join(repo,"app.js"),to=join(repo,"docs","app.js");
    mkdirSync(join(repo,"docs"),{recursive:true});
    execFileSync("git",["mv",from,to],{cwd:repo});
    commit("move executable into docs");
    const result=check(eventB);
    assert.notEqual(result.status,0,
      "renamed runtime deletion must be visible despite docs destination");
    assert.match(result.stderr,/non-documentation drift/);
  });
});

test("workflow_run: mixed docs and workflow changes fail closed",()=>{
  scenario(({write,commit,check})=>{
    write("README.md","# B\n");
    write(".github/workflows/deploy.yml","jobs: {}\n");
    const eventB=commit("mixed B");
    assert.notEqual(check(eventB).status,0);
  });
});

test("invalid release SHA, non-main and invalid policy are rejected",()=>{
  scenario(({release,write,commit,check,repo})=>{
    write("README.md","# B\n");
    const b=commit("docs B");
    assert.notEqual(check(b,"oops").status,0);
    assert.notEqual(check(b,"docs-only","0".repeat(40)).status,0);
    const offMain=spawnSync("bash",[guard,release,b,"docs-only"],{
      cwd:repo,encoding:"utf8",env:{...process.env,GITHUB_REF:"refs/heads/feature"},
    });
    assert.notEqual(offMain.status,0);
  });
});

test("production workflow pins SHA in checkout, artifacts and deploy",()=>{
  assert.match(workflow,/release_sha: \$\{\{ steps\.release-guard\.outputs\.release_sha \}\}/);
  assert.match(workflow,/RELEASE_SHA: \$\{\{ needs\.require-main\.outputs\.release_sha \}\}/);
  assert.match(workflow,/git checkout --detach "\$RELEASE_SHA"/);
  assert.match(workflow,/verify-release-sha-drift\.sh "\$release_sha" "\$GITHUB_SHA" "\$mode"/);
  assert.equal((workflow.match(/verify-release-sha-drift\.sh "\$RELEASE_SHA" "\$GITHUB_SHA" "\$DRIFT_MODE"/g)||[]).length,2);
  for(const name of ["backend","frontend"])
    assert.ok(workflow.includes(name+":$"+"{RELEASE_SHA}"),
      "image tag must match original published SHA");
  assert.ok(workflow.includes("scripts/deploy-production.sh '$"+"{RELEASE_SHA}'"));
  assert.ok(workflow.includes("potapoff-admin-$"+"{RELEASE_SHA}.tar.gz"));
});

test("automatic deployment is opt-in and manual dispatch remains supported",()=>{
  const gate=/^  require-main:\n([\s\S]*?)(?=^  predeploy:)/m.exec(workflow)?.[1];
  assert.ok(gate,"production deployment must have require-main gate");
  assert.match(gate,/github\.event_name == 'workflow_dispatch'/,
    "manual deployment remains possible with exact SHA verification");
  assert.match(gate,/github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(gate,/github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(gate,/vars\.POTAPOFF_AUTODEPLOY_ENABLED == 'true'/,
    "a successful image build alone must never deploy without operator opt-in");
  assert.ok(!/vars\.POTAPOFF_AUTODEPLOY_ENABLED != 'false'/.test(gate),
    "absent variables must never imply permission");
});
