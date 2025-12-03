import { Router } from 'itty-router'

const router = Router({ base: '/api' })

const DELIJN_RT_URL = 'https://api.delijn.be/gtfs/v3/realtime?json=true&position=true'
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
}

router.options('/busses', () => new Response(null, { status: 204, headers: corsHeaders }))

router.get('/busses', async (_request, env) => {
  try {
    if (!env?.DL_GTFSRT) {
      return new Response('Missing realtime API key', { status: 500, headers: corsHeaders })
    }

    const res = await fetch(DELIJN_RT_URL, {
      headers: {
        'Cache-Control': 'no-cache',
        'Ocp-Apim-Subscription-Key': env.DL_GTFSRT
      }
    })

    if (!res.ok) {
      return new Response('Upstream error', { status: 502, headers: corsHeaders })
    }

    const data = await res.json()

    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...corsHeaders
      }
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    })
  }
})

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) {
      const apiResponse = await router.handle(request, env, ctx)
      if (apiResponse) return apiResponse

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      })
    }

    return env.ASSETS.fetch(request)
  }
}
