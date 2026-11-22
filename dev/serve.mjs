// Dev only: serves dist/ with dev/shim.js and the background in each page, so the wallet runs in a normal tab.
//   node dev/serve.mjs
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const PORT = Number(process.env.PORT ?? 3399);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".jpg": "image/jpeg", ".webp": "image/webp" };

/** /rings-devnet/* -> the local devnet server, which a plain tab can't reach without host permissions. */
async function proxy(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const target = `http://localhost:3101${req.url.slice("/rings-devnet".length)}`;
  // Forward every header but hop-level ones: the prover's Spr-Tee* headers carry its encryption metadata.
  // Cookies pass too; set-cookie is re-added as a list below.
  const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "content-encoding", "keep-alive", "origin", "referer", "set-cookie"]);
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k) && !k.startsWith("sec-")));
  try {
    const r = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    const out = {};
    r.headers.forEach((v, k) => {
      if (!HOP.has(k)) out[k] = v;
    });
    const cookies = r.headers.getSetCookie();
    res.writeHead(r.status, { ...out, ...(cookies.length ? { "set-cookie": cookies } : {}), "cache-control": "no-store" });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`devnet server unreachable: ${e.message}`);
  }
}

createServer((req, res) => {
  if ((req.url ?? "").startsWith("/rings-devnet/")) return void proxy(req, res);
  const path = decodeURIComponent((req.url ?? "/").split("?")[0].split("#")[0]);
  if (path === "/dev/shim.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(readFileSync(join(root, "dev/shim.js")));
  }
  const file = normalize(join(dist, path === "/" ? "popup.html" : path));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end("not found");
  }
  let body = readFileSync(file);
  if (file.endsWith(".html")) {
    body = Buffer.from(
      body.toString().replace('<script type="module"', '<script src="/dev/shim.js"></script><script type="module" src="/background.js"></script><script type="module"'),
    );
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(body);
}).listen(PORT, "127.0.0.1", () => console.log(`wallet dev harness on http://localhost:${PORT}/onboarding.html`));
