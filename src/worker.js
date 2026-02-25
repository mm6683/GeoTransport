/**
 * De Lijn GTFS-RT Cloudflare Worker
 * Pure-JS protobuf decoder — no npm deps, V8-isolate safe.
 *
 * Field numbers from:
 * https://github.com/google/transit/blob/master/gtfs-realtime/proto/gtfs-realtime.proto
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
    if (input instanceof ArrayBuffer) {
      this.b = new Uint8Array(input.slice(0));
    } else if (input instanceof Uint8Array) {
      // Always own a flat copy (byteOffset = 0) so DataView aligns correctly
      this.b = new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
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
      if      (s < 28) lo |=  (b & 0x7f) << s;
      else if (s < 32) { lo |= (b & 0x7f) << s; hi |= (b & 0x7f) >>> (32 - s); }
      else             hi |= (b & 0x7f) << (s - 32);
      s += 7;
      if (!(b & 0x80)) break;
    }
    return (lo >>> 0) + hi * 4294967296;
  }

  sint32()  { return this.varint() | 0; }

  float() {
    if (this.p + 4 > this.end) throw new Error(`float: EOF at byte ${this.p}`);
    const f = this.v.getFloat32(this.p, true);
    this.p += 4;
    return f;
  }

  double() {
    if (this.p + 8 > this.end) throw new Error(`double: EOF at byte ${this.p}`);
    const f = this.v.getFloat64(this.p, true);
    this.p += 8;
    return f;
  }

  bytes() {
    const len = this.varint();
    if (this.p + len > this.end)
      throw new Error(`bytes: need ${len} but only ${this.end - this.p} left at byte ${this.p}`);
    const slice = this.b.slice(this.p, this.p + len); // .slice → own copy
    this.p += len;
    return slice;
  }

  str()  { return _dec.decode(this.bytes()); }
  sub()  { return new PBReader(this.bytes()); }
  tag()  { const t = this.varint(); return [t >>> 3, t & 7]; }

  skip(wire) {
    if      (wire === 0) this.varint();
    else if (wire === 1) { if (this.p + 8 > this.end) throw new Error("skip64 EOF"); this.p += 8; }
    else if (wire === 2) this.bytes();
    else if (wire === 5) { if (this.p + 4 > this.end) throw new Error("skip32 EOF"); this.p += 4; }
    else throw new Error(`Unknown wire type ${wire} at byte ${this.p}`);
  }
}

// Wire-type constants
const W_VARINT = 0, W_64 = 1, W_LEN = 2, W_32 = 5;

function readIf(r, w, expected, fn) {
  if (w === expected) return fn();
  r.skip(w);
  return undefined;
}

// ── GTFS-RT parsers ──────────────────────────────────────────────────────────
// Official field numbers:
//
// TripDescriptor:  trip_id=1, start_time=2, start_date=3,
//                  schedule_relationship=4, route_id=5, direction_id=6
//
// TripUpdate:      trip=1, stop_time_update=2, vehicle=3, timestamp=4, delay=5
//
// StopTimeUpdate:  stop_sequence=1, arrival=2, departure=3, stop_id=4,
//                  schedule_relationship=5
//
// StopTimeEvent:   delay=1, time=2, uncertainty=3
//
// VehiclePosition: trip=1, vehicle=2, position=3, current_stop_sequence=4,
//                  stop_id=5, current_status=6, timestamp=7,
//                  congestion_level=8, occupancy_status=9
//
// VehicleDescriptor: id=1, label=2, license_plate=3
//
// Position:        latitude=1, longitude=2, bearing=3, odometer=4, speed=5
//
// FeedEntity:      id=1, is_deleted=2, trip_update=3, vehicle=4, alert=5
// FeedHeader:      gtfs_realtime_version=1, incrementality=2, timestamp=3

function parseTripDescriptor(r) {
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.tripId               = readIf(r, w, W_LEN,    () => r.str())    ?? o.tripId;
    else if (f === 2) o.startTime            = readIf(r, w, W_LEN,    () => r.str())    ?? o.startTime;
    else if (f === 3) o.startDate            = readIf(r, w, W_LEN,    () => r.str())    ?? o.startDate;
    else if (f === 4) o.scheduleRelationship = readIf(r, w, W_VARINT, () => r.varint()) ?? o.scheduleRelationship;
    else if (f === 5) o.routeId              = readIf(r, w, W_LEN,    () => r.str())    ?? o.routeId;
    else if (f === 6) o.directionId          = readIf(r, w, W_VARINT, () => r.varint()) ?? o.directionId;
    else r.skip(w);
  }
  return o;
}

function parseVehicleDescriptor(r) {
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.id           = readIf(r, w, W_LEN, () => r.str()) ?? o.id;
    else if (f === 2) o.label        = readIf(r, w, W_LEN, () => r.str()) ?? o.label;
    else if (f === 3) o.licensePlate = readIf(r, w, W_LEN, () => r.str()) ?? o.licensePlate;
    else r.skip(w);
  }
  return o;
}

function parseStopTimeEvent(r) {
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.delay       = readIf(r, w, W_VARINT, () => r.sint32()) ?? o.delay;
    else if (f === 2) o.time        = readIf(r, w, W_VARINT, () => r.varint()) ?? o.time;
    else if (f === 3) o.uncertainty = readIf(r, w, W_VARINT, () => r.sint32()) ?? o.uncertainty;
    else r.skip(w);
  }
  return o;
}

function parseStopTimeUpdate(r) {
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.stopSequence         = readIf(r, w, W_VARINT, () => r.varint()) ?? o.stopSequence;
    else if (f === 2) o.arrival              = readIf(r, w, W_LEN,    () => parseStopTimeEvent(r.sub())) ?? o.arrival;
    else if (f === 3) o.departure            = readIf(r, w, W_LEN,    () => parseStopTimeEvent(r.sub())) ?? o.departure;
    else if (f === 4) o.stopId               = readIf(r, w, W_LEN,    () => r.str())    ?? o.stopId;
    else if (f === 5) o.scheduleRelationship = readIf(r, w, W_VARINT, () => r.varint()) ?? o.scheduleRelationship;
    else r.skip(w);
  }
  return o;
}

function parseTripUpdate(r) {
  const o = { stopTimeUpdate: [] };
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.trip      = readIf(r, w, W_LEN,    () => parseTripDescriptor(r.sub()))    ?? o.trip;
    else if (f === 2) { const s = readIf(r, w, W_LEN, () => parseStopTimeUpdate(r.sub())); if (s) o.stopTimeUpdate.push(s); }
    else if (f === 3) o.vehicle   = readIf(r, w, W_LEN,    () => parseVehicleDescriptor(r.sub())) ?? o.vehicle;
    else if (f === 4) o.timestamp = readIf(r, w, W_VARINT, () => r.varint()) ?? o.timestamp;
    else if (f === 5) o.delay     = readIf(r, w, W_VARINT, () => r.sint32()) ?? o.delay;
    else r.skip(w);
  }
  return o;
}

function parsePosition(r) {
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.latitude  = readIf(r, w, W_32, () => r.float())  ?? o.latitude;
    else if (f === 2) o.longitude = readIf(r, w, W_32, () => r.float())  ?? o.longitude;
    else if (f === 3) o.bearing   = readIf(r, w, W_32, () => r.float())  ?? o.bearing;
    else if (f === 4) o.odometer  = readIf(r, w, W_64, () => r.double()) ?? o.odometer;
    else if (f === 5) o.speed     = readIf(r, w, W_32, () => r.float())  ?? o.speed;
    else r.skip(w);
  }
  return o;
}

function parseVehiclePosition(r) {
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.trip            = readIf(r, w, W_LEN,    () => parseTripDescriptor(r.sub()))    ?? o.trip;
    else if (f === 2) o.vehicle         = readIf(r, w, W_LEN,    () => parseVehicleDescriptor(r.sub())) ?? o.vehicle;
    else if (f === 3) o.position        = readIf(r, w, W_LEN,    () => parsePosition(r.sub()))          ?? o.position;
    else if (f === 4) o.currentStopSeq  = readIf(r, w, W_VARINT, () => r.varint()) ?? o.currentStopSeq;
    else if (f === 5) o.stopId          = readIf(r, w, W_LEN,    () => r.str())    ?? o.stopId;
    else if (f === 6) o.currentStatus   = readIf(r, w, W_VARINT, () => r.varint()) ?? o.currentStatus;
    else if (f === 7) o.timestamp       = readIf(r, w, W_VARINT, () => r.varint()) ?? o.timestamp;
    else if (f === 8) o.congestionLevel = readIf(r, w, W_VARINT, () => r.varint()) ?? o.congestionLevel;
    else if (f === 9) o.occupancyStatus = readIf(r, w, W_VARINT, () => r.varint()) ?? o.occupancyStatus;
    else r.skip(w);
  }
  return o;
}

function parseFeedEntity(r) {
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.id         = readIf(r, w, W_LEN,    () => r.str())                              ?? o.id;
    else if (f === 2) o.isDeleted  = readIf(r, w, W_VARINT, () => !!r.varint())                         ?? o.isDeleted;
    else if (f === 3) o.tripUpdate = readIf(r, w, W_LEN,    () => parseTripUpdate(r.sub()))              ?? o.tripUpdate;
    else if (f === 4) o.vehicle    = readIf(r, w, W_LEN,    () => parseVehiclePosition(r.sub()))         ?? o.vehicle;
    else r.skip(w);
  }
  return o;
}

function parseFeedMessage(buf) {
  const r = new PBReader(buf);
  const feed = { header: {}, entity: [] };
  let entityErrors = 0;

  while (!r.done) {
    const [f, w] = r.tag();
    if (f === 1 && w === W_LEN) {
      const hr = r.sub();
      while (!hr.done) {
        const [hf, hw] = hr.tag();
        if      (hf === 1) feed.header.gtfsRealtimeVersion = readIf(hr, hw, W_LEN,    () => hr.str())    ?? feed.header.gtfsRealtimeVersion;
        else if (hf === 2) feed.header.incrementality      = readIf(hr, hw, W_VARINT, () => hr.varint()) ?? feed.header.incrementality;
        else if (hf === 3) feed.header.timestamp           = readIf(hr, hw, W_VARINT, () => hr.varint()) ?? feed.header.timestamp;
        else               hr.skip(hw);
      }
    } else if (f === 2 && w === W_LEN) {
      const entityBytes = r.bytes(); // isolated slice — bad entity can't corrupt the stream
      try {
        feed.entity.push(parseFeedEntity(new PBReader(entityBytes)));
      } catch (e) {
        entityErrors++;
        feed.entity.push({ _parseError: e.message });
      }
    } else {
      r.skip(w);
    }
  }

  if (entityErrors > 0) feed._entityErrors = entityErrors;
  return feed;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toHex(buf, n = 32) {
  const src = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  return Array.from(src.subarray(0, Math.min(src.length, n)))
    .map(b => b.toString(16).padStart(2, "0")).join(" ");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

// ── Worker entry-point ────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // ── Debug endpoint: /api/debug ────────────────────────────────────────
    if (url.pathname === "/api/debug") {
      if (!env.DL_GTFSRT) return json({ error: "Secret DL_GTFSRT not set" }, 500);

      const upResp = await fetch(GTFS_API_URL, {
        headers: {
          "Cache-Control": "no-cache",
          "Ocp-Apim-Subscription-Key": env.DL_GTFSRT,
          "Accept-Encoding": "identity",
        },
      }).catch(e => { throw new Error(e.message); });

      if (!upResp.ok) return json({ error: `upstream ${upResp.status}` }, 502);

      const raw = await upResp.arrayBuffer();
      const feed = parseFeedMessage(raw);

      let withTripUpdate = 0, withVehicle = 0, withBoth = 0, errors = 0;
      let sampleVehicle = null, sampleError = null, sampleTripUpdate = null;

      for (const e of feed.entity) {
        if (e._parseError) {
          errors++;
          if (!sampleError) sampleError = { id: e.id, error: e._parseError };
          continue;
        }
        const hasTU = !!e.tripUpdate;
        const hasVP = !!e.vehicle;
        if (hasTU) withTripUpdate++;
        if (hasVP) withVehicle++;
        if (hasTU && hasVP) withBoth++;
        if (hasVP && !sampleVehicle) sampleVehicle = { id: e.id, vehicle: e.vehicle };
        if (hasTU && !sampleTripUpdate) sampleTripUpdate = { id: e.id, tripUpdate: e.tripUpdate };
      }

      return json({
        bodyBytes: raw.byteLength,
        feedHeader: feed.header,
        totalEntities: feed.entity.length,
        withTripUpdate,
        withVehiclePosition: withVehicle,
        withBoth,
        parseErrors: errors,
        sampleError,
        sampleVehicle,
        sampleTripUpdate,
      });
    }

    // ── Main GTFS endpoint: /api/gtfs ─────────────────────────────────────
    if (url.pathname === "/api/gtfs") {
      if (!env.DL_GTFSRT)
        return json({ error: "Secret DL_GTFSRT not configured. Run: wrangler secret put DL_GTFSRT" }, 500);

      let upResp;
      try {
        upResp = await fetch(GTFS_API_URL, {
          headers: {
            "Cache-Control": "no-cache",
            "Ocp-Apim-Subscription-Key": env.DL_GTFSRT,
            "Accept-Encoding": "identity",
            "Accept": "application/octet-stream, application/x-protobuf, */*",
          },
        });
      } catch (err) {
        return json({ error: "Upstream fetch failed", detail: err.message }, 502);
      }

      if (!upResp.ok)
        return json({ error: `De Lijn API ${upResp.status}`, detail: await upResp.text() }, upResp.status);

      const raw = await upResp.arrayBuffer();
      if (raw.byteLength === 0)
        return json({ error: "De Lijn API returned empty body" }, 502);

      let feed;
      try {
        feed = parseFeedMessage(raw);
      } catch (err) {
        return json({
          error: "Protobuf decode failed",
          detail: err.message,
          bodyBytes: raw.byteLength,
          first32Hex: toHex(raw),
          first200Text: new TextDecoder().decode(new Uint8Array(raw, 0, Math.min(raw.byteLength, 200))),
        }, 500);
      }

      return json(feed);
    }

    return env.ASSETS.fetch(request);
  },
};
