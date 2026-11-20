#!/usr/bin/env node
"use strict";

require("ts-node").register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: {
    module: "commonjs",
    moduleResolution: "node",
    esModuleInterop: true,
    allowJs: true,
    resolveJsonModule: true,
  },
});

const { getDb } = require("../lib/trade/db.ts");
const { rebuildWalletSummary } = require("../lib/trade/wallet-summary.ts");

let db;
try {
  db = getDb();
  const result = rebuildWalletSummary(db);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (db?.open) db.close();
}
