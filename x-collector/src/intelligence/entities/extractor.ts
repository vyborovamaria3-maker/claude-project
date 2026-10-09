export type EntityType = "TOKEN" | "MENTION" | "URL" | "HASHTAG";

export interface ExtractedEntity {
  type: EntityType;
  value: string;
  confidence: number;
  /** Символьный индекс первого вхождения в тексте. */
  position: number;
}

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TOKEN_RE = /\$([A-Za-z]{2,15})(?![A-Za-z0-9])/g;
const MENTION_RE = /(?<![\w@./])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g;
const HASHTAG_RE = /(?<![\w#/])#([A-Za-z0-9_]{2,50})(?![A-Za-z0-9_])/g;

/** Хвостовая пунктуация, которая не входит в URL (запятая, скобка, точка, многоточие X). */
const URL_TRAILING = /[.,;:!?)\]}'"…]+$/;
/** Качество паттернов: тикер в верхнем регистре — обычный касhtag, иначе — шум. */
const TICKER_RE = /^[A-Z]{2,10}$/;
const WORDS_ONLY_RE = /^[A-Za-z]{2,}$/;

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

interface Match {
  type: EntityType;
  value: string;
  position: number;
  confidence: number;
}

function scan(re: RegExp, text: string, accept: (m: RegExpExecArray) => Match | null): Match[] {
  const out: Match[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const hit = accept(m);
    if (hit) out.push(hit);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

function urlConfidence(value: string): number {
  if (value.startsWith("https://")) return 0.99;
  if (value.startsWith("http://")) return 0.97;
  return 0.95;
}

/**
 * Достаёт из текста твита сущности: TOKEN ($BTC), MENTION (@user), URL, HASHTAG (#crypto).
 * URL ищется первым: всё внутри диапазона URL маскируется, чтобы #фрагмент ссылки
 * не считался хэштегом, а путь вида /@user — упоминанием.
 * Дубликаты (type+value) схлопываются: остаётся первая позиция и максимальный confidence.
 */
export function extractEntities(text: string): ExtractedEntity[] {
  if (typeof text !== "string" || text.length === 0) return [];

  const urls = scan(URL_RE, text, (m) => {
    const value = m[0].replace(URL_TRAILING, "");
    if (value.length < 8) return null;
    return { type: "URL", value, position: m.index, confidence: urlConfidence(value) };
  });
  const ranges = urls.map((u) => [u.position, u.position + u.value.length] as const);
  const inUrl = (pos: number) => ranges.some(([a, b]) => pos >= a && pos < b);

  const found: Match[] = [...urls];

  found.push(...scan(TOKEN_RE, text, (m) => {
    if (inUrl(m.index)) return null;
    const value = m[1].toUpperCase();
    return { type: "TOKEN", value, position: m.index, confidence: TICKER_RE.test(m[1]) ? 0.95 : 0.8 };
  }));

  found.push(...scan(MENTION_RE, text, (m) => {
    if (inUrl(m.index)) return null;
    const value = m[1].toLowerCase();
    return { type: "MENTION", value, position: m.index, confidence: value.length >= 3 ? 0.9 : 0.75 };
  }));

  found.push(...scan(HASHTAG_RE, text, (m) => {
    if (inUrl(m.index)) return null;
    const value = m[1].toLowerCase();
    return { type: "HASHTAG", value, position: m.index, confidence: WORDS_ONLY_RE.test(m[1]) ? 0.9 : 0.8 };
  }));

  const byKey = new Map<string, ExtractedEntity>();
  for (const m of found) {
    const key = `${m.type} ${m.value}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { type: m.type, value: m.value, confidence: round4(m.confidence), position: m.position });
    } else if (m.confidence > prev.confidence) {
      prev.confidence = round4(m.confidence);
    }
  }
  return [...byKey.values()].sort((a, b) => a.position - b.position);
}
