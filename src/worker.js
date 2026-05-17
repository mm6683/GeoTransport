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

const KERN_BASE = "https://api.delijn.be/DLKernOpenData/api/v1/haltes";

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

function extractTripUpdate(r) {
  let trip = null, lastDelay = null;
  while (!r.done) {
    const [f, w] = r.tag();
    if (f === 1 && w === 2) {
      trip = extractTripDescriptor(r.sub());
    } else if (f === 2 && w === 2) {
      const stu = r.sub();
      let d = null;
      while (!stu.done) {
        const [sf, sw] = stu.tag();
        if ((sf === 2 || sf === 3) && sw === 2) {
          const ste = stu.sub();
          while (!ste.done) {
            const [ef, ew] = ste.tag();
            if (ef === 1 && ew === 0) d = ste.si();
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

function extractVehiclePosition(r) {
  let tripId = "", routeId = "";
  let lat = 0, lng = 0, bearing = null;
  let vehicleId = "", label = "";

  while (!r.done) {
    const [f, w] = r.tag();
    if (f === 1 && w === 2) {
      const td = r.sub();
      while (!td.done) {
        const [tf, tw] = td.tag();
        if      (tf === 1 && tw === 2) tripId  = td.str();
        else if (tf === 5 && tw === 2) routeId = td.str();
        else td.skip(tw);
      }
    } else if (f === 2 && w === 2) {
      const pos = r.sub();
      while (!pos.done) {
        const [pf, pw] = pos.tag();
        if      (pf === 1 && pw === 5) lat     = pos.f32();
        else if (pf === 2 && pw === 5) lng     = pos.f32();
        else if (pf === 3 && pw === 5) bearing = pos.f32();
        else pos.skip(pw);
      }
    } else if (f === 8 && w === 2) {
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

function extractFeed(buf) {
  const r = new PB(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);

  const delayMap    = new Map();
  const canceledMap = new Map();
  const vehicles    = [];

  let timestamp = 0;

  while (!r.done) {
    const [f, w] = r.tag();

    if (f === 1 && w === 2) {
      const hr = r.sub();
      while (!hr.done) {
        const [hf, hw] = hr.tag();
        if (hf === 3 && hw === 0) timestamp = hr.vi();
        else hr.skip(hw);
      }
    } else if (f === 2 && w === 2) {
      const entityLen = r.vi();
      const entityEnd = r.p + entityLen;

      try {
        const er = new PB(r.b.subarray(r.p, entityEnd));
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
            canceledMap.set(tuData.tripId, { tripId: tuData.tripId, routeId: tuData.routeId });
          } else if (tuData.delay !== null) {
            delayMap.set(tuData.tripId, { delay: tuData.delay, directionId: tuData.directionId ?? -1 });
          }
        }

        if (vpData) vehicles.push(vpData);
      } catch (_) { /* skip bad entity */ }

      r.p = entityEnd;
    } else {
      r.skip(w);
    }
  }

  for (const v of vehicles) {
    const tu = delayMap.get(v.tripId);
    v.delay       = tu?.delay       ?? null;
    v.directionId = tu?.directionId ?? -1;
  }

  return {
    timestamp,
    vehicles,
    canceled: [...canceledMap.values()],
    counts: {
      entities: vehicles.length + canceledMap.size,
      vehicles: vehicles.length,
      canceled: canceledMap.size,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CACHE_TTL  = 14;  // seconds — GTFS-RT feed cache
const KERN_TTL   = 20;  // seconds — halte real-time doorkomsten cache

const CACHE_KEY  = "https://geotransport-cache.internal/api/gtfs";

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
    const url   = new URL(request.url);
    const cache = caches.default;

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // ── /api/gtfs — GTFS-RT vehicle feed ─────────────────────────────────────
    if (url.pathname === "/api/gtfs") {
      if (!env.DL_GTFSRT)
        return jsonResp({ error: "Secret DL_GTFSRT not configured. Run: wrangler secret put DL_GTFSRT" }, 500);

      const cacheReq = new Request(CACHE_KEY);
      const cached   = await cache.match(cacheReq);
      if (cached) {
        const headers = new Headers(cached.headers);
        Object.entries(CORS).forEach(([k, v]) => headers.set(k, v));
        headers.set("X-Cache", "HIT");
        return new Response(cached.body, { status: cached.status, headers });
      }

      let raw;
      try { raw = await fetchProto(env); }
      catch (err) { return jsonResp({ error: err.message }, err.status ?? 502); }

      let feed;
      try { feed = extractFeed(raw); }
      catch (err) { return jsonResp({ error: "Protobuf decode failed", detail: err.message }, 500); }

      const response = jsonResp(feed, 200, { "X-Cache": "MISS" });
      ctx.waitUntil(cache.put(cacheReq, response.clone()));
      return response;
    }

    // ── /api/kern/halte-rt — live departure board for a single stop ───────────
    // Upstream: GET /DLKernOpenData/api/v1/haltes/{entiteit}/{stopId}/real-time
    // Auth:     DL_OPDA secret (separate subscription from DL_GTFSRT)
    // Cache:    20 s per stop ID
    if (url.pathname === "/api/kern/halte-rt") {
      if (!env.DL_OPDA)
        return jsonResp({ error: "Secret DL_OPDA not configured. Run: wrangler secret put DL_OPDA" }, 500);

      const stopId = url.searchParams.get("id") || "";
      if (!stopId || !/^\d+$/.test(stopId))
        return jsonResp({ error: "Missing or invalid stop id" }, 400);

      const entiteit    = stopId[0];   // first digit = province entity number (1–5)
      const kernCacheKey = `https://geotransport-cache.internal/kern/halte-rt/${stopId}`;
      const kernReq      = new Request(kernCacheKey);

      const kernCached = await cache.match(kernReq);
      if (kernCached) {
        const headers = new Headers(kernCached.headers);
        Object.entries(CORS).forEach(([k, v]) => headers.set(k, v));
        headers.set("X-Cache", "HIT");
        return new Response(kernCached.body, { status: kernCached.status, headers });
      }

      let raw;
      try {
        const upstream = await fetch(
          `${KERN_BASE}/${entiteit}/${stopId}/real-time?maxAantalDoorkomsten=8`,
          {
            headers: {
              "Ocp-Apim-Subscription-Key": env.DL_OPDA,
              "Accept": "application/json",
              "Cache-Control": "no-cache",
            },
          }
        );
        if (!upstream.ok) {
          let errBody = '';
          try { errBody = await upstream.text(); } catch(_) {}
          console.error(`[GT] Kern API ${upstream.status} for stop ${stopId}:`, errBody.slice(0, 400));
          return jsonResp(
            { error: `De Lijn Kern API ${upstream.status}`, detail: errBody.slice(0, 400) },
            upstream.status >= 500 ? 502 : upstream.status,
            { "Cache-Control": "no-store" }
          );
        }
        raw = await upstream.json();
      } catch (err) {
        return jsonResp({ error: "Fetch failed: " + err.message }, 502);
      }

      // Slim response — strip all `links` arrays and keep only what the UI renders.
      const doorkomsten = (raw.doorkomsten || []).map(d => ({
        lijnnummer: d.lijnnummer  ?? null,
        richting:   d.richting    ?? null,
        bestemming: d.bestemming  ?? null,
        vias:       Array.isArray(d.vias) ? d.vias : [],
        scheduled:  d.dienstregelingTijdstip ?? null,
        realtime:   d["real-timeTijdstip"]   ?? null,
        vrtnum:     d.vrtnum ?? null,
        // Normalise the status array — upstream field is predictionStatussen
        status:     Array.isArray(d.predictionStatussen) ? d.predictionStatussen : [],
      }));

      const slim = { doorkomsten };
      const kernResp = new Response(JSON.stringify(slim), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${KERN_TTL}`,
          ...CORS,
          "X-Cache": "MISS",
        },
      });

      ctx.waitUntil(cache.put(kernReq, kernResp.clone()));
      return kernResp;
    }

    // ── Static assets ─────────────────────────────────────────────────────────
    const asset = await env.ASSETS.fetch(request);
    const ct    = asset.headers.get("Content-Type") || "";
    if (ct.includes("text/html")) {
      const h = new Headers(asset.headers);
      h.set("Cache-Control", "no-cache");
      return new Response(asset.body, { status: asset.status, headers: h });
    }
    return asset;
  },
};
