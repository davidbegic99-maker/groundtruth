// GroundTruth — server-side static OpenStreetMap basemap for the PDF cluster map.
//
// Renders an OSM raster basemap for the bounding box of the located reports and
// composites the damage-tier points on top (green = Minimal, orange = Partial,
// red = Complete — matching the live dashboard), returning a JPEG that the PDF
// writer embeds through its existing DCTDecode image path.
//
// This module is ADDITIVE and ISOLATED. areaSummaryPDF() calls it inside a
// try/catch with an overall timeout; if anything here fails (tiles unavailable,
// network down, decode error, timeout) the PDF simply falls back to the
// schematic scatter. renderClusterMapJPEG() rejects on failure — it must never
// be allowed to take the PDF down with it.
//
// No new dependencies: OSM PNG tiles are decoded with a minimal built-in decoder
// (node:zlib for the inflate step) and the composite is JPEG-encoded with
// jpeg-js (already a dependency), so the result rides the proven photo-embed path.

import zlib from 'node:zlib';
import jpeg from 'jpeg-js';

const TILE = 256;
const OSM_LAND = [242, 239, 233]; // OSM land background — fills any missing tile

// Tile source (overridable so the prototype can point at a self-hosted/cached
// tile server, or — in tests — at an unreachable URL to force the fallback).
// Read at call time so it can be configured without restarting the module.
function tileTemplate() {
  return process.env.GT_OSM_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
}

// Damage-tier point colours (0–255 RGB), identical to the dashboard markers and
// the PDF's vector dots.
const TIER_RGB = {
  Minimal: [46, 125, 50],
  Partial: [249, 168, 37],
  Complete: [211, 47, 47],
};

// Tuning — kept deliberately modest to respect OSM's tile usage policy: a single
// PDF fetches only a handful of tiles at a sensible zoom.
const TARGET_PX_W = 1024; // desired basemap width in pixels (zoom is chosen to suit)
const MAX_PX = 1600;      // hard cap on either raster dimension
const TILE_BUDGET = 20;   // max tiles fetched for one map
const PER_TILE_MS = 4000; // (advisory) per-tile budget; overall timeout governs

// ---------------------------------------------------------------------------
// Public: render the cluster basemap to a JPEG. Rejects on any failure.
// `located` = reports with non-null lat/lon. Returns { jpeg, width, height }.
// ---------------------------------------------------------------------------
export async function renderClusterMapJPEG(located, opts = {}) {
  if (!Array.isArray(located) || located.length === 0) throw new Error('no located reports');
  const aspect = opts.aspect || 516 / 150;
  const timeoutMs = opts.timeoutMs || 8000;

  // 1. Degree bounding box with schematic-style padding (so a single point or a
  //    tight cluster still renders with context).
  const lats = located.map((r) => r.lat);
  const lons = located.map((r) => r.lon);
  let minLat = Math.min(...lats), maxLat = Math.max(...lats);
  let minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const padLat = (maxLat - minLat) * 0.15 || 0.0015;
  const padLon = (maxLon - minLon) * 0.15 || 0.0015;
  minLat -= padLat; maxLat += padLat; minLon -= padLon; maxLon += padLon;
  minLat = Math.max(-85.05, minLat); maxLat = Math.min(85.05, maxLat);

  // 2. Normalised Web-Mercator box, expanded to the target aspect so the basemap
  //    is never stretched.
  let nx0 = lonToNX(minLon), nx1 = lonToNX(maxLon);
  let ny0 = latToNY(maxLat), ny1 = latToNY(minLat); // ny0 (top) < ny1 (bottom)
  let wn = nx1 - nx0, hn = ny1 - ny0;
  const cx = (nx0 + nx1) / 2, cy = (ny0 + ny1) / 2;
  if (wn / hn < aspect) wn = hn * aspect; else hn = wn / aspect;
  nx0 = cx - wn / 2; nx1 = cx + wn / 2;
  ny0 = cy - hn / 2; ny1 = cy + hn / 2;

  // 3. Choose a zoom that lands near TARGET_PX_W, then back off until the raster
  //    size and tile count are within budget.
  let z = Math.round(Math.log2(TARGET_PX_W / (wn * TILE)));
  z = Math.max(2, Math.min(18, z));
  let worldSize, gx0, gy0, gx1, gy1, pxW, pxH, txMin, txMax, tyMin, tyMax;
  for (; z >= 2; z--) {
    worldSize = TILE * Math.pow(2, z);
    gx0 = nx0 * worldSize; gx1 = nx1 * worldSize;
    gy0 = ny0 * worldSize; gy1 = ny1 * worldSize;
    pxW = Math.round(gx1 - gx0); pxH = Math.round(gy1 - gy0);
    txMin = Math.floor(gx0 / TILE); txMax = Math.floor((gx1 - 1e-6) / TILE);
    tyMin = Math.floor(gy0 / TILE); tyMax = Math.floor((gy1 - 1e-6) / TILE);
    const tiles = (txMax - txMin + 1) * (tyMax - tyMin + 1);
    if (pxW >= 2 && pxH >= 2 && pxW <= MAX_PX && pxH <= MAX_PX && tiles <= TILE_BUDGET) break;
  }
  if (!(pxW >= 2 && pxH >= 2)) throw new Error('degenerate map size');

  // 4. Canvas (RGBA), prefilled with the OSM land colour so gaps blend in.
  const canvas = new Uint8Array(pxW * pxH * 4);
  for (let i = 0; i < pxW * pxH; i++) {
    canvas[i * 4] = OSM_LAND[0];
    canvas[i * 4 + 1] = OSM_LAND[1];
    canvas[i * 4 + 2] = OSM_LAND[2];
    canvas[i * 4 + 3] = 255;
  }

  // 5. Fetch + stitch tiles under one overall timeout.
  const nTiles = Math.pow(2, z);
  const ac = new AbortController();
  const overall = setTimeout(() => ac.abort(), timeoutMs);
  let toFetch = 0, ok = 0;
  const jobs = [];
  try {
    for (let tx = txMin; tx <= txMax; tx++) {
      for (let ty = tyMin; ty <= tyMax; ty++) {
        if (ty < 0 || ty >= nTiles) continue; // off the top/bottom of the world
        const wx = ((tx % nTiles) + nTiles) % nTiles;
        toFetch++;
        const ox = Math.round(tx * TILE - gx0);
        const oy = Math.round(ty * TILE - gy0);
        jobs.push(
          fetchTile(z, wx, ty, ac.signal)
            .then((png) => { blit(canvas, pxW, pxH, decodePNG(png), ox, oy); ok++; })
            .catch(() => { /* leave this tile land-filled */ })
        );
      }
    }
    await Promise.all(jobs);
  } finally {
    clearTimeout(overall);
  }
  // Require a real basemap: most tiles must have arrived, else fall back.
  if (ok === 0 || ok < Math.ceil(toFetch / 2)) throw new Error(`insufficient tiles (${ok}/${toFetch})`);

  // 6. Composite the damage-tier points (white outline + tier core, like the
  //    dashboard markers; a dark halo keeps them legible over any basemap).
  const RI = Math.max(4, Math.round(pxW * 0.006));
  const RO = RI + Math.max(2, Math.round(pxW * 0.0025));
  for (const r of located) {
    const px = lonToNX(r.lon) * worldSize - gx0;
    const py = latToNY(r.lat) * worldSize - gy0;
    if (px < -RO || py < -RO || px > pxW + RO || py > pxH + RO) continue;
    const col = TIER_RGB[r.damage_classification] || [119, 119, 119];
    fillCircle(canvas, pxW, pxH, px, py, RO + 1, [70, 78, 90]); // dark halo
    fillCircle(canvas, pxW, pxH, px, py, RO, [255, 255, 255]);  // white outline
    fillCircle(canvas, pxW, pxH, px, py, RI, col);              // tier core
  }

  // 7. Encode to JPEG (3-component YCbCr → DeviceRGB, the same kind the PDF photo
  //    path already embeds successfully). Validate the SOF marker is present so
  //    the PDF's image embed (which reads it) can never throw downstream.
  const enc = jpeg.encode({ data: Buffer.from(canvas), width: pxW, height: pxH }, 82);
  if (!hasSOF(enc.data)) throw new Error('encoded JPEG missing SOF marker');
  return {
    jpeg: enc.data,
    width: pxW,
    height: pxH,
    zoom: z,
    tiles: toFetch,
    tilesOk: ok,
    attribution: '(c) OpenStreetMap contributors',
  };
}

// ---------------------------------------------------------------------------
// Tile fetch
// ---------------------------------------------------------------------------
async function fetchTile(z, x, y, signal) {
  const url = tileTemplate().replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const res = await fetch(url, {
    signal,
    headers: {
      // OSM tile usage policy requires a valid identifying User-Agent.
      'User-Agent': 'GroundTruth/0.1 (UNDP community crisis-mapping prototype; +https://github.com/)',
      'Accept': 'image/png,image/*;q=0.8',
      'Referer': 'https://groundtruth.undp.example/',
    },
  });
  if (!res.ok) throw new Error('tile HTTP ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Web-Mercator helpers (normalised [0,1] coordinates; multiply by worldSize for
// pixels at a given zoom).
// ---------------------------------------------------------------------------
function lonToNX(lon) { return (lon + 180) / 360; }
function latToNY(lat) {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}

// ---------------------------------------------------------------------------
// Raster compositing
// ---------------------------------------------------------------------------
function blit(canvas, cw, ch, img, ox, oy) {
  for (let j = 0; j < img.height; j++) {
    const y = oy + j;
    if (y < 0 || y >= ch) continue;
    for (let i = 0; i < img.width; i++) {
      const x = ox + i;
      if (x < 0 || x >= cw) continue;
      const s = (j * img.width + i) * 4;
      const d = (y * cw + x) * 4;
      const a = img.rgba[s + 3];
      if (a === 255) {
        canvas[d] = img.rgba[s]; canvas[d + 1] = img.rgba[s + 1]; canvas[d + 2] = img.rgba[s + 2];
      } else if (a > 0) {
        const af = a / 255;
        canvas[d] = Math.round(img.rgba[s] * af + canvas[d] * (1 - af));
        canvas[d + 1] = Math.round(img.rgba[s + 1] * af + canvas[d + 1] * (1 - af));
        canvas[d + 2] = Math.round(img.rgba[s + 2] * af + canvas[d + 2] * (1 - af));
      }
      canvas[d + 3] = 255;
    }
  }
}

function fillCircle(canvas, cw, ch, cx, cy, r, col) {
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(cw - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(ch - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        const d = (y * cw + x) * 4;
        canvas[d] = col[0]; canvas[d + 1] = col[1]; canvas[d + 2] = col[2]; canvas[d + 3] = 255;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal PNG decoder — 8-bit, non-interlaced; colour types 0/2/3/4/6.
// OSM standard tiles are 8-bit paletted (type 3). Anything outside this throws,
// which simply drops that tile (and, if too many drop, triggers the fallback).
// ---------------------------------------------------------------------------
function decodePNG(buf) {
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error('not a PNG');
  }
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos); pos += 4;
    const type = buf.toString('latin1', pos, pos + 4); pos += 4;
    const data = buf.subarray(pos, pos + len); pos += len + 4; // + CRC
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!width || !height) throw new Error('bad IHDR');
  if (interlace !== 0) throw new Error('interlaced PNG unsupported');
  if (bitDepth !== 8) throw new Error('bit depth ' + bitDepth + ' unsupported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('colour type ' + colorType + ' unsupported');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels, stride = width * bpp;
  if (raw.length < (stride + 1) * height) throw new Error('short IDAT');

  // Un-filter scanlines in place.
  const px = Buffer.alloc(stride * height);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const base = y * stride, pbase = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[rp++];
      const a = x >= bpp ? px[base + x - bpp] : 0;
      const b = y > 0 ? px[pbase + x] : 0;
      const c = (y > 0 && x >= bpp) ? px[pbase + x - bpp] : 0;
      let out;
      switch (filter) {
        case 0: out = v; break;
        case 1: out = v + a; break;
        case 2: out = v + b; break;
        case 3: out = v + ((a + b) >> 1); break;
        case 4: out = v + paeth(a, b, c); break;
        default: throw new Error('bad filter ' + filter);
      }
      px[base + x] = out & 0xff;
    }
  }

  // Expand to RGBA.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++) {
    const o = i * bpp;
    let r, g, b, al = 255;
    if (colorType === 2) { r = px[o]; g = px[o + 1]; b = px[o + 2]; }
    else if (colorType === 6) { r = px[o]; g = px[o + 1]; b = px[o + 2]; al = px[o + 3]; }
    else if (colorType === 0) { r = g = b = px[o]; }
    else if (colorType === 4) { r = g = b = px[o]; al = px[o + 1]; }
    else { // palette (type 3)
      if (!palette) throw new Error('palette missing');
      const idx = px[o];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) al = trns[idx];
    }
    rgba[p++] = r; rgba[p++] = g; rgba[p++] = b; rgba[p++] = al;
  }
  return { width, height, rgba };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// True when the JPEG has a baseline/progressive Start-Of-Frame marker — i.e. the
// PDF's jpegSize() reader (and DCTDecode) will accept it.
function hasSOF(buf) {
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return true;
    if (m === 0xd9) break; // EOI
    i += 2 + (buf.readUInt16BE(i + 2) || 0);
  }
  return false;
}
