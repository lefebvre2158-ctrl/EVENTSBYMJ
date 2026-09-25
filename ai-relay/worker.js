/**
 * Events by MJ - AI Preview Relay (Cloudflare Worker)
 *
 * Holds the OpenAI key privately so it never appears in the website code.
 *
 *   POST /        { prompt }  -> { image: <base64 png> }
 *   POST /save    { image }   -> { url }   (stores preview so Maja gets a link in the quote email)
 *   GET  /img/:id             -> the saved PNG
 *
 * Setup (one time):
 *   1. Cloudflare dashboard -> Workers & Pages -> Create -> paste this file.
 *   2. Settings -> Variables & Secrets -> add secret  OPENAI_API_KEY = sk-...
 *   3. (Optional but recommended) Storage & Databases -> KV -> create namespace "PREVIEWS",
 *      then bind it to the worker under Settings -> Bindings with variable name PREVIEWS.
 *      Without KV, /save still works but returns no link (the email still has the full prompt).
 *   4. Copy the worker URL into AI_RELAY_URL in index.html.
 */

const ALLOWED_ORIGINS = [
  'https://lefebvre2158-ctrl.github.io',
  'https://www.eventsbymj.ca',
  'https://eventsbymj.ca',
];

const MAX_PER_IP_PER_HOUR = 6;      // basic abuse protection
const IMAGE_MODEL = 'gpt-image-1';  // OpenAI image model (~$0.02-0.07 per image at 1024x1024)

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    // Serve saved preview images (public link used in the quote email)
    if (request.method === 'GET' && url.pathname.startsWith('/img/')) {
      if (!env.PREVIEWS) return json({ error: 'Storage not configured' }, 404, cors);
      const id = url.pathname.slice(5);
      const data = await env.PREVIEWS.get(id, 'arrayBuffer');
      if (!data) return new Response('Not found', { status: 404 });
      return new Response(data, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000' } });
    }

    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Origin not allowed' }, 403, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400, cors); }

    // ---- /save : store a generated preview, return a link ----
    if (url.pathname === '/save') {
      if (!env.PREVIEWS || !body.image) return json({ url: '' }, 200, cors);
      const bytes = Uint8Array.from(atob(body.image), c => c.charCodeAt(0));
      const id = crypto.randomUUID() + '.png';
      await env.PREVIEWS.put(id, bytes, { expirationTtl: 60 * 60 * 24 * 90 }); // keep 90 days
      return json({ url: `${url.origin}/img/${id}` }, 200, cors);
    }

    // ---- / : generate an image ----
    if (!env.OPENAI_API_KEY) return json({ error: 'Relay not configured' }, 500, cors);
    const prompt = String(body.prompt || '').slice(0, 1500);
    if (prompt.length < 20) return json({ error: 'Prompt too short' }, 400, cors);

    // Simple per-IP rate limit (needs KV; skipped if not bound)
    if (env.PREVIEWS) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const key = 'rl:' + ip + ':' + Math.floor(Date.now() / 3600000);
      const count = parseInt((await env.PREVIEWS.get(key)) || '0', 10);
      if (count >= MAX_PER_IP_PER_HOUR) return json({ error: 'Too many previews - please try again in an hour, or contact us directly.' }, 429, cors);
      ctx.waitUntil(env.PREVIEWS.put(key, String(count + 1), { expirationTtl: 3600 }));
    }

    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, n: 1, size: '1024x1024', quality: 'medium' }),
    });

    if (!r.ok) {
      const text = await r.text();
      console.log('OpenAI error', r.status, text);
      return json({ error: 'Image service unavailable right now' }, 502, cors);
    }
    const data = await r.json();
    const b64 = data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) return json({ error: 'No image returned' }, 502, cors);
    return json({ image: b64 }, 200, cors);
  },
};

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
