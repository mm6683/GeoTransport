/**
 * De Lijn GTFS-RT Cloudflare Worker
 * Pure-JS protobuf decoder — no npm deps, V8-isolate safe.
 */

const GTFS_API_URL =
  "https://api.delijn.be/gtfs/v3/realtime?canceled=true&delay=true&position=true&vehicleid=true&tripid=true";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// ── Protobuf reader ──────────────────────────────────────────────────────────
const _dec = new TextDecoder();

class PBReader {
  constructor(input) {
    // Always work on a fresh copy so byteOffset is always 0
    if (input instanceof ArrayBuffer) {
      this.b = new Uint8Array(input.slice(0));
    } else if (input instanceof Uint8Array) {
      this.b = input.slice(0);
    } else {
      throw new Error("PBReader: unsupported input type");
    }
    this.p = 0;
    this.end = this.b.length;
    this.v = new DataView(this.b.buffer);
  }

  get done() { return this.p >= this.end; }

  varint() {
    let lo = 0, hi = 0, s = 0;
    for (let i = 0; i < 10; i++) {
      if (this.p >= this.end) throw new Error(`varint: unexpected EOF at byte ${this.p}`);
      const b = this.b[this.p++];
      if (s < 28)      lo |= (b & 0x7f) << s;
      else if (s < 32) { lo |= (b & 0x7f) << s; hi |= (b & 0x7f) >>> (32 - s); }
      else             hi |= (b & 0x7f) << (s - 32);
      s += 7;
      if (!(b & 0x80)) break;
    }
    return (lo >>> 0) + hi * 4294967296;
  }

  varintS32() {
    return this.varint() | 0;
  }

  float() {
    if (this.p + 4 > this.end) throw new Error(`float: unexpected EOF at byte ${this.p}`);
    const f = this.v.getFloat32(this.p, true);
    this.p += 4;
    return f;
  }

  double() {
    if (this.p + 8 > this.end) throw new Error(`double: unexpected EOF at byte ${this.p}`);
    const f = this.v.getFloat64(this.p, true);
    this.p += 8;
    return f;
  }

  bytes() {
    const len = this.varint();
    if (this.p + len > this.end) throw new Error(`bytes: need ${len} but only ${this.end - this.p} left at byte ${this.p}`);
    const s = this.b.slice(this.p, this.p + len);
    this.p += len;
    return s;
  }

  str() { return _dec.decode(this.bytes()); }

  sub() { return new PBReader(this.bytes()); }

  tag() {
    const t = this.varint();
    return [t >>> 3, t & 7];
  }

  skip(wire) {
    if      (wire === 0) this.varint();
    else if (wire === 1) { if (this.p + 8 > this.end) throw new Error("skip64 EOF"); this.p += 8; }
    else if (wire === 2) this.bytes();   // consume length + body
    else if (wire === 5) { if (this.p + 4 > this.end) throw new Error("skip32 EOF"); this.p += 4; }
    else throw new Error(`Unknown wire type ${wire} at byte ${this.p}`);
  }
}

// ── GTFS-RT parsers ──────────────────────────────────────────────────────────

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
    if      (f === 1) o.stopSequence         = r.varint();
    else if (f === 4) o.stopId               = r.str();
    else if (f === 2) o.arrival              = parseStopTimeEvent(r.sub());
    else if (f === 3) o.departure            = parseStopTimeEvent(r.sub());
    else if (f === 5) o.scheduleRelationship = r.varint();
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
    if      (f === 1) o.latitude  = r.float();
    else if (f === 2) o.longitude = r.float();
    else if (f === 3) o.bearing   = r.float();
    else if (f === 4) o.odometer  = r.double();
    else if (f === 5) o.speed     = r.float();
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
    else              r.skip(w);
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function toHex(buf, maxBytes = 32) {
  const a = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer, 0, Math.min(buf.byteLength, maxBytes));
  return Array.from(a).map(b => b.toString(16).padStart(2, "0")).join(" ");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

// ── Worker entry-point ───────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/api/gtfs") {
      if (!env.DL_GTFSRT) {
        return json({ error: "Secret DL_GTFSRT not configured. Run: wrangler secret put DL_GTFSRT" }, 500);
      }

      // ── Fetch upstream ──────────────────────────────────────────────────
      let upResp;
      try {
        upResp = await fetch(GTFS_API_URL, {
          headers: {
            "Cache-Control": "no-cache",
            "Ocp-Apim-Subscription-Key": env.DL_GTFSRT,
            // Ask for raw binary, no gzip surprises
            "Accept-Encoding": "identity",
            "Accept": "application/octet-stream, application/x-protobuf, */*",
          },
        });
      } catch (err) {
        return json({ error: "Upstream fetch failed", detail: err.message }, 502);
      }

      if (!upResp.ok) {
        const detail = await upResp.text();
        return json({ error: `De Lijn API returned ${upResp.status}`, detail }, upResp.status);
      }

      const contentType = upResp.headers.get("content-type") || "";
      const raw = await upResp.arrayBuffer();

      if (raw.byteLength === 0) {
        return json({ error: "De Lijn API returned empty body", contentType }, 502);
      }

      // ── Decode ──────────────────────────────────────────────────────────
      let feed;
      try {
        feed = parseFeedMessage(raw);
      } catch (err) {
        // Return diagnostic info so we can see exactly what came back
        return json({
          error: "Protobuf decode failed",
          detail: err.message,
          contentType,
          bodyBytes: raw.byteLength,
          first32Hex: toHex(raw, 32),
          // first 200 chars as text to catch JSON/HTML error responses
          first200Text: new TextDecoder().decode(new Uint8Array(raw).slice(0, 200)),
        }, 500);
      }

      return json(feed);
    }

    return env.ASSETS.fetch(request);
  },
};
