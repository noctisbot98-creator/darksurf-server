const net = require('node:net');
const crypto = require('node:crypto');

function acceptWebSocket(server, { path = '/ssh-ws', targetPort = 2222 } = {}) {
  const handler = (req, client, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== path) { client.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers['upgrade']?.toLowerCase() !== 'websocket' || !String(req.headers.connection || '').toLowerCase().split(',').map((x) => x.trim()).includes('upgrade')) { client.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    client.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const upstream = net.createConnection({ host: '127.0.0.1', port: targetPort });
    let buffer = Buffer.alloc(0), dead = false, upstreamReady = false;
    const pending = [];
    const close = () => { if (dead) return; dead = true; client.destroy(); upstream.destroy(); };
    const forward = (payload) => { if (upstreamReady) upstream.write(payload); else pending.push(payload); };
    client.on('error', close); upstream.on('error', close); client.on('close', close); upstream.on('close', close);
    client.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const b0 = buffer[0], b1 = buffer[1], opcode = b0 & 15, masked = !!(b1 & 128);
        let len = b1 & 127, off = 2;
        if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buffer.length < 10) return; const n = buffer.readBigUInt64BE(2); if (n > 1_048_576n) return close(); len = Number(n); off = 10; }
        if (!masked) return close();
        if (buffer.length < off + 4 + len) return;
        const mask = buffer.subarray(off, off + 4); off += 4;
        const payload = Buffer.from(buffer.subarray(off, off + len)); buffer = buffer.subarray(off + len);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 8) return close();
        if (opcode === 9) { client.write(frame(10, payload)); continue; }
        if (opcode === 2 || opcode === 0) forward(payload);
      }
    });
    if (head?.length) client.emit('data', head);
    upstream.on('connect', () => {
      upstreamReady = true;
      while (pending.length && !dead) upstream.write(pending.shift());
    });
    upstream.on('data', (data) => { if (!dead) client.write(frame(2, data)); });
  };
  server.on('upgrade', handler);
  return () => server.off('upgrade', handler);
}
function frame(opcode, data) {
  const n = data.length; let h;
  if (n < 126) { h = Buffer.from([0x80 | opcode, n]); }
  else if (n <= 65535) { h = Buffer.alloc(4); h[0] = 0x80 | opcode; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, data]);
}
module.exports = { acceptWebSocket };
