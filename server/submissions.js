// GroundTruth — submission intake (Step 4).
//
// Takes an incoming PWA report, validates/normalises it against the Section 4
// schema, stores any photos encrypted (server/photos.js), hashes the device
// token one-way (SHA-256, §15), computes the AI conflict flag (§8.4), applies
// building versioning (§4.2), and writes the record. Everything tunable —
// match radius, conflict confidence — is read from the settings table, never
// hardcoded.

import crypto from 'node:crypto';
import { db, getSettingNumber } from './db.js';
import { storePhoto } from './photos.js';
import { DAMAGE_TIERS, INFRASTRUCTURE_TYPES } from './classify.js';

const HAZARD_TYPES = [
  'Earthquake', 'Flood', 'Tsunami', 'Hurricane / Cyclone', 'Wildfire',
  'Explosion', 'Chemical Incident', 'Conflict', 'Civil Unrest',
];
const LOCATION_METHODS = ['EXIF', 'LiveGPS', 'MapTap', 'Landmark', 'CellTower', 'Unknown'];
const PEOPLE = ['Yes', 'No', 'IDontKnow'];
const DEBRIS = ['Yes', 'No', 'Unknown'];

const LOCATION_CONFIDENCES = ['normal', 'low'];

const insert = db.prepare(`
INSERT OR IGNORE INTO submissions (
  submission_id, channel, timestamp, lat, lon, location_method, landmark_text,
  location_confidence,
  hazard_type, infrastructure_type, damage_classification,
  ai_suggested_damage, ai_confidence, ai_damage_percentage, ai_source, conflict_flag,
  people_in_danger, priority_flag,
  photo_hash_1, photo_hash_2, photo_hash_3,
  debris_present, description_text, language_detected, sync_status,
  building_id, version_number, dynamic_q1_answer, dynamic_q2_answer,
  received_at, device_hash
) VALUES (
  @submission_id, @channel, @timestamp, @lat, @lon, @location_method, @landmark_text,
  @location_confidence,
  @hazard_type, @infrastructure_type, @damage_classification,
  @ai_suggested_damage, @ai_confidence, @ai_damage_percentage, @ai_source, @conflict_flag,
  @people_in_danger, @priority_flag,
  @photo_hash_1, @photo_hash_2, @photo_hash_3,
  @debris_present, @description_text, @language_detected, @sync_status,
  @building_id, @version_number, @dynamic_q1_answer, @dynamic_q2_answer,
  @received_at, @device_hash
)`);

export function insertSubmission(payload) {
  const id = isUuid(payload.submission_id) ? payload.submission_id : crypto.randomUUID();

  // Idempotency: a re-sent submission (e.g. background-sync retry after a lost
  // response) must not create a duplicate. Return the existing record as-is.
  const existing = db.prepare('SELECT * FROM submissions WHERE submission_id = ?').get(id);
  if (existing) return rowResult(existing, true);

  // Store up to 3 photos, encrypted, collecting their hashes.
  const photos = Array.isArray(payload.photos) ? payload.photos.slice(0, 3) : [];
  const hashes = [null, null, null];
  photos.forEach((p, i) => {
    if (p && p.data) {
      try {
        hashes[i] = storePhoto({ base64: p.data, mime: p.mime || 'image/jpeg', width: int(p.width), height: int(p.height) });
      } catch (e) {
        console.warn('[submission] photo store failed:', e.message);
      }
    }
  });

  const lat = num(payload.lat);
  const lon = num(payload.lon);
  const { building_id, version_number } = assignBuilding(lat, lon);

  const people = PEOPLE.includes(payload.people_in_danger) ? payload.people_in_danger : null;
  const priority_flag = people === 'Yes' ? 1 : 0;

  const userDamage = DAMAGE_TIERS.includes(payload.damage_classification) ? payload.damage_classification : null;
  const aiDamage = DAMAGE_TIERS.includes(payload.ai_suggested_damage) ? payload.ai_suggested_damage : null;
  const aiConf = num(payload.ai_confidence);
  const conflict_flag = computeConflict(userDamage, aiDamage, aiConf) ? 1 : 0;

  // Record whether the AI suggestion came from the real model or the no-key mock
  // (§8): the classifier returns 'claude' for live and 'mock' for the placeholder.
  // Normalise to 'live' / 'mock' so the analyst can tell a demo placeholder apart.
  const ai_source = payload.ai_source === 'mock'
    ? 'mock'
    : (payload.ai_source === 'claude' || payload.ai_source === 'live' ? 'live' : null);

  const device_hash = payload.device_token
    ? crypto.createHash('sha256').update(String(payload.device_token)).digest('hex')
    : null;

  const location_method = LOCATION_METHODS.includes(payload.location_method)
    ? payload.location_method
    : (lat != null ? 'MapTap' : 'Unknown');

  // Location confidence (§9): 'low' marks an approximate coordinate an analyst
  // should treat with care and refine — e.g. a landmark-only report pinned at the
  // map centre, or cell-tower triangulation. Trust an explicit client value, else
  // derive it from the method so older clients and the seed stay consistent.
  const location_confidence = LOCATION_CONFIDENCES.includes(payload.location_confidence)
    ? payload.location_confidence
    : (location_method === 'Landmark' || location_method === 'CellTower' ? 'low' : 'normal');

  const record = {
    submission_id: id,
    channel: 'PWA',
    timestamp: str(payload.timestamp) || new Date().toISOString(), // CAPTURE time, not sync time
    lat, lon,
    location_method,
    landmark_text: str(payload.landmark_text),
    location_confidence,
    hazard_type: HAZARD_TYPES.includes(payload.hazard_type) ? payload.hazard_type : null,
    infrastructure_type: INFRASTRUCTURE_TYPES.includes(payload.infrastructure_type) ? payload.infrastructure_type : null,
    damage_classification: userDamage,
    ai_suggested_damage: aiDamage,
    ai_confidence: aiConf,
    ai_damage_percentage: num(payload.ai_damage_percentage),
    ai_source,
    conflict_flag,
    people_in_danger: people,
    priority_flag,
    photo_hash_1: hashes[0],
    photo_hash_2: hashes[1],
    photo_hash_3: hashes[2],
    debris_present: DEBRIS.includes(payload.debris_present) ? payload.debris_present : null,
    description_text: str(payload.description_text),
    language_detected: str(payload.language_detected),
    sync_status: 'Synced',
    building_id,
    version_number,
    dynamic_q1_answer: str(payload.dynamic_q1_answer),
    dynamic_q2_answer: str(payload.dynamic_q2_answer),
    received_at: new Date().toISOString(),
    device_hash,
  };

  insert.run(record);
  const saved = db.prepare('SELECT * FROM submissions WHERE submission_id = ?').get(id);
  return rowResult(saved, false);
}

// ---------------------------------------------------------------------------
// Building versioning (§4.2): a new report whose coordinates fall within the
// configured match radius of an existing report is linked to the same building
// and gets the next version number. No coordinates -> always a new building.
// ---------------------------------------------------------------------------
function assignBuilding(lat, lon) {
  if (lat == null || lon == null) {
    return { building_id: crypto.randomUUID(), version_number: 1 };
  }
  // Footprint matching is a production pathway; the prototype matches on GPS
  // proximity using the configurable GPS radius.
  const radius = getSettingNumber('version_match_gps_m') || 30;
  const rows = db
    .prepare('SELECT lat, lon, building_id FROM submissions WHERE lat IS NOT NULL AND lon IS NOT NULL')
    .all();
  let best = null;
  let bestDist = Infinity;
  for (const r of rows) {
    const d = haversine(lat, lon, r.lat, r.lon);
    if (d <= radius && d < bestDist) { best = r; bestDist = d; }
  }
  if (best) {
    const max = db.prepare('SELECT MAX(version_number) AS v FROM submissions WHERE building_id = ?').get(best.building_id);
    return { building_id: best.building_id, version_number: (max?.v || 0) + 1 };
  }
  return { building_id: crypto.randomUUID(), version_number: 1 };
}

// ---------------------------------------------------------------------------
// AI conflict detection (§8.4): flag whenever the user's CONFIRMED tier differs
// from the AI-SUGGESTED tier by one or more tiers AND the AI was reasonably
// confident. This catches every plausible disagreement — Minimal/Partial,
// Partial/Complete and Minimal/Complete (in either direction) — not just the
// largest gaps. The single confidence threshold lives in the settings table
// (conflict_min_confidence, ~0.70), never hardcoded. The three-tier scale and
// the priority (life-safety) flag are independent of this and unchanged.
const TIER_RANK = { Minimal: 0, Partial: 1, Complete: 2 };
function computeConflict(user, ai, conf) {
  if (!user || !ai || conf == null) return false;
  const ru = TIER_RANK[user];
  const ra = TIER_RANK[ai];
  if (ru == null || ra == null) return false;
  const minConf = getSettingNumber('conflict_min_confidence') ?? 0.70;
  return ru !== ra && conf >= minConf;
}

function rowResult(row, duplicate) {
  return {
    ok: true,
    duplicate,
    submission_id: row.submission_id,
    sync_status: row.sync_status,
    priority_flag: !!row.priority_flag,
    conflict_flag: !!row.conflict_flag,
    version_number: row.version_number,
    building_id: row.building_id,
    received_at: row.received_at,
    timestamp: row.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000; // metres
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const num = (v) =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
const int = (v) => (num(v) == null ? null : Math.round(Number(v)));
const str = (v) => (v === null || v === undefined || v === '' ? null : String(v));
const isUuid = (s) =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
