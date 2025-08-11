export async function fetchDeLijnVehicles() {
  // Public endpoint for live vehicle positions (De Lijn)
  const url = 'https://api.delijn.be/haltes/vehicles.json'; // placeholder — will replace with actual feed
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'GeoTransport/1.0 (https://yourdomain)',
      'Accept': 'application/json'
    }
  });

  if (!res.ok) {
    console.error(`De Lijn API error: ${res.status}`);
    return { entity: [] };
  }

  const json = await res.json();

  // Normalizing into your schema
  const entity = json.vehicles.map(v => ({
    vehicle: {
      id: v.id || v.vehicle_id,
      position: {
        latitude: parseFloat(v.lat || v.latitude),
        longitude: parseFloat(v.lon || v.longitude),
        bearing: v.bearing !== undefined ? parseFloat(v.bearing) : null
      }
    }
  }));

  return { entity };
}
