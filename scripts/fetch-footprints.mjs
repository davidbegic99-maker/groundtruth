// One-time, DEVELOPMENT-TIME sourcing of OpenStreetMap building footprints for
// the single GroundTruth demo area (the Sultanahmet/Fatih cluster around
// lat 41.008, lon 28.978 — where the seed reports are located).
//
// It queries the Overpass API ONCE and writes a STATIC GeoJSON file committed
// into the repo (public/data/buildings-demo.geojson). The running app NEVER calls
// Overpass — it loads the committed file, and the service worker caches it so the
// overlay works offline like the rest of the PWA.
//
// Re-run manually only if you want to refresh the footprints:
//   node scripts/fetch-footprints.mjs
//
// Bounding box (small, one demo area only): south,west,north,east
//   41.0070, 28.9770, 41.0100, 28.9805  (~330 m × ~300 m)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public', 'data', 'buildings-demo.geojson');

const BBOX = { south: 41.0070, west: 28.9770, north: 41.0100, east: 28.9805 };

const query = `[out:json][timeout:60];
(way["building"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}););
out body geom;`;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function run() {
  let data = null;
  for (const url of ENDPOINTS) {
    try {
      console.log('Querying', url, '…');
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'GroundTruth-UNDP-prototype/1.0 (one-time footprint sourcing)',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      data = await resp.json();
      break;
    } catch (e) {
      console.warn('  failed:', e.message);
    }
  }
  if (!data) throw new Error('All Overpass endpoints failed');

  const features = [];
  for (const el of data.elements || []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
    const ring = el.geometry.map((p) => [round(p.lon), round(p.lat)]);
    if (ring.length < 4) continue;
    // Close the ring if Overpass didn't.
    const first = ring[0], last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    features.push({
      type: 'Feature',
      properties: { osm_id: el.id, building: (el.tags && el.tags.building) || 'yes' },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
  }

  const fc = {
    type: 'FeatureCollection',
    name: 'GroundTruth demo building footprints (Istanbul, Sultanahmet/Fatih cluster)',
    note: 'Sourced once from OpenStreetMap via Overpass at development time. One demo area only.',
    bbox: [BBOX.west, BBOX.south, BBOX.east, BBOX.north],
    features,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(fc));
  console.log(`Wrote ${features.length} building footprints → ${OUT}`);
}

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
