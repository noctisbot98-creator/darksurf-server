const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { XrayBackend } = require('../src/core');

// Faux binaire `xray` : journalise les commandes et répond comme le vrai (JSON), pour tester l'analyse des sorties.
function fakeXray(dir) {
  const bin = path.join(dir, 'xray'), log = path.join(dir, 'calls.log'), up = path.join(dir, 'uptime');
  fs.writeFileSync(up, '1000');
  fs.writeFileSync(bin, `#!/usr/bin/env bash
echo "$@" >> "${log}"
case "$2" in
  statssys) echo "{\\"Uptime\\": $(cat "${up}")}" ;;
  statsquery) cat "${dir}/stats.json" 2>/dev/null || echo '{}' ;;
  inbounduser) if [ -f "${dir}/no-inbounduser" ]; then echo "unknown command" >&2; exit 1; fi; cat "${dir}/users.json" 2>/dev/null || echo '{}' ;;
  adu) f="\${@: -1}"; cp "$f" "${dir}/last-adu.json"; [ -f "${dir}/exists" ] && { echo "already exists" >&2; exit 1; }; echo "Added 1 user(s) in total."; exit 0 ;;
  rmu) [ -f "${dir}/missing" ] && { echo "user not found" >&2; exit 1; }; exit 0 ;;
esac
`, { mode: 0o755 });
  return { bin, log, up };
}

test('Xray : ajout à chaud (fichier adu), retrait, consommation, activité, redémarrage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-xray-'));
  const { bin, log, up } = fakeXray(dir);
  let now = 5000;
  const x = new XrayBackend({ bin, api: '127.0.0.1:10085', tag: 'vless-ws', now: () => now });
  const uid = '11111111-2222-3333-4444-555555555555';

  await x.addPeer(uid);
  const adu = JSON.parse(fs.readFileSync(path.join(dir, 'last-adu.json'), 'utf8'));
  assert.equal(adu.inbounds[0].tag, 'vless-ws'); assert.equal(adu.inbounds[0].settings.clients[0].id, uid); assert.equal(adu.inbounds[0].settings.clients[0].email, uid);
  await x.addPeer(uid);                                                   // déjà connu : aucun 2e appel
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter((l) => /^api adu/.test(l)).length, 1);

  // consommation = envoi + réception ; « actif » = compteur qui bouge
  fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({ stat: [
    { name: `user>>>${uid}>>>traffic>>>uplink`, value: '300' }, { name: `user>>>${uid}>>>traffic>>>downlink`, value: 1200 }, { name: 'inbound>>>x>>>traffic>>>uplink', value: 9 }] }));
  let t = await x.transfer();
  assert.equal(t.get(uid), 1500); assert.equal(t.size, 1);
  assert.equal((await x.handshakes()).get(uid), 5000);
  now = 5100; await x.transfer(); assert.equal((await x.handshakes()).get(uid), 5000);     // pas de trafic : l'activité reste ancienne
  fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({ stat: [{ name: `user>>>${uid}>>>traffic>>>uplink`, value: '400' }, { name: `user>>>${uid}>>>traffic>>>downlink`, value: 1200 }] }));
  now = 5200; await x.transfer(); assert.equal((await x.handshakes()).get(uid), 5200);

  // liste des utilisateurs : `inbounduser` si disponible, sinon notre suivi
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ users: [{ email: uid, level: 0 }] }));
  assert.deepEqual([...await x.listPeers()], [uid]);
  fs.writeFileSync(path.join(dir, 'no-inbounduser'), '');
  assert.deepEqual([...await x.listPeers()], [uid]);

  // Xray redémarre (uptime qui repart de zéro) : les utilisateurs dynamiques sont perdus, on les ré-ajoutera
  fs.writeFileSync(up, '3');
  await x.transfer();
  assert.deepEqual([...await x.listPeers()], []);
  await x.addPeer(uid);
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter((l) => /^api adu/.test(l)).length, 2);

  // retrait (y compris si l'utilisateur n'existe déjà plus) ; « already exists » toléré
  await x.removePeer(uid);
  assert.match(fs.readFileSync(log, 'utf8'), /rmu --server=127\.0\.0\.1:10085 -tag=vless-ws 11111111/);
  fs.writeFileSync(path.join(dir, 'missing'), ''); await x.removePeer(uid);
  fs.writeFileSync(path.join(dir, 'exists'), ''); await x.addPeer(uid); assert.ok(x.known.has(uid));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Xray : erreurs de commande remontées (le service réessaie au passage suivant)', async () => {
  const x = new XrayBackend({ bin: '/nonexistent/xray' });
  await assert.rejects(x.transfer());
  await assert.rejects(x.addPeer('aaaaaaaa-0000-0000-0000-000000000000'));
});

test('Xray : avec un port TCP direct, l\'utilisateur est ajouté aux deux entrées', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-xray-'));
  const { bin, log } = fakeXray(dir);
  const x = new XrayBackend({ bin, tcpPort: 10050 });
  await x.addPeer('uuid-1');
  const sent = JSON.parse(fs.readFileSync(path.join(dir, 'last-adu.json'), 'utf8'));
  assert.deepEqual(sent.inbounds.map((i) => [i.tag, i.port]), [['vless-ws', 10000], ['vless-tcp', 10050]]);
  await x.removePeer('uuid-1');
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('rmu')).length, 2);
});

test('Xray : REALITY ajoute l\'utilisateur avec le flux Vision', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-xray-'));
  const { bin } = fakeXray(dir);
  const x = new XrayBackend({ bin, realityPort: 8443 });
  await x.addPeer('uuid-2');
  const sent = JSON.parse(fs.readFileSync(path.join(dir, 'last-adu.json'), 'utf8'));
  const r = sent.inbounds.find((i) => i.tag === 'vless-reality');
  assert.equal(r.port, 8443);
  assert.equal(r.settings.clients[0].flow, 'xtls-rprx-vision');
  assert.equal(sent.inbounds.find((i) => i.tag === 'vless-ws').settings.clients[0].flow, undefined);
});

test('Xray : le mode UDP (mKCP) ajoute l\'utilisateur à son entrée', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-xray-'));
  const { bin } = fakeXray(dir);
  const x = new XrayBackend({ bin, kcpPort: 4443 });
  await x.addPeer('uuid-3');
  const sent = JSON.parse(fs.readFileSync(path.join(dir, 'last-adu.json'), 'utf8'));
  assert.equal(sent.inbounds.find((i) => i.tag === 'vless-kcp').port, 4443);
});
