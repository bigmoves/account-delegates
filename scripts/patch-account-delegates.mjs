#!/usr/bin/env node
// Teach the installed OAuth packages the one scope attribute proposal 0017
// introduces, `account:delegates`, so that the browser demo can show it on the
// real consent screen. Wired as part of this package's `postinstall`; also
// runnable by hand:
//
//   node scripts/patch-account-delegates.mjs
//
// Two edits, both in files the demo would otherwise leave untouched:
//
// 1. @atproto/oauth-scopes (server side): add `delegates` to the list of
//    account attributes the parser accepts. Without this the provider's PAR
//    endpoint silently drops `account:delegates` from the requested scope
//    (unknown scopes are filtered, not refused), so it never reaches the token
//    and nothing can be gated on it.
//
// 2. @atproto/oauth-provider-ui (the consent screen): the same attribute list
//    is inlined into the scope-description chunk, and the account section only
//    knows how to render the `status` attribute. Extend the list and add one
//    card next to the status card. The chunk's hash in bundle-manifest.json is
//    only used as an ETag, so it does not need updating, but the chunk is
//    served as immutable: hard-refresh a browser that has seen it before.
//
// Neither edit changes behaviour for scopes that exist today.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const log = (m) => console.log(`[patch-delegates] ${m}`);

const pnpmDir = join(REPO, "node_modules", ".pnpm");
if (!existsSync(pnpmDir)) {
  log("node_modules/.pnpm not found — nothing to patch");
  process.exit(0);
}
const entries = readdirSync(pnpmDir);
const findPkg = (prefix) => entries.filter((e) => e.startsWith(prefix));

// --- 1. the server-side scope vocabulary -------------------------------------
for (const dir of findPkg("@atproto+oauth-scopes@")) {
  const file = join(pnpmDir, dir, "node_modules", "@atproto", "oauth-scopes", "dist", "scopes", "account-permission.js");
  if (!existsSync(file)) continue;
  const src = readFileSync(file, "utf8");
  if (src.includes("'delegates'")) {
    log(`${dir}: already patched`);
    continue;
  }
  const re = /(ACCOUNT_ATTRIBUTES = Object\.freeze\(\[)([^\]]*)(\])/;
  if (!re.test(src)) {
    log(`${dir}: ACCOUNT_ATTRIBUTES not found; skipping`);
    continue;
  }
  writeFileSync(file, src.replace(re, (_, a, list, c) => `${a}${list.trimEnd()}\n    'delegates',\n${c}`));
  log(`${dir}: account attributes += delegates`);
}

// --- 2. the consent screen ----------------------------------------------------
for (const dir of findPkg("@atproto+oauth-provider-ui@")) {
  const dist = join(pnpmDir, dir, "node_modules", "@atproto", "oauth-provider-ui", "dist");
  if (!existsSync(dist)) continue;
  const chunk = readdirSync(dist).find((f) => /^scope-description-.*\.js$/.test(f));
  if (!chunk) {
    log(`${dir}: scope-description chunk not found; skipping`);
    continue;
  }
  const file = join(dist, chunk);
  let src = readFileSync(file, "utf8");
  if (src.includes("`delegates`")) {
    log(`${dir}: already patched`);
    continue;
  }
  const attrs = "Object.freeze([`email`,`repo`,`status`])";
  if (!src.includes(attrs)) {
    log(`${dir}: attribute list not found in ${chunk}; skipping`);
    continue;
  }
  src = src.replace(attrs, "Object.freeze([`email`,`repo`,`status`,`delegates`])");

  // The account section is one function that renders the `status` card or
  // nothing. Wrap it: the original keeps its name's job under a new name, and
  // the new function renders the original plus the delegates card.
  const head = "function si({permissions:e}){";
  const at = src.indexOf(head);
  if (at === -1) {
    log(`${dir}: account card function not found in ${chunk}; skipping`);
    continue;
  }
  // The bundle's jsx runtime is `f`, DescriptionCard is `Q`, the users icon is `te`;
  // all are in scope where the original function is defined.
  const wrapper =
    "function si({permissions:e}){return[(0,f.jsx)(si0,{permissions:e},`status`),(0,f.jsx)(si1,{permissions:e},`delegates`)]}" +
    "function si1({permissions:e}){return e.allowsAccount({attr:`delegates`,action:`manage`})?(0,f.jsx)(Q,{role:`listitem`,image:(0,f.jsx)(te,{className:`size-6`}),title:`Delegates`,description:`Manage who may write as your account, and see what they wrote`}):null}" +
    "function si0({permissions:e}){";
  src = src.slice(0, at) + wrapper + src.slice(at + head.length);
  writeFileSync(file, src);
  log(`${dir}: ${chunk}: attributes += delegates, and a Delegates card`);
}
