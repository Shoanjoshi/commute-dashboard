// Commute Dashboard — Cloudflare Worker proxy
// Secrets required (set in Cloudflare dashboard → Worker → Settings → Variables):
//   NJT_USERNAME     — NJ Transit API username (from datasource.njtransit.com)
//   NJT_PASSWORD     — NJ Transit API password
//   GOOGLE_MAPS_KEY  — Google Maps Distance Matrix API key (from console.cloud.google.com)

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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    try {
      // ── NJ Transit train schedule ────────────────────────────────────────
      // GET /njt?station=BRICK+CHURCH   or   /njt?station=NY
      if (url.pathname === '/njt') {
        const station = url.searchParams.get('station');
        if (!station) return json({ error: 'station param required' }, 400);

        const njtUrl =
          'https://njttraindata.njtransit.com/njttraindata.asmx/getTrainScheduleJSON' +
          `?username=${encodeURIComponent(env.NJT_USERNAME)}` +
          `&password=${encodeURIComponent(env.NJT_PASSWORD)}` +
          `&station=${encodeURIComponent(station)}`;

        const res = await fetch(njtUrl);
        const text = await res.text();
        if (!res.ok) return json({ error: `NJT API ${res.status}: ${text.slice(0, 200)}` }, 502);
        try {
          return json(JSON.parse(text));
        } catch {
          return json({ error: `NJT returned non-JSON: ${text.slice(0, 200)}` }, 502);
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
        // Surface Google's error status so we can debug
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
