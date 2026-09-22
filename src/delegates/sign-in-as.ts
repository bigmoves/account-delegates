// Sign-in as the account, with no hooks for policy: the delegate configuration
// is the policy. A person signs in to a client *as* the account; the account's
// PDS authenticates the person at their own PDS (a nested OAuth login, scope
// `atproto` only), checks that they are a delegate, and lets the stock
// consent flow finish. The token that comes out is the account's, narrowed to
// the delegate's permissions, with `act.sub` naming the person. Every write
// made with it is attributed to them.
//
// This is the "sign in as" column of the RFC's comparison table, built on the
// same delegate config as the delegated write. Nothing here is a change to
// the OAuth protocol; it is the PDS's own login flow gaining one method, the
// way a PDS might add passkeys. The provider's public hooks carry most of it;
// the scope narrowing wraps two internals (token creation, and the token
// store's read, since in stateful mode scope is read back from the store).
import { randomBytes } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import type { AppContext } from "@atproto/pds";
import { NodeOAuthClient, type NodeSavedSession, type NodeSavedState } from "@atproto/oauth-client-node";
import { AccessDeniedError, InvalidGrantError } from "@atproto/oauth-provider/errors";
import type { DelegateResolver } from "./resolve.ts";
import { narrowScope } from "./scopes.ts";
import type { DelegateStore } from "./store.ts";
import { short } from "./xrpc-error.ts";

const REQUEST_URI_PREFIX = "urn:ietf:params:oauth:request_uri:";

type Opts = {
  ctx: AppContext;
  store: DelegateStore;
  resolver: DelegateResolver;
  /** Where the browser sees this PDS (the OAuth issuer): the device cookie lives here. */
  publicUrl: string;
  /** A loopback-IP alias of the same server: OAuth forbids `localhost` in redirect URIs. */
  loopbackUrl: string;
  plcUrl: string;
  /** Dev only: PDSes to ask about a handle, since `.test` handles resolve nowhere. */
  handleResolvers: string[];
  log: (line: string) => void;
};

class MemStore<V> {
  private m = new Map<string, V>();
  async get(k: string) { return this.m.get(k); }
  async set(k: string, v: V) { this.m.set(k, v); }
  async del(k: string) { this.m.delete(k); }
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:15px/1.45 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222}
h1{font-size:1.3rem}input[type=text]{width:100%;box-sizing:border-box;font:inherit;padding:.4rem}button{font:inherit;padding:.4rem .9rem;margin-top:.6rem}
code{font:13px ui-monospace,monospace;background:#f3f3f3;padding:0 .25em}.muted{color:#666}.no{color:#b3261e}
.note{background:#f4f6fb;border-left:3px solid #7a8cc7;padding:.6rem .8rem;margin:1rem 0}</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
}

export function installSignInAs(opts: Opts): Router {
  const { ctx, store, resolver, publicUrl, loopbackUrl, plcUrl, log } = opts;
  // The provider's internals this reaches into are named where they are used.
  // A PDS adopting the proposal would do the same from inside.
  const provider: any = ctx.oauthProvider;
  if (!provider) throw new Error("sign-in as an account needs the OAuth provider");

  // --- 1. Hooks: bind the flow to the delegate -------------------------------

  const hooks = provider.hooks;

  // Consent happened. If the request was opened by a delegate sign-in, remember
  // the delegate for the token (by the request's PKCE challenge, which every
  // token minted from it carries in its stored parameters). The device
  // account created for the consent screen has done its job: remove it, so
  // this browser cannot later authorize some other client as the account.
  const onAuthorized = hooks.onAuthorized;
  hooks.onAuthorized = async (data: any) => {
    await onAuthorized?.(data);
    const { account, deviceId, requestId, parameters } = data;
    const bound = store.getRequest(requestId);
    if (bound && bound.account === account.did) {
      store.putAuthorization(parameters.code_challenge, { account: account.did, delegate: bound.delegate });
      store.deleteRequest(requestId);
      await provider.accountManager.removeDeviceAccount(deviceId, account.did);
      store.deleteDevice(deviceId, account.did);
      log(`  ${short(account.did)}: authorized ${parameters.client_id} for delegate ${short(bound.delegate)}`);
      return;
    }
    if (store.getDevice(deviceId, account.did)) {
      // A leftover device account from a delegate sign-in must never turn into
      // an unbounded session for the account.
      throw new AccessDeniedError(parameters, "This session came from a delegate sign-in; sign in again");
    }
  };

  // A token is minted (first issue or refresh). If its authorization was a
  // delegate's, record the token and put `act.sub` on the wire.
  hooks.onCreateToken = async ({ account, parameters, claims }: any) => {
    const a = store.getAuthorization(parameters.code_challenge);
    if (!a || a.account !== account.did) return;
    store.putSession(claims.jti, { account: account.did, delegate: a.delegate, clientId: claims.client_id });
    log(`  ${short(account.did)}: token ${claims.jti} is a delegated session for ${short(a.delegate)}`);
    return { ...claims, act: { sub: a.delegate } };
  };

  // The account's own credentials were used on a device: any delegate marker
  // for that device is stale.
  const onSignedIn = hooks.onSignedIn;
  hooks.onSignedIn = async (data: any) => {
    await onSignedIn?.(data);
    store.deleteDevice(data.deviceId, data.account.did);
  };

  // --- 2. Narrowing ------------------------------------------------------------
  // At issue: the token is minted from the request's parameters. For a
  // delegate's authorization, replace the requested scope with its
  // intersection with the delegate's permissions before anything is minted,
  // so the token response, the token, and the stored session all agree.
  const tokenManager = provider.tokenManager;
  const createToken = tokenManager.createToken.bind(tokenManager);
  tokenManager.createToken = async (client: any, clientAuth: any, clientMetadata: any, account: any, deviceId: any, parameters: any, code: any) => {
    const a = store.getAuthorization(parameters.code_challenge);
    if (a && a.account === account.did) {
      const permissions = await resolver.resolve(a.account, a.delegate);
      if (!permissions) throw new InvalidGrantError(`${a.delegate} is not a delegate of ${a.account}`);
      const expanded = await provider.lexiconManager.buildTokenScope(parameters.scope, account.did);
      const scope = narrowScope(expanded, permissions);
      log(`  ${short(account.did)}: scope for ${short(a.delegate)}: ${parameters.scope} → ${scope}`);
      parameters = { ...parameters, scope };
    }
    return createToken(client, clientAuth, clientMetadata, account, deviceId, parameters, code);
  };

  // At use: in stateful mode the PDS reads a token's scope back from its
  // store on every request. Narrow it there too, against the delegate's
  // *current* permissions: removal of the delegate ends the session on the
  // next request, and a permission taken away is gone at once.
  const tokenStore = tokenManager.store;
  const readToken = tokenStore.readToken.bind(tokenStore);
  tokenStore.readToken = async (tokenId: string) => {
    const info = await readToken(tokenId);
    if (!info) return info;
    const s = store.getSession(tokenId);
    if (!s || s.account !== info.account.did) return info;
    const permissions = await resolver.resolve(s.account, s.delegate);
    if (!permissions) {
      throw new Error(`${s.delegate} is no longer a delegate of ${s.account}`);
    }
    const requested = info.data.scope ?? info.data.parameters?.scope ?? "atproto";
    info.data.scope = narrowScope(requested, permissions);
    return info;
  };

  // --- 3. The nested login --------------------------------------------------
  // The PDS is an OAuth client of the delegate's PDS, asking for `atproto`
  // only: it authenticates the person and learns nothing else. A deployed PDS
  // would publish its own client metadata; the demo uses a loopback client.

  const redirect = `${loopbackUrl}/oauth/delegate/callback`;
  const client = new NodeOAuthClient({
    clientMetadata: {
      client_id: `http://localhost?${new URLSearchParams({ redirect_uri: redirect, scope: "atproto" })}`,
      client_name: `${new URL(publicUrl).host} (sign in as an account)`,
      redirect_uris: [redirect],
      scope: "atproto",
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      dpop_bound_access_tokens: true,
    },
    allowHttp: true,
    plcDirectoryUrl: plcUrl,
    handleResolver: {
      async resolve(handle: string) {
        for (const pds of opts.handleResolvers) {
          const r = await fetch(`${pds}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`).catch(() => null);
          if (r?.ok) return ((await r.json()) as { did: string }).did as any;
        }
        return null;
      },
    },
    stateStore: new MemStore<NodeSavedState>(),
    sessionStore: new MemStore<NodeSavedSession>(),
  });

  type Pending = { account: string; returnTo: string; at: number };
  const pending = new Map<string, Pending>(); // OAuth state → what we were doing
  const tickets = new Map<string, Pending & { delegate: string }>(); // one hop, 127.0.0.1 → localhost

  /** Only ever back to this PDS's own authorize page. */
  function safeReturnTo(raw: string): string | null {
    let u: URL;
    try { u = new URL(raw, publicUrl); } catch { return null; }
    if (u.origin !== new URL(publicUrl).origin || u.pathname !== "/oauth/authorize") return null;
    return u.toString();
  }
  const requestIdOf = (returnTo: string) => {
    const ru = new URL(returnTo).searchParams.get("request_uri") ?? "";
    return ru.startsWith(REQUEST_URI_PREFIX) ? ru.slice(REQUEST_URI_PREFIX.length) : null;
  };

  const router = express.Router();
  const form = express.urlencoded({ extended: false });
  const wrap = (h: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) =>
    h(req, res).catch((err) => {
      log(`  sign-in-as: ${err?.message ?? err}`);
      res.status(500).send(page("Something went wrong", `<p class="no">${esc(err?.message ?? err)}</p>`));
    });

  router.get("/oauth/delegate", wrap(async (req, res) => {
    const account = String(req.query.account ?? "");
    const returnTo = safeReturnTo(String(req.query.return_to ?? ""));
    if (!returnTo) return void res.status(400).send(page("Sign in as an account", `<p class="no">This page is reached from the sign-in screen.</p>`));
    res.send(page(`Sign in as ${account || "an account"}`, `
<p>Use <b>your own</b> account. You will be sent to your own server to sign in there, and brought back here. This server then checks that ${account ? `<code>${esc(account)}</code>` : "the account"} has made you a delegate, and what you may do as it.</p>
<form method="post" action="/oauth/delegate">
<input type="hidden" name="return_to" value="${esc(returnTo)}">
<label>Account to sign in as<br><input type="text" name="account" value="${esc(account)}" placeholder="club.test" required></label>
<label style="display:block;margin-top:.6rem">Your handle<br><input type="text" name="handle" value="" placeholder="alice.test" required autofocus></label>
<button>Continue at your own server</button>
</form>
<div class="note">Your server is asked for <code>atproto</code> only: authentication, nothing else. No credential of yours is kept here.</div>`));
  }));

  router.post("/oauth/delegate", form, wrap(async (req, res) => {
    const returnTo = safeReturnTo(String(req.body.return_to ?? ""));
    const handle = String(req.body.handle ?? "").trim().replace(/^@/, "");
    const who = String(req.body.account ?? "").trim().replace(/^@/, "");
    if (!returnTo || !handle || !who) return void res.status(400).send(page("Sign in as an account", `<p class="no">Missing a field.</p>`));
    const account = await ctx.authVerifier.findAccount(who as any, { checkDeactivated: true, checkTakedown: true }).catch(() => null);
    if (!account) return void res.status(404).send(page("Sign in as an account", `<p class="no">No account <code>${esc(who)}</code> on this server.</p>`));
    const state = randomBytes(16).toString("base64url");
    pending.set(state, { account: account.did, returnTo, at: Date.now() });
    const url = await client.authorize(handle, { state });
    log(`  sign-in-as ${short(account.did)}: sending ${handle} to ${url.origin} to authenticate`);
    res.redirect(url.toString());
  }));

  router.get("/oauth/delegate/callback", wrap(async (req, res) => {
    const params = new URLSearchParams(req.url.split("?")[1] ?? "");
    let session, state: string | null;
    try {
      ({ session, state } = await client.callback(params));
    } catch (err: any) {
      return void res.status(400).send(page("Sign in as an account", `<p class="no">Your server did not complete the sign-in: ${esc(err?.message ?? err)}</p>`));
    }
    const p = state ? pending.get(state) : undefined;
    if (state) pending.delete(state);
    const delegate = session.did;
    // Authentication is all that was needed; drop the session at their PDS.
    await session.signOut().catch(() => {});
    if (!p || Date.now() - p.at > 10 * 60 * 1000) return void res.status(400).send(page("Sign in as an account", `<p class="no">This sign-in has expired; start again.</p>`));
    const permissions = await resolver.resolve(p.account, delegate);
    if (!permissions) {
      log(`  sign-in-as ${short(p.account)}: ${short(delegate)} authenticated but is not a delegate`);
      return void res.status(403).send(page("Not a delegate", `<p class="no">You signed in as <code>${esc(delegate)}</code>, but that account is not a delegate of <code>${esc(p.account)}</code>.</p>`));
    }
    log(`  sign-in-as ${short(p.account)}: ${short(delegate)} authenticated; delegate with ${permissions.join(" ")}`);
    const ticket = randomBytes(16).toString("base64url");
    tickets.set(ticket, { ...p, delegate, at: Date.now() });
    // Back to the host the device cookie belongs to.
    res.redirect(`${publicUrl}/oauth/delegate/finish?ticket=${ticket}`);
  }));

  router.get("/oauth/delegate/finish", wrap(async (req, res) => {
    const t = tickets.get(String(req.query.ticket ?? ""));
    tickets.delete(String(req.query.ticket ?? ""));
    if (!t || Date.now() - t.at > 60 * 1000) return void res.status(400).send(page("Sign in as an account", `<p class="no">This sign-in has expired; start again.</p>`));
    const requestId = requestIdOf(t.returnTo);
    if (!requestId) return void res.status(400).send(page("Sign in as an account", `<p class="no">No authorization request to return to.</p>`));
    // The browser's device, as the provider knows it (same cookie the consent page uses).
    const { deviceId } = await provider.deviceManager.load(req, res);
    store.putRequest(requestId, { account: t.account, delegate: t.delegate, deviceId });
    store.putDevice(deviceId, { account: t.account, delegate: t.delegate });
    // A signed-in account on this device, so the consent screen has one to
    // offer. Bound to this request by onAuthorized, and removed there.
    await provider.accountManager.upsertDeviceAccount(deviceId, t.account);
    log(`  sign-in-as ${short(t.account)}: device ${deviceId} may consent for ${short(t.delegate)} on request ${requestId}`);
    res.redirect(t.returnTo);
  }));

  return router;
}
