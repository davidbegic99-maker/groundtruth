// MANUAL demo reset — deliberate, never automatic.
//
// Wipes ALL reports + photos and reloads exactly the 18-report demo dataset, in-process
// (no running server required). This is how you return to a clean demo state — e.g.
// before recording the demo video or before final handoff — and how you remove any
// stray test submissions from a database.
//
// Usage:
//   npm run seed:reset
//
// Notes:
//   - Stop the server first (Ctrl+C) so it isn't holding the database file, then run
//     this, then `npm start` again.
//   - To reset a deployment's database, run it there with GT_DB_PATH pointing at that
//     database file (and the same GT_PHOTO_KEY), e.g.:
//       GT_DB_PATH=/data/groundtruth.db npm run seed:reset
//
// The dataset itself lives in server/seed.js (single source of truth).

import { db } from '../server/db.js';
import { seedDirect } from '../server/seed.js';

const before = db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n;
const res = seedDirect({ reset: true });
const after = db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n;

console.log(`Demo reset complete.`);
console.log(`  reports before: ${before}  →  after: ${after}`);
console.log(`  loaded ${res.seeded} reports (priority: ${res.priority}, conflicts: ${res.conflict}, extra versions: ${res.extraVersions})`);
if (after !== res.seeded) {
  console.warn(`  WARNING: expected ${res.seeded} reports after reset but found ${after}.`);
}
db.close();
