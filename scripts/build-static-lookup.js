#!/usr/bin/env node
/**
 * build-static-lookup.js — Geotransport
 *
 * Generates public/static-lookup.json from De Lijn GTFS static zip.
 * Run locally after a new zip is available (check weekly).
 *
 * Usage:
 *   node scripts/build-static-lookup.js               (downloads from API)
 *   node scripts/build-static-lookup.js gtfs.zip      (use local file)
 *
 * Secret: set DL_GTFS env var to your Ocp-Apim-Subscription-Key
 *   Windows:  set DL_GTFS=your_key
 *   Unix/Mac: export DL_GTFS=your_key
 *
 * After running: wrangler deploy
 *
 * Requires: npm install jszip  (one-time)
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';

const __dir  = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dir, '../public/static-lookup.json');

const GTFS_URL = 'https://api.delijn.be/gtfs/static/v3/gtfs_transit.zip';
const API_KEY  = process.env.DL_GTFS;

// ── Get zip buffer ─────────────────────────────────────────────────────────────
let zipBuf;
const localPath = process.argv[2];
if (localPath) {
  console.log(`Reading ${localPath}...`);
  zipBuf = readFileSync(localPath);
} else {
  if (!API_KEY) {
    console.error('Set DL_GTFS env var to your Ocp-Apim-Subscription-Key.');
    process.exit(1);
  }
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

// ── routes.txt → lines map ─────────────────────────────────────────────────────
// Key: lineCode = route_id[:-1]  (e.g. "3021" from "30210"/"30211")
// This joins to RT tripId.split('_')[0]
console.log('Parsing routes.txt...');
const lines = {};
for (const r of parseCSV(await zip.file('routes.txt').async('string'))) {
  const code = r.route_id.slice(0,-1);
  const dirn = r.route_id.slice(-1);
  if (!lines[code]) {
    lines[code] = {
      name:      r.route_short_name,
      color:     r.route_color,
      textColor: r.route_text_color,
      type:      r.route_type,
      url:       r.route_url,
    };
  }
  lines[code][`dir${dirn}`] = r.route_long_name;
}
console.log(`  ${Object.keys(lines).length} lines`);

// ── trips.txt → trips map ──────────────────────────────────────────────────────
// Key: first 3 underscore-segments of trip_id (lineCode_ritNr_richting)
// Joins to RT tripId first 3 segments.
console.log('Parsing trips.txt...');
const trips = {};
for (const t of parseCSV(await zip.file('trips.txt').async('string'))) {
  const key = t.trip_id.split('_').slice(0,3).join('_');
  if (trips[key]) continue;
  trips[key] = { headsign: t.trip_headsign, routeId: t.route_id, dir: t.direction_id };
}
console.log(`  ${Object.keys(trips).length} trip prefixes`);

// ── agency.txt ─────────────────────────────────────────────────────────────────
const agency = {};
for (const a of parseCSV(await zip.file('agency.txt').async('string')))
  agency[a.agency_id] = { name: a.agency_name };

// ── feed_info.txt ──────────────────────────────────────────────────────────────
let feed = {};
const fi = parseCSV(await zip.file('feed_info.txt').async('string'))[0] || {};
feed = { version: fi.feed_version||'', endDate: fi.feed_end_date||'' };

// ── Write ──────────────────────────────────────────────────────────────────────
const out = JSON.stringify({ lines, trips, agency, feed });
writeFileSync(outPath, out);
console.log(`\n✓ ${outPath}  (${(out.length/1024).toFixed(0)} KB)`);
console.log(`  Lines: ${Object.keys(lines).length} | Trip prefixes: ${Object.keys(trips).length}`);
console.log(`  Feed: ${feed.version} valid until ${feed.endDate}`);
console.log('\nRun: wrangler deploy');
