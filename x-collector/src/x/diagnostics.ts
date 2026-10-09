import { parseProxy } from "./proxy";

export interface DiagnosticsInput {
  error: unknown;
  url?: string;
  httpStatus?: number;
  account?: string | null;
  proxyJson?: string | null;
}

/** Первый токен сообщения вида "AUTH_REQUIRED: ..." — код ошибки блока/авторизации. */
export function errorCode(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  const m = /^([A-Z][A-Z0-9_]{2,})\s*:/.exec(msg);
  if (m) return m[1];
  if (/^X returned HTTP \d+/.test(msg)) return "X_HTTP_ERROR";
  return "OTHER";
}

/** Статус proxy без credentials: none / configured host:port. */
export function proxyStatus(proxyJson: string | null | undefined): string {
  const raw = proxyJson?.trim();
  if (!raw) return "none (direct)";
  const parsed = parseProxy(proxyJson);
  if (!parsed) return "configured (unparsed)";
  return `configured ${parsed.server}${parsed.username ? " (auth)" : ""}`;
}

/**
 * Диагностика блока/ошибки: код, URL, HTTP status, аккаунт, proxy — без секретов.
 * Вызывается до любых правок кода, чтобы решение принималось по факту.
 */
export function printDiagnostics(input: DiagnosticsInput, tag = "[x-diagnostics]"): void {
  const msg = input.error instanceof Error ? input.error.message : String(input.error);
  const cause = input.error instanceof Error && input.error.cause instanceof Error
    ? input.error.cause.message
    : "";
  const lines: Array<[string, string]> = [
    ["code", errorCode(input.error)],
    ["url", input.url || "-"],
    ["http_status", input.httpStatus ? String(input.httpStatus) : "-"],
    ["account", input.account || "-"],
    ["proxy", proxyStatus(input.proxyJson)],
    ["message", msg],
  ];
  if (cause && cause !== msg) lines.push(["cause", cause]);
  console.error(`${tag} diagnostics`);
  for (const [k, v] of lines) console.error(`${tag}   ${k.padEnd(12)} ${v}`);
}
