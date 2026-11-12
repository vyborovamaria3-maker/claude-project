"use strict";

const assert = require("node:assert/strict");
const { parseTrustedProxyHops, clientIpFromHeaders } = require("./client-ip.cjs");

assert.equal(parseTrustedProxyHops(undefined), 0);
assert.equal(parseTrustedProxyHops("2"), 2);
assert.throws(() => parseTrustedProxyHops("-1"), /non-negative/);
assert.throws(() => parseTrustedProxyHops("11"), /between 0 and 10/);

const spoofed = new Headers({ "x-real-ip": "203.0.113.99", "x-forwarded-for": "203.0.113.99" });
assert.equal(clientIpFromHeaders(spoofed, 0), "untrusted-proxy");
assert.equal(clientIpFromHeaders(new Headers({ "x-forwarded-for": "198.51.100.10, 10.0.0.2" }), 1), "198.51.100.10");
assert.equal(clientIpFromHeaders(new Headers({ "x-forwarded-for": "198.51.100.10, 10.0.0.2, 10.0.0.3" }), 2), "198.51.100.10");
assert.equal(clientIpFromHeaders(new Headers({ "x-forwarded-for": "not-an-ip, 10.0.0.2" }), 2), "untrusted-proxy");
assert.equal(clientIpFromHeaders(new Headers({ "x-forwarded-for": "10.0.0.2" }), 2), "untrusted-proxy");
console.log("TRUSTED_PROXY_IP_OK");
