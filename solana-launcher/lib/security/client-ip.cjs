"use strict";

const DEFAULT_TRUST_PROXY_HOPS = 0;

function parseTrustedProxyHops(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_TRUST_PROXY_HOPS;
  if (!/^\d+$/.test(String(value))) throw new Error("TRUST_PROXY_HOPS must be a non-negative integer");
  const hops = Number(value);
  if (!Number.isSafeInteger(hops) || hops > 10) throw new Error("TRUST_PROXY_HOPS must be between 0 and 10");
  return hops;
}

/**
 * X-Forwarded-For is only trustworthy when the ingress proxy is configured to
 * overwrite/append it and TRUST_PROXY_HOPS describes the trusted suffix.
 * With no trusted proxy, all clients share a conservative bucket rather than
 * allowing attacker-controlled headers to mint unlimited identities.
 */
function clientIpFromHeaders(headers, trustedProxyHops = DEFAULT_TRUST_PROXY_HOPS) {
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 10) {
    throw new Error("Invalid trusted proxy hop count");
  }
  if (trustedProxyHops === 0) return "untrusted-proxy";

  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return "untrusted-proxy";
  const chain = forwarded.split(",").map((value) => value.trim()).filter(Boolean);
  if (chain.length < trustedProxyHops) return "untrusted-proxy";

  const candidate = chain[chain.length - trustedProxyHops];
  // Accept only a single IP literal; do not allow arbitrary bucket-key input.
  const net = require("node:net");
  return net.isIP(candidate) ? candidate : "untrusted-proxy";
}

module.exports = { parseTrustedProxyHops, clientIpFromHeaders };
