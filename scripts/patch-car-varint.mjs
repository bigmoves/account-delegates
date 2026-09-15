#!/usr/bin/env node
// Fix @atproto/car's varint import in the installed copy, so lexicon
// resolution works at all. Wired as part of this package's `postinstall`;
// also runnable by hand:
//
//   node scripts/patch-car-varint.mjs
//
// The spaces alpha moved CAR reading out of @atproto/common into a new
// @atproto/car, and the new package imports varint as a namespace:
//
//   import * as varint from 'varint'        // packages/car/src/lib/varint.ts
//
// varint@6 is CommonJS, and its `module.exports = { encode: require(…),
// decode: require(…), … }` defeats Node's cjs-module-lexer: the namespace ends
// up with `encode` but *not* `decode`. Encoding works, decoding throws
// "varint.decode is not a function" — and only under plain Node ESM, which is
// how a PDS runs. Bundlers (vitest, esbuild, tsx's own interop) synthesise the
// named exports, so upstream's tests pass.
//
// The blast radius is everything: @atproto/lex-resolver verifies a lexicon
// record's CAR proof, so every lexicon lookup fails, and a PDS answers every
// OAuth authorization carrying a space or permission-set scope with
// `invalid_scope` / "Unable to retrieve space declarations".
//
// Upstream fix is the same one line — a default import — so this can go once a
// spaces alpha ships with it.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BROKEN = "import * as varint from 'varint'";
const FIXED = "import varint from 'varint'";

const log = (m) => console.log(`[patch-car] ${m}`);

const pnpmDir = join(REPO, "node_modules", ".pnpm");
if (!existsSync(pnpmDir)) {
  log("node_modules/.pnpm not found — nothing to patch");
  process.exit(0);
}

let patched = 0;
let alreadyOk = 0;
for (const entry of readdirSync(pnpmDir)) {
  if (!entry.startsWith("@atproto+car@")) continue;
  const file = join(pnpmDir, entry, "node_modules", "@atproto", "car", "dist", "lib", "varint.js");
  if (!existsSync(file)) continue;
  const src = readFileSync(file, "utf8");
  if (!src.includes(BROKEN)) {
    alreadyOk++;
    continue;
  }
  // The installed file is hardlinked into pnpm's content store, so write a new
  // file rather than editing the one on disk — otherwise the store is patched
  // too, for every project on this machine.
  rmSync(file);
  writeFileSync(file, src.replace(BROKEN, FIXED));
  patched++;
  log(`patched ${entry}`);
}

if (patched) log(`✓ ${patched} @atproto/car cop${patched === 1 ? "y" : "ies"} patched`);
else if (alreadyOk) log("@atproto/car already imports varint correctly — nothing to do");
