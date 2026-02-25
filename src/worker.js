/**
 * De Lijn GTFS-RT Cloudflare Worker
 *
 * Decodes the binary protobuf feed with a hand-rolled parser —
 * no Node.js polyfills, no npm runtime deps, works on the V8 isolate directly.
 */

const GTFS_API_URL =
  "https://api.delijn.be/gtfs/v3/realtime?canceled=true&delay=true&position=true&vehicleid=true&tripid=true";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// ── Minimal Protobuf reader ──────────────────────────────────────────────────
const _dec = new TextDecoder();

class PBReader {
  constructor(buf) {
    this.b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.p = 0;
    this.end = this.b.length;
    this.v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength);
  }

  get done() { return this.p >= this.end; }

  /** Unsigned varint → JS number (safe up to 2^53, handles 64-bit timestamps) */
  varint() {
    let lo = 0, hi = 0, s = 0;
    for (let i = 0; i < 10; i++) {
      const b = this.b[this.p++];
      if (s < 32) lo |= (b & 0x7f) << s;
      else        hi |= (b & 0x7f) << (s - 32);
      s += 7;
      if (!(b & 0x80)) break;
    }
    return (lo >>> 0) + hi * 4294967296;
  }

  /** Signed int32 varint — handles negative values encoded as 10-byte int64 */
  varintS32() {
    let lo = 0, s = 0;
    for (let i = 0; i < 10; i++) {
      const b = this.b[this.p++];
      if (s < 32) lo |= (b & 0x7f) << s;
      s += 7;
      if (!(b & 0x80)) break;
    }
    return lo | 0; // reinterpret bits as signed 32-bit
  }

  /** IEEE-754 single float (wire type 5) */
  float() {
    const f = this.v.getFloat32(this.p, true);
    this.p += 4;
    return f;
  }

  /** Read a length-delimited byte slice */
  bytes() {
    const len = this.varint();
    const s = this.p;
    this.p += len;
    return this.b.slice(s, this.p);
  }

  /** Length-delimited UTF-8 string */
  str() { return _dec.decode(this.bytes()); }

  /** Child reader for the next length-delimited message field */
  sub() { return new PBReader(this.bytes()); }

  /** [fieldNumber, wireType] */
  tag() {
    const t = this.varint();
    return [t >>> 3, t & 7];
  }

  /** Skip an unknown field */
  skip(wire) {
    if      (wire === 0) this.varint();
    else if (wire === 1) this.p += 8;
    else if (wire === 2) this.p += this.varint();
    else if (wire === 5) this.p += 4;
    else throw new Error(`Unknown wire type ${wire}`);
  }
}

// ── GTFS-RT message parsers (field numbers from the official .proto) ─────────

function parseStopTimeEvent(r) {
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.delay       = r.varintS32();
    else if (f === 2) o.time        = r.varint();
    else if (f === 3) o.uncertainty = r.varintS32();
    else              r.skip(w);
  }
  return o;
}

function parseStopTimeUpdate(r) {
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.stopSequence          = r.varint();
    else if (f === 4) o.stopId                = r.str();
    else if (f === 2) o.arrival               = parseStopTimeEvent(r.sub());
    else if (f === 3) o.departure             = parseStopTimeEvent(r.sub());
    else if (f === 5) o.scheduleRelationship  = r.varint();
    else              r.skip(w);
  }
  return o;
}

function parseTripDescriptor(r) {
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.tripId               = r.str();
    else if (f === 2) o.routeId              = r.str();
    else if (f === 3) o.directionId          = r.varint();
    else if (f === 4) o.startTime            = r.str();
    else if (f === 5) o.startDate            = r.str();
    else if (f === 6) o.scheduleRelationship = r.varint();
    else              r.skip(w);
  }
  return o;
}

function parseVehicleDescriptor(r) {
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.id           = r.str();
    else if (f === 2) o.label        = r.str();
    else if (f === 3) o.licensePlate = r.str();
    else              r.skip(w);
  }
  return o;
}

function parsePosition(r) {
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.latitude  = r.float();   // float, wire 5
    else if (f === 2) o.longitude = r.float();   // float, wire 5
    else if (f === 3) o.bearing   = r.float();   // float, wire 5
    else if (f === 4) { r.p += 8; }              // odometer double, skip
    else if (f === 5) o.speed     = r.float();   // float, wire 5
    else              r.skip(w);
  }
  return o;
}

function parseVehiclePosition(r) {
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.trip            = parseTripDescriptor(r.sub());
    else if (f === 2) o.vehicle         = parseVehicleDescriptor(r.sub());
    else if (f === 3) o.position        = parsePosition(r.sub());
    else if (f === 4) o.currentStopSeq  = r.varint();
    else if (f === 5) o.stopId          = r.str();
    else if (f === 6) o.currentStatus   = r.varint();
    else if (f === 7) o.timestamp       = r.varint();
    else if (f === 8) o.congestionLevel = r.varint();
    else if (f === 9) o.occupancyStatus = r.varint();
    else              r.skip(w);
  }
  return o;
}

function parseTripUpdate(r) {
  const o = { stopTimeUpdate: [] };
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.trip      = parseTripDescriptor(r.sub());
    else if (f === 2) o.vehicle   = parseVehicleDescriptor(r.sub());
    else if (f === 3) o.stopTimeUpdate.push(parseStopTimeUpdate(r.sub()));
    else if (f === 4) o.timestamp = r.varint();
    else if (f === 5) o.delay     = r.varintS32();
    else              r.skip(w);
  }
  return o;
}

function parseFeedEntity(r) {
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.id         = r.str();
    else if (f === 2) o.isDeleted  = !!r.varint();
    else if (f === 3) o.tripUpdate = parseTripUpdate(r.sub());
    else if (f === 4) o.vehicle    = parseVehiclePosition(r.sub());
    else              r.skip(w);   // alert (5) and extensions — skip
  }
  return o;
}

function parseFeedMessage(buf) {
  const r = new PBReader(buf);
  const feed = { header: {}, entity: [] };
  while (!r.done) {
    const [f, w] = r.tag();
    if (f === 1) {
      const hr = r.sub();
      while (!hr.done) {
        const [hf, hw] = hr.tag();
        if      (hf === 1) feed.header.gtfsRealtimeVersion = hr.str();
        else if (hf === 2) feed.header.incrementality      = hr.varint();
        else if (hf === 3) feed.header.timestamp           = hr.varint();
        else               hr.skip(hw);
      }
    } else if (f === 2) {
      feed.entity.push(parseFeedEntity(r.sub()));
    } else {
      r.skip(w);
    }
  }
  return feed;
}

// ── Worker entry-point ───────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname === "/api/gtfs") {
      if (!env.DL_GTFSRT) {
        return json(
          { error: "Secret DL_GTFSRT not configured. Run: wrangler secret put DL_GTFSRT" },
          500,
        );
      }

      let raw;
      try {
        const resp = await fetch(GTFS_API_URL, {
          headers: {
            "Cache-Control": "no-cache",
            "Ocp-Apim-Subscription-Key": env.DL_GTFSRT,
          },
        });
        if (!resp.ok) {
          const detail = await resp.text();
          return json({ error: `De Lijn API returned ${resp.status}`, detail }, resp.status);
        }
        raw = await resp.arrayBuffer();
      } catch (err) {
        return json({ error: "Upstream fetch failed", detail: err.message }, 502);
      }

      let feed;
      try {
        feed = parseFeedMessage(raw);
      } catch (err) {
        return json({ error: "Protobuf decode failed", detail: err.message }, 500);
      }

      return json(feed);
    }

    // Everything else → static assets
    return env.ASSETS.fetch(request);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS,
    },
  });
}
