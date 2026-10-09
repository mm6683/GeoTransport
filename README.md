# De Lijn · Live GTFS-RT Map

Real-time vehicle tracker for **De Lijn** (Belgian public transport) displayed on a dark OpenStreetMap layer, served entirely via a **Cloudflare Worker**.

![screenshot placeholder](https://placehold.co/900x500/080c10/00d4ff?text=De+Lijn+Live+Tracker)

## Features

- 🗺  Dark CartoDB map with live vehicle markers (bearing arrows + route colours)
- 🚌  Decodes GTFS-Realtime protobuf on the edge — no client-side binary parsing
- ⏱  Auto-refreshes every **15 seconds** with a progress bar
- 📊  Side panel: vehicle count, trip count, on-time vs delayed stats
- 🔍  Click any marker or list item to zoom in and inspect delay / speed / bearing
- 🔑  API key stored as a **Cloudflare Secret** — never exposed to the browser

## Architecture

```
Browser  ──GET /──────────────────▶  Cloudflare Worker  ──serves──▶  public/index.html
Browser  ──GET /api/gtfs ──────────▶  Worker (src/worker.js)
                                         │
                                         ├─ adds Ocp-Apim-Subscription-Key header
                                         ├─ fetches binary protobuf from De Lijn API
                                         ├─ decodes with gtfs-realtime-bindings
                                         └─ returns clean JSON to browser
```

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) v3+
- A Cloudflare account (free tier works)
- A De Lijn API subscription key ([request here](https://data.delijn.be))

## Setup

### 1. Clone & install

```bash
git clone https://github.com/your-org/dl-gtfs-rt-map.git
cd dl-gtfs-rt-map
npm install
```

### 2. Store your API key as a Cloudflare Secret

```bash
npm run secret
# Paste your Ocp-Apim-Subscription-Key when prompted
```

This stores it as `DL_GTFSRT` — it is **never** committed to source control.

### 3. Local development

```bash
npm run dev
```

Open [http://localhost:8787](http://localhost:8787).

> **Tip:** For local dev you can put your keys in a `.dev.vars` file (git-ignored):
> ```
> DL_GTFSRT=your_key_here
> DL_OPDA=your_key_here
> CARTO_KEY=your_carto_basemaps_key_here
> ```

### 4. Deploy to Cloudflare

```bash
npm run deploy
```

Your worker will be live at `https://dl-gtfs-rt-map.<your-subdomain>.workers.dev`.

## Project Structure

```
dl-gtfs-rt-map/
├── src/
│   └── worker.js          # Cloudflare Worker — API proxy + protobuf decoder
├── public/
│   └── index.html         # Single-page map UI (Leaflet + vanilla JS)
├── wrangler.toml          # Worker configuration
├── package.json
└── .gitignore
```

## API Endpoint

`GET /api/gtfs` — proxies the De Lijn GTFS-RT feed and returns decoded JSON:

```json
{
  "header": { "gtfsRealtimeVersion": "2.0", "timestamp": 1234567890 },
  "entity": [
    {
      "id": "...",
      "vehicle": {
        "trip": { "tripId": "2026-02-25_2850_181", "routeId": "2850" },
        "position": { "latitude": 51.05, "longitude": 3.72, "bearing": 270, "speed": 12.5 },
        "vehicle": { "id": "8622", "label": "8622" }
      }
    }
  ]
}
```

## Configuration

| Variable    | Where             | Description                                          |
|-------------|-------------------|-------------------------------------------------------|
| `DL_GTFSRT` | Cloudflare Secret | `Ocp-Apim-Subscription-Key` value for GTFS-RT         |
| `DL_OPDA`   | Cloudflare Secret | Kern OpenData subscription key (halte real-time)      |
| `CARTO_KEY` | Cloudflare Secret | CARTO Basemaps API key, injected into the served HTML |

## License

MIT
