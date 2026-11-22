// Points node_modules/<SHARED> at web/node_modules: the shared core needs one copy (the SDK checks its own classes).
//   node scripts/link-shared.mjs   (build.mjs and npm test run it; npm install may remove the links)
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SHARED = ["@heliuslabs/spr", "@solana/kit"];

export function linkShared() {
  for (const pkg of SHARED) {
    const target = join(root, "../web/node_modules", pkg);
    const link = join(root, "node_modules", pkg);
    if (!existsSync(target)) throw new Error(`${pkg} is missing from web/node_modules: run npm install in web/`);
    // A link pointing anywhere else could load other code: keep it only if it resolves to web/node_modules.
    if (existsSync(link) && lstatSync(link).isSymbolicLink() && realpathSync(link).toLowerCase() === realpathSync(target).toLowerCase()) continue;
    if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) rmSync(link, { recursive: true, force: true });
    mkdirSync(dirname(link), { recursive: true });
    // Junctions need no admin rights on Windows.
    symlinkSync(target, link, "junction");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  linkShared();
  console.log("linked:", SHARED.join(", "));
}
