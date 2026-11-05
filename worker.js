// zerox.gg backend on Cloudflare Workers (replaces the old Netlify functions + Netlify Blobs).
//  - Worker: routing, CORS, cron trigger, serves the static site from /public
//  - Durable Object "Store" (SQLite): profiles, Discord links, uploaded files. One instance = no write races.
// The URL paths are kept (/.netlify/functions/db and /discord) so index.html needs no changes.
import { DurableObject } from "cloudflare:workers";
import { createHash, randomUUID } from "node:crypto";

const COLS = new Set(["profiles", "seen", "staff", "disc"]);
const MAX_DOC = 600 * 1024;
const CK = 3 * 1024 * 1024;          // upload / download chunk the page uses
const PC = 1024 * 1024;              // how pieces are stored (SQLite rows must stay < 2 MB)
const MAX_BIG = 1024 * 1024 * 1024;
const MAX_FILE = 4.5 * 1024 * 1024;
const OK_TYPES = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm|quicktime)|audio\/[\w.+-]+)$/;

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const sha = (s) => createHash("sha256").update(s).digest("hex");
const H = (s) => "h" + sha("o|" + s).slice(0, 24); // owner id -> public hash
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const visible = (d, me, admin) => d && !d.deleted && (d.pub !== false || admin || (me && d.owner === me));
const pubDoc = (c, d, me) => (c === "profiles" && d && d.owner && d.owner !== me ? { ...d, owner: H(d.owner) } : d);

const rangeOf = (req, total, cap = Infinity) => {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  const a = m[1] === "" ? Math.max(0, total - +m[2]) : +m[1], z = m[2] === "" || m[1] === "" ? total - 1 : Math.min(+m[2], total - 1);
  if (a >= total || a > z) return [-1, -1];
  return [a, Math.min(z, a + cap - 1)];
};
const part = (buf, type, [a, z], total) => new Response(buf, { status: 206, headers: { "content-type": type, "content-range": `bytes ${a}-${z}/${total}`, "content-length": String(z - a + 1), "accept-ranges": "bytes", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" } });
const bad416 = (total) => new Response(null, { status: 416, headers: { "content-range": "bytes */" + total } });

/* ---------------- Worker entry ---------------- */
const corsH = (req, env) => {
  const o = req.headers.get("origin") || "";
  const list = (env.ALLOWED_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean);
  const allow = !list.length ? (o || "*") : list.includes(o) ? o : "";
  return allow ? { "access-control-allow-origin": allow, "access-control-allow-headers": "content-type,x-me,x-admin,range", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-expose-headers": "content-range,accept-ranges,content-length", vary: "origin" } : {};
};
const stub = (env) => env.STORE.get(env.STORE.idFromName("main"));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!/^\/\.netlify\/functions\/(db|discord)$/.test(url.pathname)) return env.ASSETS.fetch(req);
    const h = corsH(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...h, "access-control-max-age": "86400" } });
    const headers = new Headers(req.headers);
    headers.set("x-client-ip", req.headers.get("cf-connecting-ip") || ""); // set here, never trusted from the client
    const res = await stub(env).fetch(new Request(req, { headers }));
    const out = new Response(res.body, res);
    for (const k of Object.keys(h)) out.headers.set(k, h[k]);
    return out;
  },
  async scheduled(_evt, env, ctx) { ctx.waitUntil(stub(env).sync()); },
};

/* ---------------- Durable Object ---------------- */
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS assets (id TEXT NOT NULL, i INTEGER NOT NULL, b BLOB NOT NULL, PRIMARY KEY (id, i))");
  }

  // --- tiny JSON store (all SQL calls are synchronous, so nothing can interleave inside one handler step) ---
  getJ(k) { const r = this.sql.exec("SELECT v FROM kv WHERE k=?", k).toArray()[0]; return r ? JSON.parse(r.v) : null; }
  setJ(k, v) { this.sql.exec("INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, JSON.stringify(v)); }
  delJ(k) { this.sql.exec("DELETE FROM kv WHERE k=?", k); }
  all(c) {
    const p = "col/" + c + "/", out = {};
    for (const r of this.sql.exec("SELECT k,v FROM kv WHERE substr(k,1,?)=? ORDER BY rowid", p.length, p)) out[r.k.slice(p.length)] = JSON.parse(r.v);
    return out;
  }
  doc(c, id) { return this.getJ("col/" + c + "/" + id); }
  put(c, id, v) { this.setJ("col/" + c + "/" + id, v); }
  rm(c, id) { this.delJ("col/" + c + "/" + id); }

  // --- files: stored as 1 MB pieces + a manifest ---
  putPieces(id, byteOff, buf) {
    const u = new Uint8Array(buf), base = byteOff / PC;
    for (let j = 0; j * PC < u.length; j++) this.sql.exec("INSERT OR REPLACE INTO assets (id,i,b) VALUES (?,?,?)", id, base + j, u.slice(j * PC, (j + 1) * PC));
  }
  readRange(id, a, z) { // bytes a..z inclusive, or null if a piece is missing
    const i0 = Math.floor(a / PC), i1 = Math.floor(z / PC);
    const rows = this.sql.exec("SELECT i,b FROM assets WHERE id=? AND i BETWEEN ? AND ? ORDER BY i", id, i0, i1).toArray();
    if (rows.length !== i1 - i0 + 1) return null;
    let n = 0; for (const r of rows) n += r.b.byteLength;
    const all = new Uint8Array(n); let o = 0;
    for (const r of rows) { all.set(new Uint8Array(r.b), o); o += r.b.byteLength; }
    return all.subarray(a - i0 * PC, z - i0 * PC + 1);
  }

  async fetch(req) {
    const p = new URL(req.url).pathname;
    return p.endsWith("/discord") ? this.discord(req) : this.db(req);
  }

  /* ======== db ======== */
  async db(req) {
    const url = new URL(req.url), E = this.env;
    const me = (req.headers.get("x-me") || "").slice(0, 64);
    const tok = E.ADMIN_TOKEN || "";
    const admin = !!tok && req.headers.get("x-admin") === tok;
    const ip = (req.headers.get("x-client-ip") || "").trim();
    const ipHash = (x) => sha((E.IP_SALT || "glitchbio") + "|" + x).slice(0, 40);

    if (req.method === "GET") {
      const id = url.searchParams.get("asset");
      if (!id || !/^[\w-]{8,64}$/.test(id)) return new Response("Not found", { status: 404 });
      const man = this.getJ("assetm/" + id);
      if (!man) return new Response("Not found", { status: 404 });
      const total = man.size, rg = rangeOf(req, total, CK);
      if (rg && rg[0] < 0) return bad416(total);
      const r = rg || (total <= MAX_FILE ? [0, total - 1] : [0, CK - 1]);
      const buf = this.readRange(id, r[0], r[1]);
      if (!buf) return new Response("Not found", { status: 404 });
      if (!rg && total <= MAX_FILE) return new Response(buf, { headers: { "content-type": man.type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
      return part(buf, man.type, r, total);
    }
    if (req.method !== "POST") return json({ error: "method" }, 405);

    const op0 = url.searchParams.get("op");
    // big file piece by piece; the last piece publishes it
    if (op0 === "chunk") {
      const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!me) return json({ error: "identity" }, 400);
      if (!OK_TYPES.test(type)) return json({ error: "type" }, 415);
      const cid = url.searchParams.get("id") || "", i = +url.searchParams.get("i"), n = +url.searchParams.get("n"), s = +url.searchParams.get("s");
      if (!/^[\w-]{8,64}$/.test(cid) || !(n >= 1 && n <= 342 && i >= 0 && i < n) || !(s > 0 && s <= MAX_BIG) || n !== Math.ceil(s / CK)) return json({ error: "chunk" }, 400);
      if (this.getJ("assetm/" + cid)) return json({ error: "exists" }, 409);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > CK || (i < n - 1 && buf.byteLength !== CK)) return json({ error: "size" }, 413);
      this.putPieces(cid, i * CK, buf);
      if (i === n - 1) this.setJ("assetm/" + cid, { type, size: s });
      return json(i === n - 1 ? { url: "/.netlify/functions/db?asset=" + cid } : { ok: true });
    }
    // small file in one request
    if (op0 === "upload") {
      const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!me) return json({ error: "identity" }, 400);
      if (!OK_TYPES.test(type)) return json({ error: "type" }, 415);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > MAX_FILE) return json({ error: "size" }, 413);
      const id = randomUUID();
      this.putPieces(id, 0, buf);
      this.setJ("assetm/" + id, { type, size: buf.byteLength });
      return json({ url: "/.netlify/functions/db?asset=" + id });
    }

    let b;
    try { b = await req.json(); } catch { return json({ error: "body" }, 400); }
    const { op, c, id } = b || {};
    if (op === "whoami") return json({ admin, configured: !!tok });
    if (op === "multi") {
      const out = {};
      for (const x of Array.isArray(b.cols) ? b.cols.slice(0, 4) : []) {
        if (!x || !COLS.has(x.c)) continue;
        const all = this.all(x.c);
        const lim = Math.min(Math.max(+x.limit || 200, 1), 1000);
        out[x.c] = Object.keys(all).filter((k) => visible(all[k], me, admin)).slice(0, lim).map((k) => ({
          id: x.c === "seen" ? H(k) : k,
          data: x.c === "seen" ? { c: all[k].c || {} } : pubDoc(x.c, all[k], me),
        }));
      }
      return json({ cols: out });
    }
    // download a file in pieces over the JSON API (what the page uses)
    if (op === "asset") {
      const aid = String(b.id || "");
      if (!/^[\w-]{8,64}$/.test(aid)) return json({ error: "id" }, 400);
      const man = this.getJ("assetm/" + aid);
      if (!man) return json({ error: "notfound" }, 404);
      const off = Math.max(0, +b.off || 0), len = Math.min(Math.max(+b.len || CK, 1), CK);
      if (off >= man.size) return json({ type: man.type, size: man.size, off, b64: "" });
      const buf = this.readRange(aid, off, Math.min(off + len, man.size) - 1);
      if (!buf) return json({ error: "notfound" }, 404);
      return json({ type: man.type, size: man.size, off, b64: b64(buf) });
    }

    if (!COLS.has(c)) return json({ error: "collection" }, 400);

    if (op === "list") {
      const all = this.all(c);
      const lim = Math.min(Math.max(+b.limit || 200, 1), 1000);
      return json({ docs: Object.keys(all).filter((k) => visible(all[k], me, admin)).slice(0, lim).map((k) => ({ id: k, data: pubDoc(c, all[k], me) })) });
    }

    if (!id || !/^[\w-]{1,64}$/.test(id)) return json({ error: "id" }, 400);

    if (op === "get") {
      const d = this.doc(c, id);
      if (c === "profiles" && d && d.pub === false && !d.deleted && !admin && d.owner !== me)
        return json({ exists: true, data: { user: id, owner: H(d.owner), saved: false, private: true } });
      return json({ exists: !!d, data: pubDoc(c, d, me) || null });
    }

    if (op === "set") {
      const data = b.data;
      if (!data || typeof data !== "object" || JSON.stringify(data).length > MAX_DOC) return json({ error: "data" }, 400);
      let ipKey = null, ipPrev = null;
      if (c === "profiles" && !admin) {
        if (!me || me.length < 16) return json({ error: "identity" }, 400);
        if (!ip) return json({ error: "ip_limit" }, 403);
        ipKey = ipHash(ip);
        ipPrev = this.doc("ips", ipKey);
        if (ipPrev && ipPrev.user !== id) {
          const old = this.doc("profiles", ipPrev.user);
          if (ipPrev.owner !== me || !old || old.deleted) return json({ error: "ip_limit" }, 403);
        }
        this.put("ips", ipKey, { user: id, owner: me, t: Date.now() });
      }
      const fail = (error, status) => {
        if (ipKey) { if (ipPrev) this.put("ips", ipKey, ipPrev); else this.rm("ips", ipKey); } // give the IP slot back
        return json({ error }, status);
      };
      const ex = this.doc(c, id);
      if ((c === "staff" || c === "disc") && !admin) return fail("forbidden", 403);
      if (c === "seen" && !admin && id !== me) return fail("forbidden", 403);
      if (c === "profiles" && !admin) {
        if (!/^[a-z0-9_]{2,20}$/.test(id)) return fail("id", 400);
        if (!me || data.owner !== me || data.user !== id) return fail("forbidden", 403);
        if (ex && ex.owner && ex.owner !== me) return fail("taken", 403);
      }
      this.put(c, id, data);
      if (c === "profiles" && !admin) {
        const f = this.getJ("dcme/" + H(me)); // badges the owner already earned (server-side flags only)
        if (f) this.put("disc", id, { m: f.m, s: f.s, d: f.d || "", t: f.t });
      }
      return json({ ok: true });
    }

    if (op === "delete") {
      const ex = this.doc(c, id);
      if (!ex) return json({ ok: true });
      if (!admin && (c !== "profiles" || !me || ex.owner !== me)) return json({ error: "forbidden" }, 403);
      if (c === "profiles" && !admin) this.put(c, id, { user: id, owner: ex.owner, saved: false, deleted: true, updated: Date.now() }); // name stays reserved
      else this.rm(c, id);
      return json({ ok: true });
    }
    return json({ error: "op" }, 400);
  }

  /* ======== Discord ======== */
  async memberFlags(discordId) {
    const E = this.env;
    if (!E.DISCORD_BOT_TOKEN || !E.DISCORD_GUILD_ID) return null;
    const r = await fetch("https://discord.com/api/v10/guilds/" + E.DISCORD_GUILD_ID + "/members/" + discordId, { headers: { authorization: "Bot " + E.DISCORD_BOT_TOKEN } });
    if (r.status === 404) {
      let j = null; try { j = await r.json(); } catch (e) { /* ignore */ }
      return j && j.code === 10007 ? { m: 0, s: 0, d: "", t: Date.now() } : null; // only "Unknown Member" means not in the server
    }
    if (!r.ok) return null;
    const m = await r.json();
    const want = new Set((E.DISCORD_STAFF_ROLE_IDS || "").split(",").map((x) => x.trim()).filter(Boolean));
    return { m: 1, s: (m.roles || []).some((x) => want.has(x)) ? 1 : 0, d: (m.user && m.user.avatar_decoration_data && m.user.avatar_decoration_data.asset) || "", t: Date.now() };
  }

  applyMany(items) {
    if (!items.length) return;
    for (const it of items) this.setJ("dcme/" + it.h, it.f);
    const profs = this.all("profiles"), byOwner = new Map(items.map((it) => [it.h, it.f]));
    for (const k of Object.keys(profs)) {
      const p = profs[k];
      if (p && p.owner && !p.deleted && byOwner.has(H(p.owner))) this.put("disc", k, byOwner.get(H(p.owner)));
    }
  }

  // cron (every 5 min): joined / left / staff role added / removed
  async sync() {
    if (!this.env.DISCORD_BOT_TOKEN) return { skipped: true };
    this.sql.exec("DELETE FROM kv WHERE substr(k,1,8)='dcstate/' AND json_extract(v,'$.t') < ?", Date.now() - 3600 * 1000);
    const links = this.all("dclinks"), ids = Object.keys(links), items = [];
    let i = 0;
    const worker = async () => {
      while (i < ids.length) {
        const did = ids[i++];
        try { const f = await this.memberFlags(did); if (f) items.push({ h: links[did], f }); } catch (e) { /* next run */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    this.applyMany(items);
    return { linked: ids.length, updated: items.length };
  }

  async discord(req) {
    const url = new URL(req.url), E = this.env;
    const op = url.searchParams.get("op");
    const cid = E.DISCORD_CLIENT_ID, sec = E.DISCORD_CLIENT_SECRET, gid = E.DISCORD_GUILD_ID;
    const redirect = E.DISCORD_REDIRECT_URI || url.origin + "/.netlify/functions/discord";
    const meOf = (r) => (r.headers.get("x-me") || "").slice(0, 64);
    let RET = "";
    const back = (r) => new Response(null, { status: 302, headers: { location: (RET || "/") + "?dc=" + r + "#/account/settings", "cache-control": "no-store" } });

    if (req.method === "POST" && op === "start") {
      if (!cid || !sec || !gid) return json({ error: "not_configured" }, 503);
      const me = meOf(req);
      if (me.length < 16) return json({ error: "identity" }, 400);
      const st = randomUUID();
      let ret = "";
      try {
        const body = await req.json();
        const origin = req.headers.get("origin") || "";
        const list = (E.ALLOWED_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean);
        const okOrigin = /^https?:\/\/[\w.-]+(:\d+)?$/.test(origin) && (!list.length || list.includes(origin));
        const base = typeof body.base === "string" && /^\/[\w\-./]*$/.test(body.base) ? body.base : "/";
        if (okOrigin && origin !== url.origin) ret = origin + (base.endsWith("/") ? base : base + "/");
      } catch (e) { /* stay on this site */ }
      this.setJ("dcstate/" + st, { me, t: Date.now(), ret });
      const q = new URLSearchParams({ client_id: cid, redirect_uri: redirect, response_type: "code", scope: "identify guilds.members.read", state: st });
      return json({ url: "https://discord.com/oauth2/authorize?" + q });
    }

    if (req.method === "POST" && op === "me") {
      const me = meOf(req);
      if (me.length < 16) return json({ error: "identity" }, 400);
      const mine = H(me), id = this.getJ("dcid/" + mine);
      if (!id) return json({ linked: false, configured: !!(cid && sec && gid) });
      const f = this.getJ("dcme/" + mine) || {};
      return json({ linked: true, n: id.n, u: id.u, i: id.i, a: id.a, d: f.d || id.d || "", m: f.m || 0, s: f.s || 0 });
    }

    if (req.method === "POST" && op === "unlink") {
      const me = meOf(req);
      if (me.length < 16) return json({ error: "identity" }, 400);
      const mine = H(me), links = this.all("dclinks");
      for (const k of Object.keys(links)) if (links[k] === mine) this.rm("dclinks", k);
      const profs = this.all("profiles");
      for (const k of Object.keys(profs)) if (profs[k] && profs[k].owner && H(profs[k].owner) === mine) this.rm("disc", k);
      this.delJ("dcme/" + mine); this.delJ("dcid/" + mine);
      return json({ ok: true });
    }

    if (req.method === "POST" && op === "recheck") {
      const me = meOf(req);
      if (me.length < 16) return json({ error: "identity" }, 400);
      if (!E.DISCORD_BOT_TOKEN) return json({ error: "no_bot" }, 503);
      const mine = H(me), links = this.all("dclinks");
      const did = Object.keys(links).find((k) => links[k] === mine);
      if (!did) return json({ error: "not_linked" }, 404);
      const f = await this.memberFlags(did);
      if (!f) return json({ error: "discord" }, 502);
      this.applyMany([{ h: mine, f }]);
      const idb = this.getJ("dcid/" + mine);
      if (idb) { idb.d = f.d || ""; this.setJ("dcid/" + mine, idb); }
      return json({ ok: true, m: f.m, s: f.s, d: f.d || "" });
    }

    // Discord sends the person back here after login
    if (req.method === "GET" && (op === "cb" || url.searchParams.has("code") || url.searchParams.has("error"))) {
      if (!cid || !sec || !gid) return back("err");
      if (url.searchParams.get("error")) return back("denied");
      const code = url.searchParams.get("code"), st = url.searchParams.get("state") || "";
      if (!code || !/^[\w-]{8,64}$/.test(st)) return back("err");
      const s = this.getJ("dcstate/" + st);
      this.delJ("dcstate/" + st);
      if (s && typeof s.ret === "string") RET = s.ret;
      if (!s || Date.now() - s.t > 10 * 60 * 1000) return back("expired");
      const mine = H(s.me);
      try {
        const tr = await fetch("https://discord.com/api/v10/oauth2/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: cid, client_secret: sec, grant_type: "authorization_code", code, redirect_uri: redirect }),
        });
        if (!tr.ok) return back("err");
        const auth = { authorization: "Bearer " + (await tr.json()).access_token };
        const ur = await fetch("https://discord.com/api/v10/users/@me", { headers: auth });
        if (!ur.ok) return back("err");
        const du = await ur.json();

        const links0 = this.all("dclinks");
        if (links0[du.id] && links0[du.id] !== mine) return back("used"); // one Discord account <-> one website owner

        let f = await this.memberFlags(du.id);
        if (!f) {
          const mr = await fetch("https://discord.com/api/v10/users/@me/guilds/" + gid + "/member", { headers: auth });
          if (mr.ok) {
            const m = await mr.json();
            const want = new Set((E.DISCORD_STAFF_ROLE_IDS || "").split(",").map((x) => x.trim()).filter(Boolean));
            f = { m: 1, s: (m.roles || []).some((r) => want.has(r)) ? 1 : 0, d: "", t: Date.now() };
          } else if (mr.status === 404) {
            let j = null; try { j = await mr.json(); } catch (e) { /* ignore */ }
            if (j && j.code === 10007) f = { m: 0, s: 0, d: "", t: Date.now() }; else return back("err");
          } else return back("err");
        }
        f.d = (du.avatar_decoration_data && du.avatar_decoration_data.asset) || "";
        for (const k of Object.keys(links0)) if (links0[k] === mine && k !== du.id) this.rm("dclinks", k);
        this.put("dclinks", du.id, mine);
        this.applyMany([{ h: mine, f }]);
        const av = du.avatar
          ? "https://cdn.discordapp.com/avatars/" + du.id + "/" + du.avatar + ".png?size=128"
          : "https://cdn.discordapp.com/embed/avatars/" + Number((BigInt(du.id) >> 22n) % 6n) + ".png";
        this.setJ("dcid/" + mine, { n: du.global_name || du.username, u: du.username, i: du.id, a: av, d: f.d || "" });
        return back(f.m ? "ok" : "nomember");
      } catch (e) {
        return back("err");
      }
    }
    return json({ error: "op" }, 400);
  }
}
