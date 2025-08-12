import { Router } from 'itty-router'

const router = Router()

router.get('/api/buses', async () => {
  try {
    // Example: fetch from upstream GTFS source
    const res = await fetch(`${UPSTREAM_API_URL}/buses`) 
    if (!res.ok) return new Response('Upstream error', { status: 502 })
    const data = await res.json()

    // Optionally normalize the data here
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})

// Serve static files from public/
router.all('*', async (request, env, ctx) => {
  return env.ASSETS.fetch(request)
})

export default {
  fetch: router.handle
}
