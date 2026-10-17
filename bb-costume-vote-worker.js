/**
 * Basecamp Beats — costume contest Worker (paste into Cloudflare dashboard).
 *
 * Bindings:
 *   PHOTOS_BUCKET  → R2  objects: {event}/costumes/...
 *   COSTUME_VOTES  → KV  keys: {event}:entries | {event}:tally | {event}:vote:{visitorId}
 *
 * Vars: EVENT_ID (halloween-2026)
 * Secret: MODERATION_SECRET
 *
 * Public:
 *   GET  /entries
 *   GET  /image/:key
 *   GET  /results
 *   GET  /me            requires X-Visitor-Id (FingerprintJS)
 *   POST /vote          { key }  requires X-Visitor-Id
 *
 * Staff (Authorization: Bearer MODERATION_SECRET):
 *   POST   /entries     multipart: file, name
 *   DELETE /entries     JSON { key }
 *   POST   /admin/reset-votes
 *
 * Anti-cheat: FingerprintJS visitorId (same in incognito). Not IP (venue NAT).
 */

const DEFAULT_EVENT = "halloween-2026";

function resolveEvent(request, env) {
  const q = new URL(request.url).searchParams.get("event");
  const raw = String(q || env.EVENT_ID || DEFAULT_EVENT)
    .toLowerCase()
    .trim();
  return /^[a-z0-9-]{3,40}$/.test(raw) ? raw : DEFAULT_EVENT;
}

function eventKeys(event) {
  return {
    event,
    entries: `${event}:entries`,
    tally: `${event}:tally`,
    vote: (id) => `${event}:vote:${id}`,
    costumePrefix: `${event}/costumes/`,
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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Visitor-Id, X-Voter-Id",
    "Access-Control-Allow-Credentials": "true",
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
  const expected = env.MODERATION_SECRET;
  if (!expected) return false;
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return auth.slice(7) === expected;
}

function visitorIdFrom(request) {
  const header = (
    request.headers.get("X-Visitor-Id") ||
    request.headers.get("X-Voter-Id") ||
    ""
  ).trim();
  if (/^[a-zA-Z0-9_-]{8,80}$/.test(header)) return header;
  return "";
}

async function loadEntries(env, k) {
  const raw = await env.COSTUME_VOTES.get(k.entries);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveEntries(env, k, entries) {
  await env.COSTUME_VOTES.put(k.entries, JSON.stringify(entries));
}

async function loadTally(env, k) {
  const raw = await env.COSTUME_VOTES.get(k.tally);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveTally(env, k, tally) {
  await env.COSTUME_VOTES.put(k.tally, JSON.stringify(tally));
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
    const k = eventKeys(resolveEvent(request, env));

    if (path.startsWith("/image/") && request.method === "GET") {
      const key = decodeURIComponent(path.slice("/image/".length));
      if (!key.startsWith(k.costumePrefix)) {
        return new Response("Not found", { status: 404, headers: cors(request) });
      }
      const obj = await env.PHOTOS_BUCKET.get(key);
      if (!obj) {
        return new Response("Not found", { status: 404, headers: cors(request) });
      }
      return serveObject(request, env, obj);
    }

    if (path === "/entries" && request.method === "GET") {
      const entries = await loadEntries(env, k);
      return json(request, {
        event: k.event,
        entries: entries.map((e) => ({
          key: e.key,
          name: e.name || "Costume",
          url: imageUrl(e.key, k.event, 900),
          thumbUrl: imageUrl(e.key, k.event, 480),
        })),
      });
    }

    if (path === "/results" && request.method === "GET") {
      const entries = await loadEntries(env, k);
      const tally = await loadTally(env, k);
      const ranked = entries
        .map((e) => ({
          key: e.key,
          name: e.name || "Costume",
          url: imageUrl(e.key, k.event, 900),
          thumbUrl: imageUrl(e.key, k.event, 480),
          votes: Number(tally[e.key] || 0),
        }))
        .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
      const totalVotes = ranked.reduce((s, e) => s + e.votes, 0);
      return json(request, { event: k.event, entries: ranked, totalVotes });
    }

    if (path === "/vote" && request.method === "POST") {
      const id = visitorIdFrom(request);
      if (!id) return json(request, { error: "Missing browser fingerprint." }, 400);
      let body = {};
      try {
        body = await request.json();
      } catch {
        return json(request, { error: "Invalid JSON" }, 400);
      }
      const key = String(body.key || "");
      const entries = await loadEntries(env, k);
      if (!entries.some((e) => e.key === key) || !key.startsWith(k.costumePrefix)) {
        return json(request, { error: "Unknown costume" }, 404);
      }

      const voteKey = k.vote(id);
      const previous = await env.COSTUME_VOTES.get(voteKey);
      if (previous === key) {
        return json(request, {
          ok: true,
          votedFor: key,
          already: true,
          message: "You already voted for this look.",
        });
      }

      const tally = await loadTally(env, k);
      if (previous && tally[previous] > 0) {
        tally[previous] = Number(tally[previous]) - 1;
      }
      tally[key] = Number(tally[key] || 0) + 1;
      await saveTally(env, k, tally);
      await env.COSTUME_VOTES.put(voteKey, key);

      return json(request, {
        ok: true,
        votedFor: key,
        switched: Boolean(previous),
        message: previous ? "Vote moved to this look." : "Vote counted.",
      });
    }

    if (path === "/me" && request.method === "GET") {
      const id = visitorIdFrom(request);
      if (!id) return json(request, { error: "Missing browser fingerprint." }, 400);
      const votedFor = await env.COSTUME_VOTES.get(k.vote(id));
      return json(request, {
        event: k.event,
        voterId: id,
        votedFor: votedFor || null,
      });
    }

    if (path === "/entries" && request.method === "POST") {
      if (!checkAuth(request, env)) return json(request, { error: "Unauthorized" }, 401);
      const form = await request.formData();
      const file = form.get("file");
      const name = String(form.get("name") || "Costume").slice(0, 60);
      if (!file || typeof file === "string") {
        return json(request, { error: "No file" }, 400);
      }
      if (file.size > 10 * 1024 * 1024) {
        return json(request, { error: "File too large (max 10MB)" }, 400);
      }
      const safeName = (file.name || "look.jpg").replace(/[^\w.\-]+/g, "_");
      const key = `${k.costumePrefix}${Date.now()}-${safeName}`;
      await env.PHOTOS_BUCKET.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || "image/jpeg" },
      });
      const entries = await loadEntries(env, k);
      entries.push({ key, name, uploaded: Date.now() });
      await saveEntries(env, k, entries);
      return json(request, { ok: true, event: k.event, key, name, url: imageUrl(key, k.event) });
    }

    if (path === "/entries" && request.method === "DELETE") {
      if (!checkAuth(request, env)) return json(request, { error: "Unauthorized" }, 401);
      let body = {};
      try {
        body = await request.json();
      } catch {
        return json(request, { error: "Invalid JSON" }, 400);
      }
      const key = String(body.key || "");
      if (!key.startsWith(k.costumePrefix)) {
        return json(request, { error: "Invalid key" }, 400);
      }
      await env.PHOTOS_BUCKET.delete(key);
      const entries = (await loadEntries(env, k)).filter((e) => e.key !== key);
      await saveEntries(env, k, entries);
      const tally = await loadTally(env, k);
      delete tally[key];
      await saveTally(env, k, tally);
      return json(request, { ok: true });
    }

    if (path === "/admin" && request.method === "GET") {
      if (!env.MODERATION_SECRET) {
        return json(request, { error: "Set MODERATION_SECRET on bb-costume-vote" }, 503);
      }
      if (!checkAuth(request, env)) return json(request, { error: "Unauthorized" }, 401);
      return json(request, { ok: true, event: k.event });
    }

    if (path === "/admin/reset-votes" && request.method === "POST") {
      if (!checkAuth(request, env)) return json(request, { error: "Unauthorized" }, 401);
      await saveTally(env, k, {});
      const list = await env.COSTUME_VOTES.list({ prefix: `${k.event}:vote:` });
      for (const item of list.keys) {
        await env.COSTUME_VOTES.delete(item.name);
      }
      return json(request, { ok: true, event: k.event });
    }

    return json(request, { error: "Not found" }, 404);
  },
};
