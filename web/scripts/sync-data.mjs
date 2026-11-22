// Copies the generated daily rainfall files next to the site so the browser can fetch them on demand.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../data/generated/daily");
const dst = path.resolve(here, "../public/data/daily");
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log("synced daily rainfall ->", path.relative(process.cwd(), dst));
