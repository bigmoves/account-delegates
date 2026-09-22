// The flow in a browser. Brings up the same network as `pnpm demo` (a PLC, two
// PDSes with account delegates, a managing app), adds the small app in
// src/app.ts, and then waits for you: the consent screens are the PDSes' own,
// and a person has to click Accept.
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as plc from "@did-plc/server";
import { startApp } from "./app.ts";
import { startManagingApp } from "./managing-app.ts";
import { startPds } from "./pds.ts";

const PORTS = {
  plc: Number(process.env.PLC_PORT ?? 2700),
  pdsA: Number(process.env.PDS_A_PORT ?? 2701),
  pdsB: Number(process.env.PDS_B_PORT ?? 2702),
  host: Number(process.env.HOST_PORT ?? 2703),
  app: Number(process.env.APP_PORT ?? 2704),
};
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = join(ROOT, ".data-app");
const log = (line: string) => console.log(`\x1b[2m${line}\x1b[0m`);

async function xrpc(base: string, nsid: string, o: { body?: unknown; params?: Record<string, string>; token?: string } = {}) {
  const url = new URL(`${base}/xrpc/${nsid}`);
  for (const [k, v] of Object.entries(o.params ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: o.body ? "POST" : "GET",
    headers: { ...(o.body ? { "content-type": "application/json" } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${nsid}: ${res.status} ${text}`);
  return json;
}

async function createAccount(pds: string, handle: string) {
  const r = await xrpc(pds, "com.atproto.server.createAccount", { body: { handle, email: `${handle}@example.com`, password: `${handle.split(".")[0]}-pass` } });
  return { did: r.did as string, handle, accessJwt: r.accessJwt as string, pds };
}

rmSync(DATA, { recursive: true, force: true });
console.log("Starting a PLC, two PDSes with account delegates, a managing app, and the app…");
const plcServer = plc.PlcServer.create({ db: plc.Database.mock(), port: PORTS.plc });
await plcServer.start();
const plcUrl = `http://localhost:${PORTS.plc}`;

// pds-a first: it hosts the club, and the account that publishes the
// permission set. pds-b (the people) is told to resolve lexicons from that
// account, the way a PDS today resolves them from the NSID's DNS authority.
// pds-a also hosts the sign-in-as page: when a delegate types their handle
// there, it asks the demo's PDSes about it (the way a real PDS would resolve
// a handle through DNS and well-known HTTP).
const pdsA = await startPds({ name: "pds-a", port: PORTS.pdsA, plcUrl, dataDir: DATA, log, handleResolvers: [`http://localhost:${PORTS.pdsB}`, `http://localhost:${PORTS.pdsA}`] });
const lexicons = await createAccount(pdsA.url, "lexicons.test");
const permissionSet = JSON.parse(readFileSync(join(ROOT, "lexicons", "com.atproto.repo.delegatedWrites.json"), "utf8"));
await xrpc(pdsA.url, "com.atproto.repo.createRecord", {
  token: lexicons.accessJwt,
  body: { repo: lexicons.did, collection: "com.atproto.lexicon.schema", rkey: permissionSet.id, validate: false, record: { $type: "com.atproto.lexicon.schema", ...permissionSet } },
});
const [pdsB, host] = await Promise.all([
  startPds({ name: "pds-b", port: PORTS.pdsB, plcUrl, dataDir: DATA, log, lexiconDidAuthority: lexicons.did }),
  startManagingApp({ port: PORTS.host, plcUrl, ttlMs: Number(process.env.CHECK_DELEGATE_TTL_MS ?? 15_000), log }),
]);

const club = await createAccount(pdsA.url, "club.test");
const alice = await createAccount(pdsB.url, "alice.test");
const bob = await createAccount(pdsB.url, "bob.test");
// The host knows its roles already; they matter only if the club switches to managing-app.
host.setRole(club.did, alice.did, "moderator");
host.setRole(club.did, bob.did, "member");

const app = await startApp({
  port: PORTS.app,
  plcUrl,
  handleResolvers: [pdsB.url, pdsA.url],
  actFor: [{ did: club.did, handle: club.handle, label: "Peninsula Riders" }],
  managingApps: [{ url: host.url, name: "the community host", serviceRef: host.serviceRef }],
  network: [
    { name: "app", url: `http://127.0.0.1:${PORTS.app}` },
    { name: "PLC", url: plcUrl },
    { name: "pds-a (the club, the permission set, the sign-in-as page)", url: pdsA.url, did: pdsA.did },
    { name: "pds-b (the people)", url: pdsB.url, did: pdsB.did },
    { name: "managing app", url: host.url, did: host.serviceRef },
    { name: "club", url: `${pdsA.url}/account`, did: club.did },
    { name: "person alice", url: `${pdsB.url}/account`, did: alice.did },
    { name: "person bob", url: `${pdsB.url}/account`, did: bob.did },
    { name: "lexicons (publishes com.atproto.repo.delegatedWrites)", url: pdsA.url, did: lexicons.did },
  ],
  log,
});

console.log(`
  ${app.url}   ← open this

  club   ${club.did}   password club-pass    on ${pdsA.url}
  alice  ${alice.did}   password alice-pass   on ${pdsB.url}
  bob    ${bob.did}   password bob-pass     on ${pdsB.url}
  host   ${host.serviceRef}   (alice is a moderator there, for the managing-app policy)

Ctrl-C to stop.`);

const shutdown = async () => {
  console.log("\nStopping…");
  await Promise.all([app.close(), pdsA.close(), pdsB.close(), host.close()]);
  await plcServer.destroy();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
