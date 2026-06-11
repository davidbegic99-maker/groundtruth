// GroundTruth — post-sync AI deduplication (§4.3).
//
// Runs asynchronously after sync. NEVER blocks a submission and NEVER deletes a
// record. It groups reports for the same location (they already share a
// building_id via the §4.2 versioning step), computes a perceptual hash of each
// photo for near-duplicate detection, and writes a human-readable analyst
// annotation for any location with more than one report — exactly the format in
// the briefing example.
//
// Perceptual hashing uses a small average-hash (8×8 grayscale) computed with
// jpeg-js. If jpeg-js is unavailable the spatial/temporal grouping and the
// annotation still work; only the perceptual signal is skipped (fails safe).

import { db, getSettingNumber } from './db.js';
import { getPhoto } from './photos.js';

let jpeg = null;
try { jpeg = (await import('jpeg-js')).default; } catch (_) { /* perceptual hashing disabled */ }

// ---------------------------------------------------------------------------
// Perceptual (average) hash → 64-bit value as 16 hex chars.
// ---------------------------------------------------------------------------
export function perceptualHash(jpegBuffer) {
  if (!jpeg) return null;
  let img;
  try { img = jpeg.decode(jpegBuffer, { useTArray: true, maxResolutionInMP: 50 }); }
  catch (_) { return null; }
  const N = 8;
  const gray = new Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x + 0.5) * img.width / N));
      const sy = Math.min(img.height - 1, Math.floor((y + 0.5) * img.height / N));
      const i = (sy * img.width + sx) * 4;
      gray[y * N + x] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    }
  }
  const mean = gray.reduce((a, b) => a + b, 0) / gray.length;
  let bits = 0n;
  for (let i = 0; i < gray.length; i++) if (gray[i] >= mean) bits |= (1n << BigInt(i));
  return bits.toString(16).padStart(16, '0');
}

export function hamming(a, b) {
  if (!a || !b) return 64;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let c = 0;
  while (x) { c += Number(x & 1n); x >>= 1n; }
  return c;
}

// ---------------------------------------------------------------------------
// Backfill perceptual hashes for records that have a photo but no hash yet.
// ---------------------------------------------------------------------------
function backfillHashes() {
  if (!jpeg) return 0;
  const rows = db
    .prepare('SELECT submission_id, photo_hash_1 FROM submissions WHERE photo_hash_1 IS NOT NULL AND perceptual_hash IS NULL')
    .all();
  const upd = db.prepare('UPDATE submissions SET perceptual_hash = ? WHERE submission_id = ?');
  let n = 0;
  for (const r of rows) {
    try {
      const p = getPhoto(r.photo_hash_1);
      if (!p) continue;
      const ph = perceptualHash(Buffer.from(p.data));
      if (ph) { upd.run(ph, r.submission_id); n++; }
    } catch (_) { /* skip unreadable photo */ }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Main entry: run after sync. Returns a small summary.
// ---------------------------------------------------------------------------
export function runDedup() {
  const hashesComputed = backfillHashes();
  const temporalHours = getSettingNumber('dedup_temporal_hours') ?? 2;

  // Same-location grouping reuses building_id (assigned by §4.2 versioning).
  const buildings = db
    .prepare('SELECT DISTINCT building_id FROM submissions WHERE building_id IS NOT NULL')
    .all()
    .map((r) => r.building_id);

  const upd = db.prepare('UPDATE submissions SET cluster_id = ?, dedup_annotation = ? WHERE building_id = ?');
  let annotated = 0;

  for (const bId of buildings) {
    const reports = db
      .prepare(
        `SELECT submission_id, timestamp, damage_classification, perceptual_hash
         FROM submissions WHERE building_id = ? ORDER BY timestamp ASC`
      )
      .all(bId);
    if (reports.length < 2) continue;

    const annotation = buildAnnotation(reports, temporalHours);
    upd.run(bId, annotation, bId);
    annotated++;
  }

  return { hashesComputed, clustersAnnotated: annotated, perceptualEnabled: !!jpeg };
}

// ---------------------------------------------------------------------------
// Annotation text — matches the briefing's example phrasing.
// ---------------------------------------------------------------------------
function buildAnnotation(reports, temporalHours) {
  const times = reports.map((r) => r.timestamp).filter(Boolean).sort();
  const first = times[0], last = times[times.length - 1];
  const counts = { Minimal: 0, Partial: 0, Complete: 0 };
  reports.forEach((r) => { if (counts[r.damage_classification] != null) counts[r.damage_classification]++; });
  const mostRecent = [...reports].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))[0];

  const breakdown = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} x${n}`)
    .join(', ');

  const distinctTiers = Object.values(counts).filter((n) => n > 0).length;
  const span = spanHours(first, last);

  // Perceptual near-duplicate note: how many share a near-identical photo.
  const hashes = reports.map((r) => r.perceptual_hash).filter(Boolean);
  let dupNote = '';
  if (hashes.length >= 2) {
    let near = 0;
    for (let i = 0; i < hashes.length; i++)
      for (let j = i + 1; j < hashes.length; j++)
        if (hamming(hashes[i], hashes[j]) <= 10) near++;
    if (near > 0) dupNote = ' Some photos appear visually near-identical (possible re-submission).';
  }

  const conflict = distinctTiers > 1
    ? ' Recommend field verification — conflicting classifications suggest evolving damage.'
    : '';
  const within = span <= temporalHours
    ? ` (within a ${temporalHours}h window)`
    : '';

  return `${reports.length} submissions detected for this location between ${hm(first)} and ${hm(last)} UTC${within}. ` +
    `Classifications: ${breakdown}. Most recent: ${mostRecent.damage_classification || '—'}.${conflict}${dupNote}`;
}

function hm(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toISOString().slice(11, 16);
}
function spanHours(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 3.6e6;
}
