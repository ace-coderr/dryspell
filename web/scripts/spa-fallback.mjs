// GitHub Pages serves 404.html for unknown paths. Copying index.html there makes deep links
// (/dryspell/ledger, refreshes) boot the single-page app instead of a dead 404.
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
copyFileSync(path.join(dist, "index.html"), path.join(dist, "404.html"));
console.log("wrote dist/404.html");
