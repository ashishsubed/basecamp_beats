/**
 * Basecamp Beats — photo gallery Worker (paste into Cloudflare dashboard).
 *
 * Live (tonight):  halloween-2026/photos/live/
 * Past events:     {event}/photos/live/
 * Legacy Naya Saal photos that still sit at live/ are served only when
 * event=naya-saal-naya-nepal.
 *
 * Bindings: PHOTOS_BUCKET
 * Optional: IMAGES (Cloudflare Images) so ?w=480 / ?w=1600 actually resize
 * Vars: EVENT_ID
 * Secret: MODERATION_SECRET (DELETE)
 */

const DEFAULT_EVENT = "halloween-2026";
const LEGACY_LIVE_EVENT = "naya-saal-naya-nepal";

function resolveEvent(request, env) {
  const q = new URL(request.url).searchParams.get("event");
  const raw = String(q || env.EVENT_ID || DEFAULT_EVENT)
    .toLowerCase()
    .trim();
  return /^[a-z0-9-]{3,40}$/.test(raw) ? raw : DEFAULT_EVENT;
}

function prefixes(event) {
  return {
    event,
    pending: `${event}/photos/pending/`,
    live: `${event}/photos/live/`,
    photos: `${event}/photos/`,
  };
}

function listPrefixes(event) {
  const p = prefixes(event);
  const prefixesForEvent = [p.live, p.pending];
  if (event === LEGACY_LIVE_EVENT) prefixesForEvent.push("live/");
  return prefixesForEvent;
}

function keyAllowed(event, key) {
  const p = prefixes(event);
  if (key.startsWith(p.photos)) return true;
  if (event === LEGACY_LIVE_EVENT && (key.startsWith("live/") || key.startsWith("pending/"))) {
    return true;
  }
  return false;
}

async function listAll(bucket, prefix) {
  const objects = [];
  let cursor;
  do {
    const listed = await bucket.list({ prefix, limit: 1000, cursor });
    objects.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return objects;
}

function allowedOrigin(origin) {
  if (!origin) return "";
  try {
    const host = new URL(origin).hostname;
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith("basecampbeats.com") ||
      host.endsWith("github.io") ||
      host.endsWith("workers.dev")
    ) {
      return origin;
    }
  } catch (_) {}
  return "";
}

function cors(request) {
  const origin = allowedOrigin(request.headers.get("Origin") || "");
  const headers = {
    "Access-Control-Allow-Methods": "GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors(request),
      "Content-Type": "application/json",
    },
  });
}

function checkAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return auth.slice(7) === env.MODERATION_SECRET;
}

function imageUrl(key, event, w) {
  let path = `/image/${encodeURIComponent(key)}?event=${encodeURIComponent(event)}`;
  if (w) path += `&w=${w}`;
  return path;
}

function parseWidth(url) {
  const w = parseInt(url.searchParams.get("w") || "0", 10);
  if (!Number.isFinite(w) || w <= 0) return 0;
  return Math.min(2400, Math.max(120, w));
}

async function serveObject(request, env, obj) {
  const headers = new Headers(cors(request));
  headers.set("Cache-Control", "public, max-age=86400, immutable");
  const width = parseWidth(new URL(request.url));
  const type = obj.httpMetadata?.contentType || "image/jpeg";

  if (width && env.IMAGES && typeof env.IMAGES.input === "function") {
    try {
      const out = await env.IMAGES.input(obj.body)
        .transform({ width, fit: "scale-down" })
        .output({ format: "image/jpeg", quality: 78 });
      const res = out.response();
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors(request))) h.set(k, v);
      h.set("Cache-Control", "public, max-age=86400, immutable");
      return new Response(res.body, { status: 200, headers: h });
    } catch (_) {}
  }

  headers.set("Content-Type", type);
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const event = resolveEvent(request, env);

    if (path === "/images" && request.method === "GET") {
      const seen = new Set();
      const images = [];
      for (const prefix of listPrefixes(event)) {
        const objects = await listAll(env.PHOTOS_BUCKET, prefix);
        for (const o of objects) {
          if (seen.has(o.key)) continue;
          if (o.key.startsWith("halloween-2026/") && event !== "halloween-2026") continue;
          seen.add(o.key);
          images.push({
            key: o.key,
            url: imageUrl(o.key, event, 1600),
            thumbUrl: imageUrl(o.key, event, 480),
          });
        }
      }
      return json(request, { event, images });
    }

    if (path.startsWith("/image/")) {
      const key = decodeURIComponent(path.slice("/image/".length));
      if (!keyAllowed(event, key)) {
        return json(request, { error: "Not found" }, 404);
      }

      if (request.method === "GET") {
        const obj = await env.PHOTOS_BUCKET.get(key);
        if (!obj) return json(request, { error: "Not found" }, 404);
        return serveObject(request, env, obj);
      }

      if (request.method === "DELETE") {
        if (!checkAuth(request, env)) return json(request, { error: "Unauthorized" }, 401);
        await env.PHOTOS_BUCKET.delete(key);
        return json(request, { ok: true, event });
      }
    }

    return json(request, { error: "Not found" }, 404);
  },
};
