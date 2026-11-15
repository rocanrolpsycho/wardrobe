// Wear history and availability (laundry) for wardrobe items.
// Stored locally in <WARDROBE_DATA_DIR>/usage.json, keyed by item id:
// { "<id>": { "wears": ["2026-11-15", ...], "status": "available" | "laundry" | "unavailable", "statusSince": "<ISO>" } }
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = "/api/usage";
const STATUSES = new Set(["available", "laundry", "unavailable"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ITEM_ID = /^[\w-]{1,120}$/;

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

function isRealDay(value) {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function entry(usage, id) {
  const current = usage[id] || {};
  return {
    wears: Array.isArray(current.wears) ? current.wears.filter(isRealDay) : [],
    status: STATUSES.has(current.status) ? current.status : "available",
    statusSince: current.statusSince || null,
  };
}

export function wardrobeUsageApi(options = {}) {
  let usageFile;
  let queue = Promise.resolve();
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;

  async function load() {
    try {
      const value = JSON.parse(await readFile(usageFile, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async function save(value) {
    const tmp = `${usageFile}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
    try { await rename(tmp, usageFile); }
    catch (error) { await rm(tmp, { force: true }); throw error; }
  }

  // Serialize writes so two quick clicks never overwrite each other.
  function mutate(change) {
    const run = queue.then(async () => {
      const usage = await load();
      const result = change(usage);
      await save(usage);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return next();
    try {
      if (url.pathname === ROOT && req.method === "GET") {
        const usage = await load();
        return json(res, 200, Object.fromEntries(Object.keys(usage).map((id) => [id, entry(usage, id)])));
      }

      if (url.pathname === `${ROOT}/laundry/done` && req.method === "POST") {
        const now = new Date().toISOString();
        const cleaned = await mutate((usage) => {
          const ids = [];
          for (const id of Object.keys(usage)) {
            const item = entry(usage, id);
            if (item.status !== "laundry") continue;
            usage[id] = { ...item, status: "available", statusSince: now };
            ids.push(id);
          }
          return ids;
        });
        return json(res, 200, { cleaned });
      }

      const match = url.pathname.match(/^\/api\/usage\/([^/]+)\/(wear|status)$/);
      if (!match || !ITEM_ID.test(match[1])) return json(res, 404, { error: "Not found" });
      const [, id, action] = match;
      const input = await body(req);

      if (action === "wear" && (req.method === "POST" || req.method === "DELETE")) {
        const day = input.date;
        if (!isRealDay(day)) return json(res, 400, { error: "Use a date like 2026-11-15" });
        const updated = await mutate((usage) => {
          const item = entry(usage, id);
          if (req.method === "POST") {
            item.wears = [...item.wears, day].sort();
            if (input.toLaundry) { item.status = "laundry"; item.statusSince = new Date().toISOString(); }
          } else {
            const index = item.wears.lastIndexOf(day);
            if (index !== -1) item.wears.splice(index, 1);
          }
          usage[id] = item;
          return item;
        });
        return json(res, 200, updated);
      }

      if (action === "status" && req.method === "PUT") {
        if (!STATUSES.has(input.status)) return json(res, 400, { error: "Unknown status" });
        const updated = await mutate((usage) => {
          const item = entry(usage, id);
          if (item.status !== input.status) { item.status = input.status; item.statusSince = new Date().toISOString(); }
          usage[id] = item;
          return item;
        });
        return json(res, 200, updated);
      }

      return json(res, 405, { error: "Method not allowed" });
    } catch (error) {
      return json(res, error.status || 500, { error: error.message || "Usage update failed" });
    }
  }

  return {
    name: "wardrobe-usage-api",
    async configResolved(config) {
      const dataDir = path.resolve(config.root, setting("WARDROBE_DATA_DIR", "data"));
      await mkdir(dataDir, { recursive: true });
      usageFile = path.join(dataDir, "usage.json");
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
