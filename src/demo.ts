// The whole flow, end to end, on a network this script brings up itself:
// a PLC, two PDSes with account delegates, and a managing app. Every step
// prints what it did and whether the outcome matched proposal 0017.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as plc from "@did-plc/server";
import { startManagingApp } from "./managing-app.ts";
import { startPds } from "./pds.ts";

const PORTS = {
  plc: Number(process.env.PLC_PORT ?? 2700),
  pdsA: Number(process.env.PDS_A_PORT ?? 2701),
  pdsB: Number(process.env.PDS_B_PORT ?? 2702),
  host: Number(process.env.HOST_PORT ?? 2703),
};
const DATA = join(fileURLToPath(new URL("..", import.meta.url)), ".data");
const CHECK_DELEGATE_TTL_MS = Number(process.env.CHECK_DELEGATE_TTL_MS ?? 1500);

// --- tiny HTTP helpers ------------------------------------------------------

type Session = { did: string; handle: string; accessJwt: string; pds: string };

async function xrpc(base: string, nsid: string, o: { method?: "GET" | "POST"; body?: unknown; params?: Record<string, string>; token?: string } = {}) {
  const url = new URL(`${base}/xrpc/${nsid}`);
  for (const [k, v] of Object.entries(o.params ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: o.method ?? (o.body ? "POST" : "GET"),
    headers: { ...(o.body ? { "content-type": "application/json" } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function createAccount(pds: string, handle: string, password: string): Promise<Session> {
  const r = await xrpc(pds, "com.atproto.server.createAccount", { body: { handle, email: `${handle}@example.com`, password } });
  if (r.status !== 200) throw new Error(`createAccount ${handle}: ${r.status} ${JSON.stringify(r.json)}`);
  return { did: r.json.did, handle, accessJwt: r.json.accessJwt, pds };
}

/** What an app does before every delegated write: ask the user's own PDS for a token addressed to the account's PDS. */
async function serviceAuth(s: Session, aud: string, lxm: string): Promise<string> {
  const r = await xrpc(s.pds, "com.atproto.server.getServiceAuth", { params: { aud, lxm }, token: s.accessJwt });
  if (r.status !== 200) throw new Error(`getServiceAuth: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.token;
}

/** A delegated createRecord: the delegate's token, the account as `repo`. */
async function writeAs(delegate: Session, accountPds: string, accountPdsDid: string, repo: string, collection: string, record: unknown, token?: string) {
  token ??= await serviceAuth(delegate, accountPdsDid, "com.atproto.repo.createRecord");
  return xrpc(accountPds, "com.atproto.repo.createRecord", { body: { repo, collection, record }, token });
}

// --- the transcript ---------------------------------------------------------

let failures = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function step(title: string) { console.log(`\n${title}`); }
function check(what: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${what}${detail ? `  ${detail}` : ""}`);
}
const log = (line: string) => console.log(`\x1b[2m${line}\x1b[0m`);

rmSync(DATA, { recursive: true, force: true });
console.log("Starting a PLC, two PDSes with account delegates, and a managing app…");
const plcServer = plc.PlcServer.create({ db: plc.Database.mock(), port: PORTS.plc });
await plcServer.start();
const plcUrl = `http://localhost:${PORTS.plc}`;
const [pdsA, pdsB, host] = await Promise.all([
  startPds({ name: "pds-a", port: PORTS.pdsA, plcUrl, dataDir: DATA, log }),
  startPds({ name: "pds-b", port: PORTS.pdsB, plcUrl, dataDir: DATA, log }),
  startManagingApp({ port: PORTS.host, plcUrl, ttlMs: CHECK_DELEGATE_TTL_MS, log }),
]);
console.log(`  PLC ${plcUrl}\n  pds-a ${pdsA.url} (${pdsA.did})\n  pds-b ${pdsB.url} (${pdsB.did})\n  host  ${host.url} (${host.serviceRef})`);

try {
  step("1. Accounts. The club lives on pds-a; the people live on pds-b.");
  const club = await createAccount(pdsA.url, "club.test", "club-pass");
  const alice = await createAccount(pdsB.url, "alice.test", "alice-pass");
  const bob = await createAccount(pdsB.url, "bob.test", "bob-pass");
  console.log(`  club  ${club.did}\n  alice ${alice.did}\n  bob   ${bob.did}`);
  const item = { $type: "social.grain.group.item", gallery: "at://did:plc:someone/social.grain.gallery/abc", createdAt: new Date().toISOString() };

  step("2. Nobody is a delegate yet: alice writing as the club is refused.");
  let r = await writeAs(alice, pdsA.url, pdsA.did, club.did, "social.grain.group.item", item);
  check("createRecord as club → 403 NotDelegate", r.status === 403 && r.json.error === "NotDelegate", `${r.status} ${r.json.error}`);

  step("3. delegate-list policy: the club, with its own session, makes alice a delegate for one collection.");
  r = await xrpc(pdsA.url, "com.atproto.server.putDelegate", { token: club.accessJwt, body: { did: alice.did, permissions: ["repo:social.grain.group.item?action=create&action=delete"], label: "alice, moderator" } });
  check("putDelegate → 200", r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);
  r = await xrpc(pdsA.url, "com.atproto.server.putDelegate", { token: club.accessJwt, body: { did: alice.did, permissions: ["rpc:*?aud=*"] } });
  check("putDelegate with an rpc: permission → 400 InvalidPermission", r.status === 400 && r.json.error === "InvalidPermission", `${r.status} ${r.json.error}`);
  r = await xrpc(pdsA.url, "com.atproto.server.putDelegate", { token: alice.accessJwt, body: { did: bob.did, permissions: ["repo:*"] } });
  check("alice cannot manage the club's delegates (her token is not the club's)", r.status !== 200 || r.json.did !== bob.did, `${r.status}`);

  step("4. alice writes as the club from pds-b: service auth from her PDS, repo = the club.");
  r = await writeAs(alice, pdsA.url, pdsA.did, club.did, "social.grain.group.item", item);
  check("createRecord as club → 200", r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);
  const uri: string = r.json.uri ?? "";
  const rev: string = r.json.commit?.rev ?? "";
  check("the record's URI is under the club's DID", uri.startsWith(`at://${club.did}/`), uri);
  const got = await xrpc(pdsA.url, "com.atproto.repo.getRecord", { params: { repo: club.did, collection: "social.grain.group.item", rkey: uri.split("/").pop()! } });
  check("anyone can read it back from the club's repo", got.status === 200 && got.json.uri === uri, `${got.status}`);
  const latest = await xrpc(pdsA.url, "com.atproto.sync.getLatestCommit", { params: { did: club.did } });
  check("the club's latest commit is the one the delegated write made", latest.status === 200 && latest.json.rev === rev, `${latest.json.rev}`);
  const writes = await xrpc(pdsA.url, "com.atproto.server.listDelegatedWrites", { token: club.accessJwt });
  check("the club's log attributes it to alice", writes.json.writes?.[0]?.delegate === alice.did && writes.json.writes?.[0]?.uri === uri, JSON.stringify(writes.json.writes?.[0]));

  step("5. Bounds. A collection outside alice's permissions, a non-delegate, a replayed token, a mixed batch.");
  r = await writeAs(alice, pdsA.url, pdsA.did, club.did, "app.bsky.feed.post", { $type: "app.bsky.feed.post", text: "as the club", createdAt: new Date().toISOString() });
  check("alice creates app.bsky.feed.post as club → 403 DelegateScopeMissing", r.status === 403 && r.json.error === "DelegateScopeMissing", `${r.status} ${r.json.error}: ${r.json.message}`);
  r = await writeAs(bob, pdsA.url, pdsA.did, club.did, "social.grain.group.item", item);
  check("bob (not a delegate) → 403 NotDelegate", r.status === 403 && r.json.error === "NotDelegate", `${r.status} ${r.json.error}`);
  const once = await serviceAuth(alice, pdsA.did, "com.atproto.repo.createRecord");
  r = await writeAs(alice, pdsA.url, pdsA.did, club.did, "social.grain.group.item", item, once);
  const again = await writeAs(alice, pdsA.url, pdsA.did, club.did, "social.grain.group.item", item, once);
  check("the same token twice: 200 then 401 ReplayedToken", r.status === 200 && again.status === 401 && again.json.error === "ReplayedToken", `${r.status} then ${again.status} ${again.json.error}`);
  const wrongMethod = await serviceAuth(alice, pdsA.did, "com.atproto.repo.deleteRecord");
  r = await writeAs(alice, pdsA.url, pdsA.did, club.did, "social.grain.group.item", item, wrongMethod);
  check("a token bound to deleteRecord cannot createRecord → 401", r.status === 401, `${r.status} ${r.json.error}`);
  const batchToken = await serviceAuth(alice, pdsA.did, "com.atproto.repo.applyWrites");
  r = await xrpc(pdsA.url, "com.atproto.repo.applyWrites", { token: batchToken, body: { repo: club.did, writes: [
    { $type: "com.atproto.repo.applyWrites#create", collection: "social.grain.group.item", value: item },
    { $type: "com.atproto.repo.applyWrites#create", collection: "app.bsky.feed.post", value: { $type: "app.bsky.feed.post", text: "smuggled", createdAt: new Date().toISOString() } },
  ] } });
  check("applyWrites with one covered and one uncovered op → 403, nothing written", r.status === 403 && r.json.error === "DelegateScopeMissing", `${r.status} ${r.json.error}`);
  const after = await xrpc(pdsA.url, "com.atproto.sync.getLatestCommit", { params: { did: club.did } });
  const posts = await xrpc(pdsA.url, "com.atproto.repo.listRecords", { params: { repo: club.did, collection: "app.bsky.feed.post" } });
  check("no app.bsky.feed.post exists in the club's repo", posts.status === 200 && posts.json.records?.length === 0, `${posts.json.records?.length} posts, rev ${after.json.rev}`);

  step("6. Revocation under delegate-list: removeDelegate takes effect on the next write.");
  r = await xrpc(pdsA.url, "com.atproto.server.removeDelegate", { token: club.accessJwt, body: { did: alice.did } });
  r = await writeAs(alice, pdsA.url, pdsA.did, club.did, "social.grain.group.item", item);
  check("alice → 403 NotDelegate", r.status === 403 && r.json.error === "NotDelegate", `${r.status} ${r.json.error}`);

  step("7. managing-app policy: the club says 'ask the host', and the host answers from roles it alone holds.");
  r = await xrpc(pdsA.url, "com.atproto.server.updateDelegateConfig", { token: club.accessJwt, body: { policy: "managing-app", managingApp: host.serviceRef } });
  check("updateDelegateConfig → managing-app", r.status === 200 && r.json.policy === "managing-app", `${r.status} ${JSON.stringify(r.json)}`);
  host.setRole(club.did, alice.did, "moderator");
  host.setRole(club.did, bob.did, "member");
  r = await writeAs(alice, pdsA.url, pdsA.did, club.did, "social.grain.group.item", item);
  check("alice (moderator on the host) writes as club → 200; pds-a asked the host, signed as the club", r.status === 200, `${r.status} ${r.json.error ?? ""}`);
  r = await writeAs(alice, pdsA.url, pdsA.did, club.did, "social.grain.group.item", item);
  check("a second write inside the TTL is served from cache (no host call above)", r.status === 200, `${r.status}`);
  r = await writeAs(bob, pdsA.url, pdsA.did, club.did, "social.grain.group.item", item);
  check("bob (plain member, no permissions) → 403 NotDelegate", r.status === 403 && r.json.error === "NotDelegate", `${r.status} ${r.json.error}`);
  r = await writeAs(alice, pdsA.url, pdsA.did, club.did, "app.bsky.feed.post", { $type: "app.bsky.feed.post", text: "x", createdAt: new Date().toISOString() });
  check("alice as moderator still cannot post → 403 DelegateScopeMissing", r.status === 403 && r.json.error === "DelegateScopeMissing", `${r.status} ${r.json.error}`);

  step(`8. Eject on the host. Revocation is bounded by the TTL the host chose (${CHECK_DELEGATE_TTL_MS} ms here).`);
  host.setRole(club.did, alice.did, null);
  r = await writeAs(alice, pdsA.url, pdsA.did, club.did, "social.grain.group.item", item);
  check("inside the TTL alice still succeeds (cached)", r.status === 200, `${r.status}`);
  await sleep(CHECK_DELEGATE_TTL_MS + 100);
  r = await writeAs(alice, pdsA.url, pdsA.did, club.did, "social.grain.group.item", item);
  check("after the TTL alice → 403 NotDelegate", r.status === 403 && r.json.error === "NotDelegate", `${r.status} ${r.json.error}`);

  step("9. The club's own writes are untouched: its session goes straight to the stock PDS.");
  r = await xrpc(pdsA.url, "com.atproto.repo.createRecord", { token: club.accessJwt, body: { repo: club.did, collection: "app.bsky.feed.post", record: { $type: "app.bsky.feed.post", text: "hello from the club itself", createdAt: new Date().toISOString() } } });
  check("club createRecord with its own access token → 200", r.status === 200, `${r.status} ${r.json.error ?? ""}`);
  const log2 = await xrpc(pdsA.url, "com.atproto.server.listDelegatedWrites", { token: club.accessJwt });
  check("the club's log holds only delegated writes", log2.status === 200 && log2.json.writes.every((w: any) => w.delegate === alice.did), `${log2.json.writes.length} entries, all by alice`);

  step("10. A community created from an app: alice, from her own PDS, creates riders.test on pds-a. No password, no email; she is its controller.");
  const create = (who: Session, body: unknown) =>
    serviceAuth(who, pdsA.did, "com.atproto.server.createDelegatedAccount").then((token) => xrpc(pdsA.url, "com.atproto.server.createDelegatedAccount", { token, body }));
  r = await create(alice, { handle: "riders.test", controllers: [alice.did], delegates: [{ did: alice.did, permissions: ["repo:social.grain.group.item?action=create&action=delete"], label: "alice, founder" }] });
  check("createDelegatedAccount → 200 with a new DID", r.status === 200 && String(r.json.did).startsWith("did:plc:"), `${r.status} ${JSON.stringify(r.json)}`);
  const riders: string = r.json.did;
  const doc = await fetch(`${plcUrl}/${riders}`).then((x) => x.json() as Promise<any>).catch(() => null);
  check("the DID resolves: handle riders.test, hosted on pds-a", doc?.alsoKnownAs?.includes("at://riders.test") && doc?.service?.some((s: any) => s.serviceEndpoint === pdsA.url), JSON.stringify(doc?.service?.[0]?.serviceEndpoint));
  r = await xrpc(pdsA.url, "com.atproto.server.createSession", { body: { identifier: "riders.test", password: "riders-pass" } });
  check("the account has no password: createSession → 401", r.status === 401, `${r.status} ${r.json.error}`);
  r = await writeAs(alice, pdsA.url, pdsA.did, riders, "social.grain.group.item", item);
  check("alice, a delegate from creation, writes as riders → 200", r.status === 200 && String(r.json.uri).startsWith(`at://${riders}/`), `${r.status} ${r.json.error ?? ""}`);
  r = await writeAs(bob, pdsA.url, pdsA.did, riders, "social.grain.group.item", item);
  check("bob → 403 NotDelegate", r.status === 403 && r.json.error === "NotDelegate", `${r.status} ${r.json.error}`);
  const manage = (who: Session, lxm: string, o: { body?: unknown; params?: Record<string, string> }) =>
    serviceAuth(who, pdsA.did, lxm).then((token) => xrpc(pdsA.url, lxm, { token, ...o }));
  r = await manage(alice, "com.atproto.server.putDelegate", { body: { account: riders, did: bob.did, permissions: ["repo:social.grain.group.item?action=create"], label: "bob" } });
  check("alice, as controller, adds bob by service auth from her own session → 200", r.status === 200 && r.json.did === bob.did, `${r.status} ${JSON.stringify(r.json)}`);
  r = await writeAs(bob, pdsA.url, pdsA.did, riders, "social.grain.group.item", item);
  check("bob now writes as riders → 200", r.status === 200, `${r.status} ${r.json.error ?? ""}`);
  r = await manage(bob, "com.atproto.server.removeDelegate", { body: { account: riders, did: alice.did } });
  check("bob, a delegate but not a controller, cannot manage → 403 NotController", r.status === 403 && r.json.error === "NotController", `${r.status} ${r.json.error}`);
  r = await manage(alice, "com.atproto.server.getDelegateConfig", { params: { account: riders } });
  check("the config names alice as controller and both as delegates", r.status === 200 && r.json.controllers?.[0] === alice.did && r.json.delegates?.length === 2, `${r.status} ${JSON.stringify(r.json)}`);
  r = await manage(alice, "com.atproto.server.updateDelegateConfig", { body: { account: riders, controllers: [alice.did, bob.did] } });
  check("alice makes bob a controller too", r.status === 200 && r.json.controllers?.includes(bob.did), `${r.status} ${JSON.stringify(r.json)}`);
  r = await manage(bob, "com.atproto.server.removeDelegate", { body: { account: riders, did: alice.did } });
  check("bob, now a controller, removes alice as a delegate → 200", r.status === 200, `${r.status} ${r.json.error ?? ""}`);
  r = await writeAs(alice, pdsA.url, pdsA.did, riders, "social.grain.group.item", item);
  check("alice can no longer write as riders → 403 NotDelegate (she is still a controller)", r.status === 403 && r.json.error === "NotDelegate", `${r.status} ${r.json.error}`);
  r = await create(alice, { handle: "riders.test", controllers: [alice.did] });
  check("the handle is taken → 400 HandleNotAvailable", r.status === 400 && r.json.error === "HandleNotAvailable", `${r.status} ${r.json.error}`);
  r = await create(alice, { handle: "other.test", controllers: [bob.did] });
  check("a caller who is not among the controllers → 403 NotController", r.status === 403 && r.json.error === "NotController", `${r.status} ${r.json.error}`);
  r = await xrpc(pdsA.url, "com.atproto.server.createDelegatedAccount", { token: alice.accessJwt, body: { handle: "other.test", controllers: [alice.did] } });
  check("an access token, not service auth → 401", r.status === 401, `${r.status} ${r.json.error}`);
} catch (err) {
  failures++;
  console.error("\nUnexpected error:", err);
} finally {
  await Promise.all([pdsA.close(), pdsB.close(), host.close()]);
  await plcServer.destroy();
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
