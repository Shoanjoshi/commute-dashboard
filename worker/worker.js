// Commute Dashboard — Cloudflare Worker proxy
// Secrets required (set in Cloudflare dashboard → Worker → Settings → Variables):
//   GOOGLE_MAPS_KEY  — Google Maps Distance Matrix API key
//   NJT_USERNAME     — NJ Transit API username (from developer.njtransit.com)
//   NJT_PASSWORD     — NJ Transit API password

const ALLOWED_ORIGINS = [
  'https://shoanjoshi.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ':'));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ── NJ Transit V2 API ────────────────────────────────────────────────────────
// Docs: https://raildata.njtransit.com
// GET /njt?station=BK  — departures from Brick Church
// GET /njt?station=NY  — departures from NY Penn Station

const NJT_BASE = 'https://raildata.njtransit.com/api/TrainData';
const NJT_TOKEN_CACHE_KEY = 'https://njt-token.internal/v1';

async function getNJTToken(env) {
  const cache = caches.default;
  const cached = await cache.match(NJT_TOKEN_CACHE_KEY);
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
  try { data = JSON.parse(text); } catch { throw new Error(`NJT getToken parse error: ${text.slice(0, 200)}`); }

  if (!data || data.errorMessage) throw new Error(`NJT getToken: ${data?.errorMessage || 'empty response'}`);
  if (data.Authenticated !== 'True' || !data.UserToken) throw new Error(`NJT auth failed — check credentials. Response: ${text.slice(0, 200)}`);

  await cache.put(NJT_TOKEN_CACHE_KEY, new Response(JSON.stringify({ token: data.UserToken }), {
    headers: { 'Cache-Control': 'max-age=82800', 'Content-Type': 'application/json' },
  }));
  return data.UserToken;
}

async function getNJTDepartures(env, station) {
  const token = await getNJTToken(env);
  const form = new FormData();
  form.append('token', token);
  form.append('station', station);

  const res = await fetch(`${NJT_BASE}/getTrainSchedule`, { method: 'POST', body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`NJT getTrainSchedule ${res.status}: ${text.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`NJT schedule parse error: ${text.slice(0, 200)}`); }
  return Array.isArray(data) ? data : (data.ITEMS || data.items || []);
}

// ── NJ Transit RSS (service alerts fallback) ─────────────────────────────────
// GET /njt-rss — returns line-level service alerts from RSS

const NJT_RSS_URL = 'https://www.njtransit.com/rss/RailAdvisories_feed.xml';
const LINE_KEYWORDS = ['morris', 'essex', 'morristown', 'montclair', 'midtown direct'];

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/.exec(block) ||
                   /<title>([\s\S]*?)<\/title>/.exec(block) || [])[1] || '';
    const desc  = (/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/.exec(block) ||
                   /<description>([\s\S]*?)<\/description>/.exec(block) || [])[1] || '';
    const pubDate = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(block) || [])[1] || '';
    items.push({ title: title.trim(), description: desc.trim(), pubDate: pubDate.trim() });
  }
  return items;
}

function isRelevant(item) {
  const text = (item.title + ' ' + item.description).toLowerCase();
  return LINE_KEYWORDS.some(k => text.includes(k));
}

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export default {
  async fetch(request, env) {
    const cors = getCorsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    try {
      // ── NJ Transit V2 API — real-time departures ──────────────────────────
      // GET /njt?station=BK  or  /njt?station=NY
      if (url.pathname === '/njt') {
        if (!env.NJT_USERNAME || !env.NJT_PASSWORD) {
          return json({ error: 'NJT_USERNAME / NJT_PASSWORD secrets not set in Cloudflare Worker' }, 500, cors);
        }
        const station = url.searchParams.get('station') || 'BK';
        try {
          const items = await getNJTDepartures(env, station);
          return json({ items }, 200, cors);
        } catch (e) {
          return json({ error: e.message }, 502, cors);
        }
      }

      // ── NJ Transit RSS alerts (Morris & Essex line) ──────────────────────
      // GET /njt-rss
      if (url.pathname === '/njt-rss') {
        const res = await fetch(NJT_RSS_URL, {
          headers: { 'User-Agent': 'CommuteDashboard/1.0' },
        });
        if (!res.ok) return json({ error: `NJT RSS ${res.status}` }, 502, cors);
        const xml = await res.text();
        const all = parseRSS(xml);
        const relevant = all.filter(isRelevant).map(item => ({
          title: stripHtml(item.title),
          description: stripHtml(item.description),
          pubDate: item.pubDate,
        }));
        return json({ alerts: relevant, total: all.length }, 200, cors);
      }

      // ── Google Maps Distance Matrix (I-280 live travel time) ────────────
      // GET /traffic?direction=east   or   /traffic?direction=west
      if (url.pathname === '/traffic') {
        if (!env.GOOGLE_MAPS_KEY) {
          return json({ error: 'GOOGLE_MAPS_KEY secret not set in Cloudflare Worker' }, 500, cors);
        }

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
          return json({ error: `Google Maps: ${data.status} — ${data.error_message || 'check API key'}` }, 502, cors);
        }
        return json(data, 200, cors);
      }

      return new Response('not found', { status: 404, headers: cors });
    } catch (e) {
      return json({ error: e.message }, 500, cors);
    }
  },
};
