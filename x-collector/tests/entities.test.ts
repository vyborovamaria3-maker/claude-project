import { test } from "node:test";
import assert from "node:assert/strict";
import { extractEntities } from "../src/intelligence/entities/extractor";

function one(text: string, type: string) {
  const found = extractEntities(text).filter((e) => e.type === type);
  assert.equal(found.length, 1, `expected single ${type} in: ${text}`);
  return found[0];
}

test("extractEntities: $BTC → TOKEN BTC", () => {
  const e = one("$BTC is going up", "TOKEN");
  assert.equal(e.value, "BTC");
  assert.ok(e.confidence > 0 && e.confidence <= 1);
  assert.equal(e.position, 0);
});

test("extractEntities: @elon → MENTION elon", () => {
  const e = one("Follow @elon", "MENTION");
  assert.equal(e.value, "elon");
});

test("extractEntities: #crypto → HASHTAG crypto", () => {
  const e = one("maximalism #crypto", "HASHTAG");
  assert.equal(e.value, "crypto");
});

test("extractEntities: URL", () => {
  const e = one("read more https://x.com/user/status/1234567890", "URL");
  assert.equal(e.value, "https://x.com/user/status/1234567890");
  assert.ok(e.confidence >= 0.95);
});

test("extractEntities: канонизация регистр/дубликаты", () => {
  const all = extractEntities("$btc и $BTC и ещё @Elon и @elon");
  assert.deepEqual(
    all.map((e) => `${e.type}:${e.value}`).sort(),
    ["MENTION:elon", "TOKEN:BTC"]
  );
  assert.equal(all.find((e) => e.type === "MENTION")!.position, 18);
});

test("extractEntities: URL не даёт ложных HASHTAG/MENTION/TOKEN", () => {
  const all = extractEntities("смотри https://x.com/search?q=%23crypto&f=live там");
  assert.equal(all.length, 1);
  assert.equal(all[0].type, "URL");
});

test("extractEntities: email — не MENTION", () => {
  const all = extractEntities("пиши на admin@example.com");
  assert.equal(all.filter((e) => e.type === "MENTION").length, 0);
});

test("extractEntities: C# — не HASHTAG", () => {
  const all = extractEntities("код на C# и на go");
  assert.equal(all.filter((e) => e.type === "HASHTAG").length, 0);
});

test("extractEntities: хвостовая пунктуация отрезается от URL", () => {
  const e = one("ссылка: https://example.com/page.", "URL");
  assert.equal(e.value, "https://example.com/page");
});

test("extractEntities: многоточие X в конце ссылки отрезается", () => {
  const e = one("читай https://example.com/bitcoin-loans/… ещё", "URL");
  assert.equal(e.value, "https://example.com/bitcoin-loans/");
});

test("extractEntities: пустой/некорректный вход", () => {
  assert.deepEqual(extractEntities(""), []);
  assert.deepEqual(extractEntities("обычный текст без сущностей"), []);
  assert.deepEqual(extractEntities(" $ "), []);
});

test("extractEntities: смешанный текст, позиции по порядку", () => {
  const all = extractEntities("Pump $SOL with @alice #solana https://t.co/abc");
  assert.deepEqual(
    all.map((e) => [e.type, e.value]),
    [
      ["TOKEN", "SOL"],
      ["MENTION", "alice"],
      ["HASHTAG", "solana"],
      ["URL", "https://t.co/abc"],
    ]
  );
  for (let i = 1; i < all.length; i++) assert.ok(all[i].position > all[i - 1].position);
});
