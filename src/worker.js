/**
 * ConquerorTV · servidor (Cloudflare Worker)
 *
 * - Sirve la web (carpeta /public).
 * - Hace de intermediario con las APIs de datos, con caché compartida para todos los visitantes:
 *     /api/sports/{football|basketball|f1}/...  → API-Sports (clave secreta API_FOOTBALL_KEY)
 *     /api/fd/...                                → football-data.org (secreto FD_TOKEN)
 *     /api/jolpica/...                           → Jolpica (F1, sin clave)
 *     /api/tsdb/...                              → TheSportsDB (ACB y MotoGP, clave pública)
 *     POST /api/highlight                        → resumen OFICIAL en YouTube (secreto YT_KEY)
 * - Ninguna clave llega al navegador.
 */

const UPSTREAM = {
  football: 'https://v3.football.api-sports.io',
  basketball: 'https://v1.basketball.api-sports.io',
  f1: 'https://v1.formula-1.api-sports.io'
};
const JOLPICA = 'https://api.jolpi.ca/ergast/f1';
const TSDB = 'https://www.thesportsdb.com/api/v1/json/123';
const FD = 'https://api.football-data.org';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, ctx, url);
    } catch (e) {
      return json({ errors: [String(e && e.message || e)], response: [] }, 500);
    }
    // Resto: archivos estáticos de /public
    return env.ASSETS.fetch(request);
  }
};

/* ------------------------------------------------------------------ */
async function handleApi(request, env, ctx, url) {
  const p = url.pathname;

  // API-Sports
  let m = p.match(/^\/api\/sports\/(football|basketball|f1)(\/.*)$/);
  if (m) {
    const [, host, rest] = m;
    const path = rest + url.search;
    return cachedUpstream(env, ctx, host, path, ttlFor(host, path));
  }

  // football-data.org
  if (p.startsWith('/api/fd/')) {
    const path = p.slice('/api/fd'.length) + url.search;
    return cachedFetch(ctx, FD + path, { headers: { 'X-Auth-Token': env.FD_TOKEN || '' } }, 12 * 3600);
  }

  // Jolpica (F1)
  if (p.startsWith('/api/jolpica/')) {
    return cachedFetch(ctx, JOLPICA + p.slice('/api/jolpica'.length) + url.search, {}, 6 * 3600);
  }

  // TheSportsDB (ACB, MotoGP)
  if (p.startsWith('/api/tsdb/')) {
    return cachedFetch(ctx, TSDB + p.slice('/api/tsdb'.length) + url.search, {}, 30 * 60);
  }

  // Resumen oficial
  if (p === '/api/highlight' && request.method === 'POST') {
    const ev = await request.json();
    const region = (request.cf && request.cf.country) || 'ES';
    const out = await findOfficialHighlight(env, ctx, ev, region);
    return json({ ...out, region });
  }

  // País del visitante (por si la página lo necesita)
  if (p === '/api/country') return json({ country: (request.cf && request.cf.country) || 'ES' });

  return json({ errors: ['Ruta no encontrada'] }, 404);
}

/* ---------------- Caché ---------------- */
// ===== API-Sports: caché global (KV) con presupuesto diario =====
// El plan gratuito permite 100 peticiones al día por deporte. El servidor:
//  - guarda cada respuesta en KV (compartida por todos los visitantes de todo el mundo),
//  - solo vuelve a pedirla cuando ha caducado,
//  - nunca supera DAILY_BUDGET peticiones al día: si se agota, sirve la última copia guardada.
const DAILY_BUDGET = 90;
function ttlFor(host, path) {
  const d = path.match(/[?&]date=(\d{4}-\d{2}-\d{2})/);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
  if (d) {
    // Días pasados: 24 h · mañana: 6 h · hoy: 20 min en horas de partidos (12-24 h España), 3 h el resto.
    // Así el total diario ronda ~45 peticiones y no agota las 100 gratuitas.
    if (d[1] < today) return 24 * 3600;
    if (d[1] > today) return 6 * 3600;
    const h = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }).format(new Date()), 10);
    return h >= 12 ? 20 * 60 : 3 * 3600;
  }
  if (/[?&]id=\d+/.test(path)) return 10 * 60;                 // un partido concreto: 10 min (30 días si ya terminó)
  if (/\/standings/.test(path)) return 12 * 3600;
  if (/[?&]next=/.test(path)) return 12 * 3600;
  if (/[?&]round=/.test(path)) return 6 * 3600;
  if (/[?&]season=/.test(path)) return 12 * 3600;
  return 3600;
}
const utcDay = () => new Date().toISOString().slice(0, 10);
async function budgetLeft(env, host) {
  const used = parseInt(await env.CACHE.get('budget:' + host + ':' + utcDay()) || '0', 10);
  return DAILY_BUDGET - used;
}
async function spendBudget(env, ctx, host) {
  const k = 'budget:' + host + ':' + utcDay();
  const used = parseInt(await env.CACHE.get(k) || '0', 10);
  ctx.waitUntil(env.CACHE.put(k, String(used + 1), { expirationTtl: 2 * 86400 }));
}
async function cachedUpstream(env, ctx, host, path, ttl) {
  const key = 'as:' + host + ':' + path;
  const saved = await env.CACHE.get(key, 'json');               // { ts, ttl, body }
  const fresh = saved && Date.now() - saved.ts < saved.ttl * 1000;
  if (fresh) return jsonText(saved.body, ttl);

  // Caducado o inexistente: ¿queda presupuesto hoy y no hay bloqueo por cupo?
  const blocked = await env.CACHE.get('limit:' + host);
  if (blocked || (await budgetLeft(env, host)) <= 0) {
    if (saved) return jsonText(saved.body, 60);                // copia antigua mejor que nada
    return json({ errors: { requests: 'LIMIT_REACHED' }, response: [] });
  }

  await spendBudget(env, ctx, host);
  let res, body;
  try {
    res = await fetch(UPSTREAM[host] + path, { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY || '' } });
    body = await res.text();
  } catch (e) {
    if (saved) return jsonText(saved.body, 60);
    throw e;
  }
  let data = null;
  try { data = JSON.parse(body); } catch (e) {}
  const errs = data && data.errors && (Array.isArray(data.errors) ? data.errors : Object.values(data.errors));
  if (!data || (errs && errs.length)) {
    const msg = errs ? errs.join(' · ') : 'Respuesta no válida';
    if (/request limit|too many requests/i.test(msg)) {
      const now = new Date();
      const secs = Math.max(60, Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now) / 1000));
      ctx.waitUntil(env.CACHE.put('limit:' + host, '1', { expirationTtl: secs }));
    }
    if (saved) return jsonText(saved.body, 60);               // con error, se sirve la última copia buena
    return json(data || { errors: [msg], response: [] });
  }
  // Partido terminado: no cambiará, se guarda 30 días
  if (/[?&]id=\d+/.test(path) && data.response && data.response[0] && data.response[0].fixture &&
      ['FT', 'AET', 'PEN'].includes(data.response[0].fixture.status.short)) ttl = 30 * 86400;
  ctx.waitUntil(env.CACHE.put(key, JSON.stringify({ ts: Date.now(), ttl, body }), { expirationTtl: Math.max(ttl * 4, 2 * 86400) }));
  return jsonText(body, ttl);
}
function jsonText(body, maxAge) {
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=' + Math.min(maxAge, 300), 'access-control-allow-origin': '*' } });
}

async function cachedFetch(ctx, upstreamUrl, init, ttl) {
  const cache = caches.default;
  const key = new Request('https://cache.conquerortv/x/' + encodeURIComponent(upstreamUrl));
  const hit = await cache.match(key);
  if (hit) return withCors(hit);
  const res = await fetch(upstreamUrl, init);
  const body = await res.text();
  const out = new Response(body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'application/json', 'cache-control': `public, max-age=${ttl}` } });
  if (res.ok) ctx.waitUntil(cache.put(key, out.clone()));
  return withCors(out);
}

/* ---------------- Resúmenes SOLO de fuentes oficiales ---------------- */
// Lista cerrada de canales oficiales de YouTube por competición (por su @cuenta).
// verified:false = pendiente de confirmar.
const OFFICIAL_SOURCES = {
  140: [{ handle: '@LaLiga', label: 'LALIGA EA SPORTS', verified: true }],
  141: [{ handle: '@LaLiga', label: 'LALIGA EA SPORTS', verified: true }],
  39:  [{ handle: '@premierleague', label: 'Premier League', verified: true }],
  135: [{ handle: '@seriea', label: 'Serie A', verified: true }],
  78:  [{ handle: '@bundesliga', label: 'Bundesliga', verified: true }],
  61:  [{ handle: '@Ligue1', label: 'Ligue 1', verified: false }],
  nba: [{ handle: '@NBA', label: 'NBA', verified: true }],
  euroleague: [{ handle: '@EuroLeague', label: 'EuroLeague', verified: false }],
  acb: [{ handle: '@ACBvideo', label: 'Liga Endesa (ACB)', verified: false }],
  f1:  [{ handle: '@Formula1', label: 'Formula 1', verified: true }],
  motogp: [{ handle: '@MotoGP', label: 'MotoGP', verified: true }]
  // Champions, Europa y Conference: sin fuente oficial gratuita por ahora
};
const GOOD = /\b(resumen|resum|highlights?|todos los goles|all goals|goles del partido|sintesi|zusammenfassung|r[ée]sum[ée]|melhores momentos|samenvatting)\b/i;
const CLIP = /\b(gol de|goal by|golazo|el gol|the goal|parad[oó]n|save|skills?|jugada de|vlog|behind the scenes|inside|t[uú]nel|tunnel|celebraci[oó]n|celebration|afici[oó]n|fans?|mic'?d up|reacciones?|reaction|declaraciones|zona mixta|mixed zone|post-?partido|post-?match|tras el partido|after the match|analysis|an[aá]lisis|debate|opini[oó]n|previa|preview|rueda de prensa|press conference|entrevista|interview|top \d+|plays of|dunk|shorts?)\b/i;
const WOMEN = /\b(femenin[oa]|women|womens|wfc|wnba|fem|liga f)\b/i;
const YOUTH = /\b(sub-?\d{2}|u-?\d{2}|juvenil|youth|castilla|promesas|filial|reserves?|academy|g league)\b/i;
const norm = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const ALIASES = { 'manchester city': ['man city'], 'manchester united': ['man utd', 'man united'], 'tottenham': ['spurs'], 'wolverhampton': ['wolves'],
  'paris saint': ['psg'], 'barcelona': ['barca'], 'atletico de madrid': ['atleti'], 'atletico madrid': ['atleti'], 'internazionale': ['inter'],
  'borussia dortmund': ['dortmund', 'bvb'], 'philadelphia 76ers': ['76ers', 'sixers'], 'portland trail blazers': ['blazers'] };
const GENERIC = ['club','real','city','united','sporting','athletic','atletico','deportivo','fc','cf','ac','sc','ud','sd','rcd','olympique','basket','basketball','baloncesto','bc','cb','de','del','la','los','las','the'];
function teamIn(name, title) {
  const n = norm(name), t = norm(title);
  for (const k in ALIASES) if (n.includes(k) && ALIASES[k].some(a => t.includes(a))) return true;
  const w = n.split(/[^a-z0-9]+/).filter(x => x.length > 2 && !GENERIC.includes(x));
  if (!w.length) return t.includes(n);
  return w.some(x => new RegExp('\\b' + x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(t) || (x.length >= 6 && t.includes(x.slice(0, 5))));
}
const isoSec = d => { const m = String(d || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
async function yt(env, endpoint, params) {
  const r = await fetch('https://www.googleapis.com/youtube/v3/' + endpoint + '?' + new URLSearchParams({ ...params, key: env.YT_KEY || '' }));
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j;
}
// @cuenta → canal (se guarda 30 días en KV)
async function resolveHandle(env, ctx, handle) {
  const k = 'ytch:' + handle.toLowerCase();
  if (env.CACHE) { const c = await env.CACHE.get(k, 'json'); if (c) return c.ch; }
  const r = await yt(env, 'channels', { part: 'snippet,contentDetails', forHandle: handle });
  const it = (r.items || [])[0];
  const ch = it ? { id: it.id, title: it.snippet.title, uploads: it.contentDetails.relatedPlaylists.uploads } : null;
  if (env.CACHE) ctx.waitUntil(env.CACHE.put(k, JSON.stringify({ ch }), { expirationTtl: 30 * 86400 }));
  return ch;
}
// Últimas subidas de un canal (caché 15 min)
async function uploadsSince(env, ctx, ch, sinceMs) {
  const cache = caches.default;
  const key = new Request('https://cache.conquerortv/ytup/' + ch.id);
  const hit = await cache.match(key);
  if (hit) { const d = await hit.json(); if (d.oldest <= sinceMs) return d.items; }
  let items = [], token = '', pages = 0;
  while (pages < 8) {
    const r = await yt(env, 'playlistItems', { part: 'snippet,contentDetails', playlistId: ch.uploads, maxResults: '50', ...(token ? { pageToken: token } : {}) });
    const batch = (r.items || []).map(x => ({ videoId: x.contentDetails.videoId, title: x.snippet.title, published: x.contentDetails.videoPublishedAt || x.snippet.publishedAt }));
    items = items.concat(batch); pages++;
    const oldest = Math.min(...batch.map(b => new Date(b.published).getTime()));
    if (!r.nextPageToken || oldest < sinceMs) break;
    token = r.nextPageToken;
  }
  const oldest = items.length ? Math.min(...items.map(b => new Date(b.published).getTime())) : Date.now();
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify({ oldest, items }), { headers: { 'cache-control': 'public, max-age=900', 'content-type': 'application/json' } })));
  return items;
}
/* ev = { key, sourceKey, kind:'match'|'event', home, away, hg, ag, start, women, youth, eventWords:[], session:'race'|'sprint'|..., banned:[] } */
async function findOfficialHighlight(env, ctx, ev, region) {
  const sources = OFFICIAL_SOURCES[ev.sourceKey] || [];
  if (!sources.length) return { status: 'no-source', sources: [], candidates: [] };
  const banned = Array.isArray(ev.banned) ? ev.banned : [];
  const kvKey = 'hl:' + region + ':' + ev.key;
  // Encontrado antes (y no descartado por el usuario): se sirve directamente
  if (env.CACHE) {
    const saved = await env.CACHE.get(kvKey, 'json');
    if (saved && !banned.includes(saved.videoId)) return saved;
  }
  const t0 = new Date(ev.start).getTime(), until = t0 + 5 * 86400000;
  const srcInfo = [], found = [];
  for (const s of sources) {
    let ch = null;
    try { ch = await resolveHandle(env, ctx, s.handle); } catch (e) { srcInfo.push({ ...s, error: e.message }); continue; }
    if (!ch) { srcInfo.push({ ...s, error: 'cuenta no encontrada' }); continue; }
    srcInfo.push({ ...s, channelId: ch.id, channelTitle: ch.title });
    const ups = await uploadsSince(env, ctx, ch, t0);
    for (const u of ups) {
      const pt = new Date(u.published).getTime();
      if (pt < t0 || pt > until) continue;
      const why = [];
      if (banned.includes(u.videoId)) why.push('descartado manualmente');
      if (!GOOD.test(u.title)) why.push('no dice resumen/highlights');
      if (CLIP.test(u.title)) why.push('clip/otro contenido (' + u.title.match(CLIP)[0] + ')');
      if (!ev.women && WOMEN.test(u.title)) why.push('femenino');
      if (!ev.youth && YOUTH.test(u.title)) why.push('cantera/filial');
      if (ev.kind === 'match') {
        if (!teamIn(ev.home, u.title) || !teamIn(ev.away, u.title)) continue;
        if (ev.hg != null && ev.ag != null && /\b\d{1,3}\s*[-–:]\s*\d{1,3}\b/.test(u.title)) {
          const ok = new RegExp('\\b' + ev.hg + '\\s*[-–:]\\s*' + ev.ag + '\\b').test(u.title) || new RegExp('\\b' + ev.ag + '\\s*[-–:]\\s*' + ev.hg + '\\b').test(u.title);
          if (!ok) why.push('el título trae otro resultado');
        }
      } else {
        if (!(ev.eventWords || []).some(w => norm(u.title).includes(w))) continue;
        const sessionRe = {
          race: /^(?!.*sprint).*\brace\b/i, sprint: /\bsprint\b(?!.*(qualifying|shootout))/i, sprintq: /sprint (qualifying|shootout)/i,
          qualifying: /^(?!.*sprint).*qualifying/i, fp1: /\bfp1\b/i, fp2: /\bfp2\b/i, fp3: /\bfp3\b/i
        }[ev.session];
        if (sessionRe && !sessionRe.test(u.title)) why.push('es de otra sesión');
      }
      found.push({ ...u, channel: ch.title, why });
    }
  }
  const valid = found.filter(v => !v.why.length);
  if (valid.length) {
    const det = await yt(env, 'videos', { part: 'contentDetails,status,snippet', id: valid.slice(0, 50).map(v => v.videoId).join(',') });
    for (const d of det.items || []) {
      const v = valid.find(x => x.videoId === d.id); if (!v) continue;
      const rr = d.contentDetails.regionRestriction, sec = isoSec(d.contentDetails.duration);
      v.duration = d.contentDetails.duration; v.sec = sec;
      v.embeddable = d.status.embeddable && d.status.privacyStatus === 'public';
      if (rr && ((rr.allowed && !rr.allowed.includes(region)) || (rr.blocked || []).includes(region))) v.why.push('bloqueado en ' + region);
      if (d.snippet.liveBroadcastContent && d.snippet.liveBroadcastContent !== 'none') v.why.push('es un directo');
      if (d.contentDetails.contentRating && d.contentDetails.contentRating.ytRating === 'ytAgeRestricted') v.why.push('restringido por edad');
      if (sec && (sec < 45 || sec > (ev.kind === 'event' ? 40 : 25) * 60)) v.why.push('duración ' + Math.round(sec / 60) + ' min');
    }
  }
  const ok = found.filter(v => !v.why.length)
    .sort((a, b) => (b.embeddable ? 1 : 0) - (a.embeddable ? 1 : 0) || new Date(a.published) - new Date(b.published));
  const best = ok[0];
  const out = best
    ? { status: 'ok', videoId: best.videoId, title: best.title, channel: best.channel, embeddable: best.embeddable, duration: best.duration, published: best.published }
    : { status: 'pending' };
  out.sources = srcInfo;
  out.candidates = found.map(({ videoId, title, channel, why, sec }) => ({ videoId, title, channel, why, sec, chosen: !!best && best.videoId === videoId }));
  // Solo se guarda (en KV, compartido) cuando se encuentra: así se escriben pocas veces
  if (best && env.CACHE) ctx.waitUntil(env.CACHE.put(kvKey, JSON.stringify(out), { expirationTtl: 30 * 86400 }));
  return out;
}

/* ---------------- Utilidades ---------------- */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function withCors(res) {
  const r = new Response(res.body, res);
  r.headers.set('access-control-allow-origin', '*');
  return r;
}
