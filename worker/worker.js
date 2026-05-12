// Commute Dashboard — Cloudflare Worker proxy
// Secrets required (set in Cloudflare dashboard → Worker → Settings → Variables):
//   NJT_USERNAME     — NJ Transit API username (from developer.njtransit.com)
//   NJT_PASSWORD     — NJ Transit API password
//   GOOGLE_MAPS_KEY  — Google Maps Distance Matrix API key

const ALLOWED_ORIGIN = 'https://shoanjoshi.github.io';

const cors = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

const NJT_BASE = 'https://raildata.njtransit.com/api/TrainData';
// Cache key for the NJT auth token (fake URL, only used as cache key)
const TOKEN_CACHE_URL = 'https://njt-token.internal/token';

async function getNJTToken(env) {
  const cache = caches.default;
  const cached = await cache.match(TOKEN_CACHE_URL);
  if (cached) {
    const { token } = await cached.json();
    return token;
  }

  const form = new FormData();
  form.append('username', env.NJT_USERNAME);
  form.append('password', env.NJT_PASSWORD);

  const res = await fetch(`${NJT_BASE}/getToken`, { method: 'POST', body: form });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`NJT getToken bad response: ${text.slice(0, 200)}`); }

  if (!data || data.errorMessage) throw new Error(`NJT getToken error: ${data?.errorMessage || 'null response'}`);
  if (data.Authenticated !== 'True' || !data.UserToken) throw new Error(`NJT auth failed: ${text.slice(0, 200)}`);

  // Cache for 23 hours (well under the 10-call/day limit)
  await cache.put(TOKEN_CACHE_URL, new Response(JSON.stringify({ token: data.UserToken }), {
    headers: { 'Cache-Control': 'max-age=82800', 'Content-Type': 'application/json' },
  }));

  return data.UserToken;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    try {
      // ── NJ Transit train schedule (V2 API) ──────────────────────────────
      // GET /njt?station=BK   or   /njt?station=NY
      if (url.pathname === '/njt') {
        const station = url.searchParams.get('station');
        if (!station) return json({ error: 'station param required' }, 400);

        let token;
        try {
          token = await getNJTToken(env);
        } catch (e) {
          return json({ error: `NJT auth: ${e.message}` }, 502);
        }

        const form = new FormData();
        form.append('token', token);
        form.append('station', station);

        const res = await fetch(`${NJT_BASE}/getTrainSchedule`, { method: 'POST', body: form });
        const text = await res.text();
        if (!res.ok) return json({ error: `NJT API ${res.status}: ${text.slice(0, 300)}` }, 502);
        try {
          return json(JSON.parse(text));
        } catch {
          return json({ error: `NJT returned non-JSON: ${text.slice(0, 300)}` }, 502);
        }
      }

      // ── Google Maps Distance Matrix (I-280 live travel time) ────────────
      // GET /traffic?direction=east   or   /traffic?direction=west
      if (url.pathname === '/traffic') {
        const direction = url.searchParams.get('direction') || 'east';
        const [origin, destination] = direction === 'east'
          ? ['Livingston, NJ 07039', 'Brick Church Station, East Orange, NJ 07017']
          : ['Brick Church Station, East Orange, NJ 07017', 'Livingston, NJ 07039'];

        const gmUrl = 'https://maps.googleapis.com/maps/api/distancematrix/json' +
          `?origins=${encodeURIComponent(origin)}` +
          `&destinations=${encodeURIComponent(destination)}` +
          `&departure_time=now` +
          `&traffic_model=best_guess` +
          `&key=${env.GOOGLE_MAPS_KEY}`;

        const res = await fetch(gmUrl);
        const data = await res.json();
        if (!res.ok || data.status === 'REQUEST_DENIED' || data.status === 'INVALID_REQUEST') {
          return json({ error: `Google Maps: ${data.status} — ${data.error_message || 'check API key'}` }, 502);
        }
        return json(data);
      }

      return new Response('not found', { status: 404, headers: cors });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
