/**
 * Разбирает счётчики X вида "1 234", "1,2K", "3.4M", "1,5 млн", "12K views".
 * Возвращает целое; при неудаче — 0.
 */
export function parseCompactNumber(raw: string | null | undefined): number {
  if (!raw) return 0;
  const text = String(raw).replace(/\s+/g, "");
  const m = text.match(/([0-9]+(?:[.,][0-9]+)?)(млрд|млн|тыс|[KMBКМБ])?/i);
  if (!m) return 0;
  const suffix = (m[2] || "").toLowerCase();
  // Со suffix'ом пунктуация — десятичная (1,2K = 1200); без него — разделитель тысяч.
  const normalized = m[2] ? m[1].replace(",", ".") : m[1].replace(/[.,]/g, "");
  const value = Number(normalized);
  if (!isFinite(value)) return 0;
  if (suffix === "k" || suffix === "к" || suffix === "тыс") return Math.round(value * 1e3);
  if (suffix === "m" || suffix === "м" || suffix === "млн") return Math.round(value * 1e6);
  if (suffix === "b" || suffix === "б" || suffix === "млрд") return Math.round(value * 1e9);
  return Math.round(value);
}

/** Числовой параметр запроса с ограничением диапазона. Бросает HttpError-подобную ошибку. */
export function intParam(raw: string | null | undefined, def: number, min: number, max: number): number {
  if (raw === null || raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`parameter must be an integer from ${min} to ${max}`);
  }
  return n;
}
