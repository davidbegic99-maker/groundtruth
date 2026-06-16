// GroundTruth — analyst & public dashboard queries (Step 5).
//
// Two clearly separated tiers (briefing §13):
//   - PUBLIC: publicCells() returns ONLY aggregated grid cells (counts per
//     damage tier). No individual coordinates or records ever leave the server
//     at the public level.
//   - ANALYST (authenticated): queryAnalyst() / buildingVersions() return full
//     individual records, including the analyst-only ai_damage_percentage.

import { db, getSettingNumber } from './db.js';

const COLS = `submission_id, channel, timestamp, lat, lon, location_method, landmark_text,
  location_confidence,
  hazard_type, infrastructure_type, damage_classification, ai_suggested_damage,
  ai_confidence, ai_damage_percentage, ai_source, conflict_flag, people_in_danger, priority_flag,
  photo_hash_1, photo_hash_2, photo_hash_3, debris_present, description_text,
  language_detected, sync_status, building_id, version_number, dynamic_q1_answer,
  dynamic_q2_answer, received_at, dedup_annotation, description_en`;

// ---------------------------------------------------------------------------
// Analyst: full individual records, filtered.
// ---------------------------------------------------------------------------
export function queryAnalyst(f = {}) {
  const where = [];
  const params = [];
  if (f.damage_classification) { where.push('damage_classification = ?'); params.push(f.damage_classification); }
  if (f.hazard_type) { where.push('hazard_type = ?'); params.push(f.hazard_type); }
  if (f.infrastructure_type) { where.push('infrastructure_type = ?'); params.push(f.infrastructure_type); }
  if (f.priority_flag) where.push('priority_flag = 1');
  if (f.conflict_flag) where.push('conflict_flag = 1');
  if (f.from_time) { where.push('timestamp >= ?'); params.push(f.from_time); }
  if (f.to_time) { where.push('timestamp <= ?'); params.push(f.to_time); }
  if (Array.isArray(f.bbox) && f.bbox.length === 4 && f.bbox.every(Number.isFinite)) {
    const [minLon, minLat, maxLon, maxLat] = f.bbox;
    where.push('lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?');
    params.push(minLat, maxLat, minLon, maxLon);
  }
  const sql =
    `SELECT ${COLS} FROM submissions ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY priority_flag DESC, received_at DESC';
  return db.prepare(sql).all(...params).map((r) => ({
    ...r,
    conflict_flag: !!r.conflict_flag,
    priority_flag: !!r.priority_flag,
  }));
}

// All versions for one building footprint, oldest first (§4.2 version history).
export function buildingVersions(buildingId) {
  return db
    .prepare(
      `SELECT submission_id, version_number, timestamp, damage_classification,
              ai_suggested_damage, ai_confidence, conflict_flag, priority_flag, dedup_annotation
       FROM submissions WHERE building_id = ? ORDER BY version_number ASC`
    )
    .all(buildingId)
    .map((r) => ({ ...r, conflict_flag: !!r.conflict_flag, priority_flag: !!r.priority_flag }));
}

// ---------------------------------------------------------------------------
// Public: aggregate into a degree grid. Returns cell centres + per-tier counts
// + the dominant tier (severity-biased on ties) — never any individual record.
// ---------------------------------------------------------------------------
export function publicCells(cellDeg) {
  const size = cellDeg > 0 ? cellDeg : 0.003;
  const underserved = getSettingNumber('underserved_max_reports') ?? 1;
  const rows = db
    .prepare('SELECT lat, lon, damage_classification FROM submissions WHERE lat IS NOT NULL AND lon IS NOT NULL')
    .all();

  const cells = new Map();
  for (const r of rows) {
    const cx = Math.floor(r.lon / size);
    const cy = Math.floor(r.lat / size);
    const key = cx + ':' + cy;
    let c = cells.get(key);
    if (!c) {
      c = { total: 0, Minimal: 0, Partial: 0, Complete: 0, lat: (cy + 0.5) * size, lon: (cx + 0.5) * size };
      cells.set(key, c);
    }
    c.total++;
    if (r.damage_classification && c[r.damage_classification] != null) c[r.damage_classification]++;
  }

  const out = [];
  for (const c of cells.values()) {
    const dominant =
      c.Complete >= c.Partial && c.Complete >= c.Minimal ? 'Complete'
      : c.Partial >= c.Minimal ? 'Partial'
      : 'Minimal';
    out.push({
      lat: c.lat, lon: c.lon, total: c.total,
      minimal: c.Minimal, partial: c.Partial, complete: c.Complete,
      dominant, underserved: c.total <= underserved,
    });
  }
  return { cells: out, total: rows.length, cellSize: size };
}
