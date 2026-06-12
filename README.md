# GroundTruth — Community Crisis Mapping Platform

**An offline-first Progressive Web App (PWA) for community crisis damage reporting, with a UNDP analyst dashboard, GIS exports, and an authenticated REST API.**

GroundTruth lets community members photograph and report damaged buildings after a
disaster — even with no internet connection — and gives UNDP analysts a map-based
dashboard with damage classification, priority flagging, version history, and
one-click data exports (CSV, GeoJSON, GeoPackage, PDF).

This repository is the **TRL-4 prototype** (proof of concept with working core
flows). It runs entirely on your own machine with no cloud account required.

---

## Table of contents

1. [The two views (start here)](#1-the-two-views-start-here)
2. [Quick start — run it in 2 minutes](#2-quick-start--run-it-in-2-minutes)
3. [The core evaluator workflow](#3-the-core-evaluator-workflow-submit--map--export)
4. [Analyst dashboard & access key](#4-analyst-dashboard--access-key)
5. [How to test offline functionality](#5-how-to-test-offline-functionality)
6. [Where the export buttons are](#6-where-the-export-buttons-are)
7. [REST API](#7-rest-api)
8. [AI damage classification & the open-source production pathway](#8-ai-damage-classification--the-open-source-production-pathway)
9. [Languages (all 6 UN languages)](#9-languages-all-6-un-languages)
10. [Privacy & security](#10-privacy--security)
11. [Configuration (nothing is hardcoded)](#11-configuration-nothing-is-hardcoded)
12. [Optional: real AI key and translation](#12-optional-real-ai-key-and-translation)
13. [Demo data](#13-demo-data)
14. [Project structure](#14-project-structure)
15. [Deployment](#15-deployment)

---

## 1. The two views (start here)

The prototype has **two clearly labelled views**. You do not need to install anything
to understand them — just open the URLs after starting the app (Section 2).

| View | URL | Who it's for | What it does |
|------|-----|--------------|--------------|
| **Reporter View** | `/` | Community members | Submit a damage report: photos → location → emergency type → AI damage assessment → questions → submit. Works offline. |
| **Analyst View** | `/analyst.html` | UNDP analysts | Map dashboard: public aggregate overview (no login) and a full analyst view (access key) with records, priority/conflict flags, version history, and exports. |

---

## 2. Quick start — run it in 2 minutes

**Prerequisite:** [Node.js](https://nodejs.org/) **version 22 or newer**. That is the
only requirement — the database is SQLite via Node's *built-in* engine, so there is
**no native build step and nothing else to install**.

Check your Node version:

```bash
node --version      # must print v22.x.x or higher
```

Then, from the project folder:

```bash
npm install         # installs the few JS dependencies
npm start           # starts the server on http://localhost:3000
```

You should see:

```
GroundTruth server running → http://localhost:3000
  Reporter View:  http://localhost:3000/
  Analyst View:   http://localhost:3000/analyst.html
```

Now open **http://localhost:3000/** in a modern browser (Chrome, Edge, Firefox, or
Safari). To stop the server, press `Ctrl + C` in the terminal.

> **Tip:** To see the dashboard populated with realistic data immediately, load the
> demo dataset — see [Section 13](#13-demo-data).

---

## 3. The core evaluator workflow (submit → map → export)

This is the complete loop the prototype is built around. It takes about a minute.

1. **Open the Reporter View** (`http://localhost:3000/`) and pick a language if you
   like (top-right selector — all 6 UN languages).
2. Click **Start a report**.
3. **Add a photo.** A short photo-guidance overlay appears first (tap *Got it*), then
   pick any image file. If the photo contains GPS data, the location is filled in
   automatically; metadata is stripped from the stored copy for privacy.
4. **Confirm the location.** Use *Use my current location*, tap the map to drop a pin,
   or type a landmark. (A report is *never* blocked by missing location.)
5. **Choose the emergency type** (e.g. Natural hazard → Earthquake).
6. **Damage assessment.** The AI suggests a damage level (Minimal / Partial / Complete)
   and a building type with a confidence score. **You confirm or correct it.** If no AI
   key is configured, a built-in sample assessment is shown so the flow still works (see
   [Section 8](#8-ai-damage-classification--the-open-source-production-pathway)).
7. **Answer the one mandatory question** ("Are there people trapped or in danger near
   this location?"). Answering *Yes* flags the report as Priority. Optional
   hazard-specific questions follow and can be skipped.
8. **Review and Submit.** Online → a green "submitted" confirmation with a mini-map.
   Offline → an orange "saved — will upload later" confirmation with a pending count.
9. **Open the Analyst View** (`http://localhost:3000/analyst.html`). The **Public
   overview** shows your report aggregated into the map. Switch to **Analyst records**,
   enter the access key (`undp-demo`), and you'll see the full record, then use the
   **Export & share** panel to download the data as CSV, GeoJSON, GeoPackage, or PDF.

---

## 4. Analyst dashboard & access key

Open **`http://localhost:3000/analyst.html`**.

- **Public overview** (no login): aggregated grid cells only — counts per damage tier
  per area. No individual report is ever exposed here. Includes a heatmap toggle, a
  coverage-gap (under-reported area) toggle, and a "reports in view" counter.
- **Analyst records** (access key required): full individual records as map markers
  (colour-coded by damage tier, with a **red Priority** badge and a **yellow Conflict**
  badge), filters, a records list, a detail panel (photos, version history, the
  analyst-only AI damage estimate, dedup annotations), and the export panel.

**Prototype access key:** `undp-demo`

To change it, set the `ANALYST_KEY` environment variable before starting the server:

```bash
# macOS / Linux
ANALYST_KEY="my-secret-key" npm start

# Windows PowerShell
$env:ANALYST_KEY = "my-secret-key"; npm start
```

The key is never stored in the public settings table, so it cannot leak through the
public API.

---

## 5. How to test offline functionality

Offline-first is a core requirement: every report is written to the device
(IndexedDB) **before** any network attempt, and uploads automatically when
connectivity returns. To verify:

**Option A — Browser DevTools (quickest):**

1. Open the Reporter View and let it load fully once (so the service worker caches it).
2. Open DevTools → **Network** tab → set throttling to **Offline** (or DevTools →
   *Application* → *Service Workers* → tick *Offline*).
3. The header shows an **Offline** indicator and a banner appears.
4. Complete a report and submit. You'll get the orange **"Report saved — will upload
   automatically when you reconnect"** confirmation, and a pending-count badge appears
   on the welcome screen.
5. Set the network back to **Online**. The queue flushes automatically (you can also
   reload the page or click **Sync now**). Refresh the Analyst View — the report is now
   there.

**Option B — Real device:** install the app (the browser's *Install app* prompt, or
the in-app *Install app* button), turn on airplane mode, submit a report, then turn
connectivity back on.

What to confirm:
- The app still loads and is fully usable with no network (service worker app shell).
- A submitted report survives a full page reload / app restart while offline.
- On reconnect, the pending count drops to zero and the report appears in the dashboard.
- Re-sending the same queued report never creates a duplicate (the server is idempotent
  on the report's ID).

Photos are compressed to a configurable target (~200 KB) for upload, while the
**full-resolution original is retained locally on the device**.

---

## 6. Where the export buttons are

In the **Analyst View** → **Analyst records** tab (enter the access key first) →
the **Export & share** card. All exports honour whatever **filters** are currently set
(damage level, emergency type, building type, time range, priority-only, conflicts-only).

| Button | Format | Notes |
|--------|--------|-------|
| **CSV** | `.csv` | Flat table: the four mandatory fields plus `submission_id`, `hazard_type`, `channel`, `location_method`, `priority_flag`, `building_id`, `version_number`. |
| **GeoJSON** | `.geojson` | Point `FeatureCollection`, WGS84 (CRS84). Records with no coordinates are kept with `null` geometry so nothing is dropped. |
| **GeoPackage** | `.gpkg` | A genuine OGC GeoPackage (single SQLite file, EPSG:4326). Opens directly in QGIS and other GIS tools. |
| **PDF summary** | `.pdf` | One-page printable area summary: damage breakdown chart, schematic cluster map, infrastructure affected, dominant hazard, time range, and a representative photo. |

**The four mandatory fields are present and correctly formatted in all tabular
exports:** geocoordinates (decimal degrees, WGS84), timestamp (UTC ISO 8601),
`damage_classification` (only `Minimal` / `Partial` / `Complete`), and
`infrastructure_type` (one of the 7 UNDP categories).

---

## 7. REST API

An authenticated `GET` endpoint returns live, filtered GeoJSON. It auto-updates as new
reports sync. Send the access key in the `x-analyst-key` header.

**Endpoint:** `GET /api/v1/reports`

**Filter parameters (all optional, combinable):**

| Parameter | Example | Meaning |
|-----------|---------|---------|
| `bbox` | `28.9,40.9,29.1,41.1` | Bounding box as `minLon,minLat,maxLon,maxLat` |
| `from_time` | `2026-06-10T00:00:00Z` | Earliest capture timestamp (UTC ISO 8601) |
| `to_time` | `2026-06-11T00:00:00Z` | Latest capture timestamp |
| `damage_classification` | `Complete` | `Minimal` / `Partial` / `Complete` |
| `hazard_type` | `Earthquake` | Any of the 9 hazard types |
| `infrastructure_type` | `Residential Infrastructure` | Any of the 7 categories |
| `priority_flag` | `1` | Only reports where people are in danger |
| `conflict_flag` | `1` | Only reports where AI and user classification diverge |

**Examples:**

```bash
# All reports as GeoJSON
curl -H "x-analyst-key: undp-demo" \
  "http://localhost:3000/api/v1/reports"

# Only "Complete" damage, priority reports, within a bounding box
curl -H "x-analyst-key: undp-demo" \
  "http://localhost:3000/api/v1/reports?damage_classification=Complete&priority_flag=1&bbox=28.9,40.9,29.1,41.1"

# Earthquake reports in a time window
curl -H "x-analyst-key: undp-demo" \
  "http://localhost:3000/api/v1/reports?hazard_type=Earthquake&from_time=2026-06-10T00:00:00Z&to_time=2026-06-11T00:00:00Z"
```

A request with no key (or a wrong key) returns `401 Unauthorized`.

The same filters also drive the file-download endpoints, which the dashboard buttons
call for you: `GET /api/export/csv`, `/api/export/geojson`, `/api/export/gpkg`,
`/api/export/pdf` (all require the `x-analyst-key` header).

---

## 8. AI damage classification & the open-source production pathway

The damage tier (Minimal / Partial / Complete), confidence score, analyst-only damage
percentage, and suggested building type come from an AI assessment of the photo,
grounded in a five-standard engineering cross-walk (ATC-20, EMS-98, Copernicus EMS,
xBD, and the UNDP tiers).

**Prototype behaviour:**
- If an `ANTHROPIC_API_KEY` environment variable is set, the prototype calls the
  **Claude API** (default model `claude-sonnet-4-6`, overridable via `ANTHROPIC_MODEL`)
  for vision classification.
- If **no key is set** (the default for an evaluator), a **deterministic built-in
  sample classifier** runs instead, so the entire flow — including conflict detection —
  is fully testable with zero configuration and zero cost.

**Open-source production pathway (required by the challenge open-source mandate):**

> The prototype AI classification uses the Claude API. The production implementation
> uses **LLaVA** (Meta, open source, Apache 2.0 license) or **CLIP** (OpenAI, open
> source, MIT license) — both are free, publicly available, and can be self-hosted by
> UNDP or any partner organization without licensing costs, ensuring full replicability
> as required by the challenge open-source mandate.

---

## 9. Languages (all 6 UN languages)

The interface is available in all six official UN languages: **English, Arabic,
Chinese (Simplified), French, Russian, and Spanish**. The language selector is on the
first screen; switching is instant (no reload). The device language is auto-detected on
first load. **Arabic renders fully right-to-left** (the entire layout mirrors).

**Adding a new language** requires **no code changes**:
1. Copy `public/locales/en.json` to `public/locales/<code>.json` and translate the
   values.
2. Add one entry to the `SUPPORTED` array in `public/js/i18n.js`
   (`{ code: '<code>', name: '<Native name>', dir: 'ltr' | 'rtl' }`).
3. Add the new file path to the `ASSETS` list in `public/sw.js` so it is cached offline.

LibreTranslate (see Section 12) handles 50+ languages for free-text user descriptions
with no extra code change.

---

## 10. Privacy & security

- **Anonymous by default** — no login, no names, phone numbers, or personal identifiers
  are ever stored. The submission screen states this explicitly.
- **Photos encrypted at rest** with **AES-256-GCM**, stored separately and referenced
  only by a SHA-256 hash. The encryption key is read from `GT_PHOTO_KEY` (hex, base64,
  or passphrase); if unset, a random key is generated once and persisted in the data
  directory so photos remain decryptable across restarts.
- **Photo metadata stripped** in the browser before upload (the stored copy is
  re-encoded via canvas, removing device serial numbers and other EXIF beyond the
  GPS/timestamp the report needs).
- **Device identifiers hashed** one-way with SHA-256 before storage — submitters cannot
  be re-identified.
- **Transport security (TLS 1.3)** is provided by the hosting platform in production
  (see Section 15). Locally the app runs over plain HTTP for convenience.
- The **public dashboard exposes aggregates only**; individual records require the
  analyst access key.

---

## 11. Configuration (nothing is hardcoded)

Operational values are stored in a `settings` table and are editable at runtime via the
settings API — **none are hardcoded in the codebase**. Notably, the PDF auto-summary
rule (default **5 reports within 200 m**) is configurable, exactly as UNDP requires.

View all settings:

```bash
curl http://localhost:3000/api/settings
```

Change one (example: trigger the PDF summary at 8 reports instead of 5):

```bash
curl -X PUT http://localhost:3000/api/settings/pdf_threshold_count \
  -H "content-type: application/json" -d '{"value": 8}'
```

Configurable settings include: PDF threshold count & radius, building-version match
radii, the deduplication time window, the AI conflict-confidence thresholds, the live
dashboard refresh interval, the photo compression target, the public grid-cell size,
and the under-reported-area threshold.

---

## 12. Optional: real AI key and translation

All of these are optional — the prototype works fully without them.

| Environment variable | Purpose |
|----------------------|---------|
| `ANTHROPIC_API_KEY` | Enables real Claude vision classification (otherwise the sample classifier runs). |
| `ANTHROPIC_MODEL` | Override the default model (`claude-sonnet-4-6`). |
| `ANALYST_KEY` | Override the analyst access key (default `undp-demo`). |
| `GT_PHOTO_KEY` | 32-byte AES key for photo encryption (hex, base64, or passphrase). |
| `LIBRETRANSLATE_URL` | Enables server-side translation of free-text descriptions into English via a [LibreTranslate](https://libretranslate.com/) instance (open source, self-hostable, 50+ languages). |
| `LIBRETRANSLATE_API_KEY` | API key for the LibreTranslate instance, if it requires one. |
| `SEED_ON_BOOT` | Set to `1` to load the 16-report demo dataset at startup **only when the database is empty** (used by the Render Blueprint so a fresh deploy shows data). Never overwrites existing reports. |
| `PORT` | Server port (default `3000`). |

When LibreTranslate is configured, the original user text **and** an English
translation are stored, plus the detected language code. When it is not configured,
translation is simply skipped and the original text is kept — nothing breaks.

---

## 13. Demo data

To populate the dashboard with a realistic 16-report Istanbul dataset (two clusters,
scattered points, priority and conflict cases, a 3-version building, and one report with
no location), start the server, then in a second terminal run:

```bash
node scripts/seed-demo.mjs
```

This **wipes** any existing reports and loads the curated demo set through the real
submission pipeline (encrypted photos, hashed device IDs, versioning, conflict flags).

**On a deployed instance** (where you can't easily run a script), set the
`SEED_ON_BOOT=1` environment variable instead. The server then loads the same demo
dataset on startup *only if the database is empty* — it never overwrites real reports.
The included Render Blueprint (`render.yaml`) sets this for you.

---

## 14. Project structure

```
public/                 The PWA (served as static files)
  index.html            Reporter View
  analyst.html          Analyst View
  manifest.json         PWA manifest
  sw.js                 Service worker (offline app shell + background sync)
  css/styles.css        Styles (incl. Arabic RTL mirroring)
  js/
    i18n.js             i18next wrapper, language detection, RTL
    shell.js            Shared shell: language selector, online/offline, SW registration
    data.js             Canonical reference data (hazards, infra types, damage tiers, questions)
    app.js              Reporter: navigation + live contribution counter
    report.js           Reporter step 1: photos + location fallback chain
    flow.js             Reporter step 2: hazard → AI → questions → review
    submit.js           Reporter step 3: submit + offline IndexedDB queue
    analyst.js          Analyst dashboard (public + authenticated tiers)
  locales/              en, ar, zh, fr, ru, es translation files
  vendor/               Leaflet, i18next, localForage, exifr (vendored, no CDN needed)
server/
  index.js              Express server + all API routes
  db.js                 SQLite schema (Node built-in node:sqlite) + settings
  submissions.js        Submission intake: validation, versioning, conflict flag
  classify.js           AI damage classification (Claude API + sample fallback)
  photos.js             AES-256-GCM encrypted photo store
  analyst.js            Analyst + public dashboard queries
  exports.js            CSV / GeoJSON / GeoPackage builders + shared filtering
  pdf.js                Dependency-free PDF area-summary writer
  dedup.js              Post-sync AI deduplication (spatial/temporal/perceptual)
  translate.js          Optional LibreTranslate integration
scripts/
  seed-demo.mjs         Load the demo dataset
  make-test-jpeg.cjs    Generate a GPS-tagged test photo (dev fixture)
```

---

## 15. Deployment

The app is a standard Node/Express server and deploys to any free Node host that
provides a public HTTPS URL. A **Render Blueprint** (`render.yaml`) is included for a
near one-click deploy.

**Deploy to Render (free, no card required):**

1. Push this repository to GitHub.
2. In [Render](https://render.com): **New +** → **Blueprint** → connect the repo.
   Render reads `render.yaml` automatically.
3. Click **Apply**. The first build runs `npm install`, then `npm start`, and Render
   assigns a public HTTPS URL such as `https://groundtruth.onrender.com`.

**Requirements for any host:**

- **Node 22+** runtime.
- Start command: `npm start` (the server binds to the platform's `PORT`).
- The platform terminates **TLS 1.3** for you, satisfying the in-transit encryption
  requirement.
- A small **writable disk** for `server/data/` (the SQLite database, the photo
  encryption key, and uploaded photos). On the Render free tier the filesystem is
  ephemeral and the service sleeps when idle, so the database resets on restart — fine
  for a TRL-4 demo where evaluators submit and immediately view/export. For persistent
  data, use a paid instance with a disk mounted at `server/data`, or set `GT_DB_PATH`
  and `GT_PHOTO_KEY` so data and key survive restarts.

> **Live demo URL:** https://groundtruth-9jr7.onrender.com

For UNDP evaluators, the deployed app is accessible without login for the Reporter View
and the public dashboard; the Analyst records tab uses the access key `undp-demo`.

---

*GroundTruth — UNDP community crisis mapping prototype (TRL-4). Anonymous reports; no
personal data stored or shared.*
