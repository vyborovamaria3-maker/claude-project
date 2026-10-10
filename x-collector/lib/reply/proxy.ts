import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import https from "node:https";
import type { Agent } from "node:http";
export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}
export function parseProxy(input: string): ProxyConfig {
  let value = input.trim();
  if (!value) throw new Error("empty proxy");
  if (!value.includes("://")) {
    if (!value.includes("@")) {
      const parts = value.split(":");
      if (parts.length === 4)
        value =
          encodeURIComponent(parts[2]) +
          ":" +
          encodeURIComponent(parts[3]) +
          "@" +
          parts[0] +
          ":" +
          parts[1];
    }
    value = "http://" + value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid proxy format");
  }
  const port = value
    .split("@")
    .pop()
    ?.match(/:(\d+)\/?$/)?.[1];
  if (
    !["http:", "https:", "socks4:", "socks5:"].includes(url.protocol) ||
    !url.hostname ||
    !port ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    !["", "/"].includes(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error("invalid proxy protocol, host or port");
  return {
    server: url.protocol + "//" + url.hostname + ":" + Number(port),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}
export function proxyIdentity(proxy: ProxyConfig): string {
  return proxy.server.toLowerCase();
}
function agent(proxy?: ProxyConfig): Agent | undefined {
  if (!proxy) return undefined;
  const url = new URL(proxy.server);
  if (proxy.username) url.username = proxy.username;
  if (proxy.password) url.password = proxy.password;
  // Resolve destination names at the proxy, using its network and address family.
  if (url.protocol === "socks5:") url.protocol = "socks5h:";
  return url.protocol.startsWith("socks")
    ? new SocksProxyAgent(url)
    : new HttpsProxyAgent(url);
}
export interface JsonResponse {
  status: number;
  headers: import("node:http").IncomingHttpHeaders;
  data: unknown;
}
export async function requestJSON(
  url: URL,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    proxy?: ProxyConfig;
    timeoutMs?: number;
  } = {},
): Promise<JsonResponse> {
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("HTTPS endpoint required");
  const body =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: options.method ?? "GET",
        agent: agent(options.proxy),
        headers: {
          Accept: "application/json",
          ...options.headers,
          ...(body
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(body)),
              }
            : {}),
        },
      },
      (res) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2000000) {
            res.destroy();
            reject(new Error("upstream response too large"));
          } else chunks.push(chunk);
        });
        res.on("error", () => reject(new Error("upstream transport failure")));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 502,
              headers: res.headers,
              data: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch {
            reject(new Error("upstream returned invalid JSON"));
          }
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error("timeout")),
      options.timeoutMs ?? 15000,
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => reject(new Error("upstream transport failure")));
    if (body) req.write(body);
    req.end();
  });
}
export async function testProxy(
  proxy: ProxyConfig,
): Promise<{ latency_ms: number; ip: string }> {
  const start = Date.now();
  const result = await requestJSON(
    new URL("https://api.ipify.org?format=json"),
    { proxy },
  );
  const data = result.data as { ip?: string };
  if (result.status !== 200 || !data.ip || !/^[0-9a-fA-F:.]+$/.test(data.ip))
    throw new Error("proxy check failed");
  return { latency_ms: Date.now() - start, ip: data.ip };
}

export async function proxyGeolocation(
  ip: string,
): Promise<{ country: string; timezone: string } | null> {
  if (process.env.REPLY_PROXY_GEOLOCATION !== "true") return null;
  try {
    const result = await requestJSON(
      new URL("https://ipapi.co/" + encodeURIComponent(ip) + "/json/"),
      { timeoutMs: 5000 },
    );
    const value = result.data as { country_code?: string; timezone?: string };
    if (
      result.status !== 200 ||
      !value.country_code ||
      !value.timezone ||
      !/^[A-Z]{2}$/.test(value.country_code)
    )
      return null;
    new Intl.DateTimeFormat("en", { timeZone: value.timezone });
    return { country: value.country_code, timezone: value.timezone };
  } catch {
    return null;
  }
}
