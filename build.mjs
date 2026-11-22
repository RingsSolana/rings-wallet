// Builds the extension into dist/, or with --release the mainnet-only store build into release/.
//   node build.mjs [--watch | --release]
import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { linkShared } from "./scripts/link-shared.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");
const release = process.argv.includes("--release");
if (watch && release) throw new Error("--watch is for development builds only.");
const dist = join(root, release ? "release" : "dist");

// @noble imports from web/src/core resolve to the wallet's copy, so the bundle holds one. Packages keep their own:
// the Privacy Rings SDK needs @noble 2.x.
const oneNoble = {
  name: "one-copy-of-noble",
  setup(b) {
    const own = (dir) => dir.toLowerCase().startsWith(root.toLowerCase());
    const inPackage = (dir) => /[\\/]node_modules[\\/]/.test(dir);
    b.onResolve({ filter: /^@noble\/(curves|hashes)(\/.*)?$/ }, (args) =>
      own(args.resolveDir) || inPackage(args.resolveDir) ? undefined : b.resolve(args.path, { kind: args.kind, resolveDir: root }),
    );
  },
};

const common = {
  bundle: true,
  platform: "browser",
  target: ["chrome116"],
  format: "esm",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  jsx: "automatic",
  logLevel: "warning",
  legalComments: "none",
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production"), __RELEASE__: JSON.stringify(release) },
  external: ["/fonts/*", "/design/*"],
  plugins: [oneNoble],
};

linkShared();
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const f of ["popup.html", "onboarding.html", "approve.html"]) cpSync(join(root, f), join(dist, f));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (release) {
  // The store assigns its own extension id: add it to RINGS_WALLET_EXTENSION_IDS on the server.
  delete manifest.key;
  manifest.host_permissions = manifest.host_permissions.filter((h) => !/localhost|devnet|api\.mainnet-beta\.solana\.com/.test(h));
  // https pages only: plain http can be tampered with in transit, and loopback pages are for development.
  for (const cs of manifest.content_scripts) cs.matches = ["https://*/*"];
}
writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(root, "public"), dist, { recursive: true });
await icons();

const builds = [
  { ...common, entryPoints: { background: join(root, "src/background.ts") }, outdir: dist },
  { ...common, entryPoints: { popup: join(root, "src/ui/popup.tsx"), onboarding: join(root, "src/ui/onboarding.tsx"), approve: join(root, "src/ui/approve.tsx") }, outdir: dist },
  // Content scripts are classic scripts: one file each, no imports at run time.
  { ...common, format: "iife", entryPoints: { content: join(root, "src/provider/content.ts") }, outdir: dist },
  {
    ...common,
    format: "iife",
    entryPoints: { inject: join(root, "src/provider/inject.ts") },
    outdir: dist,
    // Wallet Standard icon, inlined: keep it small, this script is injected into every page.
    define: { ...common.define, __RINGS_ICON__: JSON.stringify(`data:image/png;base64,${readFileSync(join(dist, "icons/128.png")).toString("base64")}`) },
  },
];
if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
  console.log("watching for changes…");
} else {
  const inputs = new Set();
  for (const options of builds) {
    const r = await esbuild.build({ ...options, metafile: true });
    for (const k of Object.keys(r.metafile.inputs)) inputs.add(k);
  }
  if (release) releaseChecks(inputs);
  console.log(`built ${dist}`);
}

/** Store build: no devnet or local endpoints, packages at their lockfile versions; writes the notices and release.json. */
function releaseChecks(inputs) {
  const files = readdirSync(dist, { recursive: true }).map(String).filter((f) => statSync(join(dist, f)).isFile());
  for (const f of files.filter((f) => f.endsWith(".js"))) {
    const code = readFileSync(join(dist, f), "utf8");
    for (const bad of ["localhost:3100", "localhost:3101", "solana:devnet", "api.devnet.solana.com"]) {
      if (code.includes(bad)) throw new Error(`release/${f} still holds "${bad}": the store build must be mainnet only.`);
    }
  }
  // The packages the bundle took code from, by their folder under node_modules.
  const pkgs = new Map();
  for (const input of inputs) {
    const m = /^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)/.exec(input.replace(/\\/g, "/"));
    if (!m) continue;
    const folder = join(root, m[1]);
    const real = existsSync(folder) ? folder : m[1];
    if (!existsSync(join(real, "package.json"))) continue;
    const pj = JSON.parse(readFileSync(join(real, "package.json"), "utf8"));
    const license = typeof pj.license === "string" ? pj.license : (pj.license?.type ?? (pj.licenses ?? []).map((l) => l.type ?? l).join(" OR "));
    const author = (typeof pj.author === "string" ? pj.author : (pj.author?.name ?? "")).replace(/\s*[<(].*$/, "").trim();
    const repo = (typeof pj.repository === "string" ? pj.repository : (pj.repository?.url ?? "")).replace(/^git\+/, "").replace(/\.git$/, "");
    pkgs.set(`${pj.name}@${pj.version}`, { name: pj.name, version: pj.version, license, author, repo, folder: real, path: m[1] });
  }
  const locks = {
    web: JSON.parse(readFileSync(join(root, "../web/package-lock.json"), "utf8")).packages ?? {},
    wallet: JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages ?? {},
  };
  for (const p of pkgs.values()) {
    const rel = p.path.replace(/^(\.\.\/)*(web\/)?/, "");
    const lock = (p.path.includes("web/node_modules") ? locks.web : locks.wallet)[rel.slice(rel.indexOf("node_modules"))];
    if (!lock) throw new Error(`${p.name}@${p.version} is bundled but not in a lockfile.`);
    if (lock.version !== p.version) throw new Error(`${p.name} is ${p.version} on disk but ${lock.version} in its lockfile: reinstall (npm ci) before a store build.`);
  }
  writeFileSync(join(dist, "THIRD_PARTY_NOTICES.txt"), thirdPartyNotices(pkgs));
  const sha = (f) => createHash("sha256").update(readFileSync(join(dist, f))).digest("hex");
  const all = readdirSync(dist, { recursive: true }).map(String).filter((f) => statSync(join(dist, f)).isFile()).sort();
  writeFileSync(
    join(root, "release.json"),
    `${JSON.stringify({ version: manifest.version, packages: [...pkgs.keys()].sort(), files: Object.fromEntries(all.map((f) => [f.replace(/\\/g, "/"), sha(f)])) }, null, 2)}\n`,
  );
}

/** THIRD_PARTY_NOTICES.txt: bundled packages, then notedSoftware(), then each named license's text from licenses/. */
function thirdPartyNotices(pkgs) {
  const entries = [...pkgs.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ title: `${p.name} ${p.version}`, license: p.license, text: packageNotice(p) }));
  const noted = notedSoftware();
  const hasher = [...pkgs.values()].find((p) => p.name === noted.wasm.package);
  if (hasher && hasher.version !== noted.wasm.version) {
    throw new Error(`${hasher.name} is ${hasher.version}, but the Rust code listed in build.mjs was read from ${noted.wasm.version}: read its WebAssembly again and update notedSoftware().`);
  }
  if (hasher) {
    for (const c of noted.wasm.crates) {
      entries.push({ title: `${c.name} ${c.version}`, license: c.license, text: `Rust code compiled into the WebAssembly of ${hasher.name}. Source: ${c.source}\n\n${c.notice}` });
    }
  }
  const fonts = existsSync(join(dist, "fonts")) ? readdirSync(join(dist, "fonts")) : [];
  for (const f of fonts) {
    if (!noted.fonts.some((font) => font.files.includes(f))) throw new Error(`release/fonts/${f} has no notice: add its copyright and license to notedSoftware() in build.mjs.`);
  }
  for (const font of noted.fonts.filter((x) => x.files.some((f) => fonts.includes(f)))) {
    entries.push({
      title: `${font.name} ${font.version}`,
      license: font.license,
      text: `${font.files.length > 1 ? "Font files" : "Font file"} ${font.files.map((f) => `fonts/${f}`).join(", ")}. Source: ${font.source}\n\n${font.notice}\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1. The license is copied at the end of this file, and is also available with a FAQ at https://openfontlicense.org`,
    });
  }
  // Every license an SPDX expression names (MIT OR Apache-2.0 names two), each copied once.
  const named = new Set();
  for (const e of entries) {
    if (/^SEE LICEN[CS]E IN /i.test(e.license)) continue;
    for (const id of e.license.replace(/[()]/g, " ").split(/\s+(?:OR|AND)\s+|\//i)) if (id.trim()) named.add(id.replace(/\s+WITH\s+.*$/i, "").trim());
  }
  const texts = [...named].sort((a, b) => a.localeCompare(b)).map((id) => {
    const file = join(root, "licenses", `${id}.txt`);
    if (!existsSync(file)) throw new Error(`The notices name the ${id} license but licenses/${id}.txt is missing: add its full text (SPDX license list or the license's steward).`);
    return `${id}\n\n${clean(readFileSync(file, "utf8"))}`;
  });
  const rule = `\n\n${"-".repeat(78)}\n\n`;
  const intro =
    "Rings Wallet includes the following open-source software: the packages bundled into its scripts, the Rust code compiled into the WebAssembly one of them carries, and its fonts. Each entry keeps the copyright and license notice that software ships with. One full copy of every license named follows at the end of this file.";
  const all = [intro, ...entries.map((e) => `${e.title} (${e.license || "see its license"})\n\n${e.text}`)].join(rule);
  const textsIntro =
    "One copy of each license named above, as the SPDX License List, apache.org or SIL publish it. The placeholders in a text stand for the copyright notice in each entry above.";
  return `${all}\n\n${"=".repeat(78)}\nLicense texts\n${"=".repeat(78)}\n\n${textsIntro}${rule}${texts.join(rule)}\n`;
}

function packageNotice(p) {
  const files = [];
  for (const dir of [p.folder, join(p.folder, "dist")]) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).sort()) {
      if (/^(licen[sc]e|copying|notice)/i.test(f) && !/\.([cm]?js|ts|json|map)$/i.test(f) && statSync(join(dir, f)).isFile()) files.push(join(dir, f));
    }
  }
  const texts = [...new Set(files.map((f) => clean(readFileSync(f, "utf8"))))].filter(Boolean);
  if (texts.length) return texts.join("\n\n");
  const readme = readdirSync(p.folder).find((f) => /^readme(\.(md|markdown|txt))?$/i.test(f));
  const section = readme ? readmeLicense(readFileSync(join(p.folder, readme), "utf8")) : "";
  if (section) return `From the License section of its README:\n\n${section}`;
  if (!p.license) throw new Error(`${p.name}@${p.version} ships no license text and its package.json names no license: check it before a store upload.`);
  return `${p.license}, as its package.json declares. The package ships no license or copyright text of its own and ${p.author ? `names ${p.author} as its author` : "names no author"}.${p.repo ? ` Source: ${p.repo}` : ""}`;
}

function readmeLicense(md) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const level = (i) => {
    const atx = /^(#{1,6})\s/.exec(lines[i]);
    if (atx) return atx[1].length;
    return lines[i].trim() && /^(=+|-+)\s*$/.test(lines[i + 1] ?? "") ? (lines[i + 1][0] === "=" ? 1 : 2) : 0;
  };
  const start = lines.findIndex((l, i) => level(i) > 0 && /^licen[sc](e|ing)\b/i.test(l.replace(/^#+\s*/, "").replace(/^[*_]+/, "")));
  if (start < 0) return "";
  const body = [];
  for (let i = start + (lines[start].startsWith("#") ? 1 : 2); i < lines.length; i++) {
    const l = level(i);
    if (l && l <= level(start)) break;
    body.push(lines[i]);
  }
  // Trim trailing blank lines and Markdown link definitions ([0]: <url>).
  while (body.length && (!body.at(-1).trim() || /^\s*\[[^\]]+\]:\s*\S/.test(body.at(-1)))) body.pop();
  return clean(body.join("\n"));
}

/** Unix line ends, no trailing spaces, no blank lines around the text. */
function clean(text) {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/^\n+/, "").trimEnd();
}

/** Hand-kept: the Rust crates inside hasher.rs's WebAssembly, and the fonts. Recheck when either changes. */
function notedSoftware() {
  const rustToolchain = "From the Rust 1.83.0 toolchain that built the WebAssembly.";
  return {
    wasm: {
      package: "@lightprotocol/hasher.rs",
      version: "0.2.1",
      crates: [
        { name: "ark-ff", version: "0.4.2", license: "MIT OR Apache-2.0", source: "https://github.com/arkworks-rs/algebra", notice: "Copyright 2022 arkworks contributors" },
        { name: "blake2b_simd", version: "1.0.2", license: "MIT", source: "https://github.com/oconnor663/blake2_simd", notice: "Copyright (c) 2018 Jack O'Connor" },
        {
          name: "light-poseidon",
          version: "0.2.0",
          license: "Apache-2.0",
          source: "https://github.com/Lightprotocol/light-poseidon",
          notice: "Author: Mike Rostecki (its Cargo.toml). The crate ships no license file; its repository's LICENSE is the Apache License 2.0 with no copyright line filled in.",
        },
        { name: "num-bigint", version: "0.4.6", license: "MIT OR Apache-2.0", source: "https://github.com/rust-num/num-bigint", notice: "Copyright (c) 2014 The Rust Project Developers" },
        { name: "wasm-bindgen", version: "0.2.99", license: "MIT OR Apache-2.0", source: "https://github.com/rustwasm/wasm-bindgen", notice: "Copyright (c) 2014 Alex Crichton" },
        { name: "js-sys", version: "0.3.76", license: "MIT OR Apache-2.0", source: "https://github.com/rustwasm/wasm-bindgen/tree/master/crates/js-sys", notice: "Copyright (c) 2014 Alex Crichton" },
        {
          name: "Rust standard library (core, alloc, std)",
          version: "1.83.0",
          license: "MIT OR Apache-2.0",
          source: "https://github.com/rust-lang/rust",
          notice: `${rustToolchain}\n\nCopyrights in the Rust project are retained by their contributors (authorship: https://thanks.rust-lang.org). Except as otherwise noted, Rust is licensed under the Apache License, Version 2.0 or the MIT license, at your option.`,
        },
        {
          name: "compiler_builtins",
          version: "0.1.133",
          license: "MIT",
          source: "https://github.com/rust-lang/compiler-builtins",
          notice: `${rustToolchain} Dual licensed under the University of Illinois "BSD-Like" license and the MIT license, at the user's choice (its LICENSE.txt); used here under the MIT license:\n\nCopyright (c) 2009-2015 by the contributors listed in CREDITS.TXT\n\nIts log2 function (libm, ported to Rust from musl and FreeBSD's msun) carries this notice:\n\nCopyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.\n\nDeveloped at SunSoft, a Sun Microsystems, Inc. business.\nPermission to use, copy, modify, and distribute this\nsoftware is freely granted, provided that this notice\nis preserved.`,
        },
        {
          name: "dlmalloc",
          version: "0.2.6",
          license: "MIT OR Apache-2.0",
          source: "https://github.com/alexcrichton/dlmalloc-rs",
          notice: `${rustToolchain} The standard library's memory allocator on WebAssembly.\n\nCopyright (c) 2014 Alex Crichton\n\nA port of Doug Lea's malloc, which Doug Lea released to the public domain, as explained at http://creativecommons.org/publicdomain/zero/1.0/`,
        },
      ],
    },
    fonts: [
      {
        name: "Archivo",
        version: "2.001",
        license: "OFL-1.1",
        files: ["archivo-var-latin.woff2"],
        source: "https://github.com/Omnibus-Type/Archivo",
        notice: "Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)",
      },
      {
        name: "IBM Plex Mono",
        version: "2.3",
        license: "OFL-1.1",
        files: ["plex-mono-400-latin.woff2", "plex-mono-500-latin.woff2"],
        source: "https://github.com/IBM/plex",
        notice: 'Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"',
      },
    ],
  };
}

async function icons() {
  const sharp = createRequire(join(root, "../web/package.json"))("sharp");
  const svg = join(root, "../web/public/rings-mark.svg");
  mkdirSync(join(dist, "icons"), { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await sharp(svg, { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(join(dist, `icons/${size}.png`));
  }
}
