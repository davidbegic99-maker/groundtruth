// ONE-TIME build helper — classify the compressed seed photos with the REAL AI.
//
// Runs each server/seed-assets/N.jpg through the SAME classify() path a live
// submission uses (Claude vision, 5-standard system prompt). Requires an
// ANTHROPIC_API_KEY — load it from the gitignored .env with Node's --env-file:
//
//   node --env-file=.env scripts/classify-seed.mjs
//
// The genuine per-photo AI output (tier / confidence / damage % / infrastructure
// type / rationale) is written to server/seed-assets/classifications.json, which
// server/seed.js then BAKES in — so reseeding reproduces the exact set with NO AI
// call and NO ./seed-photos dependency.
//
// The hazard per photo mirrors what a community member selects BEFORE the AI sees
// the image (it feeds the model's hazard-specific visual weighting). It is NOT a
// tier hint — the AI returns whatever tier it reads.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from '../server/classify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = join(__dirname, '..', 'server', 'seed-assets');

// Hazard a reporter would have selected for each photo (human context, pre-AI).
const HAZARD_BY_PHOTO = {
  1: 'Earthquake',
  2: 'Conflict',
  3: 'Earthquake',
  4: 'Wildfire',
  5: 'Hurricane / Cyclone',
  6: 'Earthquake',
  7: 'Flood',
  8: 'Conflict',
  9: 'Earthquake',
  10: 'Earthquake',
};

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('No ANTHROPIC_API_KEY in the environment. Run with: node --env-file=.env scripts/classify-seed.mjs');
  process.exit(1);
}

const out = {};
let mockFallbacks = 0;
for (let i = 1; i <= 10; i++) {
  const p = join(ASSET_DIR, `${i}.jpg`);
  if (!existsSync(p)) { console.warn(`skip ${i}.jpg — not found (run compress-seed.mjs first)`); continue; }
  const b64 = readFileSync(p).toString('base64');
  const hazard = HAZARD_BY_PHOTO[i];
  const res = await classify({ photosBase64: [b64], hazardType: hazard });
  if (res.source !== 'claude') { mockFallbacks++; console.warn(`!! ${i}.jpg fell back to ${res.source} (NOT live)`); }
  out[`${i}.jpg`] = {
    hazard,
    ai_suggested_damage: res.ai_suggested_damage,
    ai_confidence: res.ai_confidence,
    ai_damage_percentage: res.ai_damage_percentage,
    ai_infrastructure_type: res.infrastructure_type,
    ai_source: res.source === 'claude' ? 'live' : res.source,
    rationale: res.rationale,
  };
  console.log(`${i}.jpg  [${hazard}]  -> ${res.ai_suggested_damage}  conf ${res.ai_confidence}  pct ${res.ai_damage_percentage}  (${res.infrastructure_type})  [${res.source}]`);
  console.log(`        "${res.rationale}"`);
}

if (mockFallbacks > 0) {
  console.error(`\nABORTING: ${mockFallbacks} photo(s) fell back to the mock classifier — not writing classifications.json. Check the API key / network and retry.`);
  process.exit(1);
}

writeFileSync(join(ASSET_DIR, 'classifications.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`\nWrote ${Object.keys(out).length} genuine classifications -> server/seed-assets/classifications.json`);
