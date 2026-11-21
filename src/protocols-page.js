// Page « Protocoles VPN » du panel administrateur.
// Rend le registre des protocoles, leur état réel, leur configuration,
// et les liens d'import V2Box + QR codes par appareil.
const P = require('./protocols');
const QR = require('./qr');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PAGE_CSS = `
.pg{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}
.pcard{background:var(--s);border:1px solid var(--line);border-radius:18px;padding:16px;display:flex;flex-direction:column;gap:10px;position:relative;overflow:hidden}
.pcard.on{border-color:var(--g);box-shadow:0 0 0 1px rgba(43,255,136,.25)}
.pcard.err{border-color:var(--d)}
.pcard .hd{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}
.pcard .hd h3{font-size:15px;line-height:1.25;flex:1 1 100%;margin:0 0 2px}
.pill{font:700 10px ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;padding:3px 8px;border-radius:999px;white-space:nowrap}
.pill.on{background:rgba(43,255,136,.14);color:var(--g);border:1px solid rgba(43,255,136,.4)}
.pill.off{background:rgba(127,156,137,.12);color:var(--m);border:1px solid var(--line)}
.pill.err{background:rgba(255,107,107,.14);color:var(--d);border:1px solid rgba(255,107,107,.4)}
.pill.eng{background:var(--s2);color:var(--m);border:1px solid var(--line)}
.pill.ok2{background:rgba(43,255,136,.10);color:var(--g);border:1px solid rgba(43,255,136,.3)}
.pill.warn{background:rgba(255,196,84,.12);color:var(--y);border:1px solid rgba(255,196,84,.4)}
.pcard p.desc{margin:0;font-size:12.5px;color:var(--m);line-height:1.5}
.pcard .meta{display:flex;flex-wrap:wrap;gap:6px;font:600 10.5px ui-monospace,monospace;color:var(--m)}
.pcard .meta span{background:var(--s2);border:1px solid var(--line);border-radius:6px;padding:2px 6px}
.pcard .note{font-size:11.5px;color:var(--y);opacity:.85;margin:0}
.pcard .cfg{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.pcard .cfg label{margin:0;font:700 10px ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--m)}
.pcard .cfg input,.pcard .cfg select{padding:8px 10px;font-size:13px;border-radius:9px}
.pcard .cfg .wide{grid-column:1/-1}
.sw{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--t);cursor:pointer;user-select:none}
.sw input{width:auto;margin:0}
.lnk{background:var(--s2);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font:600 10.5px ui-monospace,monospace;word-break:break-all;color:var(--m);max-height:74px;overflow:auto;-webkit-user-select:all;user-select:all}
.qrbox{display:flex;gap:12px;align-items:center}
.qrbox svg{border-radius:8px;flex:none}
.devbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 14px}
.devbar select{max-width:340px}
.stat{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:0 0 14px}
.stat div{background:var(--s2);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.stat b{display:block;font:700 20px ui-monospace,monospace;color:var(--g)}
.stat small{color:var(--m);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}
.tabs a{font:700 11px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;padding:6px 10px;border-radius:8px;border:1px solid var(--line);color:var(--m);text-decoration:none}
.tabs a.on{background:var(--s2);color:var(--g);border-color:var(--g)}
details.adv{border-top:1px solid var(--line);padding-top:8px}
details.adv summary{cursor:pointer;font:700 10.5px ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--m)}
`;

function card(p, s, st) {
  const on = !!s.enabled;
  const cls = on ? (st && st.ok ? 'on' : 'err') : '';
  const pill = on
    ? (st && st.ok ? '<span class="pill on">Actif</span>' : '<span class="pill err">Erreur</span>')
    : '<span class="pill off">Inactif</span>';
  // V2Box ne sait pas importer tous les protocoles : on le dit sur la carte.
  const v2 = p.v2box === false
    ? '<span class="pill warn" title="Absent de la liste officielle de V2Box">V2Box ✗</span>'
    : '<span class="pill ok2" title="Importable dans V2Box">V2Box ✓</span>';
  const port = Number(s.port) || p.defaultPort;
  const listen = st && st.listening ? `écoute ${st.process || ''}`.trim() : (p.viaProxy ? 'via Caddy' : 'aucun écouteur');

  const fields = [];
  if (p.params.includes('path')) fields.push(`<label class="wide">Chemin WebSocket<input name="p_${p.id}_path" value="${esc(s.path || '')}" pattern="/[A-Za-z0-9/_-]{1,100}" required></label>`);
  if (p.params.includes('sni')) fields.push(`<label class="wide">SNI / domaine imité<input name="p_${p.id}_sni" value="${esc(s.sni || '')}" pattern="[A-Za-z0-9.-]{1,253}" required></label>`);
  if (p.params.includes('seed')) fields.push(`<label class="wide">Graine mKCP<input name="p_${p.id}_seed" value="${esc(s.seed || '')}" pattern="[A-Za-z0-9]{1,64}" required></label>`);
  if (p.params.includes('method')) fields.push(`<label class="wide">Chiffrement<select name="p_${p.id}_method">${['2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', 'aes-256-gcm', 'chacha20-poly1305'].map((m) => `<option value="${m}" ${s.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>`);

  return `<div class="pcard ${cls}">
  <div class="hd"><h3>${esc(p.label)}</h3>${v2}${pill}</div>
  <p class="desc">${esc(p.summary)}</p>
  <div class="meta"><span>${esc(p.engine)}</span><span>${esc(p.transport)}</span><span>${esc(p.security)}</span><span>${esc(listen)}</span></div>
  <label class="sw"><input type="checkbox" name="p_${p.id}_enabled" value="1" ${on ? 'checked' : ''}> Activer ce protocole</label>
  <div class="cfg">
    <label>Port<input type="number" name="p_${p.id}_port" value="${port}" min="${p.viaProxy ? 443 : 1024}" max="65535" required></label>
    <label>Famille<input value="${esc(p.family)}" disabled></label>
    ${fields.join('')}
  </div>
  <p class="note">${esc(p.note)}</p>
</div>`;
}

function linkBlock(p, link, qr) {
  if (!link) return '';
  return `<div class="pcard on" style="grid-column:1/-1">
  <div class="hd"><h3>${esc(p.label)}</h3><span class="pill on">Lien prêt</span></div>
  <div class="qrbox">${qr}<div style="flex:1;min-width:0">
    <div class="lnk">${esc(link)}</div>
    <p style="margin:8px 0 0"><button class="btn ghost sm" type="button" data-copy="${esc(link)}">Copier le lien</button></p>
  </div></div></div>`;
}

/**
 * @param {object} o
 *  nonce, session, settings, statuses, devices, selectedDevice, links, flashKey, engines
 */
function protocolsPage(o) {
  const { nonce, session, settings, statuses, devices, selectedDevice, links, flashKey, engines } = o;
  const st = new Map((statuses || []).map((x) => [x.id, x]));
  const active = (statuses || []).filter((x) => x.enabled).length;
  const healthy = (statuses || []).filter((x) => x.ok).length;

  const flash = flashKey === 'applied'
    ? '<div class="flash">Configuration appliquée et validée par les moteurs.</div>'
    : flashKey === 'apply_failed'
      ? '<div class="flash err">Application refusée : la configuration a été rejetée par le moteur. Les fichiers précédents ont été restaurés.</div>'
      : flashKey === 'bad_request'
        ? '<div class="flash err">Paramètres invalides : vérifie les ports (1024–65535, tous différents) et les champs.</div>'
        : '';

  const devOptions = (devices || []).map((d) => `<option value="${esc(d.id)}" ${d.id === selectedDevice ? 'selected' : ''}>${esc(d.label || d.code || d.id.slice(0, 8))} · ${esc(d.code || '')}</option>`).join('');

  const tabs = ['all', 'xray', 'singbox'].map((k) => {
    const label = k === 'all' ? 'Tous' : k === 'xray' ? 'Xray' : 'sing-box';
    return `<a href="?engine=${k}${selectedDevice ? `&device=${encodeURIComponent(selectedDevice)}` : ''}" class="${(o.engine || 'all') === k ? 'on' : ''}">${label}</a>`;
  }).join('');

  const list = P.PROTOCOLS.filter((p) => !o.engine || o.engine === 'all' || p.engine === o.engine);

  const linkCards = (links || []).map(({ id, link, qr }) => linkBlock(P.get(id), link, qr)).join('');

  const body = `<main class="wrap">
<div class="top"><h1>Protocoles VPN</h1><span class="grow"></span><span class="pro">ADMIN VPS</span></div>
${flash}
<div class="stat">
  <div><b>${active}</b><small>protocoles actifs</small></div>
  <div><b>${healthy}</b><small>en écoute réelle</small></div>
  <div><b>${(devices || []).length}</b><small>appareils</small></div>
  <div><b>${esc(engines?.xray || '—')}</b><small>Xray</small></div>
  <div><b>${esc(engines?.singbox || '—')}</b><small>sing-box</small></div>
</div>

<div class="card">
  <p class="over">Configuration centrale — administrateur uniquement</p>
  <p class="muted" style="margin:0 0 12px">Chaque protocole activé est écrit dans la configuration du moteur, validé par le binaire lui-même, puis appliqué. En cas de rejet, les fichiers précédents sont restaurés automatiquement. Les vendeurs ne voient jamais ces réglages.</p>
  <div class="tabs">${tabs}</div>
  <form method="post" action="/admin/protocols">
    <input type="hidden" name="csrf" value="${esc(session.csrf)}">
    <div class="pg">${list.map((p) => card(p, { ...P.defaults(p.id), ...(settings[p.id] || {}) }, st.get(p.id))).join('')}</div>
    <p style="margin:16px 0 0"><button class="btn" type="submit">Valider et appliquer au VPS</button></p>
  </form>
</div>

<div class="card">
  <p class="over">Liens d'import V2Box</p>
  <p class="muted" style="margin:0 0 10px">Choisis un appareil : chaque protocole actif produit un lien et un QR code à scanner dans V2Box (ou à coller dans « Importer depuis le presse-papiers »).</p>
  <form method="get" action="/admin/protocols" class="devbar">
    <input type="hidden" name="engine" value="${esc(o.engine || 'all')}">
    <select name="device" onchange="this.form.submit()">${devOptions || '<option>Aucun appareil activé</option>'}</select>
    <noscript><button class="btn ghost sm" type="submit">Afficher</button></noscript>
  </form>
  <div class="pg">${linkCards || '<p class="muted">Aucun protocole actif pour cet appareil.</p>'}</div>
</div>
</main>`;

  return { body, css: PAGE_CSS };
}

module.exports = { protocolsPage, PAGE_CSS };
