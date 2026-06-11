// GroundTruth — demo dataset + seeding helpers (single source of truth).
//
// Used in two places:
//   - scripts/seed-demo.mjs  : local dev reset + re-seed (posts through the live API).
//   - server/index.js        : optional SEED_ON_BOOT for fresh deployments where the
//                              database starts empty (e.g. Render free tier). Seeds
//                              IN-PROCESS via insertSubmission — no HTTP self-call.
//
// The dataset: a realistic 16-report Istanbul scenario — two clusters (Sultanahmet
// earthquake, Kadikoy flood) plus scattered points, 5 priority cases, 2 AI/user
// conflicts, one building reported 3 times (evolving damage → versions 1-3), and one
// report with no location (must not break the map).

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { insertSubmission } from './submissions.js';
import { runDedup } from './dedup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Capture timestamps anchored to 2026-06-10 (UTC), varied by hour.
const T = (h) => new Date(Date.UTC(2026, 5, 10, h, 0, 0)).toISOString();
const A = 'dev-A', B = 'dev-B', C = 'dev-C';

// [lat, lon, hazard, infra, userDamage, aiDamage, aiConf, aiPct, people, q1, q2, hour, withPhoto, device]
export const DEMO_ROWS = [
  // Cluster A — Sultanahmet. First 3 = SAME building, versions 1-3 (evolving damage).
  [41.00820, 28.97840, 'Earthquake', 'Residential Infrastructure', 'Minimal', 'Minimal', 0.70, 8, 'No', 'No', 'Open', 9, true, A],
  [41.00822, 28.97843, 'Earthquake', 'Residential Infrastructure', 'Partial', 'Partial', 0.72, 45, 'No', 'Yes', 'Blocked', 12, false, B],
  [41.00818, 28.97838, 'Earthquake', 'Residential Infrastructure', 'Complete', 'Complete', 0.80, 90, 'Yes', 'Yes', 'Blocked', 15, true, C],
  // Other distinct buildings nearby.
  [41.00790, 28.97900, 'Earthquake', 'Community Infrastructure', 'Partial', 'Partial', 0.68, 50, 'Yes', 'Yes', 'Blocked', 10, false, A],
  [41.00860, 28.97790, 'Earthquake', 'Commercial Infrastructure', 'Complete', 'Minimal', 0.86, 12, 'No', 'No', 'Open', 11, true, B], // CONFLICT
  [41.00840, 28.97960, 'Earthquake', 'Government Building', 'Minimal', 'Complete', 0.91, 88, 'No', 'No', 'Open', 13, false, C], // CONFLICT
  [41.00900, 28.97880, 'Earthquake', 'Public Spaces / Recreation Infrastructure', 'Partial', 'Partial', 0.60, 40, 'No', null, null, 14, false, A],
  // Cluster B — Kadikoy. Flood.
  [40.99050, 29.02900, 'Flood', 'Residential Infrastructure', 'Partial', 'Partial', 0.70, 47, 'No', 'Knee', 'No', 8, true, B],
  [40.99080, 29.02850, 'Flood', 'Commercial Infrastructure', 'Minimal', 'Minimal', 0.65, 10, 'No', 'Ankle', 'Yes', 9, false, C],
  [40.99020, 29.02950, 'Flood', 'Utility Infrastructure', 'Complete', 'Complete', 0.78, 85, 'Yes', 'Waist', 'No', 16, false, A],
  [40.99120, 29.02880, 'Flood', 'Transport and Communication Infrastructure', 'Partial', 'Partial', 0.69, 44, 'No', 'Knee', 'No', 17, false, B],
  // Isolated / underserved single points.
  [41.02500, 28.97400, 'Wildfire', 'Residential Infrastructure', 'Complete', 'Complete', 0.82, 92, 'Yes', 'Active', 'Yes', 18, false, C],
  [40.97000, 29.06000, 'Hurricane / Cyclone', 'Community Infrastructure', 'Partial', 'Partial', 0.70, 48, 'No', 'Partially missing', 'No', 7, false, A],
  [41.05000, 28.93000, 'Explosion', 'Commercial Infrastructure', 'Complete', 'Complete', 0.75, 80, 'Yes', 'No', 'Yes', 19, false, B],
  [41.01500, 29.00000, 'Conflict', 'Government Building', 'Partial', 'Partial', 0.66, 42, 'No', 'No', 'No', 20, false, C],
  // No location at all (Unknown) — must not break the map.
  [null, null, 'Civil Unrest', 'Public Spaces / Recreation Infrastructure', 'Minimal', null, null, null, 'No', null, null, 21, false, A],
];

let cachedPhoto = null;
function demoPhoto() {
  if (cachedPhoto) return cachedPhoto;
  const b64 = readFileSync(join(__dirname, '..', 'public', 'test-fixtures', 'gps-sample.jpg')).toString('base64');
  cachedPhoto = { data: b64, mime: 'image/jpeg', width: 120, height: 90 };
  return cachedPhoto;
}

// Build the same payload shape the PWA posts to /api/submissions, so the dataset is
// identical whether seeded over HTTP (the script) or in-process (boot).
export function buildPayload(row) {
  const [lat, lon, hazard, infra, dmg, ai, conf, pct, people, q1, q2, hour, withPhoto, device] = row;
  return {
    submission_id: randomUUID(),
    device_token: device,
    timestamp: T(hour),
    lat, lon,
    location_method: lat == null ? 'Unknown' : 'LiveGPS',
    hazard_type: hazard,
    infrastructure_type: infra,
    damage_classification: dmg,
    ai_suggested_damage: ai,
    ai_confidence: conf,
    ai_damage_percentage: pct,
    people_in_danger: people,
    dynamic_q1_answer: q1,
    dynamic_q2_answer: q2,
    language_detected: 'en',
    photos: withPhoto ? [demoPhoto()] : [],
  };
}

// In-process seed via the real submission pipeline (encrypted photos, hashed device
// IDs, versioning, conflict flags). `reset` wipes existing data first. Runs post-sync
// deduplication afterwards so the analyst annotations match the live demo.
export function seedDirect({ reset = false } = {}) {
  if (reset) {
    db.prepare('DELETE FROM submissions').run();
    db.prepare('DELETE FROM photos').run();
  }
  let priority = 0, conflict = 0, extraVersions = 0;
  for (const row of DEMO_ROWS) {
    const res = insertSubmission(buildPayload(row));
    if (res.priority_flag) priority++;
    if (res.conflict_flag) conflict++;
    if (res.version_number > 1) extraVersions++;
  }
  try { runDedup(); } catch (_) { /* dedup is best-effort */ }
  return { seeded: DEMO_ROWS.length, priority, conflict, extraVersions };
}

// Seed ONLY when the database is empty — never wipes existing reports. Used by the
// SEED_ON_BOOT flag so a fresh deployment shows the demo without clobbering real data.
export function seedIfEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM submissions').get();
  const count = row?.n ?? 0;
  if (count > 0) return { skipped: true, count };
  return { skipped: false, ...seedDirect({ reset: false }) };
}
