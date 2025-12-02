const CENTER = [50.85, 4.35];
const INITIAL_ZOOM = 12;
const POLL_INTERVAL_MS = 5000;

const map = L.map('map').setView(CENTER, INITIAL_ZOOM);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const icons = {
  bus: L.icon({ iconUrl: '/icons/bus.svg', iconSize: [36,36], iconAnchor: [18,18] }),
  tram: L.icon({ iconUrl: '/icons/tram.svg', iconSize: [36,36], iconAnchor: [18,18] })
};

const markers = new Map();

async function updateVehicles() {
  try {
    const res = await fetch('/api/busses', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();

    const seen = new Set();
    const entities = Array.isArray(payload.entity) ? payload.entity : [];

    entities.forEach((e) => {
      const v = e?.vehicle;
      const pos = v?.position;
      if (!v || !pos || typeof pos.latitude !== 'number' || typeof pos.longitude !== 'number') return;

      const id = String(v.vehicle?.id || v.trip?.trip_id || e.id || `${pos.latitude},${pos.longitude}`);
      seen.add(id);

      const latlng = [pos.latitude, pos.longitude];
      const routeHint = `${v.trip?.route_id || v.trip?.trip_id || ''}`.toLowerCase();
      const icon = routeHint.includes('tram') ? icons.tram : icons.bus;
      const label = v.vehicle?.label || v.vehicle?.id || v.trip?.route_id || 'Onbekend voertuig';

      if (markers.has(id)) {
        markers.get(id).setLatLng(latlng);
      } else {
        const m = L.marker(latlng, { icon }).addTo(map);
        m.bindPopup(`<strong>${label}</strong>`);
        markers.set(id, m);
      }
    });

    // remove disappeared
    for (const id of markers.keys()) {
      if (!seen.has(id)) {
        map.removeLayer(markers.get(id));
        markers.delete(id);
      }
    }
  } catch (err) {
    console.error('Update failed:', err);
  }
}

setInterval(updateVehicles, POLL_INTERVAL_MS);
updateVehicles();
