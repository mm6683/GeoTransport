#!/usr/bin/env node
/**
 * build-static-lookup.js — Geotransport
 *
 * Generates two files from De Lijn GTFS static zip:
 *   public/static-lookup.json  — lines, routes, trips (with shapeId), stops, shapes, agency, feed
 *   public/stop-times.json     — per trip_key: [{s:stop_id, a:minutes_from_midnight}, ...]
 *
 * Usage:
 *   node scripts/build-static-lookup.js               (downloads from API)
 *   node scripts/build-static-lookup.js gtfs.zip      (use local file)
 *
 * Secret: set DL_GTFS env var to your Ocp-Apim-Subscription-Key
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';

const __dir       = dirname(fileURLToPath(import.meta.url));
const outLookup   = resolve(__dir, '../public/static-lookup.json');
const outStopTimes = resolve(__dir, '../public/stop-times.json');

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
    headers: { 'Cache-Control':'no-cache', 'Ocp-Apim-Subscription-Key': API_KEY },
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

function parseCSV(text) {
  const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  const headers = lines[0].trim().split(',').map(h => h.replace(/^"|"$/g,''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim(); if (!line) continue;
    const vals = []; let cur = '', inQ = false;
    for (const ch of line + ',') {
      if (ch==='"') { inQ=!inQ; continue; }
      if (ch===',' && !inQ) { vals.push(cur); cur=''; continue; }
      cur += ch;
    }
    const row = {}; headers.forEach((h,j) => row[h] = vals[j]??'');
    rows.push(row);
  }
  return rows;
}

// Convert "HH:MM:SS" to minutes from midnight
function toMins(t) {
  if (!t) return null;
  const [h,m] = t.split(':').map(Number);
  return h * 60 + m;
}

// ── routes.txt ────────────────────────────────────────────────────────────────
console.log('Parsing routes.txt...');
const rawRoutes = {};
for (const r of parseCSV(await zip.file('routes.txt').async('string'))) {
  rawRoutes[r.route_id] = r;
}

// lines: lineCode (route_id[:-1]) → merged entry for RT tripId[0] join
const lines = {};
// routes: exact per-direction entry
const routes = {};
for (const [rid, r] of Object.entries(rawRoutes)) {
  routes[rid] = {
    name:      r.route_short_name,
    long:      r.route_long_name,
    color:     r.route_color,
    textColor: r.route_text_color,
    url:       r.route_url,
    type:      r.route_type,
  };
  const code = rid.slice(0,-1), dirn = rid.slice(-1);
  if (!lines[code]) {
    lines[code] = {
      name: r.route_short_name, color: r.route_color,
      textColor: r.route_text_color, type: r.route_type, url: r.route_url,
    };
  }
  lines[code][`dir${dirn}`] = r.route_long_name;
  lines[code][`rid${dirn}`] = rid;
}
console.log(`  ${Object.keys(lines).length} lines, ${Object.keys(routes).length} directional routes`);

// ── trips.txt ─────────────────────────────────────────────────────────────────
console.log('Parsing trips.txt...');
const trips = {};
for (const t of parseCSV(await zip.file('trips.txt').async('string'))) {
  const key = t.trip_id.split('_').slice(0,3).join('_');
  if (trips[key]) continue;
  trips[key] = {
    headsign: t.trip_headsign,
    routeId:  t.route_id,
    dir:      t.direction_id,
    shapeId:  t.shape_id,     // ← NEW: links to shapes lookup
  };
}
console.log(`  ${Object.keys(trips).length} trip prefixes`);

// ── stops.txt ─────────────────────────────────────────────────────────────────
console.log('Parsing stops.txt...');
const stops = {};
for (const s of parseCSV(await zip.file('stops.txt').async('string'))) {
  stops[s.stop_id] = {
    name: s.stop_name,
    lat:  parseFloat(s.stop_lat),
    lon:  parseFloat(s.stop_lon),
    code: s.stop_code || s.stop_id,
    wc:   s.wheelchair_boarding === '1' ? 1 : 0,
  };
}
console.log(`  ${Object.keys(stops).length} stops`);

// ── shapes.txt ────────────────────────────────────────────────────────────────
console.log('Parsing shapes.txt...');
const shapesRaw = {};
for (const p of parseCSV(await zip.file('shapes.txt').async('string'))) {
  if (!shapesRaw[p.shape_id]) shapesRaw[p.shape_id] = [];
  shapesRaw[p.shape_id].push([
    parseInt(p.shape_pt_sequence),
    parseFloat(parseFloat(p.shape_pt_lat).toFixed(5)),
    parseFloat(parseFloat(p.shape_pt_lon).toFixed(5)),
  ]);
}
// Sort by sequence and strip sequence number, keep [lat, lon] pairs
const shapes = {};
for (const [id, pts] of Object.entries(shapesRaw)) {
  shapes[id] = pts.sort((a,b) => a[0]-b[0]).map(p => [p[1], p[2]]);
}
console.log(`  ${Object.keys(shapes).length} shapes`);

// ── stop_times.txt → stop-times.json ─────────────────────────────────────────
// Key: 3-part trip_key (same as trips map)
// Value: [{s:stop_id, a:minutes_from_midnight}, ...] sorted by stop_sequence
// First occurrence per trip_key wins (same stop pattern for all trips on same template)
console.log('Parsing stop_times.txt...');
const stopTimesRaw = {};   // trip_key → [{seq, stop_id, arr_mins}]
for (const st of parseCSV(await zip.file('stop_times.txt').async('string'))) {
  const key = st.trip_id.split('_').slice(0,3).join('_');
  if (stopTimesRaw[key]) continue;  // first occurrence wins
  stopTimesRaw[key] = [];
  // We'll re-visit this trip when we encounter more rows for it
  stopTimesRaw[key].__tripId = st.trip_id;
}
// Second pass: collect all stops for each recorded trip
const seen = new Set(Object.values(stopTimesRaw).map(v => v.__tripId));
// Reset and re-parse properly (two-pass to handle streamed data)
const stopTimesFull = {};  // tripId → [{seq, sid, a}]
for (const st of parseCSV(await zip.file('stop_times.txt').async('string'))) {
  const key = st.trip_id.split('_').slice(0,3).join('_');
  if (!stopTimesFull[key]) stopTimesFull[key] = { tripId: st.trip_id, stops: [] };
  if (stopTimesFull[key].tripId !== st.trip_id) continue; // skip other trips with same key
  stopTimesFull[key].stops.push({
    seq: parseInt(st.stop_sequence),
    s:   st.stop_id,
    a:   toMins(st.arrival_time),
  });
}

const stopTimes = {};
for (const [key, val] of Object.entries(stopTimesFull)) {
  val.stops.sort((a,b) => a.seq - b.seq);
  stopTimes[key] = val.stops.map(({s, a}) => ({s, a}));
}
console.log(`  ${Object.keys(stopTimes).length} trip stop sequences`);

// ── agency.txt ────────────────────────────────────────────────────────────────
const agency = {};
for (const a of parseCSV(await zip.file('agency.txt').async('string')))
  agency[a.agency_id] = { name: a.agency_name, url: a.agency_url, phone: a.agency_phone };

// ── feed_info.txt ─────────────────────────────────────────────────────────────
let feed = {};
const fi = parseCSV(await zip.file('feed_info.txt').async('string'))[0] || {};
feed = { version: fi.feed_version||'', startDate: fi.feed_start_date||'', endDate: fi.feed_end_date||'' };

// ── Write static-lookup.json ─────────────────────────────────────────────────
const lookup = { lines, routes, trips, stops, shapes, agency, feed };
const outL = JSON.stringify(lookup, null, 0);
writeFileSync(outLookup, outL);
const lkbMB = (outL.length / 1048576).toFixed(1);
console.log(`\n✓ static-lookup.json  ${lkbMB} MB`);
console.log(`  lines=${Object.keys(lines).length}  routes=${Object.keys(routes).length}  trips=${Object.keys(trips).length}`);
console.log(`  stops=${Object.keys(stops).length}  shapes=${Object.keys(shapes).length}`);

// ── Write stop-times.json ─────────────────────────────────────────────────────
const outST = JSON.stringify(stopTimes, null, 0);
writeFileSync(outStopTimes, outST);
const stMB = (outST.length / 1048576).toFixed(1);
console.log(`✓ stop-times.json     ${stMB} MB`);
console.log(`  trip keys: ${Object.keys(stopTimes).length}`);
console.log(`\nFeed: ${feed.version} valid ${feed.startDate} → ${feed.endDate}`);
console.log('\nRun: wrangler deploy');
