#!/usr/bin/env node
// The browser flow, without the browser. Drives the app from `pnpm demo:app`
// the way a person would, but signs in and consents through the PDS's own
// consent-page API instead of clicking, so the whole thing can be checked in
// one go:
//
//   pnpm demo:app          # in one terminal
//   node scripts/walk.mjs  # in another
//
// It uses the provider UI's private endpoints (sign-in, consent), which is the
// one thing here that could change under us; the app itself is driven only
// through its pages and forms.
import http from "node:http";

const APP = process.env.APP_URL ?? "http://127.0.0.1:2704";
const API = "/@atproto/oauth-provider/~api";
const PASSWORDS = { "club.test": "club-pass", "alice.test": "alice-pass" };

let failures = 0;
const check = (what, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${what}${detail ? `  ${detail}` : ""}`);
};
const step = (t) => console.log(`\n${t}`);

// --- a cookie jar per origin ------------------------------------------------
const jar = new Map(); // origin → Map(name → value)
function remember(res, url) {
  const origin = new URL(url).origin;
  const m = jar.get(origin) ?? new Map();
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair, ...attrs] = line.split(";");
    const [name, ...rest] = pair.split("=");
    if (attrs.some((a) => /max-age=0/i.test(a))) m.delete(name.trim());
    else m.set(name.trim(), rest.join("="));
  }
  jar.set(origin, m);
}
const cookieHeader = (url) => Array.from(jar.get(new URL(url).origin) ?? []).map(([k, v]) => `${k}=${v}`).join("; ");
const csrf = (url) => (jar.get(new URL(url).origin) ?? new Map()).get("csrf-token");

// node:http rather than fetch: fetch sets its own sec-fetch-* headers, and the
// consent page checks them the way a browser would send them.
function go(url, init = {}) {
  const u = new URL(url);
  const body = init.body === undefined ? undefined : typeof init.body === "string" ? init.body : init.body.toString();
  const headers = { cookie: cookieHeader(url), ...(init.headers ?? {}) };
  if (body !== undefined) headers["content-length"] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const req = http.request(u, { method: init.method ?? "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const out = {
          status: res.statusCode,
          headers: { get: (k) => (Array.isArray(res.headers[k]) ? res.headers[k].join(", ") : res.headers[k]) ?? null, getSetCookie: () => res.headers["set-cookie"] ?? [] },
          text: async () => text,
          json: async () => JSON.parse(text),
        };
        remember(out, url);
        resolve(out);
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const browserNav = { "user-agent": "walk", accept: "text/html", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

/** Sign in and consent on the PDS's consent page, as the React app would. Returns the app URL the PDS sends the browser back to. */
async function consent(authorizeUrl, username) {
  const issuer = new URL(authorizeUrl).origin;
  const page = await go(authorizeUrl, { headers: browserNav });
  const html = await page.text();
  const m = html.match(/__authorizeData"\]=JSON\.parse\(("(?:[^"\\]|\\.)*")\)/);
  if (!m) throw new Error(`no authorize data on ${authorizeUrl}: ${page.status} ${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300)}`);
  const data = JSON.parse(JSON.parse(m[1]));
  const api = async (endpoint, body) => {
    const r = await go(`${issuer}${API}${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: issuer,
        referer: authorizeUrl,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "same-origin",
        "sec-fetch-dest": "empty",
        "x-csrf-token": csrf(issuer) ?? "",
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const signIn = await api("/sign-in", { locale: "en", username, password: PASSWORDS[username], remember: true });
  if (signIn.status !== 200) throw new Error(`sign-in ${username}: ${signIn.status} ${JSON.stringify(signIn.json)}`);
  const ok = await api("/consent", { did: signIn.json.account.sub ?? signIn.json.account.did });
  if (ok.status !== 200 || !ok.json.url) throw new Error(`consent: ${ok.status} ${JSON.stringify(ok.json)}`);
  // The consent page then navigates to /oauth/authorize/redirect, which sends the browser to the app.
  const back = await go(ok.json.url, { headers: { ...browserNav, "sec-fetch-site": "same-origin", referer: authorizeUrl } });
  const loc = back.headers.get("location");
  if (!loc) throw new Error(`redirect page: ${back.status} ${(await back.text()).slice(0, 200)}`);
  return { data, loc };
}

async function signInAt(door, who) {
  const start = await go(`${APP}/oauth/${door}/start`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ who }) });
  const authorizeUrl = start.headers.get("location");
  if (!authorizeUrl?.startsWith("http")) throw new Error(`start ${door} for ${who}: ${start.status} ${decodeURIComponent(authorizeUrl ?? "")}`);
  const { data, loc } = await consent(authorizeUrl, who);
  const cb = await go(loc);
  return { data, callbackTo: cb.headers.get("location"), status: cb.status };
}

const text = async (path) => (await go(`${APP}${path}`)).text();
const post = async (path, form) => {
  const r = await go(`${APP}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  return decodeURIComponent(r.headers.get("location") ?? "").replace(/\+/g, " ");
};
const strip = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// --- the walk -----------------------------------------------------------------

step("1. The club signs in to its settings tool with account:delegates.");
const club = await signInAt("club", "club.test");
check("consent page scope is the one permission", club.data.scope === "atproto account:delegates?action=manage", club.data.scope);
check("callback lands on /club", club.callbackTo === "/club", `${club.status} → ${club.callbackTo}`);
let html = await text("/club");
check("signed in, token carries account:delegates", /Signed in as/.test(html) && /account:delegates/.test(html));
check("no delegates yet", /No delegates/.test(html));
const aliceDid = html.match(/value="(did:plc:[a-z0-9]+)" placeholder="did:plc:…"/)?.[1];
check("the form offers alice's DID", !!aliceDid, aliceDid);

step("2. The club names alice, for one collection.");
let flash = await post("/club/delegates/put", { did: aliceDid, label: "alice, moderator", permissions: "repo:social.grain.group.item?action=create&action=delete" });
check("putDelegate through the page", /is a delegate/.test(flash), flash);
flash = await post("/club/delegates/put", { did: aliceDid, label: "x", permissions: "rpc:*?aud=*" });
check("an rpc: permission is refused", /InvalidPermission/.test(flash), flash);
html = await text("/club");
check("alice is listed with her permission", html.includes(aliceDid) && /social\.grain\.group\.item\?action=create&amp;action=delete/.test(html));

step("3. alice signs in to her app, with the permission set.");
const alice = await signInAt("set", "alice.test");
check("consent page resolved the permission set", alice.data.permissionSets?.["com.atproto.repo.delegatedWrites"]?.title === "Write to accounts that have made you a delegate", JSON.stringify(Object.keys(alice.data.permissionSets ?? {})));
check("callback lands on /alice", alice.callbackTo === "/alice");
html = await text("/alice");
{
  const scope = (strip(html).match(/token scope (.*?) Sign out/)?.[1] ?? "").replace(/&amp;/g, "&").trim();
  check("token scope is the set expanded to one rpc permission with aud=*", /(^|\s)rpc\?lxm=/.test(scope) && scope.includes("lxm=com.atproto.repo.createRecord") && /aud=\*/.test(scope) && !scope.includes("include:"), scope);
}
const clubDid = html.match(/name="as" value="(did:plc:[a-z0-9]+)"/)?.[1];
check("the page offers the club to act as", !!clubDid, clubDid);
check("and says the host listed her as a moderator", /moderator at the community host/.test(html));

step("4. alice accepts a gallery as the club, then tries to post as the club.");
await post("/alice/write", { as: clubDid, what: "accept" });
html = strip(await text("/alice"));
check("accept → committed as the club", /200 committed as the club: at:\/\/did:plc:[a-z0-9]+\/social\.grain\.group\.item\//.test(html), html.match(/200 committed[^ ]* [^ ]*/)?.[0]);
check("the URI is under the club's DID", html.includes(`at://${clubDid}/social.grain.group.item/`));
await post("/alice/write", { as: clubDid, what: "post" });
html = strip(await text("/alice"));
check("post → 403 DelegateScopeMissing", /403 DelegateScopeMissing/.test(html));

step("5. The club sees who wrote what, and removes alice.");
html = await text("/club");
check("the log names alice for createRecord", html.includes(aliceDid) && /createRecord/.test(html) && /social\.grain\.group\.item\/3/.test(html));
flash = await post("/club/delegates/remove", { did: aliceDid });
check("removeDelegate through the page", /Removed/.test(flash), flash);
await post("/alice/write", { as: clubDid, what: "accept" });
html = strip(await text("/alice"));
check("alice's next write → 403 NotDelegate", /403 NotDelegate/.test(html.split("What happened")[1] ?? ""));

step("6. The raw scope: same grant, generic consent screen.");
await post("/alice/sign-out", {});
const raw = await signInAt("raw", "alice.test");
check("consent page scope is the raw rpc permission, no permission set", raw.data.scope === "atproto rpc:com.atproto.repo.createRecord?aud=*" && Object.keys(raw.data.permissionSets ?? {}).length === 0, raw.data.scope);

step("7. The club's tool without the permission: a session that lacks account:delegates is refused.");
// Sign the club in through alice's raw door (an rpc: permission, no account:delegates) and hit the management method.
await post("/club/sign-out", {});
const wrong = await signInAt("raw", "club.test");
check("signed in through the wrong door", wrong.callbackTo === "/alice");
// That session is stored under the club's DID at the "raw" door; point the club page at it.
jar.get(APP).set("club", encodeURIComponent(wrong.data.loginHint ? clubDid : clubDid));
jar.get(APP).set("club_door", "raw");
html = strip(await text("/club"));
check("getDelegateConfig → 403 ScopeMissing", /403 ScopeMissing/.test(html), html.match(/getDelegateConfig[^<]{0,80}/)?.[0]);

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
