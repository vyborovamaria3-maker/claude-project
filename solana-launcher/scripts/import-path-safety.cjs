"use strict";

const fs = require("node:fs");
const path = require("node:path");

function isWithin(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertNoSymlinkComponents(base, target) {
  const relative = path.relative(base, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Path escapes its allowed root");
  }

  let current = base;
  const components = relative ? relative.split(path.sep) : [];
  for (const component of components) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in import paths: ${current}`);
    }
  }
}

function resolveImportPath(inputPath, allowedRoots) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new Error("Import path must be a non-empty string");
  }

  const requested = path.resolve(inputPath);
  const root = allowedRoots
    .map((value) => path.resolve(value))
    .find((candidate) => isWithin(candidate, requested));

  if (!root) throw new Error(`Path is outside allowed import roots: ${inputPath}`);

  const rootStat = fs.statSync(root);
  if (!rootStat.isDirectory()) throw new Error(`Allowed import root is not a directory: ${root}`);
  const rootReal = fs.realpathSync(root);
  assertNoSymlinkComponents(root, requested);

  const targetStat = fs.lstatSync(requested);
  if (targetStat.isSymbolicLink()) throw new Error("Symbolic-link import targets are not allowed");
  const resolvedReal = fs.realpathSync(requested);
  if (!isWithin(rootReal, resolvedReal)) throw new Error("Resolved import path escapes its allowed root");
  return resolvedReal;
}

function listXlsxFiles(root, maxFiles = Number.POSITIVE_INFINITY) {
  const safeRoot = resolveImportPath(root, [root]);
  if (!fs.statSync(safeRoot).isDirectory()) throw new Error("XLSX import root must be a directory");

  const files = [];
  const stack = [safeRoot];
  const visited = new Set();

  while (stack.length > 0) {
    const current = stack.pop();
    const realCurrent = fs.realpathSync(current);
    if (visited.has(realCurrent)) throw new Error(`Repeated directory encountered while scanning: ${current}`);
    visited.add(realCurrent);

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed in XLSX import directories: ${candidate}`);
      }
      if (stat.isDirectory()) {
        stack.push(candidate);
      } else if (stat.isFile() && candidate.toLowerCase().endsWith(".xlsx")) {
        files.push(candidate);
        if (files.length > maxFiles) return files.sort((a, b) => a.localeCompare(b));
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

module.exports = { isWithin, resolveImportPath, listXlsxFiles };
