#!/usr/bin/env node
/**
 * build-static-lookup.js — Geotransport
 *
 * Generates files from De Lijn GTFS static zip:
 *
 *   public/static-lookup.json   ~1 MB   committed to git
 *     lines, routes, trips (with shapeId), agency, feed
 *
 *   public/stops.json           ~3 MB   deployed only (gitignored)
 *     stop_id → stop_name
 *
 *   public/shapes/{lineCode}.json   deployed only (gitignored)
 *     one file per line code (~1024 files), each: { shapeId: [[lat,lon],...] }
 *
 *   public/stop-times/{lineCode}.json  deployed only (gitignored)
 *     one file per line code (~1024 files), each: { tripKey: [{s,a},...] }
 *
 * Usage:
 *   node scripts/build-static-lookup.js               (downloads from API)
 *   node scripts/build-static-lookup.js gtfs.zip      (use local file)
 *
 * Secret: DL_GTFS = Ocp-Apim-Subscription-Key
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';

const __dir = dirname(fileURLToPath(import.meta.url));
const pub   = p => resolve(__dir, '../public', p);

const GTFS_URL = 'https://api.delijn.be/gtfs/static/v3/gtfs_transit.zip';
const API_KEY  = process.env.DL_GTFS;

// ── Get zip buffer ─────────────────────────────────────────────────────────────
let zipBuf;
const localPath = process.argv[2];
if (localPath) {
  console.log(`Reading ${localPath}...`);
  zipBuf = readFileSync(localPath);
} else {
  if (!API_KEY) { console.error('Set DL_GTFS env var.'); process.exit(1); }
  console.log('Downloading GTFS static zip...');
  const resp = await fetch(GTFS_URL, {
    headers: { 'Cache-Control': 'no-cache', 'Ocp-Apim-Subscription-Key': API_KEY },
  });
  if (!resp.ok) { console.error(`HTTP ${resp.status}`); process.exit(1); }
  const total = Number(resp.headers.get('content-length') || 0);
  const chunks = []; let received = 0;
  for await (const chunk of resp.body) {
    chunks.push(chunk); received += chunk.length;
    if (total) process.stdout.write(`\r  ${(received/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB`);
  }
  console.log('\nDone.');
  zipBuf = Buffer.concat(chunks);
}

const zip = await JSZip.loadAsync(zipBuf);

// ── Streaming CSV parser ───────────────────────────────────────────────────────
const decoder = new TextDecoder('utf-8');

async function parseCSVStream(zipEntry, onRow) {
  const buf = await zipEntry.async('nodebuffer');
  let headers = null, remainder = '';
  const CHUNK = 65536;

  const parseRow = line => {
    const vals = []; let cur = '', inQ = false;
    for (const ch of line + ',') {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { vals.push(cur); cur = ''; continue; }
      cur += ch;
    }
    return vals;
  };

  for (let offset = 0; offset < buf.length; offset += CHUNK) {
    const isLast = offset + CHUNK >= buf.length;
    const text   = remainder + decoder.decode(buf.slice(offset, offset + CHUNK), { stream: !isLast });
    const lines  = text.split('\n');
    remainder    = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '').trim();
      if (!line) continue;
      const vals = parseRow(line);
      if (!headers) { headers = vals.map(h => h.replace(/^\uFEFF/, '')); continue; }
      const row = {}; headers.forEach((h, j) => row[h] = vals[j] ?? '');
      onRow(row);
    }
  }
  if (remainder.trim()) {
    const vals = parseRow(remainder.replace(/\r$/, '').trim());
    if (headers && vals.length >= headers.length) {
      const row = {}; headers.forEach((h, j) => row[h] = vals[j] ?? '');
      onRow(row);
    }
  }
}

function toMins(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function mb(s) { return `${(s.length / 1048576).toFixed(1)} MB`; }

// ── routes.txt ────────────────────────────────────────────────────────────────
console.log('Parsing routes.txt...');
const lines = {}, routes = {};
await parseCSVStream(zip.file('routes.txt'), r => {
  const rid = r.route_id;
  routes[rid] = { name: r.route_short_name, long: r.route_long_name, color: r.route_color, textColor: r.route_text_color, url: r.route_url, type: r.route_type };
  const code = rid.slice(0,-1), dirn = rid.slice(-1);
  if (!lines[code]) lines[code] = { name: r.route_short_name, color: r.route_color, textColor: r.route_text_color, type: r.route_type, url: r.route_url };
  lines[code][`dir${dirn}`] = r.route_long_name;
  lines[code][`rid${dirn}`] = rid;
});
console.log(`  ${Object.keys(lines).length} lines, ${Object.keys(routes).length} routes`);

// ── trips.txt ─────────────────────────────────────────────────────────────────
console.log('Parsing trips.txt...');
const trips = {};
await parseCSVStream(zip.file('trips.txt'), t => {
  const key = t.trip_id.split('_').slice(0,3).join('_');
  if (!trips[key]) trips[key] = { headsign: t.trip_headsign, routeId: t.route_id, dir: t.direction_id, shapeId: t.shape_id };
});
console.log(`  ${Object.keys(trips).length} trip prefixes`);

// ── agency.txt ────────────────────────────────────────────────────────────────
const agency = {};
await parseCSVStream(zip.file('agency.txt'), a => {
  agency[a.agency_id] = { name: a.agency_name, url: a.agency_url, phone: a.agency_phone };
});

// ── feed_info.txt ─────────────────────────────────────────────────────────────
let feed = {};
await parseCSVStream(zip.file('feed_info.txt'), fi => {
  if (!feed.version) feed = { version: fi.feed_version||'', startDate: fi.feed_start_date||'', endDate: fi.feed_end_date||'' };
});

// ── Write static-lookup.json — small, committed to git ───────────────────────
const outLookup = JSON.stringify({ lines, routes, trips, agency, feed });
writeFileSync(pub('static-lookup.json'), outLookup);
console.log(`\n✓ static-lookup.json  ${mb(outLookup)}  (committed to git)`);

// ── stops.txt → stops.json — deploy only ─────────────────────────────────────
console.log('Parsing stops.txt...');
const stops = {};
await parseCSVStream(zip.file('stops.txt'), s => {
  stops[s.stop_id] = {
    n: s.stop_name,
    a: Math.round(parseFloat(s.stop_lat)*1e5)/1e5,
    o: Math.round(parseFloat(s.stop_lon)*1e5)/1e5,
  };
});
const outStops = JSON.stringify(stops);
writeFileSync(pub('stops.json'), outStops);
console.log(`✓ stops.json          ${mb(outStops)}  (deploy only)`);

// ── shapes.txt → public/shapes/{lineCode}.json ───────────────────────────────
// Shape IDs follow the pattern {lineCode}{suffix} e.g. "1001134" → lineCode "1001".
// ~1024 files, each containing all shapes for that line: { shapeId: [[lat,lon],...] }
const shapesDir = resolve(__dir, '../public/shapes');
mkdirSync(shapesDir, { recursive: true });
console.log('Parsing shapes.txt...');
const shapesByLine = {};  // lineCode → { shapeId → [[seq,lat,lon]] }
await parseCSVStream(zip.file('shapes.txt'), p => {
  const lineCode = p.shape_id.slice(0, 4);  // first 4 chars = line code
  if (!shapesByLine[lineCode]) shapesByLine[lineCode] = {};
  if (!shapesByLine[lineCode][p.shape_id]) shapesByLine[lineCode][p.shape_id] = [];
  shapesByLine[lineCode][p.shape_id].push([
    parseInt(p.shape_pt_sequence),
    Math.round(parseFloat(p.shape_pt_lat)*1e5)/1e5,
    Math.round(parseFloat(p.shape_pt_lon)*1e5)/1e5,
  ]);
});
let shapeCount = 0;
for (const [lineCode, shapesRaw] of Object.entries(shapesByLine)) {
  const out = {};
  for (const [id, pts] of Object.entries(shapesRaw)) {
    out[id] = pts.sort((a,b) => a[0]-b[0]).map(p => [p[1], p[2]]);
  }
  writeFileSync(resolve(shapesDir, `${lineCode}.json`), JSON.stringify(out));
  shapeCount++;
}
console.log(`✓ shapes/             ${shapeCount} files in public/shapes/  (deploy only)`);

// ── stop_times.txt → public/stop-times/{lineCode}.json ───────────────────────
// Chunked by line code (first segment of trip key, e.g. "1001").
// ~1024 files, each containing all trips for that line: { tripKey: [{s,a},...] }
// Fetched on demand when a vehicle is selected; cached in ST by line code.
const stopTimesDir = resolve(__dir, '../public/stop-times');
mkdirSync(stopTimesDir, { recursive: true });
console.log('Parsing stop_times.txt...');
const stByLine = {};  // lineCode → { tripKey → [{s,a}] }
const stSeen   = {};  // tripKey → first tripId seen (skip duplicates)
await parseCSVStream(zip.file('stop_times.txt'), st => {
  const parts    = st.trip_id.split('_');
  const lineCode = parts[0];
  const key      = parts.slice(0,3).join('_');
  if (!stByLine[lineCode]) stByLine[lineCode] = {};
  if (!stSeen[key]) {
    stSeen[key] = st.trip_id;
    stByLine[lineCode][key] = [];
  }
  if (stSeen[key] !== st.trip_id) return;  // skip other trips with same key
  stByLine[lineCode][key].push({ seq: parseInt(st.stop_sequence), s: st.stop_id, a: toMins(st.arrival_time) });
});
let stCount = 0;
for (const [lineCode, trips] of Object.entries(stByLine)) {
  // Sort each trip's stops by sequence, strip seq field
  const out = {};
  for (const [key, stops] of Object.entries(trips)) {
    out[key] = stops.sort((a,b) => a.seq - b.seq).map(({s, a}) => ({s, a}));
  }
  writeFileSync(resolve(stopTimesDir, `${lineCode}.json`), JSON.stringify(out));
  stCount++;
}
console.log(`✓ stop-times/         ${stCount} files in public/stop-times/  (deploy only)`);



console.log(`\nFeed: ${feed.version}  valid ${feed.startDate} → ${feed.endDate}`);
console.log('Run: wrangler deploy');
