// Commute Dashboard — Cloudflare Worker proxy
// Secrets required (set in Cloudflare dashboard → Worker → Settings → Variables):
//   GOOGLE_MAPS_KEY  — Google Maps Distance Matrix API key
// Optional (for future real-time API):
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

// ── NJ Transit RSS feed parser ───────────────────────────────────────────────
// GET /njt-rss?line=morris   — returns service alerts for Morris & Essex line

const NJT_RSS_URL = 'https://www.njtransit.com/rss/RailAdvisories_feed.xml';

const LINE_KEYWORDS = ['morris', 'essex', 'morristown', 'montclair'];

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
