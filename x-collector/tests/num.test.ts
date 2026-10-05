import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCompactNumber, intParam } from "../lib/trade/num";

test("parseCompactNumber: простые числа", () => {
  assert.equal(parseCompactNumber("1234"), 1234);
  assert.equal(parseCompactNumber("1 234"), 1234);
  assert.equal(parseCompactNumber("0"), 0);
});

test("parseCompactNumber: суффиксы K/M/B и кириллица", () => {
  assert.equal(parseCompactNumber("1,2K"), 1200);
  assert.equal(parseCompactNumber("3.4M"), 3_400_000);
  assert.equal(parseCompactNumber("1,5K"), 1500);
  assert.equal(parseCompactNumber("2К"), 2000);
  assert.equal(parseCompactNumber("1М"), 1_000_000);
  assert.equal(parseCompactNumber("1,5млн"), 1_500_000);
  assert.equal(parseCompactNumber("2B"), 2_000_000_000);
});

test("parseCompactNumber: тысячи разделители без суффикса", () => {
  assert.equal(parseCompactNumber("1,234"), 1234);
  assert.equal(parseCompactNumber("1.234"), 1234);
});

test("parseCompactNumber: русские суффиксы не путаются с однобуквенными", () => {
  assert.equal(parseCompactNumber("2млрд"), 2_000_000_000);
  assert.equal(parseCompactNumber("1,5тыс"), 1500);
  assert.equal(parseCompactNumber("1.5K"), 1500);
});

test("parseCompactNumber: мусор и пустой ввод", () => {
  assert.equal(parseCompactNumber(null), 0);
  assert.equal(parseCompactNumber(undefined), 0);
  assert.equal(parseCompactNumber(""), 0);
  assert.equal(parseCompactNumber("abc"), 0);
});

test("intParam: валидация границ", () => {
  assert.equal(intParam(null, 50, 1, 100), 50);
  assert.equal(intParam("", 50, 1, 100), 50);
  assert.equal(intParam("7", 50, 1, 100), 7);
  assert.throws(() => intParam("NaN", 50, 1, 100));
  assert.throws(() => intParam("0", 50, 1, 100));
  assert.throws(() => intParam("101", 50, 1, 100));
  assert.throws(() => intParam("1.5", 50, 1, 100));
});
