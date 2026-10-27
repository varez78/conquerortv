# ConquerorTV

Resúmenes oficiales, resultados y directos deportivos. Web estática + servidor en **Cloudflare Workers**.

## Estructura
- `public/` — la web: `index.html` (portada) y `partido.html` (página de partido).
- `src/worker.js` — el servidor: intermediario con caché para las APIs de datos y búsqueda de resúmenes oficiales en YouTube.
- `wrangler.jsonc` — configuración de Cloudflare (memoria KV, tarea cada 10 min).

## Claves (secretos)
Se configuran en Cloudflare → *tu Worker → Settings → Variables and Secrets* (tipo **Secret**). Nunca en el código.

| Nombre | Para qué |
|---|---|
| `API_FOOTBALL_KEY` | API-Sports (fútbol, baloncesto, F1) |
| `FD_TOKEN` | football-data.org (resultados de la semana) |
| `YT_KEY` | YouTube Data API v3 (resúmenes oficiales) |

## Memoria compartida (KV)
Crea en Cloudflare *Storage & Databases → KV* un espacio llamado `CONQUEROR_CACHE` y pon su ID en `wrangler.jsonc`.

## Fuentes oficiales de resúmenes
Lista cerrada en `src/worker.js` (`OFFICIAL_SOURCES`). Si el resumen oficial no está publicado, la web no muestra ningún otro vídeo.
Revisión: abre una página de partido con `&debug=1`.

## Probar en local
```
npm install
cp .dev.vars.example .dev.vars   # y rellena las claves
npm run dev
```
