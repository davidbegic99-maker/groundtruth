// Reset + seed realistic demo submissions through the REAL /api/submissions
// pipeline (encrypted photos, hashed device IDs, versioning, conflict flags).
// Two Istanbul clusters + isolated underserved points + one 3-version building
// showing evolving damage. Usage: node scripts/seed-demo.mjs (server on :3000).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../server/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Wipe any existing data so the dashboard shows only the curated demo set.
db.prepare('DELETE FROM submissions').run();
db.prepare('DELETE FROM photos').run();

const photoB64 = readFileSync(join(__dirname, '..', 'public', 'test-fixtures', 'gps-sample.jpg')).toString('base64');
const photo = { data: photoB64, mime: 'image/jpeg', width: 120, height: 90 };
const T = (h) => new Date(Date.UTC(2026, 5, 10, h, 0, 0)).toISOString();
const A = 'dev-A', B = 'dev-B', C = 'dev-C';

// [lat, lon, hazard, infra, userDamage, aiDamage, aiConf, aiPct, people, q1, q2, hour, withPhoto, device]
const rows = [
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

const post = async (body) => (await fetch('http://localhost:3000/api/submissions', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})).json();

let priority = 0, conflict = 0, ver = 0;
for (const [lat, lon, hazard, infra, dmg, ai, conf, pct, people, q1, q2, hour, withPhoto, device] of rows) {
  const res = await post({
    submission_id: randomUUID(), device_token: device, timestamp: T(hour),
    lat, lon, location_method: lat == null ? 'Unknown' : 'LiveGPS',
    hazard_type: hazard, infrastructure_type: infra,
    damage_classification: dmg, ai_suggested_damage: ai, ai_confidence: conf, ai_damage_percentage: pct,
    people_in_danger: people, dynamic_q1_answer: q1, dynamic_q2_answer: q2,
    language_detected: 'en', photos: withPhoto ? [photo] : [],
  });
  if (res.priority_flag) priority++;
  if (res.conflict_flag) conflict++;
  if (res.version_number > 1) ver++;
}
console.log(`Seeded ${rows.length} reports → priority: ${priority}, conflict: ${conflict}, extra versions: ${ver}`);
process.exit(0);
