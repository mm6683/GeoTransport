/**
 * Geotransport — De Lijn GTFS-RT Cloudflare Worker
 *
 * PERFORMANCE DESIGN:
 *   Instead of decoding the full protobuf tree and re-serialising it as JSON
 *   (which was ~400 KB+ and killed the CPU), this worker does a single-pass
 *   streaming extraction of only the 4 fields the frontend needs per vehicle:
 *     lat, lng, bearing, vehicleId — from VehiclePosition entities
 *     tripId, routeId, delay       — joined from TripUpdate entities
 *     scheduleRelationship=3       — for canceled trips
 *
 *   Output JSON is ~15–30 KB regardless of how large the upstream feed is.
 */

const GTFS_URL =
  "https://api.delijn.be/gtfs/v3/realtime?canceled=true&delay=true&position=true&vehicleid=true&tripid=true";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// ── Minimal protobuf scanner ─────────────────────────────────────────────────
// We never build a full object tree — just pull out the exact bytes we need.

class PB {
  constructor(buf) {
    this.b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.p = 0;
    this.end = this.b.length;
    this.v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength);
  }

  get done() { return this.p >= this.end; }

  vi() { // unsigned varint
    let lo = 0, hi = 0, s = 0;
    for (let i = 0; i < 10; i++) {
      if (this.p >= this.end) throw new Error("varint EOF");
      const b = this.b[this.p++];
      if (s < 28)       lo |=  (b & 0x7f) << s;
      else if (s < 32)  { lo |= (b & 0x7f) << s; hi |= (b & 0x7f) >>> (32 - s); }
      else              hi |= (b & 0x7f) << (s - 32);
      s += 7;
      if (!(b & 0x80)) break;
    }
    return (lo >>> 0) + hi * 4294967296;
  }

  si() { return this.vi() | 0; } // signed int32

  f32() {
    const f = this.v.getFloat32(this.p, true);
    this.p += 4;
    return f;
  }

  // Read a length-delimited field and return a child PB reader
  sub() {
    const len = this.vi();
    if (this.p + len > this.end) throw new Error(`sub: need ${len}, have ${this.end - this.p}`);
    const child = new PB(this.b.subarray(this.p, this.p + len));
    this.p += len;
    return child;
  }

  str() {
    const len = this.vi();
    if (this.p + len > this.end) throw new Error(`str: need ${len}`);
    const s = dec.decode(this.b.subarray(this.p, this.p + len));
    this.p += len;
    return s;
  }

  tag() {
    const t = this.vi();
    return [t >>> 3, t & 7];
  }

  skip(w) {
    if      (w === 0) this.vi();
    else if (w === 1) this.p += 8;
    else if (w === 2) { const l = this.vi(); this.p += l; }
    else if (w === 5) this.p += 4;
    else throw new Error(`bad wire ${w} at ${this.p}`);
  }
}

const dec = new TextDecoder();

// ── Slim extractors — return only what the frontend uses ─────────────────────

/**
 * Extract from TripDescriptor:
 *   tripId (field 1), scheduleRelationship (field 4), routeId (field 5)
 *
 * De Lijn field mapping (verified from binary):
 *   field 1 = tripId (len)
 *   field 3 = startDate (len)
 *   field 4 = scheduleRelationship (varint)  ← 3 = CANCELED
 *   field 5 = routeId (len)
 */
function extractTripDescriptor(r) {
  const o = { tripId: "", routeId: "", schedRel: 0, directionId: -1 };
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1 && w === 2) o.tripId      = r.str();
    else if (f === 4 && w === 0) o.schedRel    = r.vi();
    else if (f === 5 && w === 2) o.routeId     = r.str();
    else if (f === 6 && w === 0) o.directionId = r.vi();
    else r.skip(w);
  }
  return o;
}

/**
 * Extract from TripUpdate:
 *   trip (field 1) → tripId + scheduleRelationship
 *   last StopTimeUpdate (field 2) → delay from departure or arrival
 *   vehicle (field 3) → vehicleId label
 *
 * Returns null if canceled (handled separately).
 */
function extractTripUpdate(r) {
  let trip = null, lastDelay = null;
  while (!r.done) {
    const [f, w] = r.tag();
    if (f === 1 && w === 2) {
      trip = extractTripDescriptor(r.sub());
    } else if (f === 2 && w === 2) {
      // StopTimeUpdate — we only want the last one's delay
      const stu = r.sub();
      let d = null;
      while (!stu.done) {
        const [sf, sw] = stu.tag();
        if ((sf === 2 || sf === 3) && sw === 2) { // arrival=2, departure=3
          const ste = stu.sub();
          while (!ste.done) {
            const [ef, ew] = ste.tag();
            if (ef === 1 && ew === 0) d = ste.si(); // delay field
            else ste.skip(ew);
          }
        } else stu.skip(sw);
      }
      if (d !== null) lastDelay = d;
    } else {
      r.skip(w);
    }
  }
  return trip ? { tripId: trip.tripId, routeId: trip.routeId, schedRel: trip.schedRel, directionId: trip.directionId, delay: lastDelay } : null;
}

/**
 * Extract from VehiclePosition:
 *   De Lijn field mapping (verified from binary debug):
 *     field 1 = TripDescriptor
 *     field 2 = Position  (lat=1,lng=2,bearing=3,speed=5 — all float/wire5)
 *     field 5 = timestamp (varint)
 *     field 8 = VehicleDescriptor (id=1,label=2)
 */
function extractVehiclePosition(r) {
  let tripId = "", routeId = "";
  let lat = 0, lng = 0, bearing = null;
  let vehicleId = "", label = "";

  while (!r.done) {
    const [f, w] = r.tag();
    if (f === 1 && w === 2) {
      // TripDescriptor
      const td = r.sub();
      while (!td.done) {
        const [tf, tw] = td.tag();
        if      (tf === 1 && tw === 2) tripId  = td.str();
        else if (tf === 5 && tw === 2) routeId = td.str();
        else td.skip(tw);
      }
    } else if (f === 2 && w === 2) {
      // Position
      const pos = r.sub();
      while (!pos.done) {
        const [pf, pw] = pos.tag();
        if      (pf === 1 && pw === 5) lat     = pos.f32();
        else if (pf === 2 && pw === 5) lng     = pos.f32();
        else if (pf === 3 && pw === 5) bearing = pos.f32();
        else pos.skip(pw);
      }
    } else if (f === 8 && w === 2) {
      // VehicleDescriptor
      const vd = r.sub();
      while (!vd.done) {
        const [vf, vw] = vd.tag();
        if      (vf === 1 && vw === 2) vehicleId = vd.str();
        else if (vf === 2 && vw === 2) label     = vd.str();
        else vd.skip(vw);
      }
    } else {
      r.skip(w);
    }
  }

  if (!lat || !lng) return null;
  return { vehicleId: vehicleId || label, tripId, routeId, lat, lng, bearing };
}

/**
 * Single-pass scan of the full FeedMessage.
 * Returns a slim object — only the data the frontend renders.
 */
function extractFeed(buf) {
  const r = new PB(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);

  // Pass 1: collect TripUpdates (delay + canceled) and VehiclePositions
  const delayMap    = new Map();  // tripId → delay (seconds)
  const canceledMap = new Map();  // tripId → { tripId, routeId }
  const vehicles    = [];

  let timestamp = 0;

  while (!r.done) {
    const [f, w] = r.tag();

    if (f === 1 && w === 2) {
      // FeedHeader — just grab timestamp
      const hr = r.sub();
      while (!hr.done) {
        const [hf, hw] = hr.tag();
        if (hf === 3 && hw === 0) timestamp = hr.vi();
        else hr.skip(hw);
      }
    } else if (f === 2 && w === 2) {
      // FeedEntity — each one is isolated so a parse error can't corrupt the stream
      const entityLen = r.vi();
      const entityEnd = r.p + entityLen;

      try {
        const er = new PB(r.b.subarray(r.p, entityEnd));

        // Peek: find field 3 (TripUpdate) or field 4 (VehiclePosition)
        let entityId = "";
        let tuData = null, vpData = null;

        while (!er.done) {
          const [ef, ew] = er.tag();
          if      (ef === 1 && ew === 2) entityId = er.str();
          else if (ef === 3 && ew === 2) tuData   = extractTripUpdate(er.sub());
          else if (ef === 4 && ew === 2) vpData   = extractVehiclePosition(er.sub());
          else er.skip(ew);
        }

        if (tuData) {
          if (tuData.schedRel === 3) {
            // CANCELED
            canceledMap.set(tuData.tripId, { tripId: tuData.tripId, routeId: tuData.routeId });
          } else if (tuData.delay !== null) {
            delayMap.set(tuData.tripId, { delay: tuData.delay, directionId: tuData.directionId ?? -1 });
          }
        }

        if (vpData) {
          vehicles.push(vpData);
        }
      } catch (_) {
        // Skip bad entity silently
      }

      r.p = entityEnd;
    } else {
      r.skip(w);
    }
  }

  // Pass 2: join delay + directionId onto vehicles (single loop, O(n))
  for (const v of vehicles) {
    const tu = delayMap.get(v.tripId);
    v.delay       = tu?.delay       ?? null;
    v.directionId = tu?.directionId ?? -1;
  }

  return {
    timestamp,
    vehicles,                              // [{vehicleId,tripId,routeId,lat,lng,bearing,delay,directionId}]
    canceled: [...canceledMap.values()],   // [{tripId,routeId}]
    counts: {
      entities: vehicles.length + canceledMap.size,
      vehicles: vehicles.length,
      canceled: canceledMap.size,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// How long to cache the parsed feed (seconds).
// The frontend refreshes every 15s, so 14s means at most 1 parse per cycle
// regardless of how many users are hitting the site simultaneously.
const CACHE_TTL = 14;

// Stable cache key — same for every user so they all share one entry.
const CACHE_KEY = "https://geotransport-cache.internal/api/gtfs";

function jsonResp(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
      ...CORS,
      ...extra,
    },
  });
}

async function fetchProto(env) {
  const resp = await fetch(GTFS_URL, {
    headers: {
      "Cache-Control": "no-cache",
      "Ocp-Apim-Subscription-Key": env.DL_GTFSRT,
      "Accept-Encoding": "identity",
    },
  });
  if (!resp.ok) throw Object.assign(new Error(`De Lijn API ${resp.status}`), { status: resp.status });
  return resp.arrayBuffer();
}

// ── Worker ────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/api/gtfs") {
      if (!env.DL_GTFSRT)
        return jsonResp({ error: "Secret DL_GTFSRT not configured. Run: wrangler secret put DL_GTFSRT" }, 500);

      // ── Cache-first: serve from Cloudflare edge cache when possible ──────
      // This means the expensive protobuf parse only runs once per CACHE_TTL
      // seconds, no matter how many concurrent users hit the endpoint.
      const cache = caches.default;
      const cacheReq = new Request(CACHE_KEY);

      const cached = await cache.match(cacheReq);
      if (cached) {
        // Clone and re-add CORS headers (cache strips them on some edge nodes)
        const headers = new Headers(cached.headers);
        Object.entries(CORS).forEach(([k, v]) => headers.set(k, v));
        headers.set("X-Cache", "HIT");
        return new Response(cached.body, { status: cached.status, headers });
      }

      // ── Cache miss: fetch + parse + store ────────────────────────────────
      let raw;
      try {
        raw = await fetchProto(env);
      } catch (err) {
        return jsonResp({ error: err.message }, err.status ?? 502);
      }

      let feed;
      try {
        feed = extractFeed(raw);
      } catch (err) {
        return jsonResp({ error: "Protobuf decode failed", detail: err.message }, 500);
      }

      const response = jsonResp(feed, 200, { "X-Cache": "MISS" });

      // Store in edge cache asynchronously — don't block the response
      ctx.waitUntil(cache.put(cacheReq, response.clone()));

      return response;
    }

    return env.ASSETS.fetch(request);
  },
};
