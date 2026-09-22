// The two product surfaces proposal 0017 leaves to apps, as one small
// server-rendered app with two doors:
//
//   /club   the controller's tool: sign in as the club, set the policy, name
//           delegates, read the write log. This is "whatever tooling its staff
//           use" in the proposal's Discovery section.
//   /alice  a delegate's app: sign in as yourself, pick an account to act for,
//           press a button. Every write is signed as alice and addressed to the
//           club's PDS with `repo` set to the club.
//
// The app holds no key and no credential for any account. Everything it does
// is with a session the person signed in with, at their own PDS, through the
// real OAuth flow and the real consent screen.
import express, { type Request, type Response } from "express";
import { IdResolver } from "@atproto/identity";
import { NodeOAuthClient, type NodeSavedSession, type NodeSavedState, type OAuthSession } from "@atproto/oauth-client-node";

export type ActFor = { did: string; handle: string; label: string };

export type AppOpts = {
  port: number;
  plcUrl: string;
  /**
   * PDSes to ask about a handle typed into the sign-in box. A real app resolves
   * handles through DNS and well-known HTTP; the demo's `.test` handles have
   * neither, so ask each local PDS in turn.
   */
  handleResolvers: string[];
  /** Accounts the delegate page offers regardless of any host: what a brand tells its staff. */
  actFor: ActFor[];
  /** Managing apps the delegate page asks "which accounts name me". Host-scoped, by nature. */
  managingApps: { url: string; name: string; serviceRef: string }[];
  /** The PDS the accounts this app acts for live on, as `did#atproto_pds`, for an audience-specific permission: what an app for one host asks for. */
  delegateAud: string;
  /** Shown on the index page. */
  network: { name: string; url: string; did?: string }[];
  log: (line: string) => void;
};

// --- OAuth clients -----------------------------------------------------------
// Loopback clients need no registration: the client_id carries the redirect
// URI and the scope, and the authorization server derives the metadata. One
// client per consent story, since the scope is part of the identity.

const SCOPES = {
  /** The controller's tool. `account:delegates` is the permission the RFC adds. */
  club: "atproto account:delegates?action=manage",
  /**
   * The delegate's app as a general-purpose client: the permission set, whose
   * own text says the audience is open. The set carries `aud=*`; an `include:`
   * may only name a specific service as `aud`, and a general-purpose client
   * cannot know where the accounts its user is a delegate of are hosted.
   */
  set: "atproto include:com.atproto.repo.delegatedWrites",
  /**
   * The delegate's app as a client for one host: the default the RFC now
   * recommends. The permission names the PDS the accounts live on, so the
   * consent is bounded to that server; the screen still renders it generically.
   */
  raw: (aud: string) => `atproto rpc:com.atproto.repo.createRecord?aud=${encodeURIComponent(aud)}`,
  /**
   * A stock client that has never heard of delegates. It signs in as whatever
   * account is typed in, asking for what an ordinary app asks for. When the
   * account is the club and the person is a delegate, the token it gets back
   * is the club's, narrowed to what the delegate may do.
   */
  stock: "atproto repo:social.grain.group.item repo:app.bsky.feed.post?action=create blob:image/*",
} as const;
type Door = keyof typeof SCOPES;
const scopeOf = (door: Door, aud: string): string => {
  const s = SCOPES[door];
  return typeof s === "function" ? s(aud) : s;
};

class MemStore<V> {
  private m = new Map<string, V>();
  async get(k: string) { return this.m.get(k); }
  async set(k: string, v: V) { this.m.set(k, v); }
  async del(k: string) { this.m.delete(k); }
}

/** Ask each PDS in turn: the first that knows the handle wins. */
function localHandleResolver(pdses: string[]) {
  return {
    async resolve(handle: string) {
      for (const pds of pdses) {
        const r = await fetch(`${pds}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`).catch(() => null);
        if (r?.ok) return ((await r.json()) as { did: string }).did as any;
      }
      return null;
    },
  };
}

function loopbackClient(opts: { base: string; door: Door; scope: string; plcUrl: string; handleResolvers: string[]; stateStore: MemStore<NodeSavedState>; sessionStore: MemStore<NodeSavedSession> }) {
  const redirect = `${opts.base}/oauth/${opts.door}/callback`;
  const scope = opts.scope;
  const client_id = `http://localhost?${new URLSearchParams({ redirect_uri: redirect, scope })}`;
  return new NodeOAuthClient({
    clientMetadata: {
      client_id,
      client_name: opts.door === "club" ? "Club settings (account delegates demo)" : opts.door === "stock" ? "A stock client (account delegates demo)" : "Grain-ish (account delegates demo)",
      redirect_uris: [redirect],
      scope,
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      dpop_bound_access_tokens: true,
    },
    allowHttp: true,
    plcDirectoryUrl: opts.plcUrl,
    handleResolver: localHandleResolver(opts.handleResolvers),
    stateStore: opts.stateStore,
    sessionStore: opts.sessionStore,
  });
}

// --- HTML ---------------------------------------------------------------------

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string, flash?: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;max-width:56rem;margin:2rem auto;padding:0 1rem;color:#222}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}
code{font:13px ui-monospace,monospace;background:#f3f3f3;padding:0 .25em}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #e5e5e5;vertical-align:top}
form.inline{display:inline}input[type=text]{width:100%;box-sizing:border-box;font:inherit;padding:.3rem}
button{font:inherit;padding:.35rem .8rem}.muted{color:#666}.ok{color:#177a2b}.no{color:#b3261e}
.flash{background:#fff7d6;border:1px solid #f0d97a;padding:.6rem .8rem;margin:1rem 0}
.note{background:#f4f6fb;border-left:3px solid #7a8cc7;padding:.6rem .8rem;margin:1rem 0}
nav a{margin-right:1rem}label{display:block;margin:.5rem 0}
</style></head><body>
<nav><a href="/">demo</a><a href="/club">the club</a><a href="/alice">alice</a><a href="/stock">a stock client</a></nav>
<h1>${esc(title)}</h1>
${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
${body}
</body></html>`;
}

// --- The app ------------------------------------------------------------------

export async function startApp(opts: AppOpts) {
  const { port, plcUrl, log } = opts;
  const base = `http://127.0.0.1:${port}`;
  const stateStore = new MemStore<NodeSavedState>();
  // Sessions are stored by DID, and two doors can hold a session for the same
  // DID (the club's own tool, and a stock client a delegate signed in to as
  // the club): one store per door.
  const clientFor = (door: Door) => loopbackClient({ base, door, scope: scopeOf(door, opts.delegateAud), plcUrl, handleResolvers: opts.handleResolvers, stateStore, sessionStore: new MemStore<NodeSavedSession>() });
  const clients: Record<Door, NodeOAuthClient> = { club: clientFor("club"), set: clientFor("set"), raw: clientFor("raw"), stock: clientFor("stock") };
  const idResolver = new IdResolver({ plcUrl });
  /** What alice's app has seen happen, newest first. */
  const outcomes: { at: string; what: string; status: number; detail: string; ok: boolean }[] = [];
  /** The same, for the stock client. */
  const stockOutcomes: typeof outcomes = [];

  /** The accounts a person may act for, as far as this app can tell, and where each answer came from. */
  async function actingAsChoices(did: string): Promise<(ActFor & { from: string })[]> {
    const out: (ActFor & { from: string })[] = [];
    for (const host of opts.managingApps) {
      const r = await fetch(`${host.url}/xrpc/community.example.listMemberships?did=${encodeURIComponent(did)}`).catch(() => null);
      if (!r?.ok) continue;
      const { memberships } = (await r.json()) as { memberships: { account: string; role: string }[] };
      for (const m of memberships) {
        const doc = await idResolver.did.resolve(m.account).catch(() => null);
        const handle = (doc?.alsoKnownAs ?? []).find((a: string) => a.startsWith("at://"))?.slice(5) ?? m.account;
        const configured = opts.actFor.find((a) => a.did === m.account);
        out.push({ did: m.account, handle, label: configured?.label ?? handle, from: `${m.role} at ${host.name}` });
      }
    }
    for (const a of opts.actFor) {
      if (!out.some((c) => c.did === a.did)) out.push({ ...a, from: "configured in this app" });
    }
    return out;
  }

  // Which person is signed in at which door: a cookie holding the DID, and the
  // OAuth client's own session store holding the tokens.
  const cookies = (req: Request) => Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((p) => p.length === 2).map(([k, v]) => [k, decodeURIComponent(v!)]));
  const setCookie = (res: Response, name: string, value: string | null) =>
    res.setHeader("set-cookie", value === null ? `${name}=; Path=/; Max-Age=0` : `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`);
  type Persona = "club" | "alice" | "stock";
  const personaOf = (door: Door): Persona => (door === "club" ? "club" : door === "stock" ? "stock" : "alice");
  async function sessionFor(req: Request, persona: Persona): Promise<{ session: OAuthSession; door: Door } | null> {
    const c = cookies(req);
    const did = c[persona];
    const door = c[`${persona}_door`] as Door | undefined;
    if (!did || !door) return null;
    try {
      return { session: await clients[door].restore(did), door };
    } catch {
      return null;
    }
  }

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const wrap = (h: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) =>
    h(req, res).catch((err) => {
      log(`  app: ${err?.message ?? err}`);
      res.status(500).send(page("Something went wrong", `<pre>${esc(err?.stack ?? err)}</pre>`));
    });

  // --- index ---
  app.get("/", (_req, res) => {
    res.send(page("Account delegates, in a browser", `
<p>Two people, one account, no shared secret. The <a href="/club">club</a> names who may write as it. Then alice exercises that two ways: <a href="/alice">her own app</a> signs her in as herself and writes as the club; <a href="/stock">a stock client</a> signs in <i>as the club</i>, with alice authenticating at her own PDS, and gets the club's session narrowed to what she may do.</p>
<h2>Walk-through</h2>
<ol>
<li>Open <a href="/club">the club</a> and sign in. The consent screen is the PDS's own; it shows a <b>Delegates</b> card for the <code>account:delegates</code> permission.</li>
<li>Make alice a delegate for <code>social.grain.group.item</code>.</li>
<li><b>Delegated write.</b> Open <a href="/alice">alice</a> and sign in as an app for one host: the permission names the club's PDS. Sign out and sign in as a general-purpose app to see the open-audience consent, which says so in its title.</li>
<li>Acting as the club, accept a gallery. It lands under the club's DID. Try posting as the club: refused, outside her bounds.</li>
<li><b>Sign-in as.</b> Open <a href="/stock">the stock client</a>, type <code>club.test</code>, and choose <i>sign in as a delegate</i>. The club's PDS sends you to alice's PDS to authenticate (<code>atproto</code> only), brings you back, and the club's own consent screen lists <code>club.test</code> as signed in. Consent. The client's token is the club's, with <code>act.sub</code> = alice and the scope cut down to her permissions.</li>
<li>Accept a gallery from the stock client: an ordinary <code>createRecord</code> as the club. Post: refused. The club's log names alice either way, and says which path.</li>
<li>Back at the club: remove her. Her next write on either path is refused; the stock client's session dies with it.</li>
</ol>
<h2>The network this app talks to</h2>
<table>${opts.network.map((n) => `<tr><th>${esc(n.name)}</th><td><a href="${esc(n.url)}">${esc(n.url)}</a></td><td class="muted">${esc(n.did ?? "")}</td></tr>`).join("")}</table>
<p class="muted">Every account's password is <code>&lt;name&gt;-pass</code>: <code>club-pass</code>, <code>alice-pass</code>.</p>`));
  });

  // --- OAuth: start and finish, per door ---
  app.post("/oauth/:door/start", wrap(async (req, res) => {
    const door = req.params.door as Door;
    if (!clients[door]) return void res.status(404).end();
    const who = String(req.body.who ?? "").trim();
    const persona = personaOf(door);
    try {
      const url = await clients[door].authorize(who);
      log(`  app: ${door}: authorize ${who} → ${url.origin}${url.pathname}`);
      if (req.body.as_delegate) {
        // The button a PDS would put on its own sign-in screen. The app only
        // knows the authorize URL; the account's PDS does the rest and comes
        // back to that URL.
        const at = `${url.origin}/oauth/delegate?${new URLSearchParams({ account: who, return_to: url.toString() })}`;
        log(`  app: ${door}: sending the browser to the PDS's sign-in-as page first`);
        return void res.redirect(at);
      }
      res.redirect(url.toString());
    } catch (err: any) {
      // e.g. the PDS refused the scope: an `include:` it could not resolve.
      log(`  app: ${door}: authorize ${who} failed: ${err?.message ?? err}`);
      res.redirect(`/${persona}?flash=${encodeURIComponent(`Could not start sign-in for ${who}: ${err?.message ?? err}`)}`);
    }
  }));
  app.get("/oauth/:door/callback", wrap(async (req, res) => {
    const door = req.params.door as Door;
    if (!clients[door]) return void res.status(404).end();
    const params = new URLSearchParams(req.url.split("?")[1] ?? "");
    const persona = personaOf(door);
    try {
      const { session } = await clients[door].callback(params);
      res.setHeader("set-cookie", [
        `${persona}=${encodeURIComponent(session.did)}; Path=/; HttpOnly; SameSite=Lax`,
        `${persona}_door=${door}; Path=/; HttpOnly; SameSite=Lax`,
      ]);
      log(`  app: ${door}: signed in ${session.did}`);
      res.redirect(`/${persona}`);
    } catch (err: any) {
      log(`  app: ${door}: callback failed: ${err?.message ?? err}`);
      res.redirect(`/${persona}?flash=${encodeURIComponent(`Sign-in did not complete: ${err?.message ?? err}`)}`);
    }
  }));
  app.post("/:persona(club|alice|stock)/sign-out", wrap(async (req, res) => {
    const persona = req.params.persona as Persona;
    const s = await sessionFor(req, persona);
    if (s) await s.session.signOut().catch(() => {});
    res.setHeader("set-cookie", [`${persona}=; Path=/; Max-Age=0`, `${persona}_door=; Path=/; Max-Age=0`]);
    res.redirect(`/${persona}`);
  }));

  // --- the club: the controller's tool ---
  const xrpc = async (session: OAuthSession, nsid: string, o: { body?: unknown; params?: Record<string, string> } = {}) => {
    const qs = o.params ? `?${new URLSearchParams(o.params)}` : "";
    const r = await session.fetchHandler(`/xrpc/${nsid}${qs}`, {
      method: o.body ? "POST" : "GET",
      headers: o.body ? { "content-type": "application/json" } : undefined,
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    const text = await r.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: r.status, json };
  };

  app.get("/club", wrap(async (req, res) => {
    const flash = typeof req.query.flash === "string" ? req.query.flash : undefined;
    const s = await sessionFor(req, "club");
    if (!s) {
      return void res.send(page("The club", `
<p>The controller's tool. It signs in <b>as the club</b>, once, with the one permission this needs: <code>${esc(SCOPES.club)}</code>. It never posts as the club; the delegates do that as themselves.</p>
<form method="post" action="/oauth/club/start"><label>Account <input type="text" name="who" value="club.test"></label><button>Sign in as the club</button></form>
<div class="note">What to look for on the consent screen: an account section with a <b>Delegates</b> card. That card exists because the RFC adds the <code>account:delegates</code> attribute; this demo teaches the installed provider UI about it (see <code>scripts/patch-account-delegates.mjs</code>).</div>`, flash));
    }
    const { session } = s;
    const cfg = await xrpc(session, "com.atproto.server.getDelegateConfig");
    const writes = await xrpc(session, "com.atproto.server.listDelegatedWrites", { params: { limit: "20" } });
    const sessions = await xrpc(session, "com.atproto.server.listDelegatedSessions");
    const info = await session.getTokenInfo().catch(() => null);
    if (cfg.status !== 200) {
      return void res.send(page("The club", `<p class="no">getDelegateConfig → ${cfg.status} ${esc(cfg.json.error)}: ${esc(cfg.json.message)}</p>
<p class="muted">Token scope: <code>${esc(info?.scope ?? "?")}</code></p>
<form method="post" action="/club/sign-out"><button>Sign out</button></form>`, flash));
    }
    const delegates: any[] = cfg.json.delegates ?? [];
    const firstPerson = opts.network.find((n) => n.name.startsWith("person"));
    res.send(page("The club", `
<p>Signed in as <code>${esc(session.did)}</code> with scope <code>${esc(info?.scope ?? "?")}</code>. <form class="inline" method="post" action="/club/sign-out"><button>Sign out</button></form></p>

<h2>Policy</h2>
<form method="post" action="/club/policy">
<label><input type="radio" name="policy" value="delegate-list" ${cfg.json.policy === "delegate-list" ? "checked" : ""}> <b>delegate-list</b>: the list below, kept by this PDS</label>
<label><input type="radio" name="policy" value="managing-app" ${cfg.json.policy === "managing-app" ? "checked" : ""}> <b>managing-app</b>: ask a service who may write as me</label>
<label>Managing app <input type="text" name="managingApp" value="${esc(cfg.json.managingApp ?? opts.managingApps[0]?.serviceRef ?? "")}" placeholder="did:web:host.example#community"></label>
<span class="muted">The demo's host is <code>${esc(opts.managingApps[0]?.serviceRef ?? "")}</code>; it holds alice as a moderator and bob as a member.</span>
<button>Save</button>
</form>

<h2>Delegates</h2>
${cfg.json.policy === "managing-app" ? `<p class="muted">Under <b>managing-app</b> the list is not consulted; the managing app answers per write.</p>` : ""}
<table><tr><th>DID</th><th>Label</th><th>Permissions</th><th>Expires</th><th></th></tr>
${delegates.length ? delegates.map((d) => `<tr><td><code>${esc(d.did)}</code></td><td>${esc(d.label ?? "")}</td><td>${(d.permissions as string[]).map((p) => `<code>${esc(p)}</code>`).join("<br>")}</td><td class="muted">${esc(d.expiresAt ?? "")}</td>
<td><form class="inline" method="post" action="/club/delegates/remove"><input type="hidden" name="did" value="${esc(d.did)}"><button>Remove</button></form></td></tr>`).join("") : `<tr><td colspan="5" class="muted">No delegates. A write as the club by anyone else is refused with NotDelegate.</td></tr>`}
</table>
<h3>Add or replace a delegate</h3>
<form method="post" action="/club/delegates/put">
<label>DID <input type="text" name="did" value="${esc(firstPerson?.did ?? "")}" placeholder="did:plc:…" list="people"></label>
<datalist id="people">${opts.network.filter((n) => n.name.startsWith("person")).map((n) => `<option value="${esc(n.did)}">${esc(n.name)}</option>`).join("")}</datalist>
<label>Label <input type="text" name="label" value="alice, moderator"></label>
<label>Permissions, one per line, in auth-scope syntax<br><textarea name="permissions" rows="3" style="width:100%;font:13px ui-monospace,monospace">repo:social.grain.group.item?action=create&amp;action=delete</textarea></label>
<button>Save delegate</button>
<span class="muted">Only <code>repo:</code>, <code>space:</code>, <code>blob:</code> are accepted; try <code>rpc:*?aud=*</code> to see it refused.</span>
</form>

<h2>Who wrote what</h2>
<table><tr><th>When</th><th>Delegate</th><th>Via</th><th>Method</th><th>Record</th></tr>
${(writes.json.writes ?? []).length ? (writes.json.writes as any[]).map((w) => `<tr><td class="muted">${esc(w.at)}</td><td><code>${esc(w.delegate)}</code></td><td>${esc(w.via)}</td><td>${esc(w.lxm.replace("com.atproto.repo.", ""))}</td><td><code>${esc(w.uri)}</code></td></tr>`).join("") : `<tr><td colspan="5" class="muted">Nothing yet.</td></tr>`}
</table>
<p class="muted">This log is account state on the club's PDS, not on the firehose and not in the commit. The records themselves are the club's, indistinguishable from its own writes. <b>Via</b> says how the delegate reached the PDS: <code>service-auth</code> is a delegated write from their own session; <code>session</code> is a sign-in as the club.</p>

<h2>Delegated sessions</h2>
<table><tr><th>When</th><th>Delegate</th><th>Client</th><th>Token</th></tr>
${(sessions.json.sessions ?? []).length ? (sessions.json.sessions as any[]).map((s) => `<tr><td class="muted">${esc(s.at)}</td><td><code>${esc(s.delegate)}</code></td><td class="muted">${esc(s.clientId ?? "")}</td><td class="muted"><code>${esc(s.jti)}</code></td></tr>`).join("") : `<tr><td colspan="4" class="muted">None. A delegate who signs in <i>as</i> the club appears here.</td></tr>`}
</table>
<p class="muted">Each is an OAuth session for the club, issued to a delegate who authenticated at their own PDS, narrowed to their permissions and carrying <code>act.sub</code>. Removing the delegate ends it on its next request.</p>`, flash));
  }));

  app.post("/club/policy", wrap(async (req, res) => {
    const s = await sessionFor(req, "club");
    if (!s) return void res.redirect("/club");
    const body: any = { policy: req.body.policy };
    if (body.policy === "managing-app") body.managingApp = String(req.body.managingApp ?? "").trim();
    const r = await xrpc(s.session, "com.atproto.server.updateDelegateConfig", { body });
    res.redirect(`/club?flash=${encodeURIComponent(r.status === 200 ? `Policy is now ${r.json.policy}.` : `updateDelegateConfig → ${r.status} ${r.json.error}: ${r.json.message}`)}`);
  }));
  app.post("/club/delegates/put", wrap(async (req, res) => {
    const s = await sessionFor(req, "club");
    if (!s) return void res.redirect("/club");
    const permissions = String(req.body.permissions ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const r = await xrpc(s.session, "com.atproto.server.putDelegate", { body: { did: String(req.body.did ?? "").trim(), label: String(req.body.label ?? "").trim() || undefined, permissions } });
    res.redirect(`/club?flash=${encodeURIComponent(r.status === 200 ? `${r.json.did} is a delegate.` : `putDelegate → ${r.status} ${r.json.error}: ${r.json.message}`)}`);
  }));
  app.post("/club/delegates/remove", wrap(async (req, res) => {
    const s = await sessionFor(req, "club");
    if (!s) return void res.redirect("/club");
    const r = await xrpc(s.session, "com.atproto.server.removeDelegate", { body: { did: String(req.body.did ?? "") } });
    res.redirect(`/club?flash=${encodeURIComponent(r.status === 200 ? `Removed. Takes effect on the next write.` : `removeDelegate → ${r.status} ${r.json.error}: ${r.json.message}`)}`);
  }));

  // --- alice: a delegate's app ---
  app.get("/alice", wrap(async (req, res) => {
    const flash = typeof req.query.flash === "string" ? req.query.flash : undefined;
    const s = await sessionFor(req, "alice");
    if (!s) {
      return void res.send(page("alice", `
<p>An app alice uses. It knows nothing about the club's host. She signs in <b>as herself</b>, once, at her own PDS. Two kinds of app, two consents:</p>
<form method="post" action="/oauth/raw/start"><label>Account <input type="text" name="who" value="alice.test"></label>
<button>Sign in as an app for one host</button> <span class="muted"><code>${esc(scopeOf("raw", opts.delegateAud))}</code></span></form>
<form method="post" action="/oauth/set/start" style="margin-top:.5rem"><input type="hidden" name="who" value="alice.test">
<button>Sign in as a general-purpose app</button> <span class="muted"><code>${esc(SCOPES.set)}</code></span></form>
<div class="note"><b>One host</b> is the default: the permission names the PDS the accounts live on, so what alice grants is bounded to that server. The stock consent screen renders it as <i>Authenticate: perform actions on your behalf</i>, with the server behind the question mark. <b>General-purpose</b> is the open audience: the app cannot know where the accounts its user is a delegate of are hosted, so it asks through the permission set <code>com.atproto.repo.delegatedWrites</code>, whose own title says so: <i>Write to any account that has made you a delegate, on any server</i>. Either way, nothing in this consent names the club: that authorization is the club's to give, on its own PDS, and the club's bounds apply regardless of what this app was granted.</div>`, flash));
    }
    const { session, door } = s;
    const info = await session.getTokenInfo().catch(() => null);
    const choices = await actingAsChoices(session.did);
    res.send(page("alice", `
<p>Signed in as <code>${esc(session.did)}</code> (${door === "set" ? "general-purpose app, open audience" : "app for one host"}), token scope <code>${esc(info?.scope ?? "?")}</code>. <form class="inline" method="post" action="/alice/sign-out"><button>Sign out</button></form></p>

<h2>Acting as</h2>
<form method="post" action="/alice/write">
${choices.map((c, i) => `<label><input type="radio" name="as" value="${esc(c.did)}" ${i === 0 ? "checked" : ""}> <b>${esc(c.label)}</b> <span class="muted">@${esc(c.handle)} · ${esc(c.did)}</span><br><span class="muted">${esc(c.from)}</span></label>`).join("") || `<p class="muted">Nobody names you, as far as this app can tell.</p>`}
<div class="note"><b>How this list was made.</b> The app asked the community host it knows for accounts where you hold a role, and added what it was configured with. The RFC gives a person no protocol-level way to enumerate every account that names them; a host can only answer for its own communities, and a brand tells its staff. A role here states what the host intends. The write below is the enforcement: it works or says why not.</div>
<p>
<button name="what" value="accept">Accept a gallery into the club's pool</button> <span class="muted">creates <code>social.grain.group.item</code> as the club</span><br><br>
<button name="what" value="post">Post as the club</button> <span class="muted">creates <code>app.bsky.feed.post</code> as the club; outside a moderator's bounds</span>
</p>
</form>

<h2>What happened</h2>
<table><tr><th>When</th><th>What</th><th>Outcome</th></tr>
${outcomes.length ? outcomes.map((o) => `<tr><td class="muted">${esc(o.at)}</td><td>${esc(o.what)}</td><td class="${o.ok ? "ok" : "no"}">${esc(o.status)} ${esc(o.detail)}</td></tr>`).join("") : `<tr><td colspan="3" class="muted">Nothing yet.</td></tr>`}
</table>`, flash));
  }));

  app.post("/alice/write", wrap(async (req, res) => {
    const s = await sessionFor(req, "alice");
    if (!s) return void res.redirect("/alice");
    const { session } = s;
    const as = String(req.body.as ?? "");
    const what = String(req.body.what ?? "accept");
    const target = (await actingAsChoices(session.did)).find((a) => a.did === as);
    if (!target) return void res.redirect("/alice?flash=Pick+an+account");
    const now = new Date().toISOString();
    const collection = what === "post" ? "app.bsky.feed.post" : "social.grain.group.item";
    const record = what === "post"
      ? { $type: collection, text: "hello from alice, as the club", createdAt: now }
      : { $type: collection, gallery: "at://did:plc:someone/social.grain.gallery/abc", createdAt: now };
    const label = `${what === "post" ? "post" : "accept gallery"} as ${target.label}`;
    const push = (status: number, detail: string, ok: boolean) => outcomes.unshift({ at: now, what: label, status, detail, ok });

    // 1. Where does the club live? Resolve its DID document, as for any DID.
    const doc = await idResolver.did.resolve(target.did);
    const pdsUrl = (doc?.service ?? []).find((x: any) => x.id === "#atproto_pds")?.serviceEndpoint as string | undefined;
    if (!pdsUrl) { push(0, "could not resolve the account's PDS", false); return void res.redirect("/alice"); }
    const describe = await fetch(`${pdsUrl}/xrpc/com.atproto.server.describeServer`).then((r) => r.json() as Promise<{ did: string }>);
    // The PDS as a service reference, the form an rpc: permission's audience takes.
    const aud = `${describe.did}#atproto_pds`;

    // 2. Ask alice's own PDS for a token addressed to the club's PDS, bound to this method.
    //    This is the call the OAuth grant gates: no rpc: permission, no token.
    const lxm = "com.atproto.repo.createRecord";
    const sa = await session.fetchHandler(`/xrpc/com.atproto.server.getServiceAuth?${new URLSearchParams({ aud, lxm })}`);
    const saJson: any = await sa.json().catch(() => ({}));
    if (sa.status !== 200) {
      push(sa.status, `getServiceAuth at alice's PDS: ${saJson.error ?? ""} ${saJson.message ?? ""}`.trim(), false);
      log(`  app: alice: getServiceAuth → ${sa.status} ${saJson.error}`);
      return void res.redirect("/alice");
    }

    // 3. The ordinary write method, with one difference: repo is not the caller.
    const w = await fetch(`${pdsUrl}/xrpc/${lxm}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${saJson.token}` },
      body: JSON.stringify({ repo: target.did, collection, record }),
    });
    const wJson: any = await w.json().catch(() => ({}));
    if (w.status === 200) {
      push(200, `committed as the club: ${wJson.uri}`, true);
    } else {
      push(w.status, `${wJson.error ?? ""}: ${wJson.message ?? ""}`, false);
    }
    log(`  app: alice: ${label} → ${w.status} ${wJson.error ?? wJson.uri ?? ""}`);
    res.redirect("/alice");
  }));

  // --- a stock client: sign in as the club ---
  app.get("/stock", wrap(async (req, res) => {
    const flash = typeof req.query.flash === "string" ? req.query.flash : undefined;
    const s = await sessionFor(req, "stock");
    if (!s) {
      return void res.send(page("A stock client", `
<p>A client that has never heard of delegates. It signs in as whatever account you type, asking for what an ordinary app asks for: <code>${esc(SCOPES.stock)}</code>.</p>
<form method="post" action="/oauth/stock/start"><label>Account <input type="text" name="who" value="club.test"></label>
<button>Sign in</button> <span class="muted">the club's own password: <code>club-pass</code></span><br><br>
<button name="as_delegate" value="1">Sign in as a delegate of this account</button> <span class="muted">authenticate at <i>your</i> PDS instead: <code>alice.test</code> / <code>alice-pass</code></span></form>
<div class="note">The second button is what the club's PDS would put on its own sign-in screen; this app only knows the authorize URL and is sent back to it. Watch the sequence: the club's PDS asks for your handle, sends you to your own PDS (asking for <code>atproto</code> only), returns, and its consent screen then offers <code>club.test</code> as signed in. Consent there is the club's, for the scopes this app asked for. What comes back is narrower.</div>
${stockOutcomes.length ? `<h2>What happened</h2>
<p class="muted">The last session ended: a delegated session whose delegate is removed cannot be used or refreshed, so the client drops it.</p>
<table><tr><th>When</th><th>What</th><th>Outcome</th></tr>
${stockOutcomes.map((o) => `<tr><td class="muted">${esc(o.at)}</td><td>${esc(o.what)}</td><td class="${o.ok ? "ok" : "no"}">${esc(o.status)} ${esc(o.detail)}</td></tr>`).join("")}</table>` : ""}`, flash));
    }
    const { session } = s;
    const info = await session.getTokenInfo().catch(() => null);
    // A delegated session whose delegate was removed cannot even be refreshed.
    const who = await xrpc(session, "com.atproto.server.getSession").catch((err) => ({ status: 0, json: { error: "SessionUnusable", message: String(err?.message ?? err) } }));
    const act = who.json.act?.sub as string | undefined;
    res.send(page("A stock client", `
<p>Signed in as <code>${esc(session.did)}</code> (<code>@${esc(who.json.handle ?? "?")}</code>).${act ? ` <b>Acting:</b> <code>${esc(act)}</code>, from <code>getSession</code>'s <code>act</code>.` : who.status === 200 ? " No <code>act</code>: this is the account's own session." : ` <span class="no">getSession → ${esc(who.status)} ${esc(who.json.error)}: ${esc(who.json.message ?? who.json.error_description ?? "")}</span>`} <form class="inline" method="post" action="/stock/sign-out"><button>Sign out</button></form></p>
<p>Token scope: <code>${esc(info?.scope ?? "?")}</code><br><span class="muted">Asked for: <code>${esc(SCOPES.stock)}</code>${act ? ". The difference is the delegate's ceiling: only what the club allowed alice survives, and nothing but repo:, blob:, space: ever can." : ""}</span></p>

<h2>Write as the account</h2>
<form method="post" action="/stock/write">
<p>
<button name="what" value="accept">Accept a gallery into the pool</button> <span class="muted">an ordinary <code>createRecord</code>, <code>repo</code> = this session's own DID</span><br><br>
<button name="what" value="post">Post</button> <span class="muted">creates <code>app.bsky.feed.post</code>; the app asked for it, ${act ? "the delegate may not" : "the account may"}</span>
</p>
</form>

<h2>What happened</h2>
<table><tr><th>When</th><th>What</th><th>Outcome</th></tr>
${stockOutcomes.length ? stockOutcomes.map((o) => `<tr><td class="muted">${esc(o.at)}</td><td>${esc(o.what)}</td><td class="${o.ok ? "ok" : "no"}">${esc(o.status)} ${esc(o.detail)}</td></tr>`).join("") : `<tr><td colspan="3" class="muted">Nothing yet.</td></tr>`}
</table>`, flash));
  }));

  app.post("/stock/write", wrap(async (req, res) => {
    const s = await sessionFor(req, "stock");
    if (!s) return void res.redirect("/stock");
    const { session } = s;
    const what = String(req.body.what ?? "accept");
    const now = new Date().toISOString();
    const collection = what === "post" ? "app.bsky.feed.post" : "social.grain.group.item";
    const record = what === "post"
      ? { $type: collection, text: "hello from the stock client", createdAt: now }
      : { $type: collection, gallery: "at://did:plc:someone/social.grain.gallery/abc", createdAt: now };
    const label = what === "post" ? "post" : "accept gallery";
    // Nothing delegate-specific: the session's own DID as repo, like any client.
    try {
      const r = await xrpc(session, "com.atproto.repo.createRecord", { body: { repo: session.did, collection, record } });
      stockOutcomes.unshift({ at: now, what: label, status: r.status, detail: r.status === 200 ? `committed: ${r.json.uri}` : `${r.json.error ?? ""}: ${r.json.message ?? r.json.error_description ?? ""}`, ok: r.status === 200 });
      log(`  app: stock: ${label} → ${r.status} ${r.json.error ?? r.json.uri ?? ""}`);
    } catch (err: any) {
      // The OAuth client gives up on a session it cannot refresh: a delegate
      // who was removed ends up here.
      stockOutcomes.unshift({ at: now, what: label, status: 0, detail: `session unusable: ${err?.message ?? err}`, ok: false });
      log(`  app: stock: ${label} → session unusable: ${err?.message ?? err}`);
    }
    res.redirect("/stock");
  }));

  const server = app.listen(port);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return {
    url: base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
