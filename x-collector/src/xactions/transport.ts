import http from "node:http";
import https from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { PlaywrightProxy } from "../x/proxy";

export interface SocksFetchOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Converts the already-validated account proxy into a credentials-bearing URL, in memory only. */
export function socksProxyUrl(proxy: PlaywrightProxy): URL {
  const url = new URL(proxy.server);
  if (url.protocol !== "socks5:" && url.protocol !== "socks5h:") {
    throw new Error("XActions requires an explicit SOCKS5 account proxy");
  }
  if (proxy.username) url.username = proxy.username;
  if (proxy.password) url.password = proxy.password;
  if (!url.hostname || !url.port) throw new Error("XActions proxy host or port missing");
  return url;
}

/**
 * Bound decoded output *during* decompression. Checking length afterwards is
 * insufficient: a very small gzip/deflate/br response can exhaust memory.
 */
export function decodeResponseBody(data: Buffer, encoding: string | undefined, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("XActions invalid response size limit");
  if (data.byteLength > maxBytes) throw new Error("XActions: HTTP response exceeds size limit");
  const kind = encoding?.toLowerCase().trim();
  const maxOutputLength = maxBytes + 1;
  let decoded: Buffer;
  if (kind === "gzip") decoded = gunzipSync(data, { maxOutputLength });
  else if (kind === "deflate") decoded = inflateSync(data, { maxOutputLength });
  else if (kind === "br") decoded = brotliDecompressSync(data, { maxOutputLength });
  else if (!kind || kind === "identity") decoded = data;
  else throw new Error("XActions unsupported HTTP content encoding");
  if (decoded.byteLength > maxBytes) throw new Error("XActions: decoded HTTP response exceeds size limit");
  return decoded;
}

/**
 * A bounded fetch transport for XActions' JSON GraphQL calls.
 * There is NO fallback to direct access when SOCKS5 fails. Browser-like
 * Request/FormData streaming is intentionally unsupported in this read-only path.
 */
export function createSocks5Fetch(proxy: PlaywrightProxy, options: SocksFetchOptions = {}): typeof fetch {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new Error("XActions: invalid transport bounds");
  }
  const agent = new SocksProxyAgent(socksProxyUrl(proxy).toString());

  return async (input, init) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new Error("XActions transport accepts URL strings only");
    }
    const target = new URL(input);
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new Error("XActions transport rejects non-HTTP requests");
    }
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? "GET").toUpperCase();
    const requestBody = init?.body;
    let body: Buffer | undefined;
    if (typeof requestBody === "string") body = Buffer.from(requestBody);
    else if (requestBody instanceof URLSearchParams) body = Buffer.from(requestBody.toString());
    else if (requestBody instanceof Uint8Array) body = Buffer.from(requestBody);
    else if (requestBody != null) throw new Error("XActions: unsupported HTTP request body");
    if (body && !headers.has("content-length")) headers.set("content-length", String(body.byteLength));

    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();

    return new Promise<Response>((resolve, reject) => {
      const fail = (error: Error) => {
        clearTimeout(deadline);
        reject(error);
      };
      const req = (target.protocol === "https:" ? https : http).request(target, {
        method, headers: Object.fromEntries(headers.entries()), agent, signal,
        timeout: timeoutMs,
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maxResponseBytes) {
            req.destroy(new Error("XActions: HTTP response exceeds size limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", fail);
        res.on("end", () => {
          clearTimeout(deadline);
          try {
            const out = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (Array.isArray(value)) value.forEach(v => out.append(name, v));
              else if (value !== undefined) out.set(name, value);
            }
            const payload = decodeResponseBody(Buffer.concat(chunks), res.headers["content-encoding"], maxResponseBytes);
            out.delete("content-encoding");
            out.delete("content-length");
            const status = res.statusCode ?? 502;
            // The Fetch Response constructor forbids a body for these statuses.
            const noBody = status === 204 || status === 205 || status === 304;
            const bytes = new Uint8Array(payload.byteLength);
            bytes.set(payload);
            resolve(new Response(noBody ? null : bytes, { status, headers: out }));
          } catch (error) { reject(error); }
        });
      });
      // Socket timeouts only bound idle periods. Bound the whole operation,
      // including proxy negotiation and responses that continuously trickle.
      const deadline = setTimeout(() => req.destroy(new Error("XActions: HTTP request timed out")), timeoutMs);
      deadline.unref();
      req.on("timeout", () => req.destroy(new Error("XActions: HTTP request timed out")));
      req.on("error", fail);
      req.end(body);
    });
  };
}
