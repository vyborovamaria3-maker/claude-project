export interface PlaywrightProxy {
  server: string;
  username?: string;
  password?: string;
}

interface ProxyJson {
  server?: unknown;
  protocol?: unknown;
  host?: unknown;
  port?: unknown;
  username?: unknown;
  password?: unknown;
}

function fromUrl(url: string): PlaywrightProxy | undefined {
  try {
    const u = new URL(url);
    if (!u.hostname) return undefined;
    const server = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
    const proxy: PlaywrightProxy = { server };
    const username = decodeURIComponent(u.username);
    const password = decodeURIComponent(u.password);
    if (username) proxy.username = username;
    if (password) proxy.password = password;
    return proxy;
  } catch {
    return undefined;
  }
}

/**
 * proxy_json из x_accounts поддерживает:
 *   1. { server, username, password }          — формат Playwright (worker buildProxy)
 *   2. { host, port, username, password }      — host/port
 *   3. "http://user:pass@host:port"            — URL (в т.ч. JSON-строка)
 * Пустой/битый/неизвестный формат → undefined, никогда не бросает.
 */
export function parseProxy(proxyJson: string | null | undefined): PlaywrightProxy | undefined {
  if (!proxyJson || !proxyJson.trim()) return undefined;
  const trimmed = proxyJson.trim();

  try {
    const raw: unknown = JSON.parse(trimmed);
    if (typeof raw === "string") return fromUrl(raw);
    if (raw && typeof raw === "object") {
      const p = raw as ProxyJson;
      if (typeof p.server === "string" && p.server) {
        const proxy: PlaywrightProxy = { server: p.server };
        if (typeof p.username === "string" && p.username) proxy.username = p.username;
        if (typeof p.password === "string" && p.password) proxy.password = p.password;
        return proxy;
      }
      if (typeof p.host === "string" && p.host) {
        const protocol = typeof p.protocol === "string" && p.protocol
          ? p.protocol.replace(/:$/, "")
          : "http";
        const port = Number(p.port);
        const proxy: PlaywrightProxy = {
          server: `${protocol}://${p.host}${Number.isInteger(port) && port > 0 ? `:${port}` : ""}`,
        };
        if (typeof p.username === "string" && p.username) proxy.username = p.username;
        if (typeof p.password === "string" && p.password) proxy.password = p.password;
        return proxy;
      }
      return undefined;
    }
  } catch {
    /* не JSON — пробуем строку как URL */
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return fromUrl(trimmed);
  return undefined;
}
