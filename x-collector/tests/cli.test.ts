import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgv, intFlag, enumFlag } from "../lib/trade/cli";

test("parseArgv: позиционные и флаги", () => {
  const r = parseArgv(["query", "--limit", "50", "--sort=latest", "tail"]);
  assert.deepEqual(r.positional, ["query", "tail"]);
  assert.equal(r.flags.limit, "50");
  assert.equal(r.flags.sort, "latest");
});

test("parseArgv: значение флага поглощает следующий аргумент", () => {
  const r = parseArgv(["--flag", "value"]);
  assert.equal(r.flags.flag, "value");
});

test("parseArgv: флаг со значением, начинающимся с -- считается включённым", () => {
  const r = parseArgv(["--flag"]);
  assert.equal(r.flags.flag, "true");
});

test("intFlag: дефолт и проверка диапазона", () => {
  assert.equal(intFlag({}, "limit", 50, 1, 100), 50);
  assert.equal(intFlag({ limit: "10" }, "limit", 50, 1, 100), 10);
  assert.throws(() => intFlag({ limit: "0" }, "limit", 50, 1, 100));
  assert.throws(() => intFlag({ limit: "abc" }, "limit", 50, 1, 100));
});

test("enumFlag: белый список", () => {
  assert.equal(enumFlag({}, "sort", "latest", ["latest", "top"] as const), "latest");
  assert.equal(enumFlag({ sort: "top" }, "sort", "latest", ["latest", "top"] as const), "top");
  assert.throws(() => enumFlag({ sort: "newest" }, "sort", "latest", ["latest", "top"] as const));
});
