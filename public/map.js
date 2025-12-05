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
    const vehicles = Array.isArray(payload.vehicles) ? payload.vehicles : [];

    vehicles.forEach((vehicle) => {
      const latlng = deriveLatLng({ latitude: vehicle.lat, longitude: vehicle.lng });
      if (!latlng) return;

      const id = String(vehicle.id || `${latlng[0]},${latlng[1]}`);
      seen.add(id);

      const route = vehicle.route || '';
      const kind = vehicle.mode === 'tram' ? 'tram' : 'bus';
      const iconKey = kind === 'tram' ? 'tram' : 'bus';
      const content = buildPopupContent(vehicle.label || 'Onbekend voertuig', route);

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
