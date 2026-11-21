const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, fakeDevice, enroll, session } = require('./helpers');

test('session : renvoie les paramètres SSH-WS et SSH-TCP liés à un appareil', async () => {
  const t = await boot({ core: { host: 'vpn.example.test', serverIp: '15.235.111.58' }, ssh: { enabled: true, secret: 'a'.repeat(64), hostKey: 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFakeTestKey', tcpPort: 2222, wsPath: '/ssh-ws' } });
  try {
    // En test, on remplace seulement le helper système sudo/useradd ; l'API et la génération des identifiants restent réelles.
    t.app.service.setSshAccount = async () => {};
    const plan = t.addPlan({ quota: null }); const seller = t.addReseller('ssh-seller');
    const { codes } = t.app.service.generateCodes(seller, plan, 1, null);
    const device = fakeDevice(); const [, enrolled] = await enroll(t.base, codes[0], device);
    const [status, body] = await session(t.base, enrolled.device_id, device);
    assert.equal(status, 200);
    assert.equal(body.profile.protocol, 'ssh-ws');
    assert.equal(body.profile.ssh.host, '15.235.111.58');
    assert.equal(body.profile.ssh.ws_host, 'd2m44uilhgzazi.cloudfront.net');
    assert.equal(body.profile.ssh.tcp_port, 2222);
    assert.equal(body.profile.ssh.ws_port, 2084);
    assert.equal(body.profile.ssh.ws_path, '/ssh-ws');
    assert.equal(body.profile.ssh.ws_host, 'd2m44uilhgzazi.cloudfront.net');
    assert.equal(body.profile.ssh.ws_tls, false);
    assert.match(body.profile.ssh.payload, /^GET \/ssh-ws HTTP\/1.1\[crlf\]Host:/);
    assert.match(body.profile.ssh.username, /^ds[0-9a-f]{20}$/);
    assert.equal(body.profile.ssh.password.length, 32);
    assert.match(body.profile.ssh.host_key, /^ecdsa-sha2-nistp256 /);
    assert.notEqual(body.profile.ssh.username, t.app.service.sshCredentials('another-device').username);
  } finally { await t.close(); }
});

test('session : le serveur impose l\'ordre des connexions (aucun choix côté client)', async () => {
  const t = await boot({ protocols: { vless: true, ssh: true, default: 'ssh-ws' }, ssh: { enabled: true, secret: 'p'.repeat(64), hostKey: 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFakeTestKey', tcpPort: 2222, wsPath: '/ssh-ws' } });
  try {
    t.app.service.setSshAccount = async () => {};
    const plan = t.addPlan({ quota: null }); const seller = t.addReseller('ssh-order');
    const { codes } = t.app.service.generateCodes(seller, plan, 1, null);
    const device = fakeDevice(); const [, enrolled] = await enroll(t.base, codes[0], device);
    const [status, body] = await session(t.base, enrolled.device_id, device);
    assert.equal(status, 200);
    assert.equal(body.profile.protocol, 'ssh-ws');
    assert.equal(body.profile.ssh.tcp_port, 2222);
    assert.equal(body.profile.ssh.payload_port, undefined);
    assert.match(body.profile.ssh.payload, /^GET \/ssh-ws HTTP\/1.1\[crlf\]Host:/);
    const ids = body.attempts.map((x) => x.id);
    assert.equal(ids[0], 'ssh-ws');                       // le protocole choisi par l'admin passe en premier
    assert.ok(ids.includes('vless-ws') && ids.includes('ssh-tcp'));
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(body.attempts.find((x) => x.id === 'vless-ws').kind, 'xray');
    assert.equal(body.attempts.find((x) => x.id === 'vless-ws').outbound.protocol, 'vless');
  } finally { await t.close(); }
});

test('session : VLESS désactivé par l\'admin -> aucune tentative VLESS', async () => {
  const t = await boot({ protocols: { vless: false, ssh: true, default: 'ssh-tcp' }, ssh: { enabled: true, secret: 'q'.repeat(64), hostKey: 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFakeTestKey', tcpPort: 2222, wsPath: '/ssh-ws' } });
  try {
    t.app.service.setSshAccount = async () => {};
    const plan = t.addPlan({ quota: null }); const seller = t.addReseller('ssh-novless');
    const { codes } = t.app.service.generateCodes(seller, plan, 1, null);
    const device = fakeDevice(); const [, enrolled] = await enroll(t.base, codes[0], device);
    const [, body] = await session(t.base, enrolled.device_id, device);
    assert.deepEqual(body.attempts.map((x) => x.id), ['ssh-tcp', 'ssh-ws']);
  } finally { await t.close(); }
});

test('SSH : le trafic des comptes SSH est compté dans le forfait, et la coupure retire le compte', async () => {
  const t = await boot({ ssh: { enabled: true, secret: 'b'.repeat(64), hostKey: 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFakeTestKey', tcpPort: 2222, wsPath: '/ssh-ws' } });
  try {
    const calls = [];
    t.app.service.setSshAccount = async (id, on) => { calls.push([id, on]); };
    let total = 0;
    t.app.service.sshUsage = async () => { const m = new Map(); const c = t.app.service.sshCredentials(calls[0] ? calls[0][0] : 'x'); if (c) m.set(c.username, total); return m; };
    const plan = t.addPlan({ quota: 1000 }); const seller = t.addReseller('ssh-meter');
    const { codes } = t.app.service.generateCodes(seller, plan, 1, null);
    const device = fakeDevice(); const [, enrolled] = await enroll(t.base, codes[0], device);
    await session(t.base, enrolled.device_id, device);
    await t.app.service.enforce();
    assert.deepEqual(calls.at(-1), [enrolled.device_id, true]);
    total = 400; await t.app.service.enforce();
    assert.equal(t.q('SELECT used_bytes FROM devices').all()[0].used_bytes, 400);
    total = 1500; await t.app.service.enforce();                       // dépasse le quota : le compte est coupé
    assert.equal(t.q('SELECT used_bytes FROM devices').all()[0].used_bytes, 1500);
    assert.deepEqual(calls.at(-1), [enrolled.device_id, false]);
  } finally { await t.close(); }
});

test('SSH : lecture du compteur du pare-feu (nom octets), lignes invalides ignorées', async () => {
  const t = await boot({ ssh: { enabled: true, secret: 'c'.repeat(64), hostKey: 'ecdsa-sha2-nistp256 AAAA', tcpPort: 2222, wsPath: '/ssh-ws' } });
  try {
    t.app.service._sudoSsh = async () => 'ds0123456789abcdef0123 1500\nbruit\nds0123456789abcdef0123 500\nroot 9\n';
    const m = await t.app.service.sshUsage();
    assert.equal(m.get('ds0123456789abcdef0123'), 2000);
    assert.equal(m.size, 1);
  } finally { await t.close(); }
});

test('session et statut : le nom saisi par le vendeur sur la clé est renvoyé au client', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ quota: null }); const seller = t.addReseller('nom-vendeur');
    const { codes } = t.app.service.generateCodes(seller, plan, 1, 'Jean Mballa');
    const device = fakeDevice(); const [, enrolled] = await enroll(t.base, codes[0], device);
    const [status, body] = await session(t.base, enrolled.device_id, device);
    assert.equal(status, 200);
    assert.equal(body.plan.client_name, 'Jean Mballa');
  } finally { await t.close(); }
});

test('fiche SSH : activation par le vendeur, durée démarrée, trafic compté, coupure au quota, 1 appareil', async () => {
  const t = await boot({ ssh: { enabled: true, secret: 'c'.repeat(64), hostKey: 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFakeTestKey', tcpPort: 2222, wsPath: '/ssh-ws' } });
  try {
    const svc = t.app.service, helper = [];
    svc._sudoSsh = async (args) => { helper.push(args.join(' ')); return ''; };
    const plan = t.addPlan({ quota: 1000 }); const seller = t.addReseller('ssh-fiche');
    const { codes } = svc.generateCodes(seller, plan, 1, 'Client Paul');
    assert.equal(t.q('SELECT activated_at FROM codes').all()[0].activated_at, null);
    const fiche = await svc.activateSshKey(seller, codes[0]);
    assert.match(fiche.username, /^dk[0-9a-f]{20}$/);
    assert.ok(fiche.password.length >= 24 && fiche.tcp_port === 2222 && fiche.ws_path === '/ssh-ws');
    assert.equal(svc.sshFiche(codes[0]).username, fiche.username);          // stable : se déduit de la clé
    assert.equal(svc.sshFiche(codes[0]).udpgw_port, null);
    svc.cfg.modules = { udpgw: { enabled: true, port: 7300 }, stunnel: { enabled: true, port: 4444 }, dropbear: { enabled: false, port: 2200 } };
    const f2 = svc.sshFiche(codes[0]);
    assert.deepEqual([f2.udpgw_port, f2.tls_ssh_port, f2.dropbear_port], [7300, 4444, null]);
    assert.ok(t.q('SELECT activated_at, expires_at, ssh_active FROM codes').all()[0].ssh_active === 1);
    assert.ok(t.q('SELECT expires_at FROM codes').all()[0].expires_at > 0);
    assert.ok(helper.some((h) => h.startsWith('ensure ' + fiche.username)));
    // trafic compté dans le forfait, puis coupure au quota
    let total = 300, sessions = 1;
    svc.sshUsage = async () => new Map([[fiche.username, total]]);
    svc.sshSessions = async () => new Map([[fiche.username, sessions]]);
    await svc.enforce();
    assert.equal(t.q('SELECT ssh_used FROM codes').all()[0].ssh_used, 300);
    assert.equal(svc.getCode(seller, codes[0]).used, 300);
    sessions = 2; await svc.enforce();                                       // 2 connexions pour 1 appareil : tout est coupé
    assert.ok(helper.includes('drop ' + fiche.username));
    sessions = 1; total = 1200; await svc.enforce();
    assert.ok(helper.at(-1).startsWith('disable ' + fiche.username));        // quota dépassé : compte désactivé
    // un autre vendeur ne peut pas lire la fiche de cette clé
    const other = t.addReseller('autre');
    await assert.rejects(() => svc.activateSshKey(other, codes[0]), (e) => e.status === 404);
  } finally { await t.close(); }
});
