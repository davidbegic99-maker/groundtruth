// GroundTruth — SQLite database layer (Node built-in node:sqlite, no native build).
// Implements the Section 4 submission schema exactly, plus a settings table so
// operational tunables (PDF threshold, match radii, conflict thresholds) are
// CONFIGURABLE and never hardcoded in the codebase.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.GT_DB_PATH || join(DATA_DIR, 'groundtruth.db');

export const db = new DatabaseSync(DB_PATH);

// Pragmas for reliability + concurrency.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS submissions (
  -- Section 4 mandatory fields ------------------------------------------------
  submission_id          TEXT PRIMARY KEY,        -- UUID, anonymous identifier
  channel                TEXT NOT NULL DEFAULT 'PWA', -- PWA / WhatsApp / SMS / Voice
  timestamp              TEXT,                    -- UTC ISO8601, CAPTURE time (not sync time)
  lat                    REAL,                    -- decimal degrees, nullable
  lon                    REAL,                    -- decimal degrees, nullable
  location_method        TEXT,                    -- EXIF / LiveGPS / MapTap / Landmark / CellTower / Unknown
  landmark_text          TEXT,                    -- only if location_method = Landmark
  location_confidence    TEXT,                    -- 'normal' / 'low'. Low = coordinate is approximate
                                                  -- (e.g. landmark-only: pinned at map centre, geocode later)
  hazard_type            TEXT,                    -- Section 6 enum
  infrastructure_type    TEXT,                    -- Section 5 enum
  damage_classification  TEXT,                    -- Minimal / Partial / Complete (USER CONFIRMED)
  ai_suggested_damage    TEXT,                    -- what AI suggested before confirmation
  ai_confidence          REAL,                    -- 0..1
  ai_damage_percentage   REAL,                    -- 0..100  ANALYST FIELD ONLY, never shown to users
  conflict_flag          INTEGER NOT NULL DEFAULT 0, -- boolean
  people_in_danger       TEXT,                    -- Yes / No / IDontKnow  (MANDATORY)
  priority_flag          INTEGER NOT NULL DEFAULT 0, -- boolean; true when people_in_danger = Yes
  photo_hash_1           TEXT,                    -- SHA-256 ref to stored image
  photo_hash_2           TEXT,                    -- nullable
  photo_hash_3           TEXT,                    -- nullable
  debris_present         TEXT,                    -- Yes / No / Unknown
  description_text       TEXT,                    -- free text / transcript / SMS body
  language_detected      TEXT,                    -- ISO 639-1
  sync_status            TEXT NOT NULL DEFAULT 'Synced', -- Queued / Synced
  building_id            TEXT,                    -- matched footprint id or null
  version_number         INTEGER NOT NULL DEFAULT 1,
  dynamic_q1_answer      TEXT,                    -- nullable
  dynamic_q2_answer      TEXT,                    -- nullable

  -- Backend-only / operational fields (Sections 4.1, 4.3, 15) ----------------
  received_at            TEXT,                    -- server receive time (distinct from capture timestamp)
  description_en         TEXT,                    -- English translation of description (LibreTranslate)
  device_hash            TEXT,                    -- SHA-256 of device id, never reversible, nullable
  nickname_hash          TEXT,                    -- hashed pseudonymous nickname, nullable
  trusted_contributor    INTEGER NOT NULL DEFAULT 0, -- backend analyst flag, never shown to user
  perceptual_hash        TEXT,                    -- pHash of primary photo, for dedup
  cluster_id             TEXT,                    -- dedup cluster grouping
  dedup_annotation       TEXT                     -- analyst annotation generated post-sync
);

CREATE INDEX IF NOT EXISTS idx_sub_building   ON submissions(building_id);
CREATE INDEX IF NOT EXISTS idx_sub_latlon     ON submissions(lat, lon);
CREATE INDEX IF NOT EXISTS idx_sub_hazard     ON submissions(hazard_type);
CREATE INDEX IF NOT EXISTS idx_sub_damage     ON submissions(damage_classification);
CREATE INDEX IF NOT EXISTS idx_sub_priority   ON submissions(priority_flag);
CREATE INDEX IF NOT EXISTS idx_sub_timestamp  ON submissions(timestamp);

-- Photos stored separately, referenced by hash only (Section 4.1 / 15).
-- 'data' holds the AES-256-GCM encrypted bytes; iv/tag stored alongside.
CREATE TABLE IF NOT EXISTS photos (
  hash         TEXT PRIMARY KEY,   -- SHA-256 of plaintext image
  mime         TEXT NOT NULL,
  iv           BLOB,               -- AES-GCM init vector
  tag          BLOB,               -- AES-GCM auth tag
  data         BLOB NOT NULL,      -- encrypted image bytes (compressed before upload)
  width        INTEGER,
  height       INTEGER,
  created_at   TEXT NOT NULL
);

-- Configurable operational settings (NOTHING hardcoded).
CREATE TABLE IF NOT EXISTS settings (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  description  TEXT
);
`);

// ---------------------------------------------------------------------------
// Lightweight migrations: add columns introduced after the initial release so
// an existing database (e.g. local dev) gains them without a manual reset.
// ---------------------------------------------------------------------------
const submissionColumns = db.prepare('PRAGMA table_info(submissions)').all().map((c) => c.name);
if (!submissionColumns.includes('location_confidence')) {
  db.exec('ALTER TABLE submissions ADD COLUMN location_confidence TEXT');
}

// ---------------------------------------------------------------------------
// Seed default settings (only if missing — never overwrite admin changes)
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = [
  ['pdf_threshold_count', '5', 'Min submissions in a cluster to auto-generate a PDF area summary'],
  ['pdf_threshold_radius_m', '200', 'Cluster radius in metres for the PDF auto-trigger'],
  ['version_match_footprint_m', '15', 'Match radius (m) for footprint-matched submissions when versioning'],
  ['version_match_gps_m', '30', 'Match radius (m) for GPS-only submissions when versioning'],
  ['dedup_temporal_hours', '2', 'Temporal clustering window (hours) for post-sync deduplication'],
  ['conflict_min_confidence', '0.75', 'Min AI confidence for a Minimal<->Complete divergence to flag a conflict'],
  ['conflict_partial_confidence', '0.85', 'Min AI confidence for a Minimal<->Partial divergence to flag a conflict'],
  ['live_refresh_seconds', '60', 'Dashboard live refresh interval when online'],
  ['photo_target_kb', '200', 'Target compressed size per photo (KB) for upload'],
  ['public_grid_cell_deg', '0.003', 'Public aggregate map grid cell size in degrees (~330m); individual reports never exposed publicly'],
  ['underserved_max_reports', '1', 'A public grid cell with this many reports or fewer is flagged as an underserved / coverage-gap area'],
];

const insertSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value, description) VALUES (?, ?, ?)'
);
for (const [k, v, d] of DEFAULT_SETTINGS) insertSetting.run(k, v, d);

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

export function getSettingNumber(key) {
  const v = getSetting(key);
  return v === undefined ? undefined : Number(v);
}

export function getAllSettings() {
  return db.prepare('SELECT key, value, description FROM settings ORDER BY key').all();
}

export function setSetting(key, value) {
  const res = db
    .prepare('UPDATE settings SET value = ? WHERE key = ?')
    .run(String(value), key);
  return res.changes > 0;
}

export default db;
