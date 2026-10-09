import { test } from "node:test";
import assert from "node:assert/strict";
import { toCSV, csvEscape } from "../lib/trade/csv";

test("csvEscape: кавычки, запятые и переводы строк", () => {
  assert.equal(csvEscape("plain"), "plain");
  assert.equal(csvEscape("a,b"), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape("line1\nline2"), '"line1\nline2"');
  assert.equal(csvEscape(null), "");
  assert.equal(csvEscape(undefined), "");
  assert.equal(csvEscape(0), "0");
});

test("toCSV: пустой массив", () => {
  assert.equal(toCSV([]), "");
});

test("toCSV: заголовок из первого элемента, значения экранированы", () => {
  const out = toCSV([
    { handle: "alice", text: "hello, world" },
    { handle: "bob", text: 'quotes "here"' },
  ]);
  const lines = out.split("\n");
  assert.equal(lines[0], "handle,text");
  assert.equal(lines[1], 'alice,"hello, world"');
  assert.equal(lines[2], 'bob,"quotes ""here"""');
});
