// Super Predict · API compartida (Netlify Functions + Netlify Blobs)
// GET  /api            -> { state }
// POST /api { ops: [] } -> aplica los cambios sobre el estado del servidor y devuelve { state }
import { getStore } from "@netlify/blobs";

const MAX_PLAYERS = 20;
const bad = k => k === "__proto__" || k === "constructor" || k === "prototype";
const okId = s => typeof s === "string" && s.length > 0 && s.length <= 40 && !bad(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s) {
  s = s && typeof s === "object" ? s : {};
  return {
    players: Array.isArray(s.players) ? s.players : [],
    matches: Array.isArray(s.matches) ? s.matches : [],
    preds: s.preds && typeof s.preds === "object" ? s.preds : {},
  };
}

function apply(st, ops) {
  for (const o of ops) {
    if (!o || typeof o !== "object") continue;

    if (o.c === "players" || o.c === "matches") {
      if (!okId(o.id)) continue;
      const list = st[o.c];
      const i = list.findIndex(x => x.id === o.id);

      if (o.rm) {
        if (i >= 0) list.splice(i, 1);
        if (o.c === "players") {
          for (const m of Object.keys(st.preds)) {
            if (st.preds[m] && typeof st.preds[m] === "object") delete st.preds[m][o.id];
          }
        } else {
          delete st.preds[o.id];
        }
        continue;
      }

      const set = {};
      if (o.set && typeof o.set === "object") {
        for (const k of Object.keys(o.set)) if (!bad(k)) set[k] = o.set[k];
      }
      const del = Array.isArray(o.del) ? o.del.filter(k => typeof k === "string" && !bad(k)) : [];

      if (i < 0) {
        if (o.c === "players") {
          const name = String(set.name || "").trim();
          if (!name || name.length > 20) continue;
          if (list.length >= MAX_PLAYERS) continue;
          if (list.some(x => String(x.name).toLowerCase() === name.toLowerCase())) continue;
          set.name = name;
          if (set.team && list.some(x => x.team === set.team)) delete set.team;
        }
        list.push(Object.assign({ id: o.id }, set));
      } else {
        const cur = list[i];
        if (o.c === "players") {
          delete set.name; // el nombre no cambia
          if (set.pin && cur.pin) { delete set.pin; delete set.regAt; } // no se pisa un PIN ya registrado
          if (set.team && list.some(x => x.id !== o.id && x.team === set.team)) delete set.team;
        }
        Object.assign(cur, set);
        for (const k of del) if (k !== "id") delete cur[k];
      }
      continue;
    }

    if (o.c === "preds") {
      if (!okId(o.m) || !okId(o.p)) continue;
      if (o.v === null || o.v === undefined) {
        if (st.preds[o.m]) {
          delete st.preds[o.m][o.p];
          if (!Object.keys(st.preds[o.m]).length) delete st.preds[o.m];
        }
      } else if (o.v && typeof o.v === "object" && Number.isInteger(o.v.h) && Number.isInteger(o.v.a) && o.v.h >= 0 && o.v.a >= 0) {
        if (!st.matches.some(x => x.id === o.m)) continue;
        if (!st.preds[o.m]) st.preds[o.m] = {};
        if (!st.preds[o.m][o.p]) st.preds[o.m][o.p] = { h: o.v.h, a: o.v.a }; // un pronóstico no se cambia
      }
    }
  }
}

export default async (req) => {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  try {
    const store = getStore({ name: "super-predict", consistency: "strong" });

    if (req.method === "GET") {
      const cur = await store.get("state", { type: "json" });
      return json({ state: norm(cur) });
    }
    if (req.method !== "POST") return json({ error: "method" }, 405);

    const body = await req.json();
    const ops = Array.isArray(body && body.ops) ? body.ops.slice(0, 5000) : [];

    for (let i = 0; i < 10; i++) {
      const cur = await store.getWithMetadata("state", { type: "json" });
      const state = norm(cur && cur.data);
      apply(state, ops);
      const res = await store.setJSON("state", state, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
      if (!res || res.modified !== false) return json({ state });
      await sleep(40 + Math.random() * 160); // alguien guardó a la vez: reintentar
    }
    return json({ error: "busy" }, 503);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
};

export const config = { path: "/api" };
