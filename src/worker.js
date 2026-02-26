/**
 * De Lijn GTFS-RT Cloudflare Worker — pure-JS protobuf decoder
 */

const GTFS_API_URL =
  "https://api.delijn.be/gtfs/v3/realtime?canceled=true&delay=true&position=true&vehicleid=true&tripid=true";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// ── Low-level varint / skip (used by both debug and parser) ──────────────────
function readVarintRaw(d, p) {
  let val = 0, shift = 0;
  while (p < d.length) {
    const b = d[p++];
    val |= (b & 0x7f) * Math.pow(2, shift); // avoid sign issues with |=
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return [val, p];
}

function skipRaw(d, p, wire) {
  if (wire === 0) { let v; [v, p] = readVarintRaw(d, p); return p; }
  if (wire === 1) return p + 8;
  if (wire === 2) { let l; [l, p] = readVarintRaw(d, p); return p + l; }
  if (wire === 5) return p + 4;
  throw new Error(`unknown wire type ${wire}`);
}

// ── Protobuf reader class ────────────────────────────────────────────────────
const _dec = new TextDecoder();

class PBReader {
  constructor(input) {
    if (input instanceof ArrayBuffer) {
      this.b = new Uint8Array(input.slice(0));
    } else {
      // Uint8Array — copy to own flat buffer so byteOffset is always 0
      this.b = new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
    }
    this.p = 0;
    this.end = this.b.length;
    this.v = new DataView(this.b.buffer);
  }

  get done() { return this.p >= this.end; }

  varint() {
    let lo = 0, hi = 0, s = 0;
    for (let i = 0; i < 10; i++) {
      if (this.p >= this.end) throw new Error(`varint EOF at ${this.p}`);
      const b = this.b[this.p++];
      if      (s < 28) lo |=  (b & 0x7f) << s;
      else if (s < 32) { lo |= (b & 0x7f) << s; hi |= (b & 0x7f) >>> (32 - s); }
      else             hi |= (b & 0x7f) << (s - 32);
      s += 7;
      if (!(b & 0x80)) break;
    }
    return (lo >>> 0) + hi * 4294967296;
  }

  sint32() { return this.varint() | 0; }

  float() {
    if (this.p + 4 > this.end) throw new Error(`float EOF at ${this.p}`);
    const f = this.v.getFloat32(this.p, true);
    this.p += 4;
    return f;
  }

  double() {
    if (this.p + 8 > this.end) throw new Error(`double EOF at ${this.p}`);
    const f = this.v.getFloat64(this.p, true);
    this.p += 8;
    return f;
  }

  bytes() {
    const len = this.varint();
    if (this.p + len > this.end)
      throw new Error(`bytes: need ${len}, only ${this.end - this.p} left at ${this.p}`);
    const s = this.b.slice(this.p, this.p + len);
    this.p += len;
    return s;
  }

  str()  { return _dec.decode(this.bytes()); }
  sub()  { return new PBReader(this.bytes()); }
  tag()  { const t = this.varint(); return [t >>> 3, t & 7]; }

  skip(wire) {
    if      (wire === 0) this.varint();
    else if (wire === 1) { this.p += 8; }
    else if (wire === 2) this.bytes();
    else if (wire === 5) { this.p += 4; }
    else throw new Error(`unknown wire ${wire} at ${this.p}`);
  }
}

const W_VARINT = 0, W_64 = 1, W_LEN = 2, W_32 = 5;

function readIf(r, w, expected, fn) {
  if (w === expected) return fn();
  r.skip(w);
  return undefined;
}

// ── GTFS-RT parsers ──────────────────────────────────────────────────────────
// Official field numbers (gtfs-realtime.proto):
//   TripDescriptor:    trip_id=1, start_time=2, start_date=3,
//                      schedule_relationship=4, route_id=5, direction_id=6
//   VehicleDescriptor: id=1, label=2, license_plate=3
//   Position:          latitude=1(f32), longitude=2(f32), bearing=3(f32),
//                      odometer=4(f64), speed=5(f32)
//   VehiclePosition:   trip=1, vehicle=2, position=3, current_stop_sequence=4,
//                      stop_id=5, current_status=6, timestamp=7,
//                      congestion_level=8, occupancy_status=9
//   TripUpdate:        trip=1, stop_time_update=2, vehicle=3,
//                      timestamp=4, delay=5
//   StopTimeEvent:     delay=1, time=2, uncertainty=3
//   StopTimeUpdate:    stop_sequence=1, arrival=2, departure=3,
//                      stop_id=4, schedule_relationship=5
//   FeedEntity:        id=1, is_deleted=2, trip_update=3, vehicle=4, alert=5
//   FeedHeader:        gtfs_realtime_version=1, incrementality=2, timestamp=3

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
    // latitude/longitude/bearing/speed are float (wire 5); odometer is double (wire 1)
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
  // De Lijn actual field numbers (verified from binary):
  //   1 = trip (TripDescriptor)
  //   2 = position (Position)        <- standard proto uses field 3
  //   5 = timestamp (varint)         <- standard proto uses field 7
  //   8 = vehicle (VehicleDescriptor)<- standard proto uses field 2
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.trip      = readIf(r, w, W_LEN,    () => parseTripDescriptor(r.sub()))    ?? o.trip;
    else if (f === 2) o.position  = readIf(r, w, W_LEN,    () => parsePosition(r.sub()))          ?? o.position;
    else if (f === 5) o.timestamp = readIf(r, w, W_VARINT, () => r.varint())                      ?? o.timestamp;
    else if (f === 8) o.vehicle   = readIf(r, w, W_LEN,    () => parseVehicleDescriptor(r.sub())) ?? o.vehicle;
    else r.skip(w);
  }
  return o;
}

function parseFeedEntity(r) {
  const o = {};
  while (!r.done) {
    const [f, w] = r.tag();
    if      (f === 1) o.id         = readIf(r, w, W_LEN,    () => r.str())                        ?? o.id;
    else if (f === 2) o.isDeleted  = readIf(r, w, W_VARINT, () => !!r.varint())                   ?? o.isDeleted;
    else if (f === 3) o.tripUpdate = readIf(r, w, W_LEN,    () => parseTripUpdate(r.sub()))        ?? o.tripUpdate;
    else if (f === 4) o.vehicle    = readIf(r, w, W_LEN,    () => parseVehiclePosition(r.sub()))   ?? o.vehicle;
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
      const entityBytes = r.bytes();
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
function toHex(d, n = 64) {
  const src = d instanceof ArrayBuffer ? new Uint8Array(d) : d;
  return Array.from(src.subarray(0, Math.min(src.length, n)))
    .map(b => b.toString(16).padStart(2, "0")).join(" ");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

async function fetchRaw(env) {
  const r = await fetch(GTFS_API_URL, {
    headers: {
      "Cache-Control": "no-cache",
      "Ocp-Apim-Subscription-Key": env.DL_GTFSRT,
      "Accept-Encoding": "identity",
    },
  });
  if (!r.ok) throw new Error(`upstream ${r.status}: ${await r.text()}`);
  return r.arrayBuffer();
}

// ── Worker entry-point ────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // ── /api/debug — full structural dump of first vehicle entity ─────────
    if (url.pathname === "/api/debug") {
      if (!env.DL_GTFSRT) return json({ error: "Secret not set" }, 500);

      let raw;
      try { raw = await fetchRaw(env); } catch (e) { return json({ error: e.message }, 502); }
      const data = new Uint8Array(raw);

      // Walk top-level to find the first entity containing field 4 (VehiclePosition)
      let i = 0;
      let vehicleEntityHex = null;
      let vehicleEntityFields = null;

      outer: while (i < data.length) {
        let tag, w, len;
        [tag, i] = readVarintRaw(data, i);
        const field = tag >>> 3; w = tag & 7;
        if (w !== 2) { i = skipRaw(data, i, w); continue; }
        [len, i] = readVarintRaw(data, i);
        const bodyStart = i;
        i += len;

        if (field !== 2) continue; // only FeedEntity (field 2)

        const ent = data.subarray(bodyStart, bodyStart + len);

        // Check if entity has field 4
        let j = 0;
        while (j < ent.length) {
          let t2; [t2, j] = readVarintRaw(ent, j);
          const f2 = t2 >>> 3, w2 = t2 & 7;
          if (f2 === 4 && w2 === W_LEN) {
            // Found a VehiclePosition entity — dump it
            vehicleEntityHex = toHex(ent, 256);

            // Decode each sub-field of the entity
            vehicleEntityFields = [];
            let k = 0;
            while (k < ent.length) {
              let t3, p3; [t3, p3] = readVarintRaw(ent, k);
              const f3 = t3 >>> 3, w3 = t3 & 7;
              const fi = { entityField: f3, wire: w3 };
              if (w3 === W_LEN) {
                let l3; [l3, p3] = readVarintRaw(ent, p3);
                const sub = ent.subarray(p3, p3 + l3);
                fi.byteLen = l3;
                fi.hex = toHex(sub, 64);
                // If VehiclePosition (f3=4), decode its sub-fields too
                if (f3 === 4) {
                  fi.vpFields = [];
                  let m = 0;
                  while (m < sub.length) {
                    let t4, p4; [t4, p4] = readVarintRaw(sub, m);
                    const f4 = t4 >>> 3, w4 = t4 & 7;
                    const vf = { field: f4, wire: w4 };
                    if (w4 === W_LEN) {
                      let l4; [l4, p4] = readVarintRaw(sub, p4);
                      vf.byteLen = l4;
                      vf.hex = toHex(sub.subarray(p4, p4 + l4), 32);
                      // If this is Position (f4=3), decode its floats
                      if (f4 === 3) {
                        const pos = sub.subarray(p4, p4 + l4);
                        vf.posFields = [];
                        let n = 0;
                        while (n < pos.length) {
                          let t5, p5; [t5, p5] = readVarintRaw(pos, n);
                          const f5 = t5 >>> 3, w5 = t5 & 7;
                          const pf = { field: f5, wire: w5 };
                          if (w5 === W_32) {
                            const dv = new DataView(pos.buffer, pos.byteOffset + p5, 4);
                            pf.float32 = dv.getFloat32(0, true); n = p5 + 4;
                          } else if (w5 === W_64) {
                            const dv = new DataView(pos.buffer, pos.byteOffset + p5, 8);
                            pf.float64 = dv.getFloat64(0, true); n = p5 + 8;
                          } else if (w5 === W_VARINT) {
                            let v; [v, p5] = readVarintRaw(pos, p5); pf.varint = v; n = p5;
                          } else if (w5 === W_LEN) {
                            let l5; [l5, p5] = readVarintRaw(pos, p5);
                            pf.hex = toHex(pos.subarray(p5, p5 + l5), 16); n = p5 + l5;
                          } else { break; }
                          vf.posFields.push(pf);
                        }
                      }
                      m = p4 + l4;
                    } else if (w4 === W_VARINT) {
                      let v; [v, p4] = readVarintRaw(sub, p4); vf.varint = v; m = p4;
                    } else if (w4 === W_32) {
                      const dv = new DataView(sub.buffer, sub.byteOffset + p4, 4);
                      vf.float32 = dv.getFloat32(0, true); m = p4 + 4;
                    } else if (w4 === W_64) {
                      const dv = new DataView(sub.buffer, sub.byteOffset + p4, 8);
                      vf.float64 = dv.getFloat64(0, true); m = p4 + 8;
                    } else { break; }
                    fi.vpFields.push(vf);
                  }
                }
                k = p3 + l3;
              } else if (w3 === W_VARINT) {
                let v; [v, p3] = readVarintRaw(ent, p3); fi.varint = v; k = p3;
              } else if (w3 === W_32) {
                const dv = new DataView(ent.buffer, ent.byteOffset + p3, 4);
                fi.float32 = dv.getFloat32(0, true); k = p3 + 4;
              } else { k = skipRaw(ent, p3, w3); }
              vehicleEntityFields.push(fi);
            }
            break outer;
          }
          j = skipRaw(ent, j, w2);
        }
      }

      return json({ vehicleEntityHex: vehicleEntityHex?.slice(0, 800), vehicleEntityFields });
    }

    // ── /api/gtfs — main feed endpoint ───────────────────────────────────
    if (url.pathname === "/api/gtfs") {
      if (!env.DL_GTFSRT)
        return json({ error: "Secret DL_GTFSRT not configured. Run: wrangler secret put DL_GTFSRT" }, 500);

      let raw;
      try { raw = await fetchRaw(env); } catch (e) { return json({ error: e.message }, 502); }
      if (raw.byteLength === 0) return json({ error: "Empty response from De Lijn API" }, 502);

      let feed;
      try {
        feed = parseFeedMessage(raw);
      } catch (err) {
        return json({
          error: "Protobuf decode failed",
          detail: err.message,
          bodyBytes: raw.byteLength,
          first32Hex: toHex(raw, 32),
        }, 500);
      }

      return json(feed);
    }

    return env.ASSETS.fetch(request);
  },
};
