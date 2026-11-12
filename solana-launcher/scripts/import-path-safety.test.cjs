"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isWithin, resolveImportPath, listXlsxFiles } = require("./import-path-safety.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xlsx-import-safe-"));
const sibling = `${root}-evil`;
try {
  fs.mkdirSync(path.join(root, "nested"));
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(root, "nested", "ok.xlsx"), "fixture");
  fs.writeFileSync(path.join(sibling, "outside.xlsx"), "fixture");

  assert.equal(isWithin(root, path.join(root, "nested")), true);
  assert.equal(isWithin(root, sibling), false);
  assert.equal(resolveImportPath(path.join(root, "nested", "ok.xlsx"), [root]), path.join(root, "nested", "ok.xlsx"));
  assert.throws(() => resolveImportPath(path.join(sibling, "outside.xlsx"), [root]), /outside allowed/);
  assert.deepEqual(listXlsxFiles(root), [path.join(root, "nested", "ok.xlsx")]);

  const link = path.join(root, "escape");
  try {
    fs.symlinkSync(sibling, link, "dir");
    assert.throws(() => listXlsxFiles(root), /Symbolic links/);
    assert.throws(() => resolveImportPath(path.join(link, "outside.xlsx"), [root]), /Symbolic links/);
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    console.warn("SYMLINK_TEST_SKIPPED: platform does not permit creating symlinks");
  }
  console.log("IMPORT_PATH_SAFETY_OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sibling, { recursive: true, force: true });
}
