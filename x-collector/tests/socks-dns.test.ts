import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { requestJSON } from '../lib/reply/proxy';

test('SOCKS5 sends the destination hostname to the proxy without local DNS', async () => {
  let destination = '';
  const server = net.createServer(socket => {
    let greeting = true;
    socket.on('data', data => {
      if (greeting) {
        greeting = false;
        socket.write(Buffer.from([5, 0]));
      } else {
        assert.equal(data[3], 3);
        destination = data.subarray(5, 5 + data[4]).toString();
        socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as net.AddressInfo).port;
    await assert.rejects(requestJSON(new URL('https://proxy-dns-test.invalid/'), {
      proxy: { server: `socks5://127.0.0.1:${port}` }, timeoutMs: 3000,
    }));
    assert.equal(destination, 'proxy-dns-test.invalid');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
