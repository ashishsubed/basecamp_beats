/**
 * Basecamp Beats — guest photo upload Worker (paste into Cloudflare dashboard).
 *
 * Guest photos for this night live under {event}/photos/… so they never mix
 * with previous events in the same R2 bucket.
 *
 * Bindings:
 *   PHOTOS_BUCKET     → R2
 *   PHOTO_RATE_LIMIT  → KV (optional; skips rate limit if unbound)
 *
 * Vars:
 *   EVENT_ID — default event slug (halloween-2026). Overridable with ?event=
 *
 * Secret:
 *   MODERATION_SECRET
 *
 * Public:
 *   POST /upload   multipart file → {event}/photos/live/ (shows on slideshow immediately)
 *
 * Staff (Authorization: Bearer MODERATION_SECRET):
 *   GET  /pending
 *   POST /approve  JSON { key }  pending → live
 */

const DEFAULT_EVENT = "halloween-2026";
const MAX_BYTES = 10 * 1024 * 1024;
const RATE_WINDOW_SEC = 600;
const RATE_MAX = 5;

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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Expose-Headers": "Retry-After",
    Vary: "Origin",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(request, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors(request),
      "Content-Type": "application/json",
      ...extra,
    },
  });
}

function checkAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return auth.slice(7) === env.MODERATION_SECRET;
}

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

async function rateLimit(env, event, ip) {
  if (!env.PHOTO_RATE_LIMIT) return { ok: true };
  const key = `${event}:rl:${ip}`;
  const raw = await env.PHOTO_RATE_LIMIT.get(key);
  let hits = 0;
  try {
    hits = raw ? Number(JSON.parse(raw).hits) || 0 : 0;
  } catch {
    hits = 0;
  }
  if (hits >= RATE_MAX) {
    return { ok: false, retryAfter: RATE_WINDOW_SEC };
  }
  await env.PHOTO_RATE_LIMIT.put(key, JSON.stringify({ hits: hits + 1 }), {
    expirationTtl: RATE_WINDOW_SEC,
  });
  return { ok: true };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const p = prefixes(resolveEvent(request, env));

    if (path === "/upload" && request.method === "POST") {
      const gated = await rateLimit(env, p.event, clientIp(request));
      if (!gated.ok) {
        return json(
          request,
          {
            error: "Slow down — too many uploads from this phone.",
            retryAfterSeconds: gated.retryAfter,
          },
          429,
          { "Retry-After": String(gated.retryAfter) }
        );
      }

      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") {
        return json(request, { error: "No file" }, 400);
      }
      if (file.size > MAX_BYTES) {
        return json(request, { error: "File too large (max 10MB)" }, 400);
      }
      const type = file.type || "image/jpeg";
      if (!String(type).startsWith("image/")) {
        return json(request, { error: "Please upload an image." }, 400);
      }
      const safeName = (file.name || "photo.jpg").replace(/[^\w.\-]+/g, "_");
      const key = `${p.live}${Date.now()}-${safeName}`;
      await env.PHOTOS_BUCKET.put(key, file.stream(), {
        httpMetadata: { contentType: type },
      });
      return json(request, {
        ok: true,
        event: p.event,
        key,
        status: "live",
        message: "It’s on the live slideshow.",
      });
    }

    if (path === "/pending" && request.method === "GET") {
      if (!checkAuth(request, env)) return json(request, { error: "Unauthorized" }, 401);
      const listed = await env.PHOTOS_BUCKET.list({ prefix: p.pending, limit: 1000 });
      return json(request, {
        event: p.event,
        keys: listed.objects.map((o) => o.key),
      });
    }

    if (path === "/approve" && request.method === "POST") {
      if (!checkAuth(request, env)) return json(request, { error: "Unauthorized" }, 401);
      let body = {};
      try {
        body = await request.json();
      } catch {
        return json(request, { error: "Invalid JSON" }, 400);
      }
      const key = String(body.key || "");
      if (!key.startsWith(p.pending)) {
        return json(request, { error: "Invalid key for this event" }, 400);
      }
      const obj = await env.PHOTOS_BUCKET.get(key);
      if (!obj) return json(request, { error: "Not found" }, 404);
      const liveKey = p.live + key.slice(p.pending.length);
      await env.PHOTOS_BUCKET.put(liveKey, obj.body, {
        httpMetadata: obj.httpMetadata,
      });
      await env.PHOTOS_BUCKET.delete(key);
      return json(request, { ok: true, event: p.event, key: liveKey });
    }

    return json(request, { error: "Not found" }, 404);
  },
};
