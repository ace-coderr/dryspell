// Old bookmarks such as /dryspell/ledger now reach 404.html on GitHub Pages; send them to the hash route.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const html = `<!doctype html><meta charset="utf-8"><title>Dryspell</title>
<script>
var base = "/dryspell/";
var p = location.pathname.indexOf(base) === 0 ? location.pathname.slice(base.length) : "";
location.replace(base + (p ? "#/" + p.replace(/\/$/, "") : ""));
</script>
<noscript><a href="/dryspell/">Dryspell</a></noscript>`;
writeFileSync(path.join(dist, "404.html"), html);
console.log("wrote dist/404.html (redirects old path URLs to the hash route)");
