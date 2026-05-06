// Commute Dashboard — Cloudflare Worker proxy
// Secrets required (set in Cloudflare dashboard → Worker → Settings → Variables):
//   NJT_USERNAME  — NJ Transit API username (from datasource.njtransit.com)
//   NJT_PASSWORD  — NJ Transit API password
//   NY511_KEY     — 511NY API key (from 511ny.org/developers)

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
        if (!res.ok) return json({ error: `NJT API ${res.status}` }, 502);
        return json(await res.json());
      }

      // ── 511NY traffic events (covers I-280) ─────────────────────────────
      // GET /traffic
      if (url.pathname === '/traffic') {
        const res = await fetch(
          `https://511ny.org/api/getevents?key=${env.NY511_KEY}&format=json`
        );
        if (!res.ok) return json({ error: `511NY API ${res.status}` }, 502);
        return json(await res.json());
      }

      return new Response('not found', { status: 404, headers: cors });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
