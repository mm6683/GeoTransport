//TODO: Change URL L9
const map = L.map('map').setView([51.05, 3.73], 10);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
}).addTo(map);

async function fetchBusPositions() {
  try {
    const response = await fetch('https://your-firebase-url/getBusData');
    const data = await response.json();

    data.entity.forEach(bus => {
      if (bus.vehicle?.position) {
        const { latitude, longitude, bearing } = bus.vehicle.position;
        L.marker([latitude, longitude])
          .addTo(map)
          .bindPopup(`Bus ID: ${bus.vehicle.vehicle.id}<br>Bearing: ${bearing.toFixed(2)}°`);
      }
    });
  } catch (error) {
    console.error('Error fetching bus positions:', error);
  }
}

// Initial load + update every 10 seconds
fetchBusPositions();
setInterval(fetchBusPositions, 10000);
