// Couche réseau : Xray-core (VLESS + WebSocket, derrière Caddy en HTTPS sur le port 443).
// L'API de ce module est celle utilisée par le service :
//   addPeer(uid) / removePeer(uid) : autorise / retire un appareil (uid = UUID Xray de l'appareil)
//   transfer()   : octets cumulés (envoyés + reçus) par uid
//   listPeers()  : uid actuellement autorisés dans Xray
//   handshakes() : uid -> date (s) de la dernière activité de trafic (sert à « connecté / hors ligne »)
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Mode "dry" : tout en mémoire, pour les tests et le développement. */
class DryBackend {
  constructor() { this.peers = new Map(); this.counters = new Map(); this.hs = new Map(); }
  async addPeer(uid) { this.peers.set(uid, true); }
  async removePeer(uid) { this.peers.delete(uid); }
  async transfer() { return new Map(this.counters); }
  async listPeers() { return new Set(this.peers.keys()); }
  async handshakes() { return new Map(this.hs); }
}

/** Mode "real" : pilote le Xray local avec sa commande `xray api` (aucun redémarrage : les utilisateurs sont ajoutés/retirés à chaud). */
class XrayBackend {
  constructor({ bin = '/usr/local/bin/xray', api = '127.0.0.1:10085', tag = 'vless-ws', listen = '127.0.0.1', port = 10000, tcpPort = 0, realityPort = 0, kcpPort = 0, now = () => Math.floor(Date.now() / 1000) } = {}) {
    Object.assign(this, { bin, api, tag, listen, port, now });
    // Entrées où l'utilisateur est ajouté : WebSocket (derrière Caddy) + TCP direct optionnel (test / mode rapide).
    this.inbounds = [{ tag, listen, port }];
    if (Number(realityPort) > 0) this.inbounds.push({ tag: 'vless-reality', listen: '0.0.0.0', port: Number(realityPort), flow: 'xtls-rprx-vision' });
    if (Number(kcpPort) > 0) this.inbounds.push({ tag: 'vless-kcp', listen: '0.0.0.0', port: Number(kcpPort) });
    if (Number(tcpPort) > 0) this.inbounds.push({ tag: 'vless-tcp', listen: '0.0.0.0', port: Number(tcpPort) });
    this.known = new Set();          // utilisateurs ajoutés (repli si `inbounduser` n'existe pas sur cette version d'Xray)
    this.uptime = null;              // détecte un redémarrage d'Xray : ses utilisateurs dynamiques disparaissent
    this.last = new Map();           // uid -> dernier cumul vu
    this.active = new Map();         // uid -> date du dernier changement de compteur
  }

  run(args) {
    return new Promise((resolve, reject) =>
      execFile(this.bin, ['api', ...args], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) =>
        (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out)))));
  }

  /** Vérifie qu'Xray répond ; s'il a redémarré, oublie les utilisateurs (le service les ré-ajoute dans les secondes qui suivent). */
  async _health() {
    const j = JSON.parse(await this.run(['statssys', `--server=${this.api}`]));
    const up = Number(j.Uptime ?? j.uptime ?? 0);
    if (this.uptime !== null && up < this.uptime) this.known.clear();
    this.uptime = up;
  }

  async addPeer(uid) {
    if (this.known.has(uid)) return;
    const f = path.join(os.tmpdir(), `ds-adu-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify({ inbounds: this.inbounds.map((i) => ({ tag: i.tag, listen: i.listen, port: i.port, protocol: 'vless', settings: { decryption: 'none', clients: [i.flow ? { id: uid, email: uid, level: 0, flow: i.flow } : { id: uid, email: uid, level: 0 }] } })) }), { mode: 0o600 });
    try {
      // `xray api adu` répond code 0 même en cas d'échec : seul « Added N user(s) » prouve l'ajout.
      const out = await this.run(['adu', `--server=${this.api}`, f]);
      if (/already exists/i.test(out)) { this.known.add(uid); return; }
      const n = /Added\s+(\d+)\s+user/i.exec(out);
      if (!n || Number(n[1]) < 1) throw new Error('adu: ' + out.trim().split('\n').slice(-2).join(' | '));
      this.known.add(uid);
    } catch (e) {
      if (/already exists/i.test(e.message)) this.known.add(uid); else throw e;
    } finally { fs.rmSync(f, { force: true }); }
  }

  async removePeer(uid) {
    for (const i of this.inbounds) {
      try { await this.run(['rmu', `--server=${this.api}`, `-tag=${i.tag}`, uid]); }
      catch (e) { if (!/not found|not exist/i.test(e.message)) throw e; }
    }
    this.known.delete(uid);
  }

  async transfer() {
    await this._health();
    const j = JSON.parse(await this.run(['statsquery', `--server=${this.api}`, '-pattern=user>>>']) || '{}');
    const m = new Map(), t = this.now();
    for (const s of j.stat || []) {
      const x = /^user>>>([^>]+)>>>traffic>>>(uplink|downlink)$/.exec(s.name || '');
      if (x) m.set(x[1], (m.get(x[1]) || 0) + Number(s.value || 0));
    }
    for (const [uid, v] of m) {
      if (v !== this.last.get(uid)) this.active.set(uid, t);
      this.last.set(uid, v);
    }
    return m;
  }

  async listPeers() {
    try {
      const j = JSON.parse(await this.run(['inbounduser', `--server=${this.api}`, `-tag=${this.tag}`]) || '{}');
      const set = new Set((j.users || []).map((u) => u.email).filter(Boolean));
      this.known = new Set(set);
      return set;
    } catch { return new Set(this.known); }        // version d'Xray sans `inbounduser` : on se fie à notre suivi
  }

  async handshakes() { return new Map(this.active); }
}

const makeBackend = (cfg) => (cfg.mode === 'real' ? new XrayBackend(cfg) : new DryBackend());

module.exports = { DryBackend, XrayBackend, makeBackend };
