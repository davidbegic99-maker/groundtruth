// Reset + re-seed the demo dataset through the REAL /api/submissions HTTP pipeline
// (encrypted photos, hashed device IDs, versioning, conflict flags, post-sync dedup).
// The dataset itself lives in server/seed.js (single source of truth).
//
// Usage: node scripts/seed-demo.mjs   (server must be running on :3000)
//        GT_SEED_URL=http://host/api/submissions node scripts/seed-demo.mjs
//
// For deployments that start with an empty database, prefer the SEED_ON_BOOT env var
// instead — see the README and server/index.js.
import { db } from '../server/db.js';
import { DEMO_ROWS, buildPayload } from '../server/seed.js';

const ENDPOINT = process.env.GT_SEED_URL || 'http://localhost:3000/api/submissions';

// Wipe existing data so the dashboard shows only the curated demo set.
db.prepare('DELETE FROM submissions').run();
db.prepare('DELETE FROM photos').run();

const post = async (body) => (await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})).json();

let priority = 0, conflict = 0, ver = 0;
for (const row of DEMO_ROWS) {
  const res = await post(buildPayload(row));
  if (res.priority_flag) priority++;
  if (res.conflict_flag) conflict++;
  if (res.version_number > 1) ver++;
}

console.log(`Seeded ${DEMO_ROWS.length} reports → priority: ${priority}, conflict: ${conflict}, extra versions: ${ver}`);
db.close();
