// Pages HTML du portail (vendeur + administrateur). Tout est échappé ; CSP par nonce (aucun script/style tiers).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const { protocolsPage } = require('./protocols-page');
const I18N = require('./portal-i18n');

const TZ = 'Africa/Douala';
const fmtBytes = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' Go' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' Mo' : b >= 1e3 ? Math.round(b / 1e3) + ' ko' : b + ' o');
const fmtDate = (s) => (s ? new Date(s * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }) : '—');
const fmtDateTime = (s) => (s ? new Date(s * 1000).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: TZ }) : '—');
// Les montants sont stockés en FCFA (100 F = 1 crédit) : 250 F s'affiche « 2,5 crédits ».
const num = (F) => (F / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
const fcfa = (F) => `${Number(F).toLocaleString('fr-FR')} FCFA`;
// Montant toujours affiché dans les deux unités : « 2,5 crédits · 250 FCFA ».
const cr = (F) => `${num(F)} crédit${Math.abs(F) > 100 ? 's' : ''} · ${fcfa(F)}`;
const price = (F) => (F === 0 ? 'Gratuit' : cr(F));
const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;
const duration = (p) => {
  const d = p.hours % 24 === 0 ? `${p.hours / 24} jour${p.hours / 24 > 1 ? 's' : ''}` : `${p.hours} heures`;
  return p.window_start === null || p.window_start === undefined ? d : `${d} (${hhmm(p.window_start)}–${hhmm(p.window_end)})`;
};
const planLine = (p) => `${duration(p)} · ${p.quota_bytes === null ? 'illimité (30 Go/24 h)' : fmtBytes(p.quota_bytes)} · jusqu'à 3 appareils${p.seller_limit ? ` · ${p.seller_limit} clés max par vendeur` : ''}`;

const CSS = `
:root{--bg:#070c08;--s:#101812;--s2:#172219;--line:#24352a;--g:#2bff88;--y:#ffe14d;--t:#eaf6ee;--m:#7f9c89;--d:#ff6b6b}
*{box-sizing:border-box}html{background:var(--bg)}
body{margin:0;color:var(--t);font:300 15px/1.5 "Roboto Light","Segoe UI",system-ui,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:16px}
h1,h2,h3,.disp{font-family:"Roboto Condensed","Arial Narrow",sans-serif-condensed,sans-serif;font-weight:700;letter-spacing:.03em;margin:0}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700}
.acc{font-family:Georgia,"Times New Roman",serif;font-style:italic;color:var(--m)}
.top{display:flex;align-items:center;gap:12px;padding:12px 0 8px;flex-wrap:wrap}
.top .grow{flex:1}.brand{font-family:"Arial Black",sans-serif;letter-spacing:.1em;font-size:18px}
.pro{background:linear-gradient(90deg,var(--g),var(--y));color:var(--bg);padding:2px 8px;border-radius:8px;font-size:10px;font-weight:700;letter-spacing:.2em}
.card{background:var(--s);border:1px solid var(--line);border-radius:20px;padding:18px;margin:0 0 14px}
.over{font:700 11px ui-monospace,Menlo,monospace;letter-spacing:.18em;color:var(--m);text-transform:uppercase}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.btn{display:inline-block;border:0;border-radius:14px;padding:12px 18px;font:700 13px "Roboto Condensed","Arial Narrow",sans-serif;letter-spacing:.14em;text-transform:uppercase;cursor:pointer;text-decoration:none;color:var(--bg);background:linear-gradient(90deg,var(--g),var(--y))}
.btn.ghost{background:transparent;color:var(--g);border:1px solid var(--g)}.btn.danger{background:transparent;color:var(--d);border:1px solid var(--d)}
.btn.sm{padding:6px 10px;font-size:11px;border-radius:10px}
input,select,textarea{width:100%;background:var(--s2);color:var(--t);border:1px solid var(--line);border-radius:12px;padding:12px;font:inherit}
input:focus,select:focus,textarea:focus{outline:2px solid var(--g)}
label{display:block;margin:10px 0 4px}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--m);font:700 11px ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase}
td,th{padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:middle}
.scroll{overflow-x:auto}.ok{color:var(--g)}.warn{color:var(--y)}.bad{color:var(--d)}.muted{color:var(--m)}
.flash{border:1px solid var(--g);border-radius:14px;padding:12px;margin:0 0 14px;background:var(--s2)}.flash.err{border-color:var(--d)}.flash.note{border-color:var(--y)}
.codes{font-size:13px;word-break:break-all;line-height:1.9}
.plan{display:block;position:relative;margin:0 0 10px;cursor:pointer}.plan input{position:absolute;opacity:0;width:1px;height:1px}
.plan>span{display:block;border:1px solid var(--line);border-radius:16px;padding:14px 16px;background:var(--s)}
.plan input:checked+span{border-color:var(--g);background:var(--s2);box-shadow:0 0 0 1px var(--g)}
.plan input:focus-visible+span{outline:2px solid var(--y)}
.price{float:right;font:700 18px ui-monospace,Menlo,monospace;color:var(--y)}
.big{font-size:17px;word-break:break-all;line-height:1.7;background:var(--s2);border-radius:14px;padding:14px}
.center{max-width:380px;margin:8vh auto}
nav{display:flex;flex-wrap:wrap;gap:4px 16px;padding:0 0 14px}
nav a{color:var(--m);text-decoration:none;font-family:"Arial Narrow",sans-serif;font-weight:700;letter-spacing:.1em;text-transform:uppercase;font-size:13px;padding:6px 0}nav a.on{color:var(--g)}
form.inline{display:inline}.row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.bar{height:6px;border-radius:4px;background:var(--s2);overflow:hidden;min-width:70px}.bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--g),var(--y))}.bar.full>i{background:var(--d)}
.big-n{font-size:30px}
`;

const ago = (t, now = Math.floor(Date.now() / 1000)) => {
  if (!t) return '—';
  const d = Math.max(0, now - t);
  return d < 60 ? "à l'instant" : d < 3600 ? `il y a ${Math.floor(d / 60)} min` : d < 86400 ? `il y a ${Math.floor(d / 3600)} h` : `il y a ${Math.floor(d / 86400)} j`;
};
const dot = (on) => `<span class="${on ? 'ok' : 'muted'}" title="${on ? 'connecté' : 'hors ligne'}">●</span> ${on ? 'connecté' : 'hors ligne'}`;
const STATE = { active: ['Active', 'ok'], expired: ['Expirée', 'bad'], quota: ['Données épuisées', 'bad'], unused: ['Non activée', 'muted'], revoked: ['Révoquée', 'bad'] };
// Mise à jour automatique : toutes les 5 s, seule la zone #live est remplacée (les filtres et formulaires restent intacts).
const LIVE_JS = `(function(){var box=document.getElementById('live');if(!box)return;
function tick(){if(document.hidden)return;fetch(location.pathname+location.search,{credentials:'same-origin'}).then(function(r){return r.ok?r.text():null}).then(function(t){
if(!t)return;var d=new DOMParser().parseFromString(t,'text/html').getElementById('live');if(d){box.innerHTML=d.innerHTML;var s=document.getElementById('stamp');if(s)s.textContent=new Date().toLocaleTimeString('fr-FR')}}).catch(function(){})}
setInterval(tick,5000)})();`;
const liveNote = '<p class="muted" style="font-size:12px;margin:0 0 14px">En direct : mise à jour automatique toutes les 5 secondes · dernière lecture <span id="stamp">à l\'ouverture</span></p>';

const LOGO = `<svg width="34" height="34" viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2bff88"/><stop offset="1" stop-color="#ffe14d"/></linearGradient></defs><g fill="none" stroke="url(#lg)" stroke-linecap="round" stroke-width="7"><circle cx="50" cy="50" r="42"/><path d="M24 40Q37 26 50 40T76 40"/><path stroke-width="5" d="M24 62Q37 48 50 62T76 62"/></g></svg>`;

function layout({ title, body, nonce, script = '', head = '', css = '' }) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><script nonce="${nonce}">${I18N.THEME_BOOT}</script>${head}<title>${esc(title)} · DARK_SURF</title><style nonce="${nonce}">${CSS}${I18N.LIGHT_CSS}${css}.sig{text-align:center;margin:34px 0 22px;font:500 12px/1 'Helvetica Neue',Arial,sans-serif;letter-spacing:.42em;color:var(--muted,#8493ad);padding-left:.42em}.sig i{display:block;width:36px;height:1px;background:var(--line,#243049);margin:0 auto 10px}</style></head>
<body>${body.includes('class="top"') ? '' : I18N.toolsHtml(true)}${body}<div class="sig"><i></i>BY NOCTIS</div><script nonce="${nonce}">${I18N.THEME_JS}${script ? '\n' + script : ''}</script></body></html>`;
}

const COPY_JS = `document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;
var t=b.getAttribute('data-copy');var o=b.textContent;
var say=function(m){b.textContent=m;setTimeout(function(){b.textContent=o},1600)};
var legacy=function(){var ok=false;try{var a=document.createElement('textarea');a.value=t;a.setAttribute('readonly','');a.style.cssText='position:fixed;top:0;left:0;opacity:0;font-size:16px';document.body.appendChild(a);a.focus();a.select();a.setSelectionRange(0,t.length);ok=document.execCommand('copy');a.remove()}catch(_){}
if(!ok){var box=b.closest('.qrbox')&&b.closest('.qrbox').querySelector('.lnk');if(box){box.style.maxHeight='none';var r=document.createRange();r.selectNodeContents(box);var sel=window.getSelection();sel.removeAllRanges();sel.addRange(r)}}
say(ok?'Copié':'Texte sélectionné : appuie longuement puis Copier')};
if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(function(){say('Copié')},legacy)}else{legacy()}});`;

// Total en direct sur la page de vente (le serveur recalcule et vérifie toujours le coût).
const COST_JS = `(function(){var q=document.getElementById('qty'),out=document.getElementById('cost');if(!q||!out)return;
function up(){var r=document.querySelector('input[name=plan]:checked');var n=parseInt(q.value,10)||0;out.textContent=r?(n*parseInt(r.getAttribute('data-price'),10)/100).toLocaleString('fr-FR',{maximumFractionDigits:2}):'0'}
document.addEventListener('change',up);q.addEventListener('input',up);up()})();`;

const hidden = (csrf, extra = {}) => `<input type="hidden" name="csrf" value="${esc(csrf)}">` +
  Object.entries(extra).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
const postBtn = (action, csrf, extra, label, cls = 'ghost') =>
  `<form class="inline" method="post" action="${esc(action)}">${hidden(csrf, extra)}<button class="btn ${cls} sm" type="submit">${label}</button></form>`;

const FLASH = {
  insufficient_credit: ['Crédits insuffisants. Demande une recharge à l\'administrateur.', 'err'],
  bad_plan: ['Forfait invalide.', 'err'], bad_quantity: ['Quantité invalide (1 à 50).', 'err'], bad_devices: ['Nombre d\'appareils invalide (1 à 3).', 'err'],
  code_revoked: ['Cette clé est révoquée : elle ne peut plus être rechargée.', 'err'],
  not_activated: ['Cette clé n\'a jamais été activée : envoie-la simplement au client.', 'err'],
  bad_login: ['Identifiant invalide (a-z, 0-9, . _ - ; 3 à 32 caractères).', 'err'],
  bad_password: ['Mot de passe trop court (10 caractères minimum).', 'err'],
  bad_amount: ['Montant invalide.', 'err'], login_taken: ['Cet identifiant existe déjà.', 'err'],
  plan_exists: ['Un forfait porte déjà ce nom.', 'err'], bad_notice: ['Annonce invalide (titre et message requis).', 'err'],
  not_found: ['Élément introuvable.', 'err'], rate_limited: ['Trop de demandes. Patiente un instant.', 'err'],
  limit_reached: ['Limite atteinte : ce forfait d\'essai ne peut plus être généré sur ton compte.', 'err'],
  trial_plan: ['Un forfait d\'essai ne peut pas recharger une clé.', 'err'],
  note_required: ['Indique une justification pour retirer des crédits.', 'err'],
  too_many_requests: ['Tu as déjà 3 demandes en attente.', 'err'],
  seller_has_keys: ['Ce vendeur a des clés : désactive-le plutôt (l\'historique est conservé).', 'err'],
  requested: ['Demande envoyée à l\'administrateur.', ''], accepted: ['Demande acceptée : crédits ajoutés.', ''], refused: ['Demande refusée.', ''],
  deleted: ['Vendeur supprimé.', ''], seeded: ['Forfaits Geny chargés.', ''],
  error: ['Action impossible.', 'err'],
  revoked: ['Clé révoquée : les appareils liés seront coupés.', ''], device: ['Appareil mis à jour.', ''],
  saved: ['Enregistré.', ''], credited: ['Crédits mis à jour.', ''], recharged: ['Clé rechargée : le nouveau forfait démarre maintenant.', ''],
};
const flashBox = (k) => (FLASH[k] ? `<div class="flash ${FLASH[k][1]}">${esc(FLASH[k][0])}</div>` : '');

function header({ reseller, csrf, page }) {
  const link = (href, label, key) => `<a href="${href}" class="${page === key ? 'on' : ''}">${label}</a>`;
  const admin = reseller.role === 'admin';
  const nav = admin
    ? link('/admin', 'Tableau de bord', 'admin') + link('/admin/clients', 'Clients', 'clients') + link('/admin/plans', 'Forfaits', 'plans') +
      link('/admin/requests', 'Demandes', 'requests') + link('/admin/notices', 'Annonces', 'notices') + link('/admin/releases', 'Versions', 'releases') + link('/admin/protocols', 'Protocoles VPN', 'protocols') + link('/admin/activation', 'Activation vendeur', 'activation') + link('/admin/audit', 'Journal', 'audit')
    : link('/sell', 'Vendre', 'sell') + link('/codes', 'Mes clés', 'codes') + link('/devices', 'Appareils', 'devices') + link('/credits', 'Crédits', 'credits');
  return `<div class="top">${LOGO}<span class="brand">DARK_SURF</span><span class="pro">${admin ? 'ADMIN' : 'PRO'}</span><span class="grow"></span>
<span class="muted">${esc(reseller.name)}${admin ? '' : ` · <a href="/credits" style="color:inherit;text-decoration:none"><b class="ok mono">${cr(reseller.balance)}</b></a>`}</span>
${I18N.toolsHtml()}${postBtn('/logout', csrf, {}, 'Quitter')}</div><nav>${nav}</nav>`;
}

function loginPage({ nonce, error }) {
  return layout({
    nonce, title: 'Connexion',
    body: `<div class="wrap center"><div style="text-align:center">${LOGO}<h1 class="brand" style="margin-top:8px">DARK_SURF</h1><span class="pro">PRO</span>
<p class="acc">Espace vendeur</p></div>
<div class="card">${error ? `<div class="flash err">${esc(error)}</div>` : ''}
<form id="form" method="post" action="/login" autocomplete="on">
<label class="over" for="login">Identifiant</label><input id="login" name="login" autocomplete="username" required maxlength="64" autofocus autocapitalize="none">
<label class="over" for="password">Mot de passe</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200">
<p><button class="btn" style="width:100%" type="submit">Se connecter</button></p></form></div></div>`,
  });
}

const noticeBox = (notices) => notices.map((n) => `<div class="flash note"><b>${esc(n.title)}</b><br><span class="muted">${esc(n.body)}</span></div>`).join('');

function keyState(c, now) {
  if (c.revoked) return ['Révoquée', 'bad'];
  if (!c.activated_at) return ['Non activée', 'muted'];
  if (c.expires_at && now > c.expires_at) return ['Expirée', 'bad'];
  if (c.quota_bytes !== null && c.used >= c.quota_bytes) return ['Données épuisées', 'bad'];
  return [`Active · ${fmtDate(c.expires_at)}`, 'ok'];
}
const usageCell = (c) => {
  if (!c.activated_at) return '<span class="muted">—</span>';
  if (c.quota_bytes === null) return `<span class="mono">${fmtBytes(c.used)}</span> <span class="muted">/ illimité</span>`;
  const pct = Math.min(100, Math.round((c.used / c.quota_bytes) * 100));
  return `<span class="mono">${fmtBytes(c.used)}</span> <span class="muted">/ ${fmtBytes(c.quota_bytes)}</span><div class="bar ${pct >= 100 ? 'full' : ''}"><i style="width:${pct}%"></i></div>`;
};

// ------------------------------------------------------------------------ vendeur

function sellPage({ nonce, session, plans, flashKey, notices }) {
  const { reseller, csrf } = session;
  const admin = reseller.role === 'admin';
  const cards = plans.map((p) => {
    const gone = p.remaining === 0;
    return `<label class="plan"><input type="radio" name="plan" value="${p.id}" data-price="${admin ? 0 : p.price}" required${gone ? ' disabled' : ''}>
<span${gone ? ' style="opacity:.45"' : ''}><b class="price">${admin ? 'Gratuit' : price(p.price)}</b><span class="disp" style="font-size:19px">${esc(p.name)}</span><br><span class="acc">${esc(planLine(p))}</span>${p.remaining === null ? '' : `<br><span class="${gone ? 'bad' : 'warn'}">${gone ? 'Épuisé : plus aucune clé de ce forfait possible' : `Il te reste ${p.remaining} clé${p.remaining > 1 ? 's' : ''}`}</span>`}</span></label>`;
  }).join('');
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'sell' })}${flashBox(flashKey)}${noticeBox(notices || [])}
<div class="card"><h2 style="font-size:24px">Générer une clé</h2>
<p class="acc">Choisis le forfait : la clé est créée et son coût est retiré de tes crédits.</p>
${plans.length ? `<form method="post" action="/sell">${hidden(csrf)}
<div class="over" style="margin:14px 0 8px">1 · Forfait</div>${cards}
<div class="row2"><div><label class="over" for="qty">2 · Quantité</label><input id="qty" name="qty" type="number" min="1" max="50" value="1" required></div>
<div><label class="over" for="devices">Appareils pour cette clé (max 3)</label><select id="devices" name="devices"><option value="1">1 appareil</option><option value="2">2 appareils</option><option value="3">3 appareils</option></select></div></div>
<div class="row2"><div><label class="over" for="note">Nom du client (affiché dans son appli)</label><input id="note" name="note" maxlength="80" placeholder="facultatif"></div></div>
<p class="muted">Coût total : <b class="warn mono" id="cost">—</b> crédit(s) · tes crédits : <b class="ok mono">${cr(reseller.balance)}</b></p>
<p><button class="btn" style="width:100%" type="submit">Générer</button></p></form>` : '<p class="muted">Aucun forfait n\'est proposé pour le moment.</p>'}</div></div>`;
  return layout({ nonce, title: 'Vendre', body, script: COST_JS });
}

function createdPage({ nonce, session, created }) {
  const { reseller, csrf } = session;
  const lines = created.codes.join('\n');
  const msg = `Ton code DARK_SURF (${created.plan}) :\n${lines}`;
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'sell' })}<div class="card">
<div class="over">${created.codes.length} clé${created.codes.length > 1 ? 's' : ''} · ${esc(created.plan)} · coût ${created.cost ? cr(created.cost) : 'gratuit'}</div>
<p class="status ok" style="font:700 20px sans-serif">Clé${created.codes.length > 1 ? 's' : ''} prête${created.codes.length > 1 ? 's' : ''} ✔</p>
<p class="big mono">${created.codes.map((c) => `<span>${esc(c)}</span>`).join('<br>')}</p>
<button class="btn ghost sm" type="button" data-copy="${esc(lines)}">Copier</button>
<a class="btn sm" href="https://wa.me/?text=${encodeURIComponent(msg)}" rel="noopener noreferrer">Envoyer par WhatsApp</a>
<p class="muted">Crédits restants : <b class="ok mono">${cr(created.balance)}</b>. Le forfait démarre quand le client active la clé dans son application.</p></div>
<p><a class="btn ghost sm" href="/sell">Générer une autre clé</a> <a class="btn ghost sm" href="/codes">Mes clés</a></p></div>`;
  return layout({ nonce, title: 'Clé générée', body, script: COPY_JS });
}

function keysPage({ nonce, session, codes, stats, flashKey, now }) {
  const { reseller, csrf } = session;
  const rows = codes.map((c) => {
    const [label, cls] = keyState(c, now);
    const canRecharge = c.activated_at && !c.revoked;
    return `<tr><td class="mono"><span>${esc(c.code)}</span><br><button class="btn ghost sm" type="button" data-copy="${esc(c.code)}">Copier</button></td>
<td>${esc(c.plan_name)}${c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ''}</td><td class="${cls}">${label}</td>
<td>${usageCell(c)}</td><td>${c.devices}/${c.max_devices}</td>
<td>${c.revoked ? '' : `<a class="btn ghost sm" href="/codes/ssh?code=${encodeURIComponent(c.code)}">Fiche SSH</a> `}${canRecharge ? `<a class="btn sm" href="/recharge?code=${encodeURIComponent(c.code)}">Recharger</a> ` : ''}${c.revoked ? '' : postBtn('/codes/revoke', csrf, { code: c.code }, 'Révoquer', 'danger')}</td></tr>`;
  }).join('');
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'codes' })}${flashBox(flashKey)}
<div class="grid" style="margin-bottom:14px"><div class="card" style="margin:0"><div class="over">Clés</div><h2 class="big-n">${stats.total}</h2></div>
<div class="card" style="margin:0"><div class="over">Non activées</div><h2 class="warn big-n">${stats.unused}</h2></div>
<div class="card" style="margin:0"><div class="over">Actives</div><h2 class="ok big-n">${stats.active}</h2></div></div>
<div class="card"><div style="display:flex;align-items:center;gap:12px"><div class="over" style="flex:1">Mes clés (200 dernières)</div><a class="btn ghost sm" href="/codes.csv">Exporter CSV</a></div>
<div class="scroll"><table><thead><tr><th>Clé</th><th>Forfait</th><th>État</th><th>Données</th><th>Appareils</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="muted">Aucune clé pour le moment.</td></tr>'}</tbody></table></div></div></div>`;
  return layout({ nonce, title: 'Mes clés', body, script: COPY_JS });
}

/** Fiche SSH d'une clé : ce que le client colle dans HTTP Custom / NPV Tunnel / etc. (la clé reste utilisable dans l'appli DARK_SURF). */
function sshPage({ nonce, session, code, fiche, enabled, flashKey, now }) {
  const { reseller, csrf } = session;
  const [label, cls] = keyState(code, now);
  const row = (k, v) => `<tr><td class="muted">${esc(k)}</td><td class="mono" style="word-break:break-all">${esc(v)}</td><td><button class="btn ghost sm" type="button" data-copy="${esc(v)}">Copier</button></td></tr>`;
  const payload = fiche ? `GET ${fiche.ws_path} HTTP/1.1[crlf]Host: ${fiche.host}[crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf]User-Agent: [ua][crlf][crlf]` : '';
  let inner;
  if (!enabled) inner = '<div class="flash note">Le transport SSH est désactivé sur ce serveur (page « Protocoles VPN » de l\'administrateur).</div>';
  else if (!fiche) inner = `<p class="muted">Cette fiche sert aux applis tierces (HTTP Custom, NPV Tunnel…). Elle active aussi le forfait de la clé s'il n'a pas encore démarré.</p>
<form method="post" action="/codes/ssh">${hidden(csrf, { code: code.code })}<p><button class="btn" style="width:100%" type="submit">Activer la fiche SSH</button></p></form>`;
  else inner = `<div class="scroll"><table><tbody>
${row('Hôte (serveur)', fiche.host)}${row('Port SSH direct', String(fiche.tcp_port))}${row('Port WebSocket TLS', String(fiche.tls_port))}${row('Chemin WebSocket', fiche.ws_path)}
${row('Identifiant SSH', fiche.username)}${row('Mot de passe SSH', fiche.password)}${fiche.tls_ssh_port ? row('Port SSH sur TLS (Stunnel)', String(fiche.tls_ssh_port)) : ''}${fiche.dropbear_port ? row('Port Dropbear', String(fiche.dropbear_port)) : ''}${fiche.udpgw_port ? row('Port UDPGW (127.0.0.1)', String(fiche.udpgw_port)) : ''}${row('Exemple de payload WebSocket', payload)}
</tbody></table></div>
<p class="muted">Un seul appareil à la fois : si plusieurs connexions sont ouvertes avec ce compte, elles sont toutes coupées. Le trafic est compté dans le forfait de la clé.</p>`;
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'codes' })}${flashBox(flashKey)}<div class="card">
<h2 style="font-size:24px">Fiche SSH</h2><p class="mono" style="word-break:break-all">${esc(code.code)}</p>
<p class="muted">${esc(code.plan_name)}${code.note ? ' · ' + esc(code.note) : ''} · <span class="${cls}">${label}</span></p>${inner}</div>
<p><a class="btn ghost sm" href="/codes">Retour</a></p></div>`;
  return layout({ nonce, title: 'Fiche SSH', body, script: COPY_JS });
}

function rechargePage({ nonce, session, code, plans, flashKey, now }) {
  const { reseller, csrf } = session;
  const admin = reseller.role === 'admin';
  const [label, cls] = keyState(code, now);
  const live = label.startsWith('Active');
  const cards = plans.filter((p) => p.seller_limit === null).map((p) => `<label class="plan"><input type="radio" name="plan" value="${p.id}" required>
<span><b class="price">${admin ? 'Gratuit' : price(p.price)}</b><span class="disp" style="font-size:19px">${esc(p.name)}</span><br><span class="acc">${esc(planLine(p))}</span></span></label>`).join('');
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'codes' })}${flashBox(flashKey)}<div class="card">
<h2 style="font-size:24px">Recharger une clé</h2><p class="mono" style="word-break:break-all">${esc(code.code)}</p>
<p class="muted">${esc(code.plan_name)}${code.note ? ' · ' + esc(code.note) : ''} · <span class="${cls}">${label}</span></p>
${live ? '<div class="flash note">Cette clé est encore active : le nouveau forfait la remplace et démarre maintenant (durée et données repartent de zéro).</div>' : ''}
<form method="post" action="/recharge">${hidden(csrf, { code: code.code })}${cards}
<p><button class="btn" style="width:100%" type="submit">Recharger la clé</button></p></form></div>
<p><a class="btn ghost sm" href="/codes">Retour</a></p></div>`;
  return layout({ nonce, title: 'Recharger', body });
}

function devicesPage({ nonce, session, devices, flashKey, now }) {
  const { reseller, csrf } = session;
  const rows = devices.map((d) => {
    const used = Math.max(0, d.used_bytes);
    const exp = d.expires_at && now > d.expires_at;
    const [st, cls] = d.revoked ? ['Clé révoquée', 'bad'] : d.disabled ? ['Désactivé', 'bad'] : exp ? ['Expiré', 'bad']
      : d.quota_bytes !== null && used - d.bytes_offset >= d.quota_bytes ? ['Données épuisées', 'warn'] : ['Actif', 'ok'];
    return `<tr><td>${esc(d.label)}<br><span class="muted mono">${esc(String(d.id).slice(0, 8))}</span></td><td class="mono">${esc(d.code.slice(0, 8))}…</td>
<td>${esc(d.plan_name)}</td><td class="mono">${fmtBytes(used)}</td><td class="muted">${fmtDateTime(d.last_seen)}</td><td class="${cls}">${st}</td>
<td>${postBtn(`/devices/${d.id}/toggle`, csrf, {}, d.disabled ? 'Réactiver' : 'Désactiver')} ${postBtn(`/devices/${d.id}/delete`, csrf, {}, 'Libérer', 'danger')}</td></tr>`;
  }).join('');
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'devices' })}${flashBox(flashKey)}
<div class="card"><div class="over">Appareils de mes clients</div><div class="scroll"><table><thead><tr><th>Appareil</th><th>Clé</th><th>Forfait</th><th>Données</th><th>Dernière connexion</th><th>État</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="7" class="muted">Aucun appareil activé.</td></tr>'}</tbody></table></div>
<p class="acc">« Libérer » enlève l'appareil de la clé : le client peut alors l'activer sur un autre téléphone.</p></div></div>`;
  return layout({ nonce, title: 'Appareils', body });
}

const KIND = { recharge: 'Recharge', adjust: 'Correction', sale: 'Vente de clé', renew: 'Recharge de clé' };
const ledgerRows = (rows) => rows.map((l) => `<tr><td class="muted">${fmtDateTime(l.created_at)}</td><td>${KIND[l.kind] || esc(l.kind)}${l.ref || l.note ? `<br><span class="muted">${esc([l.ref, l.note].filter(Boolean).join(' · '))}</span>` : ''}</td>
<td class="mono ${l.delta > 0 ? 'ok' : 'warn'}">${l.delta > 0 ? '+' : ''}${num(l.delta)}</td><td class="mono">${num(l.balance_after)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Aucun mouvement.</td></tr>';
const ledgerTable = (rows) => `<div class="scroll"><table><thead><tr><th>Date</th><th>Opération</th><th>Crédits</th><th>Solde</th></tr></thead><tbody>${ledgerRows(rows)}</tbody></table></div>`;

const REQ = { pending: ['En attente', 'warn'], accepted: ['Acceptée', 'ok'], refused: ['Refusée', 'bad'] };
function creditsPage({ nonce, session, ledger, notices, requests = [], phone, flashKey }) {
  const { reseller, csrf } = session;
  const reqRows = requests.map((r) => `<tr><td class="muted">${fmtDateTime(r.created_at)}</td><td class="mono">${num(r.amount)} crédits <span class="muted">(${r.amount.toLocaleString('fr-FR')} F)</span></td><td class="${REQ[r.status][1]}">${REQ[r.status][0]}</td></tr>`).join('');
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'credits' })}${flashBox(flashKey)}${noticeBox(notices || [])}
<div class="card"><div class="over">Mes crédits</div><h2 class="ok big-n">${num(reseller.balance)}</h2><p class="muted mono" style="margin:-6px 0 8px">${fcfa(reseller.balance)}</p>
<p class="acc">1 crédit = 100 FCFA. Quand tes crédits sont épuisés, tu ne peux plus vendre de forfait.</p></div>
<div class="card"><div class="over">Demander une recharge</div>
<form method="post" action="/credits/request"><label class="over" for="credits">Nombre de crédits souhaités</label><input id="credits" name="credits" inputmode="decimal" required placeholder="ex. 50">
<p class="muted">1 crédit = 100 FCFA. Contacte l'administrateur : <a class="ok" href="tel:${esc(String(phone || '').replace(/\s/g, ''))}">${esc(phone || '')}</a></p>${hidden(csrf)}
<button class="btn" type="submit">Envoyer la demande</button></form>
${reqRows ? `<div class="scroll" style="margin-top:12px"><table><thead><tr><th>Date</th><th>Demande</th><th>État</th></tr></thead><tbody>${reqRows}</tbody></table></div>` : ''}</div>
<div class="card"><div class="over">Historique</div>${ledgerTable(ledger)}</div></div>`;
  return layout({ nonce, title: 'Crédits', body });
}

// ------------------------------------------------------------------ administrateur

function adminDashboard({ nonce, session, stats, sellers, flashKey, notices, info, bySeller = new Map(), counts }) {
  const { reseller, csrf } = session;
  const card = (label, value, cls = '', href = '') => `<${href ? `a href="${href}" style="text-decoration:none;color:inherit"` : 'div'} class="card" style="margin:0;display:block"><div class="over">${label}</div><h2 class="${cls} big-n">${value}</h2></${href ? 'a' : 'div'}>`;
  const rows = sellers.map((s) => `<tr><td><a href="/admin/sellers/${s.id}" style="color:var(--g)" class="mono">${esc(s.login)}</a><br><span class="muted">${esc(s.name)}</span></td>
<td class="mono ${s.balance === 0 ? 'bad' : 'ok'}">${num(s.balance)}<br><span class="muted">${fcfa(s.balance)}</span></td><td class="mono">${s.keys_active} <span class="muted">/ ${s.keys_total}</span></td>
<td class="mono ${bySeller.get(s.id) ? 'ok' : 'muted'}">${bySeller.get(s.id) || 0}</td>
<td class="mono">${fmtBytes(s.bytes_used)}</td><td class="mono">${num(s.credits_spent)}</td><td class="muted">${ago(s.last_login)}</td>
<td class="${s.active ? 'ok' : 'bad'}">${s.active ? 'Actif' : 'Désactivé'}</td></tr>`).join('');
  const c = counts || {};
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'admin' })}${flashBox(flashKey)}${noticeBox(notices || [])}${liveNote}
<div id="live"><div class="grid" style="margin-bottom:14px">${card('Clients connectés maintenant', c.online ?? info?.online ?? 0, 'ok', '/admin/clients?state=online')}${card('Clients (clés)', c.all ?? 0, '', '/admin/clients')}
${card('Clés actives', stats.keys_active, 'ok', '/admin/clients?state=active')}${card('Clés expirées', stats.keys_expired, '', '/admin/clients?state=expired')}${card('Clés révoquées', stats.keys_revoked, '', '/admin/clients?state=revoked')}${card('Non activées', stats.keys_unused, '', '/admin/clients?state=unused')}
${card('Vendeurs actifs', stats.sellers)}${card('Crédits chez les vendeurs', num(stats.credits_in_wallets) + ' · ' + fcfa(stats.credits_in_wallets), 'warn')}${card('Crédits distribués', num(stats.credits_sold))}${card('Crédits consommés', num(stats.credits_spent))}
${card('Demandes en attente', stats.requests_pending, stats.requests_pending ? 'warn' : '', '/admin/requests')}${card('Appareils', stats.devices)}${card('Données totales', fmtBytes(stats.bytes_used))}</div>
${info ? `<div class="card"><div class="over">Serveur</div><p class="muted">Xray <b class="mono ${info.peers === null ? 'bad' : 'ok'}">${info.peers === null ? 'ne répond pas' : 'actif'}</b> (${esc(info.mode)}) · appareils autorisés : <b class="mono">${info.peers ?? '?'}</b> · connectés : <b class="mono ok">${info.online}</b> · RAM : <b class="mono">${fmtBytes(info.ram.total - info.ram.free)}</b> / ${fmtBytes(info.ram.total)}${info.disk ? ` · disque : <b class="mono">${fmtBytes(info.disk.total - info.disk.free)}</b> / ${fmtBytes(info.disk.total)}` : ''} · allumé depuis ${Math.floor(info.uptime / 86400)} j</p></div>` : ''}
<div class="card"><div style="display:flex;align-items:center;gap:12px"><div class="over" style="flex:1">Vendeurs</div><a class="btn sm" href="/admin/sellers/new">Nouveau vendeur</a></div>
<div class="scroll"><table><thead><tr><th>Vendeur</th><th>Crédits</th><th>Clés actives / total</th><th>Connectés</th><th>Données</th><th>Crédits utilisés</th><th>Dernière connexion</th><th>État</th></tr></thead>
<tbody>${rows || '<tr><td colspan="8" class="muted">Aucun vendeur. Crée le premier.</td></tr>'}</tbody></table></div></div></div></div>`;
  return layout({ nonce, title: 'Tableau de bord', body, script: LIVE_JS });
}

const clientRow = (c, now) => `<tr><td><a href="/admin/clients/${encodeURIComponent(c.code)}" class="mono" style="color:var(--g)">${esc(c.code.slice(0, 12))}…</a>${c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ''}</td>
<td><a href="/admin/sellers/${c.reseller_id}" style="color:inherit">${esc(c.seller)}</a></td><td>${esc(c.plan_name)}</td>
<td class="${STATE[c.state][1]}">${STATE[c.state][0]}${c.state === 'active' && c.expires_at ? `<br><span class="muted">jusqu'au ${fmtDateTime(c.expires_at)}</span>` : ''}</td>
<td>${usageCell(c)}</td><td>${c.devices.length}/${c.max_devices}<br>${c.devices.length ? dot(c.online) : '<span class="muted">—</span>'}</td>
<td class="muted">${ago(c.last_activity, now)}</td></tr>`;

function clientsPage({ nonce, session, data, sellers, f, now }) {
  const { reseller, csrf } = session;
  const chip = (key, label) => `<a class="btn sm ${f.state === key ? '' : 'ghost'}" href="/admin/clients?state=${key}${f.seller ? `&seller=${f.seller}` : ''}${f.q ? `&q=${encodeURIComponent(f.q)}` : ''}">${label} ${data.counts[key] ?? 0}</a>`;
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'clients' })}${liveNote}
<div class="card"><form method="get" action="/admin/clients"><div class="row2"><div><label class="over" for="q">Recherche (clé, vendeur, forfait, appareil)</label><input id="q" name="q" value="${esc(f.q)}" placeholder="ex. TUN-ab12, marie, Pixel"></div>
<div><label class="over" for="seller">Vendeur</label><select id="seller" name="seller"><option value="0">Tous</option>${sellers.map((x) => `<option value="${x.id}"${f.seller === x.id ? ' selected' : ''}>${esc(x.login)}</option>`).join('')}</select></div></div>
<input type="hidden" name="state" value="${esc(f.state)}"><p><button class="btn sm" type="submit">Filtrer</button></p></form></div>
<div id="live"><div style="display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px">${chip('all', 'Tous')}${chip('online', 'Connectés')}${chip('active', 'Actifs')}${chip('expired', 'Expirés')}${chip('quota', 'Données épuisées')}${chip('unused', 'Non activés')}${chip('revoked', 'Révoqués')}</div>
<div class="card"><div class="over">${data.total} clé${data.total > 1 ? 's' : ''}${data.total > data.shown ? ` (les ${data.shown} plus récentes affichées : affine la recherche)` : ''}</div>
<div class="scroll"><table><thead><tr><th>Clé</th><th>Vendeur</th><th>Forfait</th><th>État</th><th>Données</th><th>Appareils</th><th>Dernière activité</th></tr></thead>
<tbody>${data.rows.map((c) => clientRow(c, now)).join('') || '<tr><td colspan="7" class="muted">Aucun client pour ce filtre.</td></tr>'}</tbody></table></div></div></div></div>`;
  return layout({ nonce, title: 'Clients', body, script: LIVE_JS });
}

function clientPage({ nonce, session, c, flashKey, now }) {
  const { reseller, csrf } = session;
  const back = `/admin/clients/${encodeURIComponent(c.code)}`;
  const devRows = c.devices.map((d, i) => `<tr><td>${i + 1}</td><td><b>${esc(d.label || 'Appareil')}</b><br><span class="muted mono">${esc(String(d.id).slice(0, 8))}</span></td>
<td class="muted">${fmtDateTime(d.created_at)}</td><td class="mono">${fmtBytes(d.used_bytes)}</td><td class="muted">${ago(d.last_activity, now)}</td>
<td>${d.disabled ? '<span class="bad">bloqué</span>' : dot(d.online)}</td>
<td>${postBtn(`/devices/${d.id}/toggle`, csrf, { back }, d.disabled ? 'Débloquer' : 'Bloquer')} ${postBtn(`/devices/${d.id}/delete`, csrf, { back }, 'Libérer', 'danger')}</td></tr>`).join('');
  const total = c.devices.reduce((n, d) => n + d.used_bytes, 0);
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'clients' })}${flashBox(flashKey)}${liveNote}<div id="live">
<div class="card"><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><div style="flex:1 1 100%"><div class="over">Clé</div><div class="mono big" style="margin-top:6px">${esc(c.code)}</div></div>
<button class="btn ghost sm" data-copy="${esc(c.code)}">Copier</button>${c.revoked ? '' : postBtn('/codes/revoke', csrf, { code: c.code, back }, 'Révoquer la clé', 'danger')}</div></div>
<div class="grid" style="margin-bottom:14px"><div class="card" style="margin:0"><div class="over">État</div><h2 class="${STATE[c.state][1]} big-n" style="font-size:22px">${STATE[c.state][0]}</h2><span class="muted">${c.devices.length ? dot(c.online) : 'jamais connecté'}</span></div>
<div class="card" style="margin:0"><div class="over">Forfait</div><h2 class="big-n" style="font-size:20px">${esc(c.plan_name)}</h2><span class="muted">${c.quota_bytes === null ? 'illimité' : fmtBytes(c.quota_bytes)} · ${duration(c)}</span></div>
<div class="card" style="margin:0"><div class="over">Données utilisées</div><h2 class="big-n" style="font-size:22px">${fmtBytes(c.used)}</h2><span class="muted">${c.quota_bytes === null ? 'illimité' : 'sur ' + fmtBytes(c.quota_bytes)}</span></div>
<div class="card" style="margin:0"><div class="over">Expire</div><h2 class="big-n" style="font-size:20px">${c.expires_at ? fmtDateTime(c.expires_at) : '—'}</h2><span class="muted">${c.activated_at ? 'activée le ' + fmtDateTime(c.activated_at) : 'pas encore activée'}</span></div></div>
<div class="card"><div class="over">Vendeur</div><p><a href="/admin/sellers/${c.reseller_id}" style="color:var(--g)" class="mono">${esc(c.seller)}</a> · ${esc(c.seller_name)} · clé créée le ${fmtDateTime(c.created_at)}${c.note ? ` · note : ${esc(c.note)}` : ''} · prix du forfait ${price(c.price)}</p></div>
<div class="card"><div class="over">Appareils de la clé (${c.devices.length}/${c.max_devices})</div><div class="scroll"><table><thead><tr><th>#</th><th>Appareil</th><th>Activé le</th><th>Conso</th><th>Dernière activité</th><th>État</th><th></th></tr></thead>
<tbody>${devRows || '<tr><td colspan="7" class="muted">Aucun appareil : la clé n\'a jamais été utilisée.</td></tr>'}</tbody>${devRows ? `<tfoot><tr><td colspan="3"><b>Total</b></td><td class="mono">${fmtBytes(total)}</td><td colspan="3"></td></tr></tfoot>` : ''}</table></div>
<p class="acc">« Libérer » supprime l'appareil : la clé pourra être activée sur un autre téléphone. « Bloquer » coupe l'accès sans rien supprimer.</p></div></div></div>`;
  return layout({ nonce, title: 'Client', body, script: LIVE_JS + COPY_JS });
}

function sellerNewPage({ nonce, session, flashKey }) {
  const { reseller, csrf } = session;
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'admin' })}${flashBox(flashKey)}<div class="card"><h2 style="font-size:24px">Nouveau vendeur</h2>
<form method="post" action="/admin/sellers">${hidden(csrf)}
<label class="over" for="login">Identifiant</label><input id="login" name="login" required maxlength="32" autocapitalize="none" autocomplete="off">
<label class="over" for="name">Nom affiché</label><input id="name" name="name" maxlength="60" autocomplete="off">
<label class="over" for="credits">Crédits de départ</label><input id="credits" name="credits" inputmode="decimal" value="0">
<label class="over" for="password">Mot de passe (vide = généré automatiquement)</label><input id="password" name="password" autocomplete="off" maxlength="100">
<p><button class="btn" type="submit">Créer le vendeur</button></p></form></div></div>`;
  return layout({ nonce, title: 'Nouveau vendeur', body });
}

/** Affiche un mot de passe une seule fois (création ou réinitialisation). */
function secretPage({ nonce, session, title, login, password, sellerId }) {
  const { reseller, csrf } = session;
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'admin' })}<div class="card"><h2 style="font-size:22px">${esc(title)}</h2>
<p class="muted">Identifiant : <span class="mono">${esc(login)}</span></p><div class="over">Mot de passe (affiché une seule fois)</div>
<p class="big mono">${esc(password)}</p><button class="btn ghost sm" type="button" data-copy="${esc(`Identifiant : ${login}\nMot de passe : ${password}`)}">Copier</button></div>
<p><a class="btn ghost sm" href="/admin/sellers/${sellerId}">Fiche du vendeur</a> <a class="btn ghost sm" href="/admin">Tableau de bord</a></p></div>`;
  return layout({ nonce, title, body, script: COPY_JS });
}

function sellerPage({ nonce, session, seller, codes, ledger, flashKey, now }) {
  const { reseller, csrf } = session;
  const act = (a) => `/admin/sellers/${seller.id}/${a}`;
  const rows = codes.map((c) => { const [label, cls] = keyState(c, now);
    return `<tr><td><a href="/admin/clients/${encodeURIComponent(c.code)}" class="mono" style="color:var(--g)">${esc(c.code.slice(0, 12))}…</a></td><td>${esc(c.plan_name)}${c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ''}</td>
<td class="${cls}">${label}</td><td>${usageCell(c)}</td><td>${c.devices}/${c.max_devices}</td>
<td>${c.revoked ? '' : postBtn('/codes/revoke', csrf, { code: c.code, back: `/admin/sellers/${seller.id}` }, 'Révoquer', 'danger')}</td></tr>`; }).join('');
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'admin' })}${flashBox(flashKey)}
<div class="card"><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><div style="flex:1"><h2 style="font-size:24px">${esc(seller.name)}</h2>
<span class="muted mono">${esc(seller.login)}</span> · <span class="${seller.active ? 'ok' : 'bad'}">${seller.active ? 'Actif' : 'Désactivé'}</span> · <span class="muted">dernière connexion ${fmtDateTime(seller.last_login)}</span></div>
${postBtn(act('toggle'), csrf, {}, seller.active ? 'Désactiver' : 'Réactiver', seller.active ? 'danger' : 'ghost')}
${postBtn(act('password'), csrf, {}, 'Nouveau mot de passe')}
${postBtn(act('delete'), csrf, {}, 'Supprimer', 'danger')}</div></div>
<div class="grid" style="margin-bottom:14px"><div class="card" style="margin:0"><div class="over">Crédits</div><h2 class="ok big-n">${num(seller.balance)}</h2></div>
<div class="card" style="margin:0"><div class="over">Clés actives</div><h2 class="big-n">${seller.keys_active} <span class="muted" style="font-size:16px">/ ${seller.keys_total}</span></h2></div>
<div class="card" style="margin:0"><div class="over">Crédits achetés / utilisés</div><h2 class="big-n">${num(seller.credits_bought)} <span class="muted" style="font-size:16px">/ ${num(seller.credits_spent)}</span></h2></div>
<div class="card" style="margin:0"><div class="over">Données consommées</div><h2 class="big-n" style="font-size:22px">${fmtBytes(seller.bytes_used)}</h2></div></div>
<div class="card"><div class="over">Recharger / corriger les crédits</div>
<form method="post" action="${act('credit')}">${hidden(csrf)}<div class="row2"><div><label class="over" for="amount">Montant (crédits)</label><input id="amount" name="amount" inputmode="decimal" required placeholder="ex. 50 ou 2,5"></div>
<div><label class="over" for="mode">Opération</label><select id="mode" name="mode"><option value="add">Ajouter</option><option value="remove">Retirer (correction)</option></select></div></div>
<label class="over" for="note">Note / justification (obligatoire pour un retrait)</label><input id="note" name="note" maxlength="80">
<p><button class="btn" type="submit">Valider</button></p></form></div>
<div class="card"><div class="over">Clés du vendeur (200 dernières)</div><div class="scroll"><table><thead><tr><th>Clé</th><th>Forfait</th><th>État</th><th>Données</th><th>Appareils</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="muted">Aucune clé.</td></tr>'}</tbody></table></div></div>
<div class="card"><div class="over">Mouvements de crédit</div>${ledgerTable(ledger)}</div></div>`;
  return layout({ nonce, title: seller.name, body });
}

function plansAdminPage({ nonce, session, plans, flashKey }) {
  const { reseller, csrf } = session;
  const rows = plans.map((p) => `<tr><td><b>${esc(p.name)}</b><br><span class="muted">${esc(planLine(p))}</span></td>
<td><form class="inline" method="post" action="/admin/plans/${p.id}">${hidden(csrf)}<input name="credits" inputmode="decimal" value="${num(p.price).replace(/\s/g, '')}" style="width:90px;padding:6px" aria-label="Crédits">
<button class="btn ghost sm" type="submit">Prix</button></form><br><span class="muted">${p.price.toLocaleString('fr-FR')} FCFA</span></td>
<td class="${p.active ? 'ok' : 'bad'}">${p.active ? 'En vente' : 'Retiré'}</td>
<td>${postBtn(`/admin/plans/${p.id}`, csrf, { active: p.active ? '0' : '1' }, p.active ? 'Retirer' : 'Remettre', p.active ? 'danger' : 'ghost')}</td></tr>`).join('');
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'plans' })}${flashBox(flashKey)}
<div class="card"><div style="display:flex;align-items:center;gap:12px"><div class="over" style="flex:1">Grille des forfaits (1 crédit = 100 FCFA)</div>
${postBtn('/admin/plans/seed', csrf, {}, 'Charger les forfaits Geny', 'ghost')}</div><div class="scroll"><table><thead><tr><th>Forfait</th><th>Prix vendeur (crédits)</th><th>État</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="4" class="muted">Aucun forfait : clique « Charger les forfaits Geny ».</td></tr>'}</tbody></table></div>
<p class="acc">Retirer un forfait ne coupe pas les clés déjà vendues. La durée et les données d'un forfait ne se modifient pas : crées-en un nouveau.</p></div>
<div class="card"><div class="over">Nouveau forfait</div><form method="post" action="/admin/plans">${hidden(csrf)}
<label class="over" for="name">Nom</label><input id="name" name="name" required maxlength="40" placeholder="ex. Pass Mensuel Standard">
<div class="row2"><div><label class="over" for="duration">Durée</label><input id="duration" name="duration" type="number" min="1" max="87600" value="30" required></div>
<div><label class="over" for="unit">Unité</label><select id="unit" name="unit"><option value="days">jours</option><option value="hours">heures</option></select></div></div>
<div class="row2"><div><label class="over" for="quota_gb">Données (Go)</label><input id="quota_gb" name="quota_gb" inputmode="decimal" placeholder="vide si illimité"></div>
<div><label class="over" for="credits">Prix vendeur (crédits, 0 = gratuit)</label><input id="credits" name="credits" inputmode="decimal" required placeholder="ex. 2,5"></div></div>
<div class="row2"><div><label class="over" for="window">Plage horaire (facultatif)</label><input id="window" name="window" placeholder="00:00-06:00"></div>
<div><label class="over" for="limit">Clés max par vendeur (essai)</label><input id="limit" name="limit" type="number" min="1" placeholder="illimité"></div></div>
<label><input type="checkbox" name="unlimited" value="1" style="width:auto"> Données illimitées</label>
<p><button class="btn" type="submit">Créer le forfait</button></p></form></div></div>`;
  return layout({ nonce, title: 'Forfaits', body });
}

function requestsPage({ nonce, session, requests, flashKey }) {
  const { reseller, csrf } = session;
  const rows = requests.map((r) => `<tr><td class="muted">${fmtDateTime(r.created_at)}</td><td><a class="mono ok" href="/admin/sellers/${r.reseller_id}">${esc(r.login)}</a><br><span class="muted">${esc(r.name)}</span></td>
<td class="mono">${num(r.amount)} crédits<br><span class="muted">${r.amount.toLocaleString('fr-FR')} FCFA</span></td><td class="${REQ[r.status][1]}">${REQ[r.status][0]}</td>
<td>${r.status === 'pending' ? postBtn(`/admin/requests/${r.id}/accept`, csrf, {}, 'Accepter') + ' ' + postBtn(`/admin/requests/${r.id}/refuse`, csrf, {}, 'Refuser', 'danger') : ''}</td></tr>`).join('');
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'requests' })}${flashBox(flashKey)}
<div class="card"><div class="over">Demandes de recharge des vendeurs</div><div class="scroll"><table><thead><tr><th>Date</th><th>Vendeur</th><th>Demande</th><th>État</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" class="muted">Aucune demande.</td></tr>'}</tbody></table></div>
<p class="acc">Accepter ajoute les crédits au vendeur tout de suite (écriture dans son historique).</p></div></div>`;
  return layout({ nonce, title: 'Demandes', body });
}

function auditPage({ nonce, session, rows }) {
  const { reseller, csrf } = session;
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'audit' })}
<div class="card"><div class="over">Journal des actions sensibles</div><div class="scroll"><table><thead><tr><th>Date</th><th>Qui</th><th>Action</th><th>Détail</th></tr></thead>
<tbody>${rows.map((r) => `<tr><td class="muted">${fmtDateTime(r.created_at)}</td><td class="mono">${esc(r.actor)}</td><td>${esc(r.action)}</td><td class="muted">${esc(r.detail || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Rien pour le moment.</td></tr>'}</tbody></table></div></div></div>`;
  return layout({ nonce, title: 'Journal', body });
}

const AUD = { clients: 'Clients (appli VPN)', sellers: 'Vendeurs', all: 'Tout le monde' };
function activationPage({ nonce, session, hasKey, pub, issued, error, flashKey }) {
  const { reseller, csrf } = session;
  const out = issued ? `<div class="card"><div class="over">Code d'activation prêt ✔</div>
<p class="muted">Pour le téléphone <b class="mono">${esc(issued.device)}</b> · ${issued.exp ? 'valable jusqu\'au ' + fmtDate(issued.exp) : 'sans expiration'} · ${esc(issued.label)}</p>
<p class="mono" style="word-break:break-all;font-size:13px">${esc(issued.code)}</p>
<button class="btn sm" type="button" data-copy="${esc(issued.code)}">Copier</button>
<a class="btn ghost sm" href="https://wa.me/?text=${encodeURIComponent('Code d\'activation DARK_SURF PRO :\n' + issued.code)}" rel="noopener noreferrer">Envoyer par WhatsApp</a></div>` : '';
  const keyCard = hasKey
    ? `<div class="muted">Clé privée vendeur installée ✔ · clé publique de l'appli : <span class="mono" style="word-break:break-all;font-size:11px">${esc(pub)}</span></div>`
    : `<div class="flash err">Clé privée vendeur absente. Colle ci-dessous le contenu de seller-private.pem (une seule fois).</div>
<form method="post" action="/admin/activation/key">${hidden(csrf)}<textarea name="pem" rows="6" required placeholder="-----BEGIN PRIVATE KEY-----"></textarea>
<p><button class="btn" type="submit">Installer la clé</button></p></form>`;
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'activation' })}${flashBox(flashKey)}${error ? `<div class="flash err">${esc(error)}</div>` : ''}
<div class="card"><h2 style="font-size:22px">Activation de l'appli vendeur</h2>
<p class="acc">Le vendeur ouvre l'appli PRO : elle affiche l'identifiant de son téléphone (AAAA-BBBB-CCCC-DDDD-EEEE). Colle-le ici pour lui donner la permission d'utiliser l'appli.</p>${keyCard}</div>
${hasKey ? `<div class="card"><div class="over">Donner la permission</div><form method="post" action="/admin/activation/issue">${hidden(csrf)}
<label class="over" for="device">Identifiant du téléphone</label><input id="device" name="device" required maxlength="40" autocapitalize="characters" placeholder="AAAA-BBBB-CCCC-DDDD-EEEE">
<label class="over" for="label">Nom du vendeur</label><input id="label" name="label" maxlength="40" placeholder="ex. Jean">
<label class="over" for="days">Validité (jours, 0 = sans expiration)</label><input id="days" name="days" type="number" min="0" max="3650" value="30">
<p><button class="btn" type="submit">Générer le code</button></p></form></div>` : ''}${out}</div>`;
  return layout({ nonce, title: 'Activation vendeur', body, script: COPY_JS });
}

function noticesAdminPage({ nonce, session, notices, flashKey }) {
  const { reseller, csrf } = session;
  const rows = notices.map((n) => `<tr><td><b>${esc(n.title)}</b><br><span class="muted">${esc(n.body)}</span></td><td>${AUD[n.audience]}</td>
<td class="muted">${fmtDate(n.created_at)}${n.expires_at ? `<br>jusqu'au ${fmtDate(n.expires_at)}` : ''}</td><td class="${n.active ? 'ok' : 'muted'}">${n.active ? 'Publiée' : 'Retirée'}</td>
<td>${n.active ? postBtn(`/admin/notices/${n.id}/remove`, csrf, {}, 'Retirer', 'danger') : ''}</td></tr>`).join('');
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'notices' })}${flashBox(flashKey)}
<div class="card"><div class="over">Nouvelle annonce</div><form method="post" action="/admin/notices">${hidden(csrf)}
<label class="over" for="audience">Destinataires</label><select id="audience" name="audience"><option value="clients">Clients (notification dans l'appli VPN)</option><option value="sellers">Vendeurs (bandeau du portail)</option><option value="all">Tout le monde</option></select>
<label class="over" for="title">Titre</label><input id="title" name="title" required maxlength="80">
<label class="over" for="body">Message</label><textarea id="body" name="body" required maxlength="400" rows="3"></textarea>
<label class="over" for="days">Visible pendant (jours, vide = jusqu'à retrait)</label><input id="days" name="days" type="number" min="1" max="365">
<p><button class="btn" type="submit">Publier</button></p></form></div>
<div class="card"><div class="over">Annonces</div><div class="scroll"><table><thead><tr><th>Annonce</th><th>Pour</th><th>Date</th><th>État</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" class="muted">Aucune annonce.</td></tr>'}</tbody></table></div></div></div>`;
  return layout({ nonce, title: 'Annonces', body });
}

function releasesAdminPage({ nonce, session, releases }) {
  const { reseller, csrf } = session;
  const rows = releases.map((r) => `<tr><td class="mono">${r.version_code}</td><td>${esc(r.version_name)}</td><td class="muted">${esc(r.notes || '')}</td><td class="mono">${fmtBytes(r.size)}</td>
<td class="${r.active ? 'ok' : 'muted'}">${r.active ? 'Proposée' : 'Retirée'}${r.required ? ' · obligatoire' : ''}${r.min_version_code ? ` · min ${r.min_version_code}` : ''}</td><td class="muted">${fmtDate(r.created_at)}</td></tr>`).join('');
  const body = `<div class="wrap">${header({ reseller, csrf, page: 'releases' })}
<div class="card"><div class="over">Versions de l'application VPN</div><div class="scroll"><table><thead><tr><th>Code</th><th>Version</th><th>Notes</th><th>Taille</th><th>État</th><th>Date</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="muted">Aucune version publiée.</td></tr>'}</tbody></table></div>
<p class="acc">Pour publier : <span class="mono">darksurf-admin publish-release app.apk --version-code N --version-name X.Y.Z --notes "…"</span> sur le serveur.</p></div></div>`;
  return layout({ nonce, title: 'Versions', body });
}

const messagePage = ({ nonce, title, text }) => layout({ nonce, title, body: `<div class="wrap center"><div class="card"><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p><a class="btn ghost" href="/">Retour</a></div></div>` });


// Page « Protocoles VPN » : moteur multi-protocoles (src/protocols-page.js) + transport SSH historique.
function protocolsAdminPage({ nonce, session, settings, flashKey, statuses, devices, selectedDevice, links, engines, engine }) {
  const s = settings || {};
  const field = (name, label, value, type='text', hint='') => `<label>${label}<input name="${name}" type="${type}" value="${esc(value ?? '')}" ${type==='number'?'min="1024" max="65535"':''} required></label>${hint?`<small class="muted">${hint}</small>`:''}`;
  const toggle = (name,label,on) => `<label style="display:flex;gap:10px;align-items:center"><input style="width:auto" type="checkbox" name="${name}" value="1" ${on?'checked':''}> ${label}</label>`;

  const main = protocolsPage({ nonce, session, settings: s.protocols || {}, statuses, devices, selectedDevice, links, flashKey, engines, engine });

  const sshCard = `<div class="card"><p class="over">Transport principal</p><h2>SSH-WS / SSH-TCP</h2><p class="muted">SSH-WS est le transport prioritaire. L’adresse IP du VPS, le Host HTTP, le SNI et le payload sont distribués séparément aux clients. Les vendeurs ne peuvent pas modifier ces paramètres.</p>
  <form method="post" action="/admin/protocols/ssh">${hidden(session.csrf)}
  ${toggle('ssh_enabled','Activer SSH-TCP / SSH-WS',s.ssh_enabled)}
  <div class="row2">${field('ssh_tcp_port','Port du serveur SSH',s.ssh_tcp_port||2250,'number','Port réel du démon SSH DARK SURF.')}</div>
  <div class="row2">${field('ssh_ws_path','Chemin WebSocket SSH',s.ssh_ws_path||'/ws-ssh')}${field('ssh_ws_port','Port WebSocket SSH',s.ssh_ws_port||2084,'number','Port TCP du listener WS direct.')}</div>
  <div class="row2">${field('ssh_ws_host','Host HTTP / CloudFront',s.ssh_ws_host||'d2m44uilhgzazi.cloudfront.net')}</div>
  <label>Payload HTTP personnalisé<textarea name="ssh_ws_payload" rows="3" placeholder="GET /ws-ssh HTTP/1.1[crlf]Host: d2m44uilhgzazi.cloudfront.net[crlf]Upgrade: websocket[crlf][crlf]">${esc(s.ssh_ws_payload||'')}</textarea><small class="muted">Laisse vide pour générer automatiquement les en-têtes WebSocket obligatoires. Utilise [crlf] pour les retours à la ligne.</small></label>
  <div class="row2">${toggle('vless_enabled','Autoriser VLESS',s.vless_enabled!==false)}<label>Protocole essayé en premier (le client n'a aucun choix)<select name="default_protocol"><option value="ssh-ws" ${s.default_protocol==='ssh-ws' || !s.default_protocol?'selected':''}>SSH-WS (prioritaire)</option><option value="vless" ${s.default_protocol==='vless'?'selected':''}>VLESS</option><option value="ssh-tcp" ${s.default_protocol==='ssh-tcp'?'selected':''}>SSH-TCP</option></select></label></div>
  <button class="btn" type="submit">Appliquer au VPS</button></form></div>`;

  const mods = s.modules || {};
  const mrow = (key, label, hint) => `<div class="row2">${toggle(key + '_enabled', label, !!(mods[key] && mods[key].enabled))}${field(key + '_port', 'Port', (mods[key] && mods[key].port) || '', 'number', hint)}</div>`;
  const modulesCard = `<div class="card"><p class="over">Modules SSH</p><h2>SSH sur TLS · Dropbear · UDPGW</h2><p class="muted">Chaque module s'installe et se démarre sur le VPS quand tu l'actives, et s'arrête quand tu le coupes. Ils apparaissent ensuite dans la fiche SSH de chaque clé. Pense à ouvrir ces ports chez l'hébergeur.</p>
  <form method="post" action="/admin/protocols/modules">${hidden(session.csrf)}
  ${mrow('stunnel', 'Activer SSH sur TLS (Stunnel)', 'TCP, certificat auto-signé.')}
  ${mrow('dropbear', 'Activer Dropbear', 'TCP, deuxième serveur SSH léger.')}
  ${mrow('udpgw', 'Activer UDPGW (appels, jeux, DNS UDP)', 'Port local uniquement, joint à travers le tunnel SSH.')}
  <button class="btn" type="submit">Appliquer au VPS</button></form></div>`;
  const cdnHost = (settings && settings.host) || '';
  const cdnCard = `<div class="card"><p class="over">CloudFront (optionnel)</p><h2>Mettre ton serveur derrière un CDN</h2>
  <p class="muted">À faire dans la console AWS, une seule fois. Dans « Create distribution » :</p>
  <div class="scroll"><table><tbody>
  <tr><td class="muted">Origin domain</td><td class="mono">${esc(cdnHost)}</td></tr>
  <tr><td class="muted">Protocol</td><td>HTTPS only (port 443)</td></tr>
  <tr><td class="muted">Viewer protocol policy</td><td>HTTP and HTTPS (pas de redirection)</td></tr>
  <tr><td class="muted">Allowed HTTP methods</td><td>GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE</td></tr>
  <tr><td class="muted">Cache policy</td><td>CachingDisabled</td></tr>
  <tr><td class="muted">Origin request policy</td><td>AllViewerExceptHostHeader <span class="muted">(pas « AllViewer » : il enverrait le mauvais Host et donnerait une erreur 502)</span></td></tr>
  <tr><td class="muted">WAF</td><td>Do not enable security protections</td></tr>
  </tbody></table></div>
  <p class="muted">Quand la distribution est « Enabled », son nom (dxxxxxxxx.cloudfront.net) sert d'hôte devant ce serveur, pour le trafic WebSocket (VLESS ou SSH-WS).</p></div>`;
  const body = main.body.replace('</main>', sshCard + modulesCard + cdnCard + '</main>');
  return layout({ title: 'Protocoles VPN', body: header({ reseller: session.reseller, csrf: session.csrf, page: 'protocols' }) + body, nonce, css: main.css, script: COPY_JS });
}

module.exports = {
  loginPage, activationPage, sellPage, createdPage, keysPage, sshPage, rechargePage, devicesPage, creditsPage,
  adminDashboard, sellerNewPage, secretPage, sellerPage, clientsPage, clientPage, plansAdminPage, requestsPage, auditPage, noticesAdminPage, releasesAdminPage, protocolsAdminPage, messagePage, esc,
};
