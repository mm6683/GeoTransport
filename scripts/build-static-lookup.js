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
 *   public/shapes.json          large   deployed only (gitignored)
 *     shape_id → [[lat,lon], ...]
 *
 *   public/stop-times.json      large   deployed only (gitignored)
 *     trip_key → [{s, a}, ...]
 *
 * Usage:
 *   node scripts/build-static-lookup.js               (downloads from API)
 *   node scripts/build-static-lookup.js gtfs.zip      (use local file)
 *
 * Secret: DL_GTFS = Ocp-Apim-Subscription-Key
 */

import { readFileSync, writeFileSync } from 'fs';
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
await parseCSVStream(zip.file('stops.txt'), s => { stops[s.stop_id] = s.stop_name; });
const outStops = JSON.stringify(stops);
writeFileSync(pub('stops.json'), outStops);
console.log(`✓ stops.json          ${mb(outStops)}  (deploy only)`);

// ── shapes.txt → public/shapes/{shapeId}.json — one file per shape ───────────
// Each file is tiny (~5–20KB), fetched on demand, cached by the browser.
import { mkdirSync } from 'fs';
console.log('Parsing shapes.txt...');
const shapesRaw = {};
await parseCSVStream(zip.file('shapes.txt'), p => {
  if (!shapesRaw[p.shape_id]) shapesRaw[p.shape_id] = [];
  shapesRaw[p.shape_id].push([parseInt(p.shape_pt_sequence), Math.round(parseFloat(p.shape_pt_lat)*1e5)/1e5, Math.round(parseFloat(p.shape_pt_lon)*1e5)/1e5]);
});
const shapesDir = resolve(__dir, '../public/shapes');
mkdirSync(shapesDir, { recursive: true });
let shapeCount = 0;
for (const [id, pts] of Object.entries(shapesRaw)) {
  const sorted = pts.sort((a,b) => a[0]-b[0]).map(p => [p[1], p[2]]);
  writeFileSync(resolve(shapesDir, `${id}.json`), JSON.stringify(sorted));
  shapeCount++;
}
console.log(`✓ shapes/             ${shapeCount} files in public/shapes/  (deploy only)`);

// ── stop_times.txt → public/stop-times/{key}.json — one file per trip key ────
// Each file is ~1–3KB, fetched on demand when a vehicle's panel is opened.
const stopTimesDir = resolve(__dir, '../public/stop-times');
mkdirSync(stopTimesDir, { recursive: true });
console.log('Parsing stop_times.txt...');
const stAccum = {};
await parseCSVStream(zip.file('stop_times.txt'), st => {
  const key = st.trip_id.split('_').slice(0,3).join('_');
  if (!stAccum[key]) stAccum[key] = { tripId: st.trip_id, stops: [] };
  if (stAccum[key].tripId !== st.trip_id) return;
  stAccum[key].stops.push({ seq: parseInt(st.stop_sequence), s: st.stop_id, a: toMins(st.arrival_time) });
});
let stCount = 0;
for (const [key, val] of Object.entries(stAccum)) {
  val.stops.sort((a,b) => a.seq - b.seq);
  const data = val.stops.map(({s, a}) => ({s, a}));
  writeFileSync(resolve(stopTimesDir, `${key}.json`), JSON.stringify(data));
  stCount++;
}
console.log(`✓ stop-times/         ${stCount} files in public/stop-times/  (deploy only)`);


console.log(`\nFeed: ${feed.version}  valid ${feed.startDate} → ${feed.endDate}`);
console.log('Run: wrangler deploy');
