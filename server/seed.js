// GroundTruth — demo dataset + seeding helpers (single source of truth).
//
// Used in two places:
//   - scripts/seed-demo.mjs  : local dev reset + re-seed (posts through the live API).
//   - server/index.js        : optional SEED_ON_BOOT for fresh deployments where the
//                              database starts empty (e.g. Render free tier). Seeds
//                              IN-PROCESS via insertSubmission — no HTTP self-call.
//
// THE DATASET — an 11-report demonstration set built from REAL community photos that
// were classified ONCE by the REAL Claude vision model (scripts/classify-seed.mjs),
// internally consistent so it shows the app at its best:
//   * Every photo report carries the GENUINE AI reading for that exact image — tier,
//     confidence, and analyst damage % — baked from server/seed-assets/classifications.json.
//     These are real model results (ai_source:'live'), NOT the no-key mock placeholder.
//   * All 11 reports sit in the Sultanahmet demo cluster (~41.008, 28.978, within ~150 m)
//     under the building footprints — far more than the >=5-within-200 m the PDF area
//     summary needs.
//   * One building in that cluster is reported THREE times over three days with
//     escalating damage (Partial -> Partial -> Complete) to demonstrate version history.
//   * Three believable AI/user conflicts that flag under the widened conflict logic:
//     two where the AI read an intact facade as Minimal but the resident knew the
//     interior/rear had failed (Partial), and one where the AI over-read flooding as
//     Complete but the structure was actually sound (Partial).
//   * Four priority (people-in-danger) reports — including one Partial-tier flood, so
//     priority is visibly independent of the damage tier.
//   * A spread of hazards (earthquake, flood, wildfire, hurricane/cyclone, conflict,
//     civil unrest) and five infrastructure types, as far as the photos honestly allow.
//   * One landmark-only report with an APPROXIMATE, low-confidence coordinate pinned
//     near the cluster (no precise GPS, no photo, so no AI suggestion) — it demonstrates
//     the landmark fallback honestly: shown on the map flagged "approximate", never ~0,0.
//
// REPRODUCIBLE + OFFLINE: the AI values are baked (read from the committed JSON) and the
// photos are committed (server/seed-assets/*.jpg), so reseeding reproduces this exact set
// WITHOUT calling the AI again and WITHOUT needing ./seed-photos at run time.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { insertSubmission } from './submissions.js';
import { runDedup } from './dedup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = join(__dirname, 'seed-assets');

// Genuine per-photo AI classifications, produced ONCE by scripts/classify-seed.mjs
// (the real Claude vision path) over the compressed photos. Loaded here so the AI
// values on every report are exactly what the model returned — no transcription, no
// re-classification at seed time.
const AI = JSON.parse(readFileSync(join(ASSET_DIR, 'classifications.json'), 'utf8'));

// Capture timestamps inside a believable active-crisis window: the 3-4 days before the
// demo's "today" (2026-06-18), so the date filter is demonstrable and nothing is stale.
const T = (day, h, m = 0) => new Date(Date.UTC(2026, 5, day, h, m, 0)).toISOString();

// Object rows (clearer + safer than positional tuples for a set this detailed).
//   photo        seed-assets filename; its baked AI reading is attached automatically
//   lat/lon      decimal degrees, or null for the no-coordinate landmark report
//   user         user-CONFIRMED damage tier (Minimal | Partial | Complete)
//   hazard/infra Section 6 / Section 5 enums (infra is the human-confirmed type)
//   people       people_in_danger (Yes | No | IDontKnow); Yes -> priority_flag
//   q1/q2        optional crisis-specific answers (exact values from public/js/data.js)
//   method/conf2/landmark/desc   location method, location_confidence, landmark, text
//   device       seeds a distinct hashed device id; at = capture timestamp
//
// AI tier vs user tier per row (the conflict flag fires when they differ and the baked
// AI confidence is >= 0.70):  CONFLICT rows are marked inline.
export const DEMO_ROWS = [
  // === VERSIONED BUILDING — Sultanahmet, same coordinate, three versions over three
  // days with escalating damage. Inserted in chronological order so version_number
  // tracks the timeline. Each version is its own photo + genuine AI reading.
  { photo: '3.jpg', lat: 41.00800, lon: 28.97800, hazard: 'Earthquake', infra: 'Residential Infrastructure',
    user: 'Partial', people: 'No', q1: 'No', q2: 'Open', device: 'A', at: T(14, 9),
    desc: 'Long diagonal cracks have opened across the front of the block since the first quake; residents are uneasy but still inside.' },
  { photo: '1.jpg', lat: 41.00800, lon: 28.97800, hazard: 'Earthquake', infra: 'Residential Infrastructure',
    user: 'Partial', people: 'No', q1: 'No', q2: 'Blocked', device: 'B', at: T(15, 16),
    desc: 'Same building the next day — the cracks have widened and plaster is shedding from the upper floors; the stairwell is now blocked.' },
  { photo: '9.jpg', lat: 41.00800, lon: 28.97800, hazard: 'Earthquake', infra: 'Residential Infrastructure',
    user: 'Complete', people: 'Yes', q1: 'Yes', q2: 'Blocked', device: 'C', at: T(17, 8),
    desc: 'Came back this morning — the building has pancaked. People are still unaccounted for under the debris.' },

  // === OTHER DISTINCT BUILDINGS in the cluster (each >30 m apart, so its own footprint).
  // Shelled apartment tower — severe, people in danger (priority). AI Complete = user.
  { photo: '2.jpg', lat: 41.00850, lon: 28.97770, hazard: 'Conflict', infra: 'Residential Infrastructure',
    user: 'Complete', people: 'Yes', q1: 'Yes', q2: 'No', device: 'A', at: T(15, 11),
    desc: 'A shell struck the corner of the apartment tower; the corner flats are gone and the stairwell is exposed. Families on the lower floors got out.' },
  // Government records building the wildfire front passed — intact. AI Minimal = user.
  { photo: '4.jpg', lat: 41.00760, lon: 28.97830, hazard: 'Wildfire', infra: 'Government Building',
    user: 'Minimal', people: 'No', q1: 'Contained', q2: 'No', device: 'B', at: T(14, 13),
    desc: 'The fire front passed along this street. The old government records building is sooty but structurally untouched — no cracks, roof intact.' },
  // Bank facade intact from the street, but the windward rear/roof were torn off.
  // CONFLICT: AI read the clean facade as Minimal; the resident confirmed Partial.
  { photo: '5.jpg', lat: 41.00830, lon: 28.97880, hazard: 'Hurricane / Cyclone', infra: 'Commercial Infrastructure',
    user: 'Partial', people: 'No', q1: 'Partially missing', q2: 'No', device: 'C', at: T(16, 10),
    desc: 'From the street the bank facade looks fine, but the windward rear wall and part of the roof were torn off in the storm — the back offices are open to the sky.' },
  // Tram station: street frontage intact, interior concourse roof partly down.
  // CONFLICT: AI read the intact frontage as Minimal; staff confirmed Partial inside.
  { photo: '6.jpg', lat: 41.00880, lon: 28.97850, hazard: 'Earthquake', infra: 'Transport and Communication Infrastructure',
    user: 'Partial', people: 'No', q1: 'No', q2: 'Blocked', device: 'A', at: T(15, 14),
    desc: 'The tram still runs and the street frontage looks intact, but inside the station the concourse roof has partly come down — staff have closed the platform.' },
  // Flooded house — water has since receded; structurally sound. People were stranded
  // (priority). CONFLICT: AI over-read the inundation as Complete; it is actually Partial.
  { photo: '7.jpg', lat: 41.00770, lon: 28.97760, hazard: 'Flood', infra: 'Residential Infrastructure',
    user: 'Partial', people: 'Yes', q1: 'Waist', q2: 'Yes', device: 'B', at: T(16, 7),
    desc: 'Floodwater reached the windows and it looked destroyed, but the water has dropped and the walls and roof are sound — it can be saved once it dries. People were stranded on the roof earlier.' },
  // Apartment block, top floors and roof collapsed — people likely home (priority).
  { photo: '8.jpg', lat: 41.00820, lon: 28.97720, hazard: 'Conflict', infra: 'Residential Infrastructure',
    user: 'Complete', people: 'Yes', q1: 'Yes', q2: 'No', device: 'C', at: T(17, 12),
    desc: 'The top two floors of the building are gone and the roof has collapsed in; we think people were home when it was hit.' },
  // Old masonry house collapsed into the lane — had been evacuated, so likely empty.
  { photo: '10.jpg', lat: 41.00740, lon: 28.97870, hazard: 'Earthquake', infra: 'Residential Infrastructure',
    user: 'Complete', people: 'No', q1: "I don't know", q2: 'Blocked', device: 'A', at: T(16, 18),
    desc: 'Older masonry house at the edge of the square has collapsed into the lane; it had been evacuated after the first tremor, so we think it was empty.' },

  // === LANDMARK-ONLY report — no precise GPS, no photo (so no AI suggestion). Pinned
  // APPROXIMATELY near the cluster (>30 m from the other footprints) and flagged
  // low-confidence so the analyst geocodes it later. It sits inside the 200 m cluster
  // radius, so the area summary includes it honestly — shown as "approximate", never ~0,0.
  { lat: 41.00900, lon: 28.97900, hazard: 'Civil Unrest', infra: 'Community Infrastructure',
    user: 'Partial', people: 'No', q1: 'No', q2: 'No', device: 'B', at: T(17, 15),
    method: 'Landmark', conf2: 'low',
    landmark: 'Community clinic near Sultanahmet square (by the old fountain) — exact building to be geocoded',
    desc: 'Sent by SMS during the unrest — no GPS; pinned approximately near the landmark. Cracks across the clinic\'s front wall and a broken window; please verify the exact location.' },
];

const photoCache = new Map();
function seedPhoto(file) {
  if (photoCache.has(file)) return photoCache.get(file);
  const b64 = readFileSync(join(ASSET_DIR, file)).toString('base64');
  const photo = { data: b64, mime: 'image/jpeg', width: null, height: null };
  photoCache.set(file, photo);
  return photo;
}

// Build the same payload shape the PWA posts to /api/submissions, so the dataset is
// identical whether seeded over HTTP (the script) or in-process (boot). Photo reports
// carry the GENUINE baked AI reading for that image; the landmark report has none.
export function buildPayload(r) {
  const ai = r.photo ? AI[r.photo] : null;
  if (r.photo && !ai) throw new Error(`No baked classification for ${r.photo} — re-run scripts/classify-seed.mjs`);
  return {
    submission_id: randomUUID(),
    device_token: 'seed-' + (r.device || 'X'),
    timestamp: r.at,
    lat: r.lat, lon: r.lon,
    location_method: r.method || (r.lat == null ? 'Unknown' : 'LiveGPS'),
    location_confidence: r.conf2 || (r.lat == null ? null : 'normal'),
    landmark_text: r.landmark || null,
    hazard_type: r.hazard,
    infrastructure_type: r.infra,
    damage_classification: r.user,
    ai_suggested_damage: ai ? ai.ai_suggested_damage : null,
    ai_confidence: ai ? ai.ai_confidence : null,
    ai_damage_percentage: ai ? ai.ai_damage_percentage : null,
    // Genuinely classified by the live Claude vision model (scripts/classify-seed.mjs),
    // so this is a real AI result — NOT the no-key mock placeholder. The mock label is
    // reserved for true no-API-key fallback cases at submit time.
    ai_source: ai ? 'live' : null,
    people_in_danger: r.people,
    dynamic_q1_answer: r.q1 || null,
    dynamic_q2_answer: r.q2 || null,
    description_text: r.desc || null,
    language_detected: 'en',
    photos: r.photo ? [seedPhoto(r.photo)] : [],
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
