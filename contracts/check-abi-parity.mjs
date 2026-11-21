// Verifies the Solidity fallback engine exposes exactly the same external functions (same 4-byte
// selectors) as the Stylus engine's exported ABI. Run from the repo root:
//   node contracts/check-abi-parity.mjs
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const abiFile = readFileSync(path.join(here, "stylus", "abi", "IDryspellEngine.sol"), "utf8");

// function foo(uint256 a, address b) external view returns (...)  ->  foo(uint256,address)
const stylusSigs = [...abiFile.matchAll(/function\s+(\w+)\s*\(([^)]*)\)/g)].map(([, name, args]) => {
  const types = args
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => a.split(/\s+/)[0]); // drop memory/calldata/param names, keep the type token
  return `${name}(${types.join(",")})`;
});

const selector = (sig) => execFileSync("cast", ["sig", sig], { encoding: "utf8" }).trim();
const stylus = new Map(stylusSigs.map((s) => [selector(s), s]));

const inspected = execFileSync("forge", ["inspect", "DryspellEngineSol", "methodIdentifiers", "--json"], {
  cwd: path.join(here, "solidity"),
  encoding: "utf8",
});
const sol = new Map(Object.entries(JSON.parse(inspected)).map(([sig, sel]) => ["0x" + sel, sig]));

let bad = 0;
for (const [sel, sig] of stylus) {
  if (!sol.has(sel)) {
    console.log(`MISSING in Solidity engine: ${sig} (${sel})`);
    bad++;
  }
}
for (const [sel, sig] of sol) {
  if (!stylus.has(sel)) {
    console.log(`EXTRA in Solidity engine:   ${sig} (${sel})`);
    bad++;
  }
}
console.log(`${stylus.size} Stylus functions, ${sol.size} Solidity functions, ${bad} differences`);
process.exit(bad ? 1 : 0);
