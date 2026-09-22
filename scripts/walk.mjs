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

/** Open the PDS's authorize page and read what the React app would render from. A redirect (automatic SSO) is returned as `redirect`. */
async function authorizePage(authorizeUrl) {
  const page = await go(authorizeUrl, { headers: browserNav });
  const redirect = page.headers.get("location");
  if (redirect) return { data: null, redirect };
  const html = await page.text();
  const m = html.match(/__authorizeData"\]=JSON\.parse\(("(?:[^"\\]|\\.)*")\)/);
  if (!m) throw new Error(`no authorize data on ${authorizeUrl}: ${page.status} ${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300)}`);
  const s = html.match(/__sessions"\]=JSON\.parse\(("(?:[^"\\]|\\.)*")\)/);
  const data = JSON.parse(JSON.parse(m[1]));
  // The accounts already signed in on this device, as the page lists them.
  data.sessions = s ? JSON.parse(JSON.parse(s[1])) : [];
  return { data, redirect: null };
}

/** The consent page's own JSON API, with the headers a browser would send from that page. */
async function providerApi(authorizeUrl, endpoint, body) {
  const issuer = new URL(authorizeUrl).origin;
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
}

/** Accept the request for `did` (already signed in on this device) and follow the PDS back to the app. */
async function accept(authorizeUrl, did) {
  const ok = await providerApi(authorizeUrl, "/consent", { did });
  if (ok.status !== 200 || !ok.json.url) throw new Error(`consent: ${ok.status} ${JSON.stringify(ok.json)}`);
  // The consent page then navigates to /oauth/authorize/redirect, which sends the browser to the app.
  const back = await go(ok.json.url, { headers: { ...browserNav, "sec-fetch-site": "same-origin", referer: authorizeUrl } });
  const loc = back.headers.get("location");
  if (!loc) throw new Error(`redirect page: ${back.status} ${(await back.text()).slice(0, 200)}`);
  return loc;
}

/** Sign in and consent on the PDS's consent page, as the React app would. Returns the app URL the PDS sends the browser back to. */
async function consent(authorizeUrl, username) {
  const { data } = await authorizePage(authorizeUrl);
  const signIn = await providerApi(authorizeUrl, "/sign-in", { locale: "en", username, password: PASSWORDS[username], remember: true });
  if (signIn.status !== 200) throw new Error(`sign-in ${username}: ${signIn.status} ${JSON.stringify(signIn.json)}`);
  const loc = await accept(authorizeUrl, signIn.json.account.sub ?? signIn.json.account.did);
  return { data, loc };
}

/** Pick an account the consent page already lists as signed in, and consent. */
async function chooseSession(authorizeUrl, did) {
  const { data, redirect } = await authorizePage(authorizeUrl);
  if (redirect) return { data, loc: redirect };
  return { data, loc: await accept(authorizeUrl, did) };
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

// --- sign-in as the account -----------------------------------------------------

const form = { "content-type": "application/x-www-form-urlencoded" };
const STOCK_SCOPE = "atproto repo:social.grain.group.item repo:app.bsky.feed.post?action=create blob:image/*";

step("8. Sign-in as the club: a stock client, with alice authenticating at her own PDS.");
await post("/club/sign-out", {});
await post("/stock/sign-out", {});
const clubAgain = await signInAt("club", "club.test");
check("the club's tool is back (its own password)", clubAgain.callbackTo === "/club");
flash = await post("/club/delegates/put", { did: aliceDid, label: "alice, moderator", permissions: "repo:social.grain.group.item?action=create&action=delete" });
check("alice is a delegate again", /is a delegate/.test(flash), flash);
const start = await go(`${APP}/oauth/stock/start`, { method: "POST", headers: form, body: new URLSearchParams({ who: "club.test", as_delegate: "1" }) });
const delegatePage = start.headers.get("location") ?? "";
check("the app sends the browser to the club's PDS, to its sign-in-as page", /\/oauth\/delegate\?/.test(delegatePage), delegatePage.slice(0, 80));
const pdsA = new URL(delegatePage).origin;
const returnTo = new URL(delegatePage).searchParams.get("return_to");
check("with the authorize URL to come back to", returnTo?.startsWith(`${pdsA}/oauth/authorize?`), returnTo?.slice(0, 60));
const dp = await go(delegatePage, { headers: browserNav });
check("the page names the account to sign in as", dp.status === 200 && /club\.test/.test(await dp.text()));
const sub = await go(`${pdsA}/oauth/delegate`, { method: "POST", headers: form, body: new URLSearchParams({ account: "club.test", handle: "alice.test", return_to: returnTo }) });
const nested = sub.headers.get("location") ?? "";
check("alice is sent to her own PDS to authenticate", nested.startsWith("http") && new URL(nested).origin !== pdsA, nested.slice(0, 60));
const nestedLogin = await consent(nested, "alice.test");
check("her PDS is asked for atproto only", nestedLogin.data.scope === "atproto", nestedLogin.data.scope);
check("by the club's PDS acting as a client, asking for nothing more", /^http:\/\/localhost\?/.test(nestedLogin.data.clientId ?? "") && /scope=atproto(&|$)/.test(nestedLogin.data.clientId ?? ""), nestedLogin.data.clientId);
const cb = await go(nestedLogin.loc);
const finishUrl = cb.headers.get("location") ?? "";
check("the loopback callback hops back to the host holding the device cookie", /^http:\/\/localhost:\d+\/oauth\/delegate\/finish\?ticket=/.test(finishUrl), `${cb.status} ${finishUrl.slice(0, 60)}`);
const fin = await go(finishUrl);
check("finish returns to the club's authorize page", fin.headers.get("location") === returnTo, `${fin.status} ${fin.headers.get("location")?.slice(0, 60)}`);
const chosen = await chooseSession(returnTo, clubDid);
const sessionDid = (s) => s.account?.sub ?? s.account?.did;
check("the club's consent screen lists club.test as signed in", chosen.redirect || (chosen.data?.sessions ?? []).some((s) => sessionDid(s) === clubDid), JSON.stringify(chosen.data?.sessions?.map((s) => s.account?.handle)));
check("and asks for the stock client's own scopes, untouched", !chosen.data || chosen.data.scope === STOCK_SCOPE, chosen.data?.scope);
const stockCb = await go(chosen.loc);
check("callback lands on /stock", stockCb.headers.get("location") === "/stock", `${stockCb.status} → ${stockCb.headers.get("location")}`);
html = strip(await text("/stock"));
check("the client holds the club's session, acting alice", html.includes(`Signed in as ${clubDid}`) && html.includes(`Acting: ${aliceDid}`), html.match(/Signed in as .*? Sign out/)?.[0]?.slice(0, 160));
{
  const scope = (html.match(/Token scope: (.*?) Asked for/)?.[1] ?? "").replace(/&amp;/g, "&").trim();
  check("token scope is the request narrowed to alice's permissions", scope === "atproto repo:social.grain.group.item?action=create&action=delete", scope);
}

step("9. Writes from the stock client: ordinary createRecord, repo = the session's own DID.");
await post("/stock/write", { what: "accept" });
html = strip(await text("/stock"));
check("accept → committed as the club", new RegExp(`200 committed: at://${clubDid}/social\\.grain\\.group\\.item/`).test(html), html.match(/200 committed[^ ]* [^ ]*/)?.[0]);
await post("/stock/write", { what: "post" });
html = strip(await text("/stock"));
check("post → 403 DelegateScopeMissing", /403 DelegateScopeMissing/.test(html));
html = await text("/club");
check("the club's log names alice, via session", /<td>session<\/td>/.test(html) && html.includes(aliceDid));
check("the club lists the delegated session", (html.split("Delegated sessions")[1] ?? "").includes(aliceDid));

step("10. The device account made for consent is gone: this browser cannot authorize another client as the club on its own.");
const again = await go(`${APP}/oauth/stock/start`, { method: "POST", headers: form, body: new URLSearchParams({ who: "club.test" }) });
const authorizeUrl2 = again.headers.get("location");
const pg = await authorizePage(authorizeUrl2);
check("no club session on this device", !pg.redirect && !(pg.data?.sessions ?? []).some((s) => sessionDid(s) === clubDid), JSON.stringify(pg.data?.sessions?.map((s) => s.account?.handle) ?? pg.redirect));

step("11. Remove alice: the delegated session ends on its next request.");
flash = await post("/club/delegates/remove", { did: aliceDid });
await post("/stock/write", { what: "accept" });
html = strip(await text("/stock"));
check("the stock client's next write is refused", /(401|no longer a delegate|invalid_token|session unusable)/i.test(html.split("What happened")[1] ?? ""), (html.split("What happened")[1] ?? "").slice(0, 160));

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
