// GroundTruth — PDF area summary (Step 6, briefing §13.3).
//
// A printable, shareable cluster summary for field coordinators who have no GIS
// software. Built with a tiny dependency-free PDF writer (no PDFKit/Puppeteer
// needed — keeps the prototype install light and reliable). One Letter page.
//
// Contents per §13.3: a schematic local map of the cluster, a damage-tier
// breakdown bar chart, infrastructure types affected, the dominant hazard type,
// the time range, and a photo thumbnail from the highest-confidence report.
//
// The PDF is generated in English (the operational lingua franca for field
// coordinators) so no CJK/Arabic font embedding is required.

import { getRows } from './exports.js';
import { getPhoto } from './photos.js';
import { renderClusterMapJPEG } from './staticmap.js';

const W = 612, H = 792; // US Letter, points
const MARGIN = 48;

// ---------------------------------------------------------------------------
// Public entry: build the area-summary PDF for a filtered set of reports.
// `meta` may carry { title, areaLabel }.
// ---------------------------------------------------------------------------
export async function areaSummaryPDF(filters = {}, meta = {}) {
  const rows = getRows(filters);
  const doc = new Pdf();

  let y = H - MARGIN; // top-down cursor (PDF y grows upward; we convert)

  // Header
  doc.text(MARGIN, y, 'GroundTruth — Area Damage Summary', { size: 20, bold: true });
  y -= 24;
  doc.text(MARGIN, y, meta.title || 'UNDP crisis damage report cluster', { size: 11, color: GREY });
  y -= 14;
  doc.text(MARGIN, y, `Generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`, { size: 9, color: GREY });
  y -= 10;
  doc.line(MARGIN, y, W - MARGIN, y, GREY_LINE);
  y -= 20;

  // Tier counts
  const tiers = { Minimal: 0, Partial: 0, Complete: 0 };
  rows.forEach((r) => { if (tiers[r.damage_classification] != null) tiers[r.damage_classification]++; });
  const total = rows.length;

  // Headline stats
  doc.text(MARGIN, y, `${total} report${total === 1 ? '' : 's'} in this area`, { size: 13, bold: true });
  y -= 16;
  const priority = rows.filter((r) => r.priority_flag).length;
  const conflict = rows.filter((r) => r.conflict_flag).length;
  doc.text(MARGIN, y, `Priority (people in danger): ${priority}    Classification conflicts: ${conflict}`, { size: 10, color: GREY });
  y -= 24;

  // --- Damage tier breakdown bar chart ---
  doc.text(MARGIN, y, 'Damage tier breakdown', { size: 12, bold: true });
  y -= 16;
  const chartTop = y, barH = 16, gap = 10, maxBarW = 300, labelW = 78;
  const maxCount = Math.max(1, tiers.Minimal, tiers.Partial, tiers.Complete);
  const order = [['Minimal', TIER.Minimal], ['Partial', TIER.Partial], ['Complete', TIER.Complete]];
  order.forEach(([name, color], i) => {
    const by = chartTop - i * (barH + gap);
    const count = tiers[name];
    const w = (count / maxCount) * maxBarW;
    doc.text(MARGIN, by - 12, name, { size: 10 });
    doc.rect(MARGIN + labelW, by - barH, maxBarW, barH, { fill: BAR_BG });
    if (w > 0) doc.rect(MARGIN + labelW, by - barH, w, barH, { fill: color });
    doc.text(MARGIN + labelW + Math.max(w, 0) + 6, by - 12, String(count), { size: 10, bold: true });
  });
  y = chartTop - 3 * (barH + gap) - 8;

  // --- Local cluster map -----------------------------------------------------
  // A real OpenStreetMap basemap of the cluster with the report points drawn on
  // it by damage tier (green=Minimal, orange=Partial, red=Complete), matching the
  // live dashboard. This map-image step is ADDITIVE and ISOLATED: if it fails for
  // ANY reason (tiles unavailable, network issue, timeout, render error) the PDF
  // still generates — falling back to the original schematic scatter below. A map
  // failure must NEVER block or corrupt PDF generation.
  const located = rows.filter((r) => r.lat != null && r.lon != null);
  const mapH = 150, mapW = W - 2 * MARGIN;

  let mapImg = null;
  if (located.length) {
    try {
      mapImg = await renderClusterMapJPEG(located, { aspect: mapW / mapH, timeoutMs: 8000 });
    } catch (_) { mapImg = null; /* fall through to the schematic fallback */ }
  }

  let mapDrawn = false;
  if (mapImg) {
    // Roll back to a clean state if anything below throws, so a failed map can
    // never leave partial ops behind — the schematic then renders exactly as before.
    const opMark = doc.ops.length, imgMark = doc.images.length, yMark = y;
    try {
      doc.text(MARGIN, y, 'Cluster map (OpenStreetMap basemap — points by damage tier)', { size: 12, bold: true });
      const mapBottom = (y - 8) - mapH;
      doc.image(mapImg.jpeg, mapImg.width, mapImg.height, MARGIN, mapBottom, mapW, mapH);
      doc.rect(MARGIN, mapBottom, mapW, mapH, { stroke: GREY_LINE });
      // Keep the "X located / Y without coordinates" note, on a light strip so it
      // stays legible over the basemap.
      const note = `${located.length} located - ${total - located.length} without coordinates`;
      doc.rect(MARGIN + 4, mapBottom + 4, note.length * 4.4 + 8, 12, { fill: WHITE });
      doc.text(MARGIN + 8, mapBottom + 6, note, { size: 8, color: GREY });
      // OSM attribution (required by the tile usage policy).
      const attr = mapImg.attribution || '(c) OpenStreetMap contributors';
      const aw = attr.length * 4.4 + 8;
      doc.rect(W - MARGIN - aw - 4, mapBottom + 4, aw, 12, { fill: WHITE });
      doc.text(W - MARGIN - aw, mapBottom + 6, attr, { size: 8, color: GREY });
      y = mapBottom - 24;
      mapDrawn = true;
    } catch (_) {
      doc.ops.length = opMark; doc.images.length = imgMark; y = yMark; mapDrawn = false;
    }
  }

  if (!mapDrawn) {
    // Schematic fallback (vector scatter, no tiles) — unchanged from the original.
    doc.text(MARGIN, y, 'Cluster map (schematic — points by damage tier)', { size: 12, bold: true });
    y -= 8;
    const mapTop = y, mapBottom = y - mapH;
    doc.rect(MARGIN, mapBottom, mapW, mapH, { stroke: GREY_LINE });
    if (located.length) {
      const lats = located.map((r) => r.lat), lons = located.map((r) => r.lon);
      let minLat = Math.min(...lats), maxLat = Math.max(...lats);
      let minLon = Math.min(...lons), maxLon = Math.max(...lons);
      // pad so single-point / tight clusters still render sensibly
      const padLat = (maxLat - minLat) * 0.15 || 0.0008;
      const padLon = (maxLon - minLon) * 0.15 || 0.0008;
      minLat -= padLat; maxLat += padLat; minLon -= padLon; maxLon += padLon;
      const pad = 10;
      located.forEach((r) => {
        const px = MARGIN + pad + ((r.lon - minLon) / (maxLon - minLon)) * (mapW - 2 * pad);
        const py = mapBottom + pad + ((r.lat - minLat) / (maxLat - minLat)) * (mapH - 2 * pad);
        doc.dot(px, py, 4, TIER[r.damage_classification] || GREY);
      });
      doc.text(MARGIN + 6, mapBottom + 6, `${located.length} located • ${total - located.length} without coordinates`, { size: 8, color: GREY });
    } else {
      doc.text(MARGIN + 10, mapTop - mapH / 2, 'No located reports in this selection.', { size: 10, color: GREY });
    }
    y = mapBottom - 24;
  }

  // --- Two columns: infrastructure types + dominant hazard / time range ---
  const colY = y;
  doc.text(MARGIN, colY, 'Infrastructure affected', { size: 12, bold: true });
  const infra = countBy(rows, 'infrastructure_type');
  let iy = colY - 16;
  Object.entries(infra).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    doc.text(MARGIN, iy, `• ${shortInfra(k)}: ${v}`, { size: 10 });
    iy -= 13;
  });
  if (!Object.keys(infra).length) { doc.text(MARGIN, iy, '—', { size: 10, color: GREY }); iy -= 13; }

  const col2 = MARGIN + 280;
  doc.text(col2, colY, 'Hazard & time range', { size: 12, bold: true });
  const haz = countBy(rows, 'hazard_type');
  const dominantHaz = Object.entries(haz).sort((a, b) => b[1] - a[1])[0];
  const times = rows.map((r) => r.timestamp).filter(Boolean).sort();
  doc.text(col2, colY - 16, `Dominant hazard: ${dominantHaz ? dominantHaz[0] : '—'}`, { size: 10 });
  doc.text(col2, colY - 29, `From: ${times[0] ? times[0].replace('T', ' ').slice(0, 16) : '—'}`, { size: 10 });
  doc.text(col2, colY - 42, `To:   ${times.length ? times[times.length - 1].replace('T', ' ').slice(0, 16) : '—'}`, { size: 10 });

  // --- Photo thumbnail from the highest-confidence report ---
  const best = rows
    .filter((r) => r.photo_hash_1)
    .sort((a, b) => (b.ai_confidence || 0) - (a.ai_confidence || 0))[0];
  let photoBottom = Math.min(iy, colY - 55) - 10;
  if (best) {
    const p = safeGetPhoto(best.photo_hash_1);
    if (p) {
      const dims = jpegSize(p.data) || { w: p.width || 120, h: p.height || 90 };
      const dispW = 120, dispH = Math.max(40, Math.round((dims.h / dims.w) * dispW));
      const top = photoBottom;
      doc.text(MARGIN, top, 'Representative photo (highest-confidence report)', { size: 10, bold: true });
      try {
        doc.image(p.data, dims.w, dims.h, MARGIN, top - 14 - dispH, dispW, dispH);
        doc.text(MARGIN + dispW + 12, top - 26, `Damage: ${best.damage_classification || '—'}`, { size: 9 });
        doc.text(MARGIN + dispW + 12, top - 39, `AI confidence: ${best.ai_confidence != null ? Math.round(best.ai_confidence * 100) + '%' : '—'}`, { size: 9 });
        doc.text(MARGIN + dispW + 12, top - 52, `Hazard: ${best.hazard_type || '—'}`, { size: 9 });
        photoBottom = top - 14 - dispH;
      } catch (_) { /* image embed failed — skip gracefully */ }
    }
  }

  // Footer
  doc.text(MARGIN, MARGIN - 16, 'GroundTruth — UNDP community crisis mapping prototype. Anonymous reports; no personal data.', { size: 8, color: GREY });

  return doc.render(W, H);
}

// ---------------------------------------------------------------------------
// Auto-trigger detection (§13.3): clusters that reach the configurable
// threshold (default 5 reports within 200 m). Returns cluster centres so the
// dashboard can flag "a PDF summary is available" and offer the download.
// ---------------------------------------------------------------------------
export function autoPdfClusters(thresholdCount, radiusM) {
  const rows = getRows({}).filter((r) => r.lat != null && r.lon != null);
  const clusters = [];
  const used = new Set();
  for (let i = 0; i < rows.length; i++) {
    if (used.has(i)) continue;
    const group = [rows[i]];
    for (let j = 0; j < rows.length; j++) {
      if (j === i || used.has(j)) continue;
      if (haversine(rows[i].lat, rows[i].lon, rows[j].lat, rows[j].lon) <= radiusM) group.push(rows[j]);
    }
    if (group.length >= thresholdCount) {
      group.forEach((g) => used.add(rows.indexOf(g)));
      const lat = group.reduce((s, r) => s + r.lat, 0) / group.length;
      const lon = group.reduce((s, r) => s + r.lon, 0) / group.length;
      clusters.push({ lat, lon, count: group.length, radius_m: radiusM });
    }
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function safeGetPhoto(hash) { try { return getPhoto(hash); } catch (_) { return null; } }
function countBy(rows, key) {
  const o = {};
  rows.forEach((r) => { const v = r[key]; if (v) o[v] = (o[v] || 0) + 1; });
  return o;
}
function shortInfra(s) { return String(s).replace(' Infrastructure', '').replace(' Building', ''); }
function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Minimal JPEG dimension + component reader (SOF0/1/2 markers).
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), comps: buf[i + 9] };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const TIER = { Minimal: [0.18, 0.49, 0.20], Partial: [0.98, 0.66, 0.14], Complete: [0.83, 0.18, 0.18] };
const GREY = [0.42, 0.45, 0.50];
const GREY_LINE = [0.80, 0.84, 0.88];
const BAR_BG = [0.93, 0.95, 0.97];
const WHITE = [1, 1, 1];

// ===========================================================================
// Tiny PDF writer — text (Helvetica), rectangles, lines, dots, JPEG images.
// ===========================================================================
class Pdf {
  constructor() { this.ops = []; this.images = []; }

  _col(c, op) { const [r, g, b] = c; return `${f(r)} ${f(g)} ${f(b)} ${op}`; }

  text(x, y, str, { size = 11, bold = false, color = [0, 0, 0] } = {}) {
    this.ops.push(
      `${this._col(color, 'rg')}`,
      `BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${f(x)} ${f(y)} Tm (${esc(str)}) Tj ET`
    );
  }
  rect(x, y, w, h, { fill, stroke } = {}) {
    if (fill) this.ops.push(`${this._col(fill, 'rg')}`, `${f(x)} ${f(y)} ${f(w)} ${f(h)} re f`);
    if (stroke) this.ops.push(`${this._col(stroke, 'RG')}`, `${f(x)} ${f(y)} ${f(w)} ${f(h)} re S`);
  }
  line(x1, y1, x2, y2, color = [0, 0, 0]) {
    this.ops.push(`${this._col(color, 'RG')}`, `${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l S`);
  }
  dot(cx, cy, r, color) {
    // approximate a filled circle with a Bézier path
    const k = 0.5523 * r;
    this.ops.push(
      `${this._col(color, 'rg')}`,
      `${f(cx + r)} ${f(cy)} m`,
      `${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c`,
      `${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} c`,
      `${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c`,
      `${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} c f`
    );
  }
  image(data, srcW, srcH, x, y, w, h) {
    const comps = (jpegSize(data) || {}).comps;
    const cs = comps === 1 ? 'DeviceGray' : 'DeviceRGB';
    const name = 'Im' + this.images.length;
    this.images.push({ name, data, w: srcW, h: srcH, cs });
    this.ops.push('q', `${f(w)} 0 0 ${f(h)} ${f(x)} ${f(y)} cm /${name} Do`, 'Q');
  }

  render(width, height) {
    const objs = []; // index = obj number - 1
    const content = Buffer.from(this.ops.join('\n'), 'latin1');

    const xobjEntries = this.images.map((im, i) => `/${im.name} ${7 + i} 0 R`).join(' ');
    const resources =
      `/Font << /F1 5 0 R /F2 6 0 R >>` + (this.images.length ? ` /XObject << ${xobjEntries} >>` : '');

    objs[0] = buf(`<< /Type /Catalog /Pages 2 0 R >>`);
    objs[1] = buf(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
    objs[2] = buf(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << ${resources} >> /Contents 4 0 R >>`);
    objs[3] = Buffer.concat([buf(`<< /Length ${content.length} >>\nstream\n`, true), content, buf(`\nendstream`, true)]);
    objs[4] = buf(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
    objs[5] = buf(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
    this.images.forEach((im, i) => {
      const dict = `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /${im.cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>`;
      objs[6 + i] = Buffer.concat([buf(`${dict}\nstream\n`, true), im.data, buf(`\nendstream`, true)]);
    });

    // Assemble with byte offsets for the xref table.
    let out = Buffer.from('%PDF-1.4\n%\xff\xff\xff\xff\n', 'latin1');
    const offsets = [];
    objs.forEach((body, i) => {
      offsets[i] = out.length;
      out = Buffer.concat([out, buf(`${i + 1} 0 obj\n`, true), body, buf(`\nendobj\n`, true)]);
    });
    const xrefStart = out.length;
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach((o) => { xref += String(o).padStart(10, '0') + ' 00000 n \n'; });
    xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    return Buffer.concat([out, buf(xref, true)]);
  }
}

function buf(s) { return Buffer.from(s, 'latin1'); }
function f(n) { return (Math.round(n * 100) / 100).toString(); }
function esc(s) { return String(s).replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, ''); }
