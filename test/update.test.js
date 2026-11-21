const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot, post } = require('./helpers');
const { run } = require('../src/admin');

const fakeApk = (seed) => Buffer.concat([Buffer.from('PK\x03\x04'), crypto.createHash('sha256').update(seed).digest(), Buffer.alloc(4000, seed.length)]);

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsrel-'));
  const t = await boot({ releasesDir: dir });
  const publish = (code, name, extra = [], seed = 'v' + code) => {
    const f = path.join(dir, `src-${code}.apk`); fs.writeFileSync(f, fakeApk(seed));
    return run(['publish-release', f, '--version-code', String(code), '--version-name', name, ...extra], t.app.db, { releasesDir: dir });
  };
  return { t, dir, publish };
}

test('mise à jour : aucune version publiée / client à jour → update:false', async () => {
  const { t, publish } = await setup();
  try {
    assert.deepEqual((await post(t.base, 'app/android', { version_code: 1 }))[1], { update: false });
    publish(2, '1.1.0');
    assert.deepEqual((await post(t.base, 'app/android', { version_code: 2 }))[1], { update: false });
    assert.deepEqual((await post(t.base, 'app/android', { version_code: 9 }))[1], { update: false });
    assert.equal((await post(t.base, 'app/android', { version_code: 'x' }))[0], 400);
  } finally { await t.close(); }
});

test('mise à jour : annonce la dernière version, SHA-256 et fichier téléchargeable identiques', async () => {
  const { t, publish, dir } = await setup();
  try {
    publish(2, '1.1.0'); publish(3, '1.2.0', ['--notes', 'Correctifs']);
    const [s, r] = await post(t.base, 'app/android', { version_code: 1 });
    assert.equal(s, 200); assert.equal(r.update, true); assert.equal(r.version_code, 3); assert.equal(r.version_name, '1.2.0');
    assert.equal(r.notes, 'Correctifs'); assert.equal(r.required, false); assert.equal('file' in r, false);
    assert.match(r.url, /\/downloads\/darksurf-3\.apk$/);

    const dl = await fetch(t.base + new URL(r.url).pathname);
    assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'application/vnd.android.package-archive');
    const body = Buffer.from(await dl.arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(body).digest('hex'), r.sha256);
    assert.equal(body.length, r.size);
    assert.deepEqual(body, fs.readFileSync(path.join(dir, 'darksurf-3.apk')));
  } finally { await t.close(); }
});

test('mise à jour obligatoire : --required et --min-code', async () => {
  const { t, publish } = await setup();
  try {
    publish(5, '2.0.0', ['--min-code', '3']);
    assert.equal((await post(t.base, 'app/android', { version_code: 2 }))[1].required, true);    // < min
    assert.equal((await post(t.base, 'app/android', { version_code: 4 }))[1].required, false);   // ≥ min
    publish(6, '2.1.0', ['--required']);
    assert.equal((await post(t.base, 'app/android', { version_code: 5 }))[1].required, true);
  } finally { await t.close(); }
});

test('téléchargement : pas de traversée de chemin, version retirée introuvable, PUBLIC_URL respectée', async () => {
  const { t, publish } = await setup();
  try {
    publish(2, '1.1.0');
    // http.get n'normalise pas le chemin (fetch/URL transformerait « .. » avant l'envoi)
    const raw = (p) => new Promise((ok) => require('http').get({ host: '127.0.0.1', port: new URL(t.base).port, path: p }, (r) => { r.resume(); ok(r.statusCode); }));
    assert.ok([303, 404].includes(await raw('/downloads/../data/darksurf.db')));   // normalisé par le serveur → portail → /login, jamais le fichier
    assert.equal(await raw('/downloads/..%2f..%2fetc%2fpasswd'), 404);
    for (const p of [ '/downloads/%2e%2e%2fsecret', '/downloads/darksurf-9.apk', '/downloads/darksurf-2.apk.bak', '/downloads/']) {
      assert.equal((await fetch(t.base + p)).status, 404, p);
    }
    assert.equal((await fetch(t.base + '/downloads/darksurf-2.apk')).status, 200);
    t.app.cfg.publicUrl = 'https://api.example.com';
    assert.equal((await post(t.base, 'app/android', { version_code: 1 }))[1].url, 'https://api.example.com/downloads/darksurf-2.apk');
    run(['deactivate-release', '2'], t.app.db);
    assert.equal((await fetch(t.base + '/downloads/darksurf-2.apk')).status, 404);
    assert.deepEqual((await post(t.base, 'app/android', { version_code: 1 }))[1], { update: false });
  } finally { await t.close(); }
});

test('publish-release : refuse un faux APK, une version en double, un nom invalide', async () => {
  const { t, dir, publish } = await setup();
  try {
    const txt = path.join(dir, 'x.apk'); fs.writeFileSync(txt, 'pas un apk'.repeat(200));
    assert.throws(() => run(['publish-release', txt, '--version-code', '1', '--version-name', '1.0'], t.app.db, { releasesDir: dir }), /APK/);
    assert.throws(() => run(['publish-release', '/nexiste/pas.apk', '--version-code', '1', '--version-name', '1.0'], t.app.db, { releasesDir: dir }));
    publish(2, '1.0.0');
    assert.throws(() => publish(2, '1.0.1'), /UNIQUE/);
    assert.throws(() => publish(3, '../../etc'));
    assert.match(run(['list-releases'], t.app.db), /code 2 — 1\.0\.0/);
  } finally { await t.close(); }
});
