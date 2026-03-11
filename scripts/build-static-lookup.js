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

const __dir        = dirname(fileURLToPath(import.meta.url));
const outLookup    = resolve(__dir, '../public/static-lookup.json');
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
// Reads a zip entry as a Buffer and calls onRow(row) for each parsed CSV row.
// Never builds a giant string — processes ~8KB chunks at a time.
const decoder = new TextDecoder('utf-8');

async function parseCSVStream(zipEntry, onRow) {
  const buf = await zipEntry.async('nodebuffer');
  let headers = null;
  let remainder = '';
  const CHUNK = 65536; // 64KB chunks

  for (let offset = 0; offset < buf.length; offset += CHUNK) {
    const slice = buf.slice(offset, Math.min(offset + CHUNK, buf.length));
    const text  = remainder + decoder.decode(slice, { stream: offset + CHUNK < buf.length });
    const lines = text.split('\n');
    // Last element may be incomplete — carry forward
    remainder = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '').trim();
      if (!line) continue;

      // Parse fields (handles simple quoting)
      const vals = []; let cur = '', inQ = false;
      for (const ch of line + ',') {
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === ',' && !inQ) { vals.push(cur); cur = ''; continue; }
        cur += ch;
      }

      if (!headers) {
        headers = vals.map(h => h.replace(/^\uFEFF/, '')); // strip BOM
        continue;
      }
      const row = {};
      headers.forEach((h, j) => row[h] = vals[j] ?? '');
      onRow(row);
    }
  }

  // Handle any trailing content
  if (remainder.trim()) {
    const line = remainder.replace(/\r$/, '').trim();
    const vals = []; let cur = '', inQ = false;
    for (const ch of line + ',') {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { vals.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (headers && vals.length >= headers.length) {
      const row = {};
      headers.forEach((h, j) => row[h] = vals[j] ?? '');
      onRow(row);
    }
  }
}

function toMins(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// ── routes.txt ────────────────────────────────────────────────────────────────
console.log('Parsing routes.txt...');
const lines = {}, routes = {};
await parseCSVStream(zip.file('routes.txt'), r => {
  const rid = r.route_id;
  routes[rid] = {
    name: r.route_short_name, long: r.route_long_name,
    color: r.route_color, textColor: r.route_text_color,
    url: r.route_url, type: r.route_type,
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
});
console.log(`  ${Object.keys(lines).length} lines, ${Object.keys(routes).length} directional routes`);

// ── trips.txt ─────────────────────────────────────────────────────────────────
console.log('Parsing trips.txt...');
const trips = {};
await parseCSVStream(zip.file('trips.txt'), t => {
  const key = t.trip_id.split('_').slice(0,3).join('_');
  if (trips[key]) return;
  trips[key] = {
    headsign: t.trip_headsign, routeId: t.route_id,
    dir: t.direction_id, shapeId: t.shape_id,
  };
});
console.log(`  ${Object.keys(trips).length} trip prefixes`);

// ── stops.txt ─────────────────────────────────────────────────────────────────
console.log('Parsing stops.txt...');
const stops = {};
await parseCSVStream(zip.file('stops.txt'), s => {
  stops[s.stop_id] = {
    name: s.stop_name,
    lat:  parseFloat(parseFloat(s.stop_lat).toFixed(5)),
    lon:  parseFloat(parseFloat(s.stop_lon).toFixed(5)),
    wc:   s.wheelchair_boarding === '1' ? 1 : 0,
  };
});
console.log(`  ${Object.keys(stops).length} stops`);

// ── shapes.txt ────────────────────────────────────────────────────────────────
console.log('Parsing shapes.txt...');
const shapesRaw = {};
await parseCSVStream(zip.file('shapes.txt'), p => {
  if (!shapesRaw[p.shape_id]) shapesRaw[p.shape_id] = [];
  shapesRaw[p.shape_id].push([
    parseInt(p.shape_pt_sequence),
    parseFloat(parseFloat(p.shape_pt_lat).toFixed(5)),
    parseFloat(parseFloat(p.shape_pt_lon).toFixed(5)),
  ]);
});
const shapes = {};
for (const [id, pts] of Object.entries(shapesRaw)) {
  shapes[id] = pts.sort((a,b) => a[0]-b[0]).map(p => [p[1], p[2]]);
}
console.log(`  ${Object.keys(shapes).length} shapes`);

// ── stop_times.txt ────────────────────────────────────────────────────────────
// Key: 3-part trip_key. First occurrence per key wins (same stop pattern).
console.log('Parsing stop_times.txt...');
const stAccum = {};   // trip_key → { tripId, stops:[] }
await parseCSVStream(zip.file('stop_times.txt'), st => {
  const key = st.trip_id.split('_').slice(0,3).join('_');
  if (!stAccum[key]) {
    stAccum[key] = { tripId: st.trip_id, stops: [] };
  }
  // Only collect stops from the first trip_id seen for this key
  if (stAccum[key].tripId !== st.trip_id) return;
  stAccum[key].stops.push({ seq: parseInt(st.stop_sequence), s: st.stop_id, a: toMins(st.arrival_time) });
});
const stopTimes = {};
for (const [key, val] of Object.entries(stAccum)) {
  val.stops.sort((a,b) => a.seq - b.seq);
  stopTimes[key] = val.stops.map(({s, a}) => ({s, a}));
}
console.log(`  ${Object.keys(stopTimes).length} trip stop sequences`);

// ── agency.txt ────────────────────────────────────────────────────────────────
const agency = {};
await parseCSVStream(zip.file('agency.txt'), a => {
  agency[a.agency_id] = { name: a.agency_name, url: a.agency_url, phone: a.agency_phone };
});

// ── feed_info.txt ─────────────────────────────────────────────────────────────
let feed = {};
await parseCSVStream(zip.file('feed_info.txt'), fi => {
  if (!feed.version) feed = {
    version: fi.feed_version || '',
    startDate: fi.feed_start_date || '',
    endDate: fi.feed_end_date || '',
  };
});

// ── Write static-lookup.json ─────────────────────────────────────────────────
const lookup = { lines, routes, trips, stops, shapes, agency, feed };
const outL = JSON.stringify(lookup);
writeFileSync(outLookup, outL);
console.log(`\n✓ static-lookup.json  ${(outL.length/1048576).toFixed(1)} MB`);
console.log(`  lines=${Object.keys(lines).length}  routes=${Object.keys(routes).length}  trips=${Object.keys(trips).length}`);
console.log(`  stops=${Object.keys(stops).length}  shapes=${Object.keys(shapes).length}`);

// ── Write stop-times.json ─────────────────────────────────────────────────────
const outST = JSON.stringify(stopTimes);
writeFileSync(outStopTimes, outST);
console.log(`✓ stop-times.json     ${(outST.length/1048576).toFixed(1)} MB`);
console.log(`  trip keys: ${Object.keys(stopTimes).length}`);
console.log(`\nFeed: ${feed.version} valid ${feed.startDate} → ${feed.endDate}`);
console.log('\nRun: wrangler deploy');
