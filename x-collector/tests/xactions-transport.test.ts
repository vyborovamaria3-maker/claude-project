import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { createSocks5Fetch } from "../src/xactions/transport";

// Local SOCKS fixture only: no external connections or X quota consumption.
async function fixture(t: test.TestContext, handler: http.RequestListener) {
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  };
  const server = http.createServer(handler);
  server.on("connection", track);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const proxy = net.createServer(socket => {
    track(socket);
    socket.once("data", () => {
      socket.write(Buffer.from([5, 0]));
      socket.once("data", () => {
        const destination = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1", () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          socket.pipe(destination);
          destination.pipe(socket);
        });
        track(destination);
        socket.on("close", () => destination.destroy());
      });
    });
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise<void>(resolve => proxy.close(() => resolve())),
      new Promise<void>(resolve => server.close(() => resolve())),
    ]);
  });
  return {
    proxy: { server: `socks5h://127.0.0.1:${(proxy.address() as net.AddressInfo).port}` },
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
  };
}

test("HTTP deadline aborts continuously trickling responses", async t => {
  let completed = false;
  let chunks = 0;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"ok":true}');
    const interval = setInterval(() => { chunks++; res.write(" "); }, 10);
    const end = setTimeout(() => { completed = true; res.end(); }, 2000);
    res.on("close", () => { clearInterval(interval); clearTimeout(end); });
  });
  await assert.rejects(createSocks5Fetch(f.proxy, { timeoutMs: 250 })(f.url), /timed out/);
  assert.ok(chunks > 0, "response must send data below the idle timeout");
  assert.equal(completed, false, "deadline must reject before the response finishes");
});

test("HTTP transport completes normal responses and honors cancellation", async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === "/wait") return;
    res.end('{"ok":true}');
  });
  const fetch = createSocks5Fetch(f.proxy, { timeoutMs: 1000 });
  assert.deepEqual(await (await fetch(f.url)).json(), { ok: true });
  const controller = new AbortController();
  const request = fetch(`${f.url}/wait`, { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, (error: unknown) => error instanceof Error && error.name === "AbortError");
});
