import test from "node:test";
import assert from "node:assert/strict";
import {
  applySecurityHeaders,
  checkOrigin,
  createRateLimiter,
  isSameOrigin,
  clientIp,
  dashboardRequestOrigin,
} from "../lib/trade/http-security";

function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    statusCode: 200,
    headers,
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    end() {},
  };
}

test("applySecurityHeaders sets nosniff, frame deny and CSP", () => {
  const res = fakeRes();
  applySecurityHeaders(res, {});
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.match(res.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.doesNotMatch(res.headers["content-security-policy"], /unsafe-eval/);
});

test("allowUnsafeEval adds unsafe-eval only when explicitly requested", () => {
  const res = fakeRes();
  applySecurityHeaders(res, { allowUnsafeEval: true });
  assert.match(res.headers["content-security-policy"], /unsafe-eval/);
});

test("checkOrigin allows safe methods and enforces origin for mutating methods", () => {
  const allowed = "https://dashboard.example.com";
  assert.equal(checkOrigin({ method: "GET", headers: {} }, allowed).ok, true);
  assert.equal(checkOrigin({ method: "POST", headers: { origin: allowed } }, allowed).ok, true);
  assert.equal(checkOrigin({ method: "POST", headers: { referer: allowed + "/path" } }, allowed).ok, true);
  assert.equal(checkOrigin({ method: "POST", headers: { origin: "https://evil.example" } }, allowed).ok, false);
  assert.equal(checkOrigin({ method: "POST", headers: {} }, allowed).ok, false);
  assert.equal(checkOrigin({ method: "POST", headers: {} }, undefined).ok, true);
});

test("isSameOrigin normalizes trailing slashes and paths", () => {
  assert.equal(isSameOrigin({ headers: { origin: "https://a.example" } }, "https://a.example/"), true);
  assert.equal(isSameOrigin({ headers: { referer: "https://a.example/x/y" } }, "https://a.example"), true);
});

test("rate limiter blocks after the configured budget and resets", () => {
  const allow = createRateLimiter(2);
  const key = "1.2.3.4";
  assert.equal(allow(key, 0), true);
  assert.equal(allow(key, 0), true);
  assert.equal(allow(key, 0), false);
  assert.equal(allow(key, 60_001), true);
});

test("rate limiter with zero limit is a no-op", () => {
  const allow = createRateLimiter(0);
  for (let i = 0; i < 100; i++) assert.equal(allow("x", 0), true);
});

test("clientIp ignores spoofed forwarded headers and uses socket address", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" }, socket: { remoteAddress: "1.1.1.1" } }), "1.1.1.1");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "1.1.1.1" } }), "1.1.1.1");
  assert.equal(clientIp({ headers: {} }), "unknown");
});

test("local dashboard aliases preserve port and explicit origin restrictions", () => {
 for(const host of ["localhost:3001","127.0.0.1:3001","[::1]:3001"]){
  const allowed=dashboardRequestOrigin({headers:{host}},undefined,"127.0.0.1",3001);
  assert.equal(checkOrigin({method:"POST",headers:{origin:`http://${host}`}},allowed).ok,true);
  for(const origin of ["https://evil.example","http://localhost:3000"])assert.equal(checkOrigin({method:"POST",headers:{origin}},allowed).ok,false);
 }
 for(const host of ["evil.example:3001","localhost:3000","localhost:3001@evil.example","localhost:3001/path","localhost:3001?x=1"])
  assert.equal(dashboardRequestOrigin({headers:{host}},undefined,"127.0.0.1",3001),"http://127.0.0.1:3001");
 assert.equal(dashboardRequestOrigin({headers:{host:"localhost:3001"}},"https://configured.example","127.0.0.1",3001),"https://configured.example");
 assert.equal(dashboardRequestOrigin({headers:{host:"localhost:3001"}},undefined,"0.0.0.0",3001),"http://0.0.0.0:3001");
});

test("dashboard CSP stays self-only and does not allow external hosts", () => {
  const res = fakeRes();
  applySecurityHeaders(res, { allowUnsafeEval: true });
  assert.match(res.headers["content-security-policy"], /script-src 'self' 'unsafe-inline' 'unsafe-eval'/);
  assert.doesNotMatch(res.headers["content-security-policy"], /https:\/\//);
});
