"use strict";

const assert = require("node:assert/strict");
const { parseTrustedProxyHops, clientIpFromHeaders } = require("./client-ip.cjs");

assert.equal(parseTrustedProxyHops(undefined), 0);
assert.equal(parseTrustedProxyHops("2"), 2);
assert.throws(() => parseTrustedProxyHops("-1"), /non-negative/);
assert.throws(() => parseTrustedProxyHops("11"), /between 0 and 10/);

// No trusted proxy at all: header contents are attacker-controlled.
const spoofed = new Headers({ "x-real-ip": "203.0.113.99", "x-forwarded-for": "203.0.113.99" });
assert.equal(clientIpFromHeaders(spoofed, 0), "untrusted-proxy");

// One trusted proxy, matching the production nginx overwrite:
// X-Forwarded-For "$remote_addr, 127.0.0.1".
assert.equal(
  clientIpFromHeaders(new Headers({ "x-forwarded-for": "198.51.100.10, 127.0.0.1" }), 1),
  "198.51.100.10",
);

// Two trusted proxies appended their own addresses after the client entry.
assert.equal(
  clientIpFromHeaders(new Headers({ "x-forwarded-for": "198.51.100.10, 10.0.0.2, 10.0.0.3" }), 2),
  "198.51.100.10",
);

// Direct connection without a proxy: no header at all must share the
// conservative bucket instead of minting an identity.
assert.equal(clientIpFromHeaders(new Headers(), 1), "untrusted-proxy");

// A single-value header behind a hops=1 proxy that did not append its own
// address has no trustworthy client entry; fail closed.
assert.equal(
  clientIpFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.99" }), 1),
  "untrusted-proxy",
);

// Spoofed entries beyond the trusted suffix must not become the client IP.
assert.equal(
  clientIpFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.99, 198.51.100.10, 127.0.0.1" }), 1),
  "198.51.100.10",
);

// Empty chain and whitespace-only entries.
assert.equal(clientIpFromHeaders(new Headers({ "x-forwarded-for": "" }), 1), "untrusted-proxy");
assert.equal(clientIpFromHeaders(new Headers({ "x-forwarded-for": " , , " }), 1), "untrusted-proxy");

// Invalid IP literals in the client position.
assert.equal(
  clientIpFromHeaders(new Headers({ "x-forwarded-for": "not-an-ip, 10.0.0.2" }), 2),
  "untrusted-proxy",
);
assert.equal(
  clientIpFromHeaders(new Headers({ "x-forwarded-for": "999.1.1.1, 10.0.0.2" }), 1),
  "untrusted-proxy",
);
assert.equal(
  clientIpFromHeaders(new Headers({ "x-forwarded-for": "2001:db8:::1, 10.0.0.2" }), 1),
  "untrusted-proxy",
);

// Valid IPv6 client literal is accepted.
assert.equal(
  clientIpFromHeaders(new Headers({ "x-forwarded-for": "2001:db8::1, 10.0.0.2" }), 1),
  "2001:db8::1",
);

// Different clients produce different rate-limit identities; the same client
// keeps one identity, and untrusted traffic stays in the shared bucket.
const alice = clientIpFromHeaders(new Headers({ "x-forwarded-for": "198.51.100.10, 127.0.0.1" }), 1);
const bob = clientIpFromHeaders(new Headers({ "x-forwarded-for": "198.51.100.11, 127.0.0.1" }), 1);
assert.notEqual(alice, bob);
assert.equal(alice, "198.51.100.10");
assert.equal(
  clientIpFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.50" }), 1),
  clientIpFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.99" }), 1),
  "spoofing headers must not escape the shared untrusted bucket",
);

console.log("TRUSTED_PROXY_IP_OK");
