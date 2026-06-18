// GroundTruth — demo dataset + seeding helpers (single source of truth).
//
// Used in two places:
//   - scripts/seed-demo.mjs  : local dev reset + re-seed (posts through the live API).
//   - server/index.js        : optional SEED_ON_BOOT for fresh deployments where the
//                              database starts empty (e.g. Render free tier). Seeds
//                              IN-PROCESS via insertSubmission — no HTTP self-call.
//
// THE DATASET — a purpose-built 18-report demonstration set, internally consistent so
// it shows the app at its best:
//   * AI values track the AI-SUGGESTED tier (Minimal ~5-18% / Partial ~40-65% /
//     Complete ~80-97%, confidence rising with severity), never an implausible pairing.
//   * A tight EARTHQUAKE cluster of 8 reports sits under the Sultanahmet building
//     footprints around 41.008, 28.978 — enough to trigger the PDF auto-summary
//     (>=5 within 200 m).
//   * One building in that cluster is reported THREE times with escalating damage
//     (Partial -> Partial -> Complete) to demonstrate version history.
//   * Three believable AI/user conflicts (e.g. AI saw an intact facade, the resident
//     knew the interior had collapsed) that flag under the widened conflict logic.
//   * Four priority (people-in-danger) reports, all seven infrastructure types, and a
//     spread of hazards (earthquake, flood, wildfire, cyclone, conflict, civil unrest).
//   * One landmark-only report with an APPROXIMATE, low-confidence coordinate pinned
//     near the Sultanahmet cluster (no precise GPS) — it demonstrates the landmark
//     fallback honestly: it shows on the map flagged "approximate", never at ~0,0.
// Every AI suggestion is marked ai_source:'mock' so the analyst can tell this is demo
// data (a prototype placeholder), not a live model result.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { insertSubmission } from './submissions.js';
import { runDedup } from './dedup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Capture timestamps anchored to the 2026-06-15 Istanbul scenario (UTC).
const T = (day, h, m = 0) => new Date(Date.UTC(2026, 5, day, h, m, 0)).toISOString();

// Object rows (clearer + safer than positional tuples for a set this detailed).
//   lat/lon      decimal degrees, or null for the no-coordinate landmark report
//   user         user-CONFIRMED damage tier (Minimal | Partial | Complete)
//   ai           AI-SUGGESTED tier (drives conf/pct below); null = no AI suggestion
//   conf/pct     ai_confidence (0..1) / ai_damage_percentage (0..100) — track `ai`
//   people       people_in_danger (Yes | No | IDontKnow); Yes -> priority_flag
//   q1/q2        optional crisis-specific answers (must match data.js option values)
//   photo        attach the representative demo JPEG to this report
//   method/conf2/landmark/desc   location method, location_confidence, landmark, text
export const DEMO_ROWS = [
  // === EARTHQUAKE CLUSTER — Sultanahmet, under the demo footprints (~41.008, 28.978).
  // First THREE rows are the SAME building (within the GPS match radius), versions 1-3
  // with escalating damage and matching, increasing timestamps.
  { lat: 41.00800, lon: 28.97800, hazard: 'Earthquake', infra: 'Residential Infrastructure',
    user: 'Partial', ai: 'Partial', conf: 0.82, pct: 45, people: 'No', q1: 'Yes', q2: 'Open',
    photo: true, device: 'A', at: T(15, 8) },
  { lat: 41.00800, lon: 28.97800, hazard: 'Earthquake', infra: 'Residential Infrastructure',
    user: 'Partial', ai: 'Partial', conf: 0.85, pct: 52, people: 'No', q1: 'Yes', q2: 'Blocked',
    photo: false, device: 'B', at: T(15, 14) },
  { lat: 41.00800, lon: 28.97800, hazard: 'Earthquake', infra: 'Residential Infrastructure',
    user: 'Complete', ai: 'Complete', conf: 0.92, pct: 90, people: 'Yes', q1: 'Yes', q2: 'Blocked',
    photo: true, device: 'C', at: T(16, 9),
    desc: 'Returned the next morning — the upper floors have now pancaked. People still unaccounted for.' },

  // Other distinct buildings in the cluster (>30 m apart, so each is its own footprint).
  { lat: 41.00850, lon: 28.97770, hazard: 'Earthquake', infra: 'Commercial Infrastructure',
    user: 'Complete', ai: 'Partial', conf: 0.80, pct: 55, people: 'Yes', q1: 'Yes', q2: 'Blocked',
    photo: true, device: 'A', at: T(15, 10),
    desc: 'Shopfront looks intact from the street but the rear and roof have collapsed inward.' }, // CONFLICT
  { lat: 41.00760, lon: 28.97830, hazard: 'Earthquake', infra: 'Government Building',
    user: 'Minimal', ai: 'Minimal', conf: 0.88, pct: 12, people: 'No', q1: 'No', q2: 'Open',
    photo: true, device: 'B', at: T(15, 11) },
  { lat: 41.00830, lon: 28.97880, hazard: 'Earthquake', infra: 'Community Infrastructure',
    user: 'Partial', ai: 'Partial', conf: 0.78, pct: 48, people: 'No', q1: 'Yes', q2: 'Open',
    photo: false, device: 'C', at: T(15, 12) },
  { lat: 41.00880, lon: 28.97850, hazard: 'Earthquake', infra: 'Public Spaces / Recreation Infrastructure',
    user: 'Complete', ai: 'Complete', conf: 0.90, pct: 85, people: 'No', q1: 'No', q2: 'Blocked',
    photo: true, device: 'A', at: T(15, 13) },
  { lat: 41.00770, lon: 28.97760, hazard: 'Earthquake', infra: 'Utility Infrastructure',
    user: 'Partial', ai: 'Minimal', conf: 0.83, pct: 15, people: 'No', q1: 'Yes', q2: 'Blocked',
    photo: false, device: 'B', at: T(15, 15),
    desc: 'Substation wall is bulging and one transformer bay has partly collapsed.' }, // CONFLICT

  // === SCATTERED REPORTS — other districts and hazards (the tool is context-agnostic).
  // Kadikoy flood.
  { lat: 40.99050, lon: 29.02900, hazard: 'Flood', infra: 'Transport and Communication Infrastructure',
    user: 'Partial', ai: 'Partial', conf: 0.80, pct: 47, people: 'No', q1: 'Knee', q2: 'No',
    photo: true, device: 'B', at: T(14, 8) },
  { lat: 40.99300, lon: 29.03200, hazard: 'Flood', infra: 'Commercial Infrastructure',
    user: 'Minimal', ai: 'Minimal', conf: 0.86, pct: 10, people: 'No', q1: 'Ankle', q2: 'Yes',
    photo: false, device: 'C', at: T(14, 9) },
  { lat: 40.98800, lon: 29.02500, hazard: 'Flood', infra: 'Residential Infrastructure',
    user: 'Complete', ai: 'Partial', conf: 0.82, pct: 60, people: 'Yes', q1: 'Waist', q2: 'No',
    photo: true, device: 'A', at: T(14, 16),
    desc: 'Water only reached the ground floor but the building has shifted off its foundation.' }, // CONFLICT
  // Wildfire.
  { lat: 41.02500, lon: 28.97400, hazard: 'Wildfire', infra: 'Residential Infrastructure',
    user: 'Complete', ai: 'Complete', conf: 0.95, pct: 92, people: 'Yes', q1: 'Active', q2: 'Yes',
    photo: true, device: 'C', at: T(15, 18) },
  { lat: 41.02700, lon: 28.97700, hazard: 'Wildfire', infra: 'Public Spaces / Recreation Infrastructure',
    user: 'Partial', ai: 'Partial', conf: 0.80, pct: 44, people: 'No', q1: 'Contained', q2: 'No',
    photo: false, device: 'A', at: T(15, 19) },
  // Cyclone.
  { lat: 40.97000, lon: 29.06000, hazard: 'Hurricane / Cyclone', infra: 'Community Infrastructure',
    user: 'Partial', ai: 'Partial', conf: 0.78, pct: 50, people: 'No', q1: 'Partially missing', q2: 'No',
    photo: false, device: 'B', at: T(14, 7) },
  { lat: 40.96800, lon: 29.05700, hazard: 'Hurricane / Cyclone', infra: 'Utility Infrastructure',
    user: 'Complete', ai: 'Complete', conf: 0.88, pct: 83, people: 'No', q1: 'Fully missing', q2: 'Yes',
    photo: true, device: 'C', at: T(14, 17) },
  // Conflict / civil unrest.
  { lat: 41.04500, lon: 28.93000, hazard: 'Conflict', infra: 'Government Building',
    user: 'Minimal', ai: 'Minimal', conf: 0.84, pct: 14, people: 'No', q1: 'No', q2: 'No',
    photo: false, device: 'A', at: T(16, 11) },
  { lat: 41.04600, lon: 28.93200, hazard: 'Civil Unrest', infra: 'Commercial Infrastructure',
    user: 'Partial', ai: 'Partial', conf: 0.79, pct: 55, people: 'No', q1: 'Yes', q2: 'No',
    photo: false, device: 'B', at: T(16, 12) },

  // === LANDMARK-ONLY report — no precise GPS. Came in with only a landmark, pinned
  // APPROXIMATELY near the Sultanahmet cluster (>30 m from the other footprints, so it
  // is its own building) and flagged low-confidence so the analyst geocodes it later.
  // It sits inside the 200 m cluster radius, so the area summary includes it honestly —
  // shown on the map as an "approximate" point, never plotted at ~0,0.
  { lat: 41.00900, lon: 28.97900, hazard: 'Earthquake', infra: 'Community Infrastructure',
    user: 'Partial', ai: null, conf: null, pct: null, people: 'No',
    photo: false, device: 'C', at: T(16, 10),
    method: 'Landmark', conf2: 'low', landmark: 'Community clinic near Sultanahmet square (by the old fountain) — exact building to be geocoded',
    desc: 'Sent by SMS — no GPS; pinned approximately near the reported landmark. Cracks across the clinic wall; please verify the exact location.' },
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
export function buildPayload(r) {
  return {
    submission_id: randomUUID(),
    device_token: 'seed-' + r.device,
    timestamp: r.at,
    lat: r.lat, lon: r.lon,
    location_method: r.method || (r.lat == null ? 'Unknown' : 'LiveGPS'),
    location_confidence: r.conf2 || (r.lat == null ? null : 'normal'),
    landmark_text: r.landmark || null,
    hazard_type: r.hazard,
    infrastructure_type: r.infra,
    damage_classification: r.user,
    ai_suggested_damage: r.ai,
    ai_confidence: r.conf,
    ai_damage_percentage: r.pct,
    // Demo marker: the AI suggestion is a prototype placeholder (no live key), so the
    // analyst detail panel labels it as such rather than passing it off as a live result.
    ai_source: r.ai ? 'mock' : null,
    people_in_danger: r.people,
    dynamic_q1_answer: r.q1 || null,
    dynamic_q2_answer: r.q2 || null,
    description_text: r.desc || null,
    language_detected: 'en',
    photos: r.photo ? [demoPhoto()] : [],
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
