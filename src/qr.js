// QR code en SVG pur (aucune dépendance réseau, aucun script côté navigateur).
// Basé sur qrcode-generator (MIT, Kazuhiko Arase) — voir src/vendor/qrcode.js.
const qrcode = require('./vendor/qrcode.js');

/**
 * Rend un QR code SVG inline.
 * @param {string} text  contenu à encoder
 * @param {object} opts  { size, margin, dark, light }
 */
function svg(text, opts = {}) {
  const size = opts.size || 220;
  const margin = opts.margin === undefined ? 2 : opts.margin;
  const dark = opts.dark || '#0b0f14';
  const light = opts.light || '#ffffff';
  let qr;
  try {
    qr = qrcode(0, 'M');
    qr.addData(String(text));
    qr.make();
  } catch (e) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 10 10" role="img" aria-label="QR indisponible"><rect width="10" height="10" fill="${light}"/><text x="5" y="5.6" font-size="1.2" text-anchor="middle" fill="#b00">QR</text></svg>`;
  }
  const n = qr.getModuleCount();
  const total = n + margin * 2;
  let cells = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) cells += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR code de configuration">` +
    `<rect width="${total}" height="${total}" fill="${light}"/><path d="${cells}" fill="${dark}"/></svg>`;
}

module.exports = { svg };
