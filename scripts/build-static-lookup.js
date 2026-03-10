#!/usr/bin/env node
/**
 * build-static-lookup.js
 * Geotransport — De Lijn GTFS Static lookup builder
 *
 * Run this locally whenever De Lijn publishes a new static feed (check weekly).
 * It downloads the zip, parses routes.txt + trips.txt + agency.txt + feed_info.txt,
 * and writes a slim public/static-lookup.json that the worker serves as a static asset.
 *
 * WHY LOCAL (not in the Worker):
 *   The full zip is ~1 GB. Parsing it inside a Cloudflare Worker would hit CPU limits
 *   instantly. Running it locally keeps the Worker fast and costs nothing.
 *
 * Usage:
 *   npm install jszip node-fetch   (one-time)
 *   node scripts/build-static-lookup.js
 *
 *   Or pass a local zip instead of downloading:
 *   node scripts/build-static-lookup.js path/to/gtfs_transit.zip
 *
 * Secrets: set DL_GTFS env var (Ocp-Apim-Subscription-Key) or use .env file
 *   Windows:  set DL_GTFS=your_key_here
 *   Unix:     export DL_GTFS=your_key_here
 *
 * After running, deploy with: wrangler deploy
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';

const __dir  = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dir, '../public/static-lookup.json');

const GTFS_URL = 'https://api.delijn.be/gtfs/static/v3/gtfs_transit.zip';
const API_KEY  = process.env.DL_GTFS;

// ── Get zip buffer ────────────────────────────────────────────────────────────
let zipBuf;
const localPath = process.argv[2];

if (localPath) {
  console.log(`Reading local zip: ${localPath}`);
  zipBuf = readFileSync(localPath);
} else {
  if (!API_KEY) {
    console.error('ERROR: Set the DL_GTFS environment variable to your Ocp-Apim-Subscription-Key.');
    console.error('  Windows: set DL_GTFS=your_key_here');
    console.error('  Unix:    export DL_GTFS=your_key_here');
    process.exit(1);
  }
  console.log('Downloading GTFS static zip from De Lijn API...');
  const resp = await fetch(GTFS_URL, {
    headers: {
      'Cache-Control': 'no-cache',
      'Ocp-Apim-Subscription-Key': API_KEY,
    },
  });
  if (!resp.ok) {
    console.error(`Download failed: HTTP ${resp.status}`);
    process.exit(1);
  }
  const total = Number(resp.headers.get('content-length') || 0);
  const chunks = [];
  let received = 0;
  for await (const chunk of resp.body) {
    chunks.push(chunk);
    received += chunk.length;
    if (total) process.stdout.write(`\r  ${(received/1024/1024).toFixed(1)} MB / ${(total/1024/1024).toFixed(1)} MB`);
  }
  console.log('\nDownload complete.');
  zipBuf = Buffer.concat(chunks);
}

// ── Parse zip ─────────────────────────────────────────────────────────────────
console.log('Loading zip...');
const zip = await JSZip.loadAsync(zipBuf);

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const headers = lines[0].trim().split(',').map(h => h.replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = []; let cur = '', inQ = false;
    for (const ch of line + ',') {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { vals.push(cur); cur = ''; continue; }
      cur += ch;
    }
    const row = {};
    headers.forEach((h, j) => row[h] = vals[j] ?? '');
    rows.push(row);
  }
  return rows;
}

// ── routes.txt ────────────────────────────────────────────────────────────────
console.log('Parsing routes.txt...');
const routes = {};
for (const r of parseCSV(await zip.file('routes.txt').async('string'))) {
  routes[r.route_id] = {
    name:      r.route_short_name,
    long:      r.route_long_name,
    color:     r.route_color,
    textColor: r.route_text_color,
    url:       r.route_url,
    type:      r.route_type,
  };
}
console.log(`  ${Object.keys(routes).length} routes`);

// ── trips.txt ─────────────────────────────────────────────────────────────────
// Key: first 3 underscore-segments of trip_id (lineCode_ritNr_richting)
// This is stable across service date variants and hash suffixes.
console.log('Parsing trips.txt (large file, please wait)...');
const trips = {};
for (const t of parseCSV(await zip.file('trips.txt').async('string'))) {
  const key = t.trip_id.split('_').slice(0, 3).join('_');
  if (trips[key]) continue;
  const r = routes[t.route_id] || {};
  trips[key] = {
    routeId:   t.route_id,
    name:      r.name      || '',
    headsign:  t.trip_headsign,
    color:     r.color     || '',
    textColor: r.textColor || '',
    long:      r.long      || '',
    url:       r.url       || '',
    type:      r.type      || '3',
  };
}
console.log(`  ${Object.keys(trips).length} unique trip prefixes`);

// ── agency.txt ────────────────────────────────────────────────────────────────
console.log('Parsing agency.txt...');
const agency = {};
for (const a of parseCSV(await zip.file('agency.txt').async('string'))) {
  agency[a.agency_id] = {
    name:     a.agency_name,
    url:      a.agency_url,
    timezone: a.agency_timezone,
    lang:     a.agency_lang,
    phone:    a.agency_phone,
  };
}

// ── feed_info.txt ─────────────────────────────────────────────────────────────
console.log('Parsing feed_info.txt...');
let feed = {};
const feedRows = parseCSV(await zip.file('feed_info.txt').async('string'));
if (feedRows.length) {
  const fi = feedRows[0];
  feed = {
    publisher: fi.feed_publisher_name,
    url:       fi.feed_publisher_url,
    version:   fi.feed_version,
    startDate: fi.feed_start_date,
    endDate:   fi.feed_end_date,
  };
}

// ── Write output ──────────────────────────────────────────────────────────────
const out = JSON.stringify({ routes, trips, agency, feed }, null, 0);
writeFileSync(outPath, out);
const kb = (out.length / 1024).toFixed(0);
console.log(`\n✓ Written ${outPath}  (${kb} KB)`);
console.log(`  Routes: ${Object.keys(routes).length}`);
console.log(`  Trip prefixes: ${Object.keys(trips).length}`);
console.log(`  Feed version: ${feed.version}`);
console.log('\nNext: wrangler deploy');
