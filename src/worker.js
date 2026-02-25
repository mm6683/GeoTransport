import { transit_realtime } from "gtfs-realtime-bindings";

const GTFS_API_URL =
  "https://api.delijn.be/gtfs/v3/realtime?canceled=true&delay=true&position=true&vehicleid=true&tripid=true";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ── API proxy route ─────────────────────────────────────────────────────
    if (url.pathname === "/api/gtfs") {
      if (!env.DL_GTFSRT) {
        return new Response(
          JSON.stringify({ error: "Secret DL_GTFSRT is not configured. Run: wrangler secret put DL_GTFSRT" }),
          { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      let feedResponse;
      try {
        feedResponse = await fetch(GTFS_API_URL, {
          headers: {
            "Cache-Control": "no-cache",
            "Ocp-Apim-Subscription-Key": env.DL_GTFSRT,
          },
          cf: { cacheEverything: false },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ error: "Failed to reach De Lijn API", detail: err.message }),
          { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      if (!feedResponse.ok) {
        const body = await feedResponse.text();
        return new Response(
          JSON.stringify({ error: `De Lijn API returned ${feedResponse.status}`, detail: body }),
          { status: feedResponse.status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      const buffer = await feedResponse.arrayBuffer();

      let feed;
      try {
        feed = transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
      } catch (err) {
        return new Response(
          JSON.stringify({ error: "Failed to decode protobuf", detail: err.message }),
          { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      // Convert Long objects to plain numbers so JSON.stringify works cleanly
      const plain = JSON.parse(
        JSON.stringify(feed, (_key, value) => {
          // protobufjs Long → number
          if (value && typeof value === "object" && "low" in value && "high" in value && "unsigned" in value) {
            return value.low + value.high * 4294967296;
          }
          return value;
        })
      );

      return new Response(JSON.stringify(plain), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          ...CORS_HEADERS,
        },
      });
    }

    // ── Static assets ────────────────────────────────────────────────────────
    return env.ASSETS.fetch(request);
  },
};
