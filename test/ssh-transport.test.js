const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { acceptWebSocket } = require('../src/ssh-transport');

function maskedFrame(data) {
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const h = Buffer.from([0x82, 0x80 | data.length]);
  const body = Buffer.from(data);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat([h, mask, body]);
}

test('SSH-WS : handshake RFC6455 et relais binaire vers le port SSH', async () => {
  const echoSockets = new Set();
  const echo = net.createServer((s) => { echoSockets.add(s); s.on('close', () => echoSockets.delete(s)); s.pipe(s); });
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const gatewaySockets = new Set();
  const gateway = http.createServer((_q, res) => { res.writeHead(404); res.end(); });
  gateway.on('connection', (s) => { gatewaySockets.add(s); s.on('close', () => gatewaySockets.delete(s)); });
  const detach = acceptWebSocket(gateway, { path: '/ws-ssh', targetPort: echo.address().port });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const socket = net.connect(gateway.address().port, '127.0.0.1');
  try {
    const key = crypto.randomBytes(16).toString('base64');
    const response = await new Promise((resolve, reject) => {
      let data = '';
      socket.once('error', reject);
      socket.on('data', (chunk) => {
        data += chunk.toString('latin1');
        if (data.includes('\r\n\r\n')) resolve(data);
      });
      socket.write(`GET /ws-ssh HTTP/1.1\r\nHost: d2m44uilhgzazi.cloudfront.net\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
    assert.ok(response.includes('Sec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')));
    const received = new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      const timeout = setTimeout(() => reject(new Error('websocket_echo_timeout')), 2000);
      socket.on('data', (chunk) => {
        chunks.push(chunk); size += chunk.length;
        if (size >= 7) { clearTimeout(timeout); resolve(Buffer.concat(chunks)); }
      });
    });
    socket.write(maskedFrame(Buffer.from('SSH-OK')));
    const frame = await received;
    assert.equal(frame[0] & 0x0f, 2);
    assert.equal(frame.subarray(2, 8).toString(), 'SSH-OK');
  } finally {
    detach(); socket.destroy();
    for (const s of gatewaySockets) s.destroy();
    for (const s of echoSockets) s.destroy();
    await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => gateway.close(r));
    for (const s of echoSockets) s.destroy();
    await new Promise((r) => echo.close(r));
  }
});
