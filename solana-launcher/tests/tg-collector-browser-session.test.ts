import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserSession, validBrowserSession, localAutoConnectAllowed, browserRequestOrigin, TG_SESSION_SECONDS } from "../lib/tgCollectorBrowserSession.ts";
const secret="local-browser-session-fixture-key";
const origin="http://127.0.0.1:3100";

test("automatic connection requires explicit loopback origin and development mode", () => {
  assert.equal(localAutoConnectAllowed("1", origin, origin, false), true);
  assert.equal(localAutoConnectAllowed(undefined, origin, origin, false), false);
  assert.equal(localAutoConnectAllowed("1", origin, origin, true), false);
  assert.equal(localAutoConnectAllowed("1", origin, "http://127.0.0.1:3000", false), false);
  assert.equal(localAutoConnectAllowed("1", "https://evil.invalid", "https://evil.invalid", false), false);
  assert.equal(localAutoConnectAllowed("1", origin + "/path", origin, false), false);
});

test("browser session is signed, origin-bound and expires", () => {
  const now=1000000;
  const cookie=createBrowserSession(secret,origin,now);
  assert.equal(validBrowserSession(cookie,secret,origin,now),true);
  assert.equal(validBrowserSession(cookie,secret,"http://localhost:3100",now),false);
  assert.equal(validBrowserSession(cookie,secret+"wrong",origin,now),false);
  assert.equal(validBrowserSession(cookie,secret,origin,now+TG_SESSION_SECONDS*1000),false);
  const [body,signature]=cookie.split(".");
  assert.equal(validBrowserSession(body+"A."+signature,secret,origin,now),false);
  assert.equal(validBrowserSession(cookie+".extra",secret,origin,now),false);
  assert.equal(cookie.includes(secret),false);
});

test("browser origin normalization preserves the external host and port", () => {
  assert.equal(browserRequestOrigin("http:","127.0.0.1:3100"),origin);
  assert.equal(browserRequestOrigin("http:","localhost:80"),"http://localhost");
  assert.equal(browserRequestOrigin("http:",""),"");
});
