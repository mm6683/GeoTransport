const CENTER = [50.85, 4.35];
const INITIAL_ZOOM = 12;
const POLL_INTERVAL_MS = 5000;

const map = L.map('map').setView(CENTER, INITIAL_ZOOM);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const icons = {
  bus: L.icon({ iconUrl: '/icons/bus.svg', iconSize: [36, 36], iconAnchor: [18, 18] }),
  tram: L.icon({ iconUrl: '/icons/tram.svg', iconSize: [36, 36], iconAnchor: [18, 18] })
};

const markers = new Map(); // id -> { marker, iconKey, content }

function deriveLatLng(pos) {
  if (!pos || typeof pos.latitude !== 'number' || typeof pos.longitude !== 'number') return null;
  return [pos.latitude, pos.longitude];
}

function deriveVehicleId(entity) {
  const v = entity?.vehicle;
  return (
    v?.vehicle?.id ||
    v?.vehicle?.label ||
    v?.trip?.trip_id ||
    entity?.id ||
    null
  );
}

function deriveRoute(v) {
  return v?.trip?.route_id || v?.trip?.trip_id || '';
}

function deriveKind(v, routeHint) {
  const type = v?.vehicle?.type;
  if (typeof type === 'number') {
    // GTFS vehicle types: 0 tram, 3 bus
    if (type === 0) return 'tram';
    if (type === 3) return 'bus';
  }

  const normalized = `${routeHint}`.toLowerCase();
  return normalized.includes('tram') ? 'tram' : 'bus';
}

function deriveLabel(v, route) {
  return v?.vehicle?.label || v?.vehicle?.id || route || 'Onbekend voertuig';
}

function buildPopupContent(label, route) {
  const routeText = route ? `<div>Lijn: ${route}</div>` : '';
  return `<strong>${label}</strong>${routeText}`;
}

async function updateVehicles() {
  try {
    const res = await fetch('/api/busses', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();

    const seen = new Set();
    const entities = Array.isArray(payload.entity) ? payload.entity : [];

    entities.forEach((e) => {
      const v = e?.vehicle;
      if (!v) return;

      const latlng = deriveLatLng(v.position);
      if (!latlng) return;

      const id = String(deriveVehicleId(e) || `${latlng[0]},${latlng[1]}`);
      seen.add(id);

      const route = deriveRoute(v);
      const kind = deriveKind(v, route);
      const iconKey = kind === 'tram' ? 'tram' : 'bus';
      const content = buildPopupContent(deriveLabel(v, route), route);

      if (markers.has(id)) {
        const entry = markers.get(id);
        entry.marker.setLatLng(latlng);
        if (entry.iconKey !== iconKey) {
          entry.marker.setIcon(icons[iconKey]);
          entry.iconKey = iconKey;
        }
        if (entry.content !== content) {
          const popup = entry.marker.getPopup();
          if (popup) {
            popup.setContent(content);
          } else {
            entry.marker.bindPopup(content);
          }
          entry.content = content;
        }
      } else {
        const marker = L.marker(latlng, { icon: icons[iconKey] }).addTo(map);
        marker.bindPopup(content);
        markers.set(id, { marker, iconKey, content });
      }
    });

    // remove disappeared
    for (const id of markers.keys()) {
      if (!seen.has(id)) {
        const entry = markers.get(id);
        map.removeLayer(entry.marker);
        markers.delete(id);
      }
    }
  } catch (err) {
    console.error('Update failed:', err);
  }
}

setInterval(updateVehicles, POLL_INTERVAL_MS);
updateVehicles();
