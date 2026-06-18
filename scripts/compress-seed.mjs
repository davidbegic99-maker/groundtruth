// ONE-TIME build helper — compress the raw ./seed-photos into committed demo assets.
//
// Reads ./seed-photos/1.jpg .. 10.jpg, downscales the longest edge to <=1100px
// (honouring EXIF orientation), re-encodes as JPEG, and writes the result to
// server/seed-assets/1.jpg .. 10.jpg. The compressed bytes are what get BOTH
// classified by the AI (scripts/classify-seed.mjs) AND committed to the repo, so
// the AI sees exactly the bytes the demo ships — and reseeding never needs the
// large raw originals.
//
// Pure Node (jpeg-js + exifr, already project deps) — no native build, no key.
//
// Usage:  node scripts/compress-seed.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import * as exifr from 'exifr';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..', 'seed-photos');
const OUT_DIR = join(__dirname, '..', 'server', 'seed-assets');
const MAX_EDGE = 1100;
const QUALITY = 70;

if (!existsSync(SRC_DIR)) {
  console.error(`No ./seed-photos directory — nothing to compress. (${SRC_DIR})`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

// Apply an EXIF orientation (1..8) to an RGBA {width,height,data} image so the
// stored pixels are upright (jpeg-js ignores EXIF, so phone photos can be sideways).
function applyOrientation(img, o) {
  if (!o || o === 1) return img;
  const { width: w, height: h, data: s } = img;
  const get = (x, y) => ((y * w + x) * 4);
  let tw = w, th = h;
  if (o >= 5) { tw = h; th = w; } // 90deg rotations swap dimensions
  const d = new Uint8Array(tw * th * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx, ny;
      switch (o) {
        case 2: nx = w - 1 - x; ny = y; break;            // mirror horizontal
        case 3: nx = w - 1 - x; ny = h - 1 - y; break;     // 180
        case 4: nx = x; ny = h - 1 - y; break;             // mirror vertical
        case 5: nx = y; ny = x; break;                     // transpose
        case 6: nx = th - 1 - y; ny = x; break;            // 90 CW
        case 7: nx = th - 1 - y; ny = tw - 1 - x; break;   // transverse
        case 8: nx = y; ny = tw - 1 - x; break;            // 90 CCW
        default: nx = x; ny = y;
      }
      const si = get(x, y);
      const di = (ny * tw + nx) * 4;
      d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = s[si + 3];
    }
  }
  return { width: tw, height: th, data: d };
}

// Area-average downscale (good quality for large reductions). Never upscales.
function downscale(img, maxEdge) {
  const { width: sw, height: sh, data: sd } = img;
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  if (scale >= 1) return img;
  const tw = Math.max(1, Math.round(sw * scale));
  const th = Math.max(1, Math.round(sh * scale));
  const td = new Uint8Array(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    const sy0 = Math.floor((ty * sh) / th);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * sh) / th));
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = Math.floor((tx * sw) / tw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * sw) / tw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * sw + sx) * 4;
          r += sd[i]; g += sd[i + 1]; b += sd[i + 2]; a += sd[i + 3]; n++;
        }
      }
      const j = (ty * tw + tx) * 4;
      td[j] = Math.round(r / n); td[j + 1] = Math.round(g / n);
      td[j + 2] = Math.round(b / n); td[j + 3] = Math.round(a / n);
    }
  }
  return { width: tw, height: th, data: td };
}

const report = [];
for (let i = 1; i <= 10; i++) {
  const srcPath = join(SRC_DIR, `${i}.jpg`);
  if (!existsSync(srcPath)) { console.warn(`skip ${i}.jpg — not found`); continue; }
  const raw = readFileSync(srcPath);
  let orientation = 1;
  try { orientation = (await exifr.orientation(raw)) || 1; } catch (_) { /* no exif */ }
  const decoded = jpeg.decode(raw, { useTArray: true, maxResolutionInMP: 200, maxMemoryUsageInMB: 2048, formatAsRGBA: true });
  const upright = applyOrientation({ width: decoded.width, height: decoded.height, data: decoded.data }, orientation);
  const small = downscale(upright, MAX_EDGE);
  const enc = jpeg.encode({ data: small.data, width: small.width, height: small.height }, QUALITY);
  const outPath = join(OUT_DIR, `${i}.jpg`);
  writeFileSync(outPath, enc.data);
  const kb = (enc.data.length / 1024).toFixed(0);
  report.push({ file: `${i}.jpg`, orientation, from: `${decoded.width}x${decoded.height}`, to: `${small.width}x${small.height}`, kb: Number(kb) });
  console.log(`${i}.jpg  ${decoded.width}x${decoded.height} -> ${small.width}x${small.height}  (orient ${orientation})  ${kb} KB`);
}
console.log(`\nCompressed ${report.length} photos into server/seed-assets/`);
