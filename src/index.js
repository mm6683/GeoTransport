import { fetchDeLijnVehicles } from './fetchers/delijn.js';
import { corsHeaders } from './utils/cors.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- Buses endpoint (De Lijn) ---
    if (url.pathname === '/api/buses') {
      const data = await fetchDeLijnVehicles();
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    // 404 fallback
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
};
