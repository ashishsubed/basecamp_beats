/**
 * Basecamp Beats — costume contest Worker (paste into Cloudflare dashboard).
 *
 * Bindings:
 *   PHOTOS_BUCKET  → R2
 *     {event}/costumes/{ts}-{file}   look photo, customMetadata.name = title
 *     {event}/votes/{visitorId}.json one object per phone, customMetadata.picks = JSON array
 *   COSTUME_VOTES  → KV (optional; only read for look titles uploaded before R2 metadata)
 *
 * Every phone writes only its own vote object and every look is its own R2 object,
 * so simultaneous votes and uploads never overwrite each other. Totals are counted
 * from the vote objects on each /results request.
 *
 * Vars: EVENT_ID (halloween-2026)
 * Secret: MODERATION_SECRET
 *
 * Public:
 *   GET  /entries
 *   GET  /image/:key
 *   GET  /results
 *   GET  /me            requires X-Visitor-Id (FingerprintJS)
 *   POST /vote          { key }  requires X-Visitor-Id — toggles a pick; up to MAX_VOTES distinct looks
 *
 * Staff (Authorization: Bearer MODERATION_SECRET):
 *   GET    /admin
 *   POST   /entries     multipart: file, name
 *   DELETE /entries     JSON { key }
 *   POST   /admin/reset-votes
 *
 * Anti-cheat: FingerprintJS visitorId (same in incognito). Not IP (venue NAT).
 */

const DEFAULT_EVENT = "halloween-2026";
const MAX_VOTES = 3;

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
    legacyEntries: `${event}:entries`,
    costumePrefix: `${event}/costumes/`,
    votePrefix: `${event}/votes/`,
    voteObject: (id) => `${event}/votes/${id}.json`,
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
      "Cache-Control": "no-store",
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

async function listAll(bucket, prefix) {
  const objects = [];
  let cursor;
  do {
    const listed = await bucket.list({ prefix, limit: 1000, cursor, include: ["customMetadata"] });
    objects.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return objects;
}

async function legacyNames(env, k) {
  if (!env.COSTUME_VOTES) return {};
  try {
    const raw = await env.COSTUME_VOTES.get(k.legacyEntries);
    const list = raw ? JSON.parse(raw) : [];
    return Object.fromEntries((Array.isArray(list) ? list : []).map((e) => [e.key, e.name]));
  } catch {
    return {};
  }
}

async function loadEntries(env, k) {
  const [objects, names] = await Promise.all([
    listAll(env.PHOTOS_BUCKET, k.costumePrefix),
    legacyNames(env, k),
  ]);
  return objects
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((o) => ({
      key: o.key,
      name: o.customMetadata?.name || names[o.key] || "Costume",
    }));
}

function cleanPicks(picks, liveKeys) {
  if (!Array.isArray(picks)) return [];
  return [...new Set(picks.map(String))].filter((key) => liveKeys.has(key)).slice(0, MAX_VOTES);
}

async function loadPicks(env, k, id, liveKeys) {
  const obj = await env.PHOTOS_BUCKET.get(k.voteObject(id));
  if (!obj) return [];
  try {
    return cleanPicks(await obj.json(), liveKeys);
  } catch {
    return [];
  }
}

async function countVotes(env, k, liveKeys) {
  const tally = {};
  const objects = await listAll(env.PHOTOS_BUCKET, k.votePrefix);
  for (const o of objects) {
    let picks = [];
    try {
      picks = JSON.parse(o.customMetadata?.picks || "[]");
    } catch {}
    for (const key of cleanPicks(picks, liveKeys)) {
      tally[key] = (tally[key] || 0) + 1;
    }
  }
  return tally;
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

function publicEntry(e, event) {
  return {
    key: e.key,
    name: e.name,
    url: imageUrl(e.key, event, 900),
    thumbUrl: imageUrl(e.key, event, 480),
  };
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
        entries: entries.map((e) => publicEntry(e, k.event)),
      });
    }

    if (path === "/results" && request.method === "GET") {
      const entries = await loadEntries(env, k);
      const tally = await countVotes(env, k, new Set(entries.map((e) => e.key)));
      const ranked = entries
        .map((e, order) => ({ ...publicEntry(e, k.event), votes: tally[e.key] || 0, order }))
        .sort((a, b) => b.votes - a.votes || a.order - b.order);
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
      const liveKeys = new Set(entries.map((e) => e.key));
      if (!liveKeys.has(key)) {
        return json(request, { error: "Unknown costume" }, 404);
      }

      const picks = await loadPicks(env, k, id, liveKeys);
      const removing = picks.includes(key);

      if (!removing && picks.length >= MAX_VOTES) {
        return json(request, {
          error: `You've used all ${MAX_VOTES} votes. Tap one of your picks to free a vote.`,
          votes: picks,
          votesLeft: 0,
          maxVotes: MAX_VOTES,
        }, 409);
      }

      const next = removing ? picks.filter((p) => p !== key) : [...picks, key];
      if (next.length) {
        const value = JSON.stringify(next);
        await env.PHOTOS_BUCKET.put(k.voteObject(id), value, {
          httpMetadata: { contentType: "application/json" },
          customMetadata: { picks: value },
        });
      } else {
        await env.PHOTOS_BUCKET.delete(k.voteObject(id));
      }

      const left = MAX_VOTES - next.length;
      return json(request, {
        ok: true,
        votes: next,
        votesLeft: left,
        maxVotes: MAX_VOTES,
        removed: removing,
        message: removing
          ? `Vote removed. ${left} left.`
          : left
            ? `Vote counted. ${left} left.`
            : "Vote counted. That was your last one.",
      });
    }

    if (path === "/me" && request.method === "GET") {
      const id = visitorIdFrom(request);
      if (!id) return json(request, { error: "Missing browser fingerprint." }, 400);
      const entries = await loadEntries(env, k);
      const picks = await loadPicks(env, k, id, new Set(entries.map((e) => e.key)));
      return json(request, {
        event: k.event,
        voterId: id,
        votes: picks,
        votesLeft: MAX_VOTES - picks.length,
        maxVotes: MAX_VOTES,
      });
    }

    if (path === "/entries" && request.method === "POST") {
      if (!checkAuth(request, env)) return json(request, { error: "Unauthorized" }, 401);
      const form = await request.formData();
      const file = form.get("file");
      const name = String(form.get("name") || "Costume").trim().slice(0, 60) || "Costume";
      if (!file || typeof file === "string") {
        return json(request, { error: "No file" }, 400);
      }
      if (file.size > 10 * 1024 * 1024) {
        return json(request, { error: "File too large (max 10MB)" }, 400);
      }
      const safeName = (file.name || "look.jpg").replace(/[^\w.\-]+/g, "_");
      const key = `${k.costumePrefix}${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`;
      await env.PHOTOS_BUCKET.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || "image/jpeg" },
        customMetadata: { name },
      });
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
      const objects = await listAll(env.PHOTOS_BUCKET, k.votePrefix);
      for (let i = 0; i < objects.length; i += 1000) {
        await env.PHOTOS_BUCKET.delete(objects.slice(i, i + 1000).map((o) => o.key));
      }
      return json(request, { ok: true, event: k.event, cleared: objects.length });
    }

    return json(request, { error: "Not found" }, 404);
  },
};
