import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reapOrphanArchivePages } from "../lib/archive/orphan-gc";

test("archive reaper dry-run never deletes; delete mode touches only old unreferenced hashed files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xa-gc-"));
  const hashA = "ab" + "0".repeat(62);
  const hashB = "ab" + "1".repeat(62);
  const hashC = "ab" + "2".repeat(62);
  const shard = path.join(root, "ab");
  const fileA = path.join(shard, hashA + ".json.gz");
  const fileB = path.join(shard, hashB + ".json.gz");
  const fileC = path.join(shard, hashC + ".json.gz");
  try {
    await fs.mkdir(shard);
    await Promise.all([fileA,fileB,fileC].map(p => fs.writeFile(p, "fixture")));
    await fs.writeFile(path.join(shard, "temporary.tmp"), "never-touch");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await Promise.all([fileA,fileB].map(p => fs.utimes(p, old, old)));
    const references = new Set([fileB]);
    const isReferenced = async (p: string) => references.has(p);
    const dry = await reapOrphanArchivePages(root, 24*60*60*1000, isReferenced, false);
    assert.equal(dry.orphanFiles, 1);
    assert.equal(dry.deletedFiles, 0);
    await fs.stat(fileA);
    const clean = await reapOrphanArchivePages(root, 24*60*60*1000, isReferenced, true);
    assert.equal(clean.orphanFiles, 1);
    assert.equal(clean.deletedFiles, 1);
    await assert.rejects(fs.stat(fileA), { code: "ENOENT" });
    await fs.stat(fileB);
    await fs.stat(fileC);
    await fs.stat(path.join(shard, "temporary.tmp"));
  } finally {
    await fs.rm(root, {recursive:true,force:true});
  }
});

test("archive reaper aborts deletion when reference appears on second check", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xa-gc-race-"));
  const hash = "ff" + "a".repeat(62);
  const file = path.join(root, "ff", hash + ".json.gz");
  try {
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, "old");
    const old = new Date(Date.now()-48*60*60*1000);
    await fs.utimes(file, old, old);
    let checks=0;
    const result=await reapOrphanArchivePages(root, 24*60*60*1000,
      async () => ++checks > 1, true);
    assert.equal(result.deletedFiles,0);
    await fs.stat(file);
  } finally {
    await fs.rm(root,{recursive:true,force:true});
  }
});
