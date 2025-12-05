import { Router } from 'itty-router'

const router = Router({ base: '/api' })

const DELIJN_RT_URL = 'https://api.delijn.be/gtfs/v3/realtime?json=true&position=true'
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
}

function deriveLatLng(pos) {
  if (!pos || typeof pos.latitude !== 'number' || typeof pos.longitude !== 'number') return null
  return { lat: pos.latitude, lng: pos.longitude }
}

function deriveVehicleId(entity) {
  const v = entity?.vehicle
  const id = v?.vehicle?.id || v?.vehicle?.label || v?.trip?.trip_id || entity?.id
  return id ? String(id) : null
}

function deriveRoute(v) {
  return v?.trip?.route_id || v?.trip?.trip_id || ''
}

function deriveMode(v, routeHint) {
  const type = v?.vehicle?.type
  if (typeof type === 'number') {
    if (type === 0) return 'tram'
    if (type === 3) return 'bus'
  }

  const normalized = `${routeHint}`.toLowerCase()
  return normalized.includes('tram') ? 'tram' : 'bus'
}

function deriveLabel(v, route) {
  return v?.vehicle?.label || v?.vehicle?.id || route || 'Onbekend voertuig'
}

function mapEntities(payload) {
  const entities = Array.isArray(payload?.entity) ? payload.entity : []
  const vehicles = []

  entities.forEach((entity) => {
    const vehicleData = entity?.vehicle
    if (!vehicleData) return

    const coords = deriveLatLng(vehicleData.position)
    if (!coords) return

    const route = deriveRoute(vehicleData)
    const mapped = {
      id: deriveVehicleId(entity) || `${coords.lat},${coords.lng}`,
      lat: coords.lat,
      lng: coords.lng,
      bearing: typeof vehicleData?.position?.bearing === 'number' ? vehicleData.position.bearing : null,
      route,
      mode: deriveMode(vehicleData, route),
      label: deriveLabel(vehicleData, route)
    }

    vehicles.push(mapped)
  })

  return {
    vehicles,
    timestamp: payload?.header?.timestamp || null
  }
}

const busHandler = async (_request, env) => {
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

    const raw = await res.json()
    const data = mapEntities(raw)

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
}

router.options('/busses', () => new Response(null, { status: 204, headers: corsHeaders }))
router.options('/busses/*', () => new Response(null, { status: 204, headers: corsHeaders }))

router.get('/busses', busHandler)
router.get('/busses/*', busHandler)

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
