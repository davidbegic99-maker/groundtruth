// GroundTruth — data exports & shared filtering (Step 6, briefing §14).
//
// One filter engine (queryAnalyst, reused from analyst.js) feeds all outputs so
// the CSV, GeoJSON, GeoPackage exports and the REST API always agree. All three
// formats carry the mandatory fields (§14.1): geocoordinates (WGS84 decimal
// degrees), timestamp (UTC ISO 8601), damage_classification, infrastructure_type
// — plus the extras each format requires (§14.2).
//
// GeoPackage is produced WITHOUT any third-party GIS library: a .gpkg file is
// just a SQLite database that follows the OGC GeoPackage layout, and Node ships
// a SQLite engine (node:sqlite). We build a spec-valid single-file GPKG directly.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryAnalyst } from './analyst.js';

// Re-export so routes can pull rows once and hand them to any formatter.
export function getRows(filters) {
  return queryAnalyst(filters);
}

// ---------------------------------------------------------------------------
// CSV (§14.2): flat table — mandatory fields plus submission_id, hazard_type,
// channel, location_method, priority_flag.
// ---------------------------------------------------------------------------
const CSV_COLUMNS = [
  'submission_id', 'lat', 'lon', 'timestamp',
  'damage_classification', 'infrastructure_type',
  'hazard_type', 'channel', 'location_method', 'priority_flag',
  'building_id', 'version_number',
];

export function toCSV(rows) {
  const head = CSV_COLUMNS.join(',');
  const lines = rows.map((r) =>
    CSV_COLUMNS.map((c) => csvCell(c === 'priority_flag' ? (r.priority_flag ? 1 : 0) : r[c])).join(',')
  );
  return head + '\n' + lines.join('\n') + (lines.length ? '\n' : '');
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------------------------------------------------------------------------
// GeoJSON (§14.2): point geometry + all mandatory fields as properties,
// including building_id and version_number. Records with no coordinates are
// kept with null geometry so no data is silently dropped.
// ---------------------------------------------------------------------------
export function toGeoJSON(rows) {
  return {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    features: rows.map((r) => ({
      type: 'Feature',
      geometry: r.lon != null && r.lat != null ? { type: 'Point', coordinates: [r.lon, r.lat] } : null,
      properties: {
        submission_id: r.submission_id,
        timestamp: r.timestamp,
        damage_classification: r.damage_classification,
        infrastructure_type: r.infrastructure_type,
        hazard_type: r.hazard_type,
        channel: r.channel,
        location_method: r.location_method,
        priority_flag: !!r.priority_flag,
        conflict_flag: !!r.conflict_flag,
        building_id: r.building_id,
        version_number: r.version_number,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// GeoPackage (§14.2): OGC standard single file, geometry + all fields, WGS84
// (EPSG:4326) CRS metadata included. Returned as a Buffer of the .gpkg bytes.
// ---------------------------------------------------------------------------
const GPKG_APPLICATION_ID = 0x47504b47; // 'GPKG'
const GPKG_USER_VERSION = 10300; // GeoPackage 1.3.0
const TABLE = 'groundtruth_reports';

export function toGPKG(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'gt-gpkg-'));
  const path = join(dir, 'export.gpkg');
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA application_id = ${GPKG_APPLICATION_ID};`);
    db.exec(`PRAGMA user_version = ${GPKG_USER_VERSION};`);

    // Required GeoPackage metadata tables.
    db.exec(`
      CREATE TABLE gpkg_spatial_ref_sys (
        srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY,
        organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
        definition TEXT NOT NULL, description TEXT
      );
      CREATE TABLE gpkg_contents (
        table_name TEXT PRIMARY KEY, data_type TEXT NOT NULL,
        identifier TEXT UNIQUE, description TEXT DEFAULT '',
        last_change TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
        srs_id INTEGER REFERENCES gpkg_spatial_ref_sys(srs_id)
      );
      CREATE TABLE gpkg_geometry_columns (
        table_name TEXT NOT NULL, column_name TEXT NOT NULL,
        geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
        z TINYINT NOT NULL, m TINYINT NOT NULL,
        CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name)
      );
    `);

    const srs = db.prepare(
      `INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)`
    );
    srs.run('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system');
    srs.run('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system');
    srs.run('WGS 84 geodetic', 4326, 'EPSG', 4326, WGS84_WKT, 'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid');

    // Feature table: integer primary key + geometry blob + attributes.
    db.exec(`
      CREATE TABLE ${TABLE} (
        fid INTEGER PRIMARY KEY AUTOINCREMENT,
        geom BLOB,
        submission_id TEXT, timestamp TEXT,
        damage_classification TEXT, infrastructure_type TEXT,
        hazard_type TEXT, channel TEXT, location_method TEXT,
        priority_flag INTEGER, conflict_flag INTEGER,
        building_id TEXT, version_number INTEGER,
        lat REAL, lon REAL
      );
    `);

    db.prepare(
      `INSERT INTO gpkg_geometry_columns VALUES (?, 'geom', 'POINT', 4326, 0, 0)`
    ).run(TABLE);

    const ins = db.prepare(`
      INSERT INTO ${TABLE}
        (geom, submission_id, timestamp, damage_classification, infrastructure_type,
         hazard_type, channel, location_method, priority_flag, conflict_flag,
         building_id, version_number, lat, lon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rows) {
      const geom = gpkgPoint(r.lon, r.lat);
      if (r.lon != null && r.lat != null) {
        minX = Math.min(minX, r.lon); maxX = Math.max(maxX, r.lon);
        minY = Math.min(minY, r.lat); maxY = Math.max(maxY, r.lat);
      }
      ins.run(
        geom, r.submission_id, r.timestamp, r.damage_classification, r.infrastructure_type,
        r.hazard_type, r.channel, r.location_method, r.priority_flag ? 1 : 0, r.conflict_flag ? 1 : 0,
        r.building_id, r.version_number, r.lat, r.lon
      );
    }

    const bbox = Number.isFinite(minX)
      ? { minX, minY, maxX, maxY }
      : { minX: null, minY: null, maxX: null, maxY: null };
    db.prepare(
      `INSERT INTO gpkg_contents (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id)
       VALUES (?, 'features', ?, ?, ?, ?, ?, ?, 4326)`
    ).run(TABLE, 'GroundTruth reports', 'UNDP GroundTruth crisis damage reports', bbox.minX, bbox.minY, bbox.maxX, bbox.maxY);

    db.close();
    return readFileSync(path);
  } finally {
    try { db.close(); } catch (_) { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

// GeoPackageBinary blob (little-endian header + WKB point). Null when no coords.
function gpkgPoint(lon, lat) {
  if (lon == null || lat == null) return null;
  const header = Buffer.alloc(8);
  header.write('GP', 0, 'ascii');   // magic
  header.writeUInt8(0, 2);          // version 0
  header.writeUInt8(1, 3);          // flags: little-endian byte order, no envelope
  header.writeInt32LE(4326, 4);     // srs_id
  const wkb = Buffer.alloc(21);
  wkb.writeUInt8(1, 0);             // byte order: little-endian
  wkb.writeUInt32LE(1, 1);          // WKB type 1 = Point
  wkb.writeDoubleLE(lon, 5);
  wkb.writeDoubleLE(lat, 13);
  return Buffer.concat([header, wkb]);
}

const WGS84_WKT =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,' +
  'AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,' +
  'AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,' +
  'AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]';
