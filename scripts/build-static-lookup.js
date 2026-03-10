#!/usr/bin/env node
/**
 * build-static-lookup.js
 * Geotransport — De Lijn GTFS Static lookup builder
 *
 * Run this locally whenever De Lijn publishes a new static feed.
 * It downloads the zip, parses routes.txt + agency.txt,
 * and writes public/static-lookup.json.
 *
 * NOTE: Only routes.txt and agency.txt are needed — NOT the gigabyte trips.txt.
 * The lookup is keyed by lineCode (first segment of RT tripId).
 *
 * Usage:
 *   node scripts/build-static-lookup.js              (downloads from API)
 *   node scripts/build-static-lookup.js my.zip       (use local zip)
 *
 * Set DL_GTFS env var for downloads:
 *   Windows:  set DL_GTFS=your_key_here
 *   Unix:     export DL_GTFS=your_key_here
 *
 * Requires: npm install jszip   (one-time)
 * After running: wrangler deploy
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';

const __dir   = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dir, '../public/static-lookup.json');

const GTFS_URL = 'https://api.delijn.be/gtfs/static/v3/gtfs_transit.zip';
const API_KEY  = process.env.DL_GTFS;

// ── Get zip buffer ─────────────────────────────────────────────────────────────
let zipBuf;
const localPath = process.argv[2];

if (localPath) {
  console.log(`Reading local zip: ${localPath}`);
  zipBuf = readFileSync(localPath);
} else {
  if (!API_KEY) {
    console.error('ERROR: Set DL_GTFS to your Ocp-Apim-Subscription-Key.');
    console.error('  Windows: set DL_GTFS=your_key_here');
    console.error('  Unix:    export DL_GTFS=your_key_here');
    process.exit(1);
  }
  console.log('Downloading GTFS static zip from De Lijn API...');
  const resp = await fetch(GTFS_URL, {
    headers: { 'Cache-Control': 'no-cache', 'Ocp-Apim-Subscription-Key': API_KEY },
  });
  if (!resp.ok) { console.error(`HTTP ${resp.status}`); process.exit(1); }
  const total  = Number(resp.headers.get('content-length') || 0);
  const chunks = []; let received = 0;
  for await (const chunk of resp.body) {
    chunks.push(chunk); received += chunk.length;
    if (total) process.stdout.write(`\r  ${(received/1024/1024).toFixed(1)} / ${(total/1024/1024).toFixed(1)} MB`);
  }
  console.log('\nDone.');
  zipBuf = Buffer.concat(chunks);
}

const zip = await JSZip.loadAsync(zipBuf);

function parseCSV(text) {
  const rows = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  const headers = rows[0].trim().split(',').map(h => h.replace(/^"|"$/g,''));
  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const line = rows[i].trim(); if (!line) continue;
    const vals = []; let cur = '', inQ = false;
    for (const ch of line + ',') {
      if (ch==='"') { inQ=!inQ; continue; }
      if (ch===','&&!inQ) { vals.push(cur); cur=''; continue; }
      cur += ch;
    }
    const row = {}; headers.forEach((h,j) => row[h]=vals[j]??'');
    result.push(row);
  }
  return result;
}

// ── routes.txt → keyed by lineCode (route_id minus last digit) ────────────────
console.log('Parsing routes.txt...');
const lines = {};
const routesById = {};
for (const r of parseCSV(await zip.file('routes.txt').async('string'))) {
  const lc  = r.route_id.slice(0, -1);   // "30210" → "3021"
  const dir = r.route_id.slice(-1);       // "0" or "1"
  routesById[r.route_id] = r;
  if (!lines[lc]) {
    lines[lc] = {
      name:      r.route_short_name,
      color:     r.route_color,
      textColor: r.route_text_color,
      type:      r.route_type,
      dirs: {}
    };
  }
  lines[lc].dirs[dir] = {
    long: r.route_long_name,
    url:  r.route_url,
  };
}
console.log(`  ${Object.keys(lines).length} lines`);

// ── agency.txt ────────────────────────────────────────────────────────────────
console.log('Parsing agency.txt...');
const agency = {};
for (const a of parseCSV(await zip.file('agency.txt').async('string'))) {
  agency[a.agency_id] = { name:a.agency_name, url:a.agency_url, phone:a.agency_phone };
}

// ── Write ─────────────────────────────────────────────────────────────────────
const out = JSON.stringify({ lines, agency }, null, 0);
writeFileSync(outPath, out);
console.log(`\n✓ ${outPath}  (${(out.length/1024).toFixed(0)} KB)`);
console.log(`  Lines: ${Object.keys(lines).length}`);
console.log('\nNext: wrangler deploy');
