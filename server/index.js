// GroundTruth — Express server (prototype backend).
// Serves the PWA, the settings API, and (added in later steps) submissions,
// AI classification, exports, and the REST API.

import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, getAllSettings, getSetting, setSetting } from './db.js';
import { classify } from './classify.js';
import { insertSubmission } from './submissions.js';
import { queryAnalyst, buildingVersions, publicCells } from './analyst.js';
import { getPhoto } from './photos.js';
import { getRows, toCSV, toGeoJSON, toGPKG } from './exports.js';
import { areaSummaryPDF, autoPdfClusters } from './pdf.js';
import { runDedup } from './dedup.js';
import { translateToEnglish, translationEnabled } from './translate.js';
import { seedIfEmpty } from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const app = express();
app.use(express.json({ limit: '25mb' }));

// --- Static PWA (served with no aggressive caching so updates show during dev) ---
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res, path) {
      if (path.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// --- Health ---------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'GroundTruth',
    time: new Date().toISOString(),
    node: process.version,
  });
});

// --- Stats (drives the community contribution counter) --------------------
app.get('/api/stats', (req, res) => {
  const row = db.prepare('SELECT COUNT(*) AS total FROM submissions').get();
  res.json({ total: row?.total ?? 0 });
});

// --- Settings (configurable operational values — Section "PDF THRESHOLD") --
app.get('/api/settings', (req, res) => {
  res.json({ settings: getAllSettings() });
});

app.get('/api/settings/:key', (req, res) => {
  const value = getSetting(req.params.key);
  if (value === undefined) return res.status(404).json({ error: 'unknown setting' });
  res.json({ key: req.params.key, value });
});

app.put('/api/settings/:key', (req, res) => {
  const { value } = req.body ?? {};
  if (value === undefined || value === null)
    return res.status(400).json({ error: 'value required' });
  const ok = setSetting(req.params.key, value);
  if (!ok) return res.status(404).json({ error: 'unknown setting' });
  res.json({ key: req.params.key, value: String(value) });
});

// --- AI damage classification (Section 8) ---------------------------------
// Accepts up to 3 base64 JPEGs plus the selected hazard type. Returns a UNDP
// damage tier suggestion, confidence, analyst-only damage %, and a suggested
// infrastructure type. Uses the Claude vision API when ANTHROPIC_API_KEY is
// set; otherwise a deterministic mock so the flow is testable with no key.
app.post('/api/classify', async (req, res) => {
  try {
    const { photos, hazard_type } = req.body ?? {};
    const photosBase64 = Array.isArray(photos) ? photos.filter((p) => typeof p === 'string') : [];
    const result = await classify({ photosBase64, hazardType: hazard_type ?? null });
    res.json(result);
  } catch (err) {
    console.error('[/api/classify] error', err);
    res.status(500).json({ error: 'classification_failed' });
  }
});

// --- Submissions (Step 4: offline-first submit) ---------------------------
// Accepts an assembled PWA report (+ up to 3 base64 photos). Stores photos
// encrypted, hashes the device token, computes the conflict flag, applies
// building versioning, and writes the record. Idempotent on submission_id so
// background-sync retries never duplicate.
app.post('/api/submissions', (req, res) => {
  try {
    const payload = req.body ?? {};
    const result = insertSubmission(payload);
    res.status(result.duplicate ? 200 : 201).json(result);
    // Post-sync processing runs AFTER the response — never blocks the submitter
    // (§4.3: "Run asynchronously after every sync event. Never block submission").
    if (!result.duplicate) {
      setImmediate(() => processAfterSync(result.submission_id, payload).catch(() => {}));
    }
  } catch (err) {
    console.error('[/api/submissions] error', err);
    res.status(500).json({ error: 'submission_failed' });
  }
});

// Translate the description into English (if LibreTranslate is configured) and
// run AI deduplication. Both are best-effort and isolated from the submit path.
async function processAfterSync(submissionId, payload) {
  if (translationEnabled() && payload.description_text) {
    try {
      const tr = await translateToEnglish(payload.description_text);
      if (tr && (tr.translated || tr.detected)) {
        db.prepare('UPDATE submissions SET description_en = ?, language_detected = COALESCE(?, language_detected) WHERE submission_id = ?')
          .run(tr.translated, tr.detected, submissionId);
      }
    } catch (e) { console.warn('[translate] failed:', e.message); }
  }
  try { runDedup(); } catch (e) { console.warn('[dedup] failed:', e.message); }
}

// --- Public dashboard (Tier 1, no auth): aggregate grid cells only ---------
// Returns ONLY per-cell counts — never individual records (briefing §13.1).
app.get('/api/public/cells', (req, res) => {
  const cell = req.query.cell ? Number(req.query.cell) : Number(getSetting('public_grid_cell_deg')) || 0.003;
  res.json(publicCells(cell));
});

// --- Analyst dashboard (Tier 2, authenticated) ----------------------------
// Simple shared access key for the TRL-4 prototype. Default 'undp-demo' is
// documented for evaluators; override with the ANALYST_KEY env var. The key is
// NOT stored in the public settings table, so it never leaks via /api/settings.
function analystKey() {
  return process.env.ANALYST_KEY || 'undp-demo';
}
function requireAnalyst(req, res, next) {
  const key = req.get('x-analyst-key');
  if (key && key === analystKey()) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Validate an access key (used by the login screen).
app.get('/api/analyst/check', requireAnalyst, (req, res) => res.json({ ok: true }));

// Shared filter parser (§14.3) — used by the analyst list, the exports, and the
// REST API so they always return the same filtered set.
function parseFilters(q) {
  return {
    damage_classification: q.damage_classification || null,
    hazard_type: q.hazard_type || null,
    infrastructure_type: q.infrastructure_type || null,
    priority_flag: q.priority_flag === '1' || q.priority_flag === 'true',
    conflict_flag: q.conflict_flag === '1' || q.conflict_flag === 'true',
    from_time: q.from_time || null,
    to_time: q.to_time || null,
    bbox: q.bbox ? q.bbox.split(',').map(Number) : null,
  };
}

// Full individual records, filtered (damage/hazard/infra/time/priority/conflict/bbox).
app.get('/api/analyst/submissions', requireAnalyst, (req, res) => {
  res.json({ submissions: queryAnalyst(parseFilters(req.query)) });
});

// --- Exports (§14): CSV / GeoJSON / GeoPackage downloads -------------------
// All authenticated; all honour the same filters as the dashboard. The client
// fetches with the auth header and saves the response as a file.
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

app.get('/api/export/csv', requireAnalyst, (req, res) => {
  const csv = toCSV(getRows(parseFilters(req.query)));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="groundtruth-${stamp()}.csv"`);
  res.send(csv);
});

app.get('/api/export/geojson', requireAnalyst, (req, res) => {
  const fc = toGeoJSON(getRows(parseFilters(req.query)));
  res.setHeader('Content-Type', 'application/geo+json');
  res.setHeader('Content-Disposition', `attachment; filename="groundtruth-${stamp()}.geojson"`);
  res.send(JSON.stringify(fc));
});

app.get('/api/export/gpkg', requireAnalyst, (req, res) => {
  const buf = toGPKG(getRows(parseFilters(req.query)));
  res.setHeader('Content-Type', 'application/geopackage+sqlite3');
  res.setHeader('Content-Disposition', `attachment; filename="groundtruth-${stamp()}.gpkg"`);
  res.send(buf);
});

// --- PDF area summary (§13.3): on-demand for the current map view ---------
app.get('/api/export/pdf', requireAnalyst, async (req, res) => {
  try {
    const pdf = await areaSummaryPDF(parseFilters(req.query), { title: req.query.title || undefined });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="groundtruth-area-${stamp()}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[/api/export/pdf] error', err);
    res.status(500).json({ error: 'pdf_failed' });
  }
});

// Auto-trigger detection (§13.3): clusters reaching the configurable threshold
// (default 5 within 200 m). The dashboard uses this to flag where a summary is
// auto-available; the analyst downloads it via /api/export/pdf for that area.
app.get('/api/analyst/pdf-clusters', requireAnalyst, (req, res) => {
  const count = Number(getSetting('pdf_threshold_count')) || 5;
  const radius = Number(getSetting('pdf_threshold_radius_m')) || 200;
  res.json({ threshold: { count, radius_m: radius }, clusters: autoPdfClusters(count, radius) });
});

// --- REST API (§14.3): authenticated GET → filtered GeoJSON ---------------
// Returns LIVE data (auto-updates as new submissions sync). Filters: bbox,
// from_time, to_time, damage_classification, hazard_type, infrastructure_type,
// priority_flag. Documented in the README with example requests.
app.get('/api/v1/reports', requireAnalyst, (req, res) => {
  const fc = toGeoJSON(getRows(parseFilters(req.query)));
  res.setHeader('Content-Type', 'application/geo+json');
  res.json(fc);
});

// Version history for one building footprint.
app.get('/api/analyst/building/:id', requireAnalyst, (req, res) => {
  res.json({ versions: buildingVersions(req.params.id) });
});

// Run post-sync AI deduplication on demand (§4.3) — backfills perceptual hashes
// and (re)writes analyst annotations for multi-report locations.
app.post('/api/analyst/run-dedup', requireAnalyst, (req, res) => {
  res.json(runDedup());
});

// Decrypted photo bytes (analyst only). The client fetches with the auth header
// and turns the response into an object URL, so the key never appears in a URL.
app.get('/api/photo/:hash', requireAnalyst, (req, res) => {
  const p = getPhoto(req.params.hash);
  if (!p) return res.status(404).json({ error: 'not_found' });
  res.setHeader('Content-Type', p.mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(Buffer.from(p.data));
});

// Demo seeding for a fresh start (e.g. a brand-new deployment, or local first run).
// This loads the 18-report demo dataset ONLY when the database is empty, and NEVER
// wipes or overwrites existing reports — so a restart preserves everything that has
// been submitted (important on a persistent disk where evaluators' reports must
// survive). On by default; set SEED_ON_BOOT=0 (or false) to start completely empty.
// To deliberately wipe and reload the clean demo set, use `npm run seed:reset`.
const seedFlag = process.env.SEED_ON_BOOT;
const seedDisabled = seedFlag === '0' || (typeof seedFlag === 'string' && seedFlag.toLowerCase() === 'false');
if (!seedDisabled) {
  try {
    const r = seedIfEmpty();
    console.log(
      r.skipped
        ? `[seed-if-empty] skipped — ${r.count} report(s) already present (not wiped)`
        : `[seed-if-empty] empty database — seeded ${r.seeded} demo reports (priority ${r.priority}, conflict ${r.conflict}, extra versions ${r.extraVersions})`
    );
  } catch (e) {
    console.warn('[seed-if-empty] failed:', e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GroundTruth server running → http://localhost:${PORT}`);
  console.log(`  Reporter View:  http://localhost:${PORT}/`);
  console.log(`  Analyst View:   http://localhost:${PORT}/analyst.html`);
});

export default app;
