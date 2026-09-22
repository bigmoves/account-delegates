// The delegated write path and the delegate-management methods, mounted in
// front of a stock alpha PDS. Everything here is what proposal 0017 says the
// PDS itself would do; it is an extension only so that the prototype runs
// from published packages. Each handler names where it would live upstream.
//
// A delegate reaches a write method two ways, and both land here:
//
//   service auth   the delegate's own token, `repo` = the account (the RFC's
//                  delegated write: one login, one session, per-call tokens)
//   session        an OAuth token *for the account* that the account's PDS
//                  issued to a delegate who signed in as it (sign-in-as); it
//                  carries `act.sub`, and its scope is already narrowed
//
// Either way the write is bounded, committed as the account, and logged.
import express, { type Request, type Response, type Router } from "express";
import type { AppContext } from "@atproto/pds";
import { repoPrepare } from "@atproto/pds";
import { ScopeMissingError, ScopePermissions } from "@atproto/oauth-scopes";
import { verifyJwt } from "@atproto/xrpc-server";
import { parseCid } from "@atproto/lex-data";
import type { DelegateResolver } from "./resolve.ts";
import type { DelegateStore, Via } from "./store.ts";
import { XrpcError, sendError, short } from "./xrpc-error.ts";

type Opts = {
  ctx: AppContext;
  store: DelegateStore;
  resolver: DelegateResolver;
  /** This PDS's service DID; the `aud` a delegate's token must name. */
  serviceDid: string;
  log: (line: string) => void;
};

/** The token's payload, decoded but not verified, to decide who handles the request. */
function peekJwt(req: Request): Record<string, any> | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^(Bearer|DPoP) (.+)$/.exec(h);
  if (!m) return null;
  const parts = m[2]!.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const isServiceAuthShaped = (p: Record<string, any> | null) =>
  !!p && typeof p.iss === "string" && typeof p.lxm === "string" && typeof p.sub !== "string";

const isDelegatedSessionShaped = (p: Record<string, any> | null) =>
  !!p && typeof p.sub === "string" && typeof p.jti === "string" && typeof p.act?.sub === "string";

/** Who is writing, on whose behalf, and within what. */
type DelegateAuth = {
  delegate: string;
  /** Anything with the OAuth matcher's shape: a fresh ScopePermissions or the session's own. */
  permissions: { assertRepo(m: { action: "create" | "update" | "delete"; collection: string }): void };
  via: Via;
};

export function delegatesRouter(opts: Opts): Router {
  const { ctx, store, resolver, serviceDid, log } = opts;
  const router = express.Router();
  const json = express.json({ limit: "1mb" });

  // --- Authenticating a delegate ---------------------------------------------
  // Upstream: auth-verifier.ts gains a `delegatedWrite` verifier that accepts
  // either a service auth token (below) or the existing OAuth output whose
  // token is a delegated session.

  /** Verify the delegate's service auth token for this method. RFC § Authentication. */
  async function authenticateServiceAuth(req: Request, lxm: string, account: string): Promise<DelegateAuth> {
    const peek = peekJwt(req)!;
    const aud: string = peek.aud;
    if (aud !== serviceDid && aud !== `${serviceDid}#atproto_pds`) {
      throw new XrpcError(401, "BadJwtAudience", `token audience ${aud} is not this PDS`);
    }
    const jwt = req.headers.authorization!.split(" ")[1]!;
    let payload;
    try {
      payload = await verifyJwt(jwt, aud, lxm, (iss, forceRefresh) =>
        ctx.idResolver.did.resolveAtprotoKey(iss, forceRefresh),
      );
    } catch (err: any) {
      throw new XrpcError(401, err?.customErrorName ?? "InvalidToken", err?.message ?? "bad token");
    }
    if (typeof payload.jti !== "string") {
      throw new XrpcError(401, "BadJwtJti", "a delegated write requires a jti");
    }
    if (payload.exp - Math.floor(Date.now() / 1000) > 60) {
      throw new XrpcError(401, "BadJwtExpiration", "a delegated write token may live at most 60 seconds");
    }
    if (!store.consumeJti(payload.jti, payload.exp)) {
      throw new XrpcError(401, "ReplayedToken", "this token has already been used");
    }
    const delegate = payload.iss.split("#")[0]!;
    if (delegate === account) {
      throw new XrpcError(400, "InvalidRequest", "a delegated write names another account as repo");
    }
    const permissions = await resolver.resolve(account, delegate);
    if (!permissions) {
      throw new XrpcError(403, "NotDelegate", `${delegate} is not a delegate of ${account}`);
    }
    // The same matcher an OAuth session gets; a delegate entry reads like a granted scope.
    return { delegate, permissions: new ScopePermissions(permissions), via: "service-auth" };
  }

  /** The stock OAuth verification, then: is this token a delegated session for `account`? */
  async function authenticateSession(req: Request, res: Response, account: string): Promise<DelegateAuth> {
    const peek = peekJwt(req)!;
    const verify = ctx.authVerifier.authorization({ authorize: () => {} } as any);
    const out = await verify({ req, res, params: {} } as any);
    if (!("credentials" in out)) throw new XrpcError(out.status, out.error ?? "AuthRequired", out.message ?? "authentication required");
    const creds: any = out.credentials;
    const s = store.getSession(peek.jti);
    if (!s || s.account !== creds.did) throw new XrpcError(401, "InvalidToken", "not a delegated session");
    if (creds.did !== account) throw new XrpcError(403, "RepoMismatch", "a delegated session writes only to its own account");
    // The scope on `creds.permissions` was narrowed to the delegate's current
    // permissions when the token was read back from the store.
    return { delegate: s.delegate, permissions: creds.permissions, via: "session" };
  }

  // --- The delegated write ----------------------------------------------------
  // Upstream: the `did !== auth.credentials.did` check in each repo write
  // handler becomes assertRepoAccess(), which is this function.

  type Op =
    | { action: "create"; collection: string; rkey?: string; value: unknown }
    | { action: "update"; collection: string; rkey: string; value: unknown }
    | { action: "delete"; collection: string; rkey: string };

  async function delegatedWrite(req: Request, res: Response, lxm: string, repo: string, ops: Op[], extra: { validate?: boolean; swapCommit?: string }) {
    const account = await ctx.authVerifier.findAccount(repo as any, { checkDeactivated: true, checkTakedown: true });
    const did = account.did;
    const auth = isServiceAuthShaped(peekJwt(req))
      ? await authenticateServiceAuth(req, lxm, did)
      : await authenticateSession(req, res, did);
    for (const op of ops) {
      try {
        auth.permissions.assertRepo({ action: op.action, collection: op.collection });
      } catch (err) {
        if (err instanceof ScopeMissingError) {
          throw new XrpcError(403, "DelegateScopeMissing", `delegate lacks ${err.scope}`);
        }
        throw err;
      }
    }
    const writes = await Promise.all(
      ops.map((op) =>
        op.action === "create"
          ? repoPrepare.prepareCreate({ did, collection: op.collection as any, rkey: op.rkey, record: op.value as any, validate: extra.validate })
          : op.action === "update"
            ? repoPrepare.prepareUpdate({ did, collection: op.collection as any, rkey: op.rkey, record: op.value as any, validate: extra.validate })
            : repoPrepare.prepareDelete({ did, collection: op.collection as any, rkey: op.rkey }),
      ),
    );
    const swapCommitCid = extra.swapCommit ? parseCid(extra.swapCommit) : undefined;
    // From here it is the stock handler, verbatim: the commit is the account's,
    // signed with its key, sequenced onto its firehose.
    const commit = await ctx.actorStore.transact(did, async (actorTxn) => {
      const commit = await actorTxn.repo.processWrites(writes, swapCommitCid);
      await ctx.sequencer.sequenceCommit(did, commit);
      return commit;
    });
    await ctx.accountManager.updateRepoRoot(did, commit.cid, commit.rev);
    for (const w of writes) {
      store.recordWrite({ account: did, delegate: auth.delegate, lxm, uri: w.uri.toString(), cid: "cid" in w ? w.cid?.toString() : undefined, via: auth.via });
    }
    log(`  ${short(did)} committed ${commit.rev} for delegate ${short(auth.delegate)} via ${auth.via} (${ops.map((o) => `${o.action} ${o.collection}`).join(", ")})`);
    return { commit, writes };
  }

  const delegatedOnly = (lxm: string, handler: (req: Request, res: Response) => Promise<void>) =>
    router.post(`/xrpc/${lxm}`, (req, res, next) => {
      // Service-auth tokens and delegated sessions are ours; everything else
      // is the stock PDS's, untouched (and its body unread, so it can parse it).
      const p = peekJwt(req);
      if (!isServiceAuthShaped(p) && !isDelegatedSessionShaped(p)) return next();
      json(req, res, (err) => {
        if (err) return sendError(res, err);
        handler(req, res).catch((e) => sendError(res, e));
      });
    });

  delegatedOnly("com.atproto.repo.createRecord", async (req, res) => {
    const { repo, collection, rkey, record, validate, swapCommit } = req.body;
    const { commit, writes } = await delegatedWrite(req, res, "com.atproto.repo.createRecord", repo, [{ action: "create", collection, rkey, value: record }], { validate, swapCommit });
    const w = writes[0] as any;
    res.json({ uri: w.uri.toString(), cid: w.cid.toString(), commit: { cid: commit.cid.toString(), rev: commit.rev }, validationStatus: w.validationStatus });
  });

  delegatedOnly("com.atproto.repo.putRecord", async (req, res) => {
    const { repo, collection, rkey, record, validate, swapCommit } = req.body;
    const account = await ctx.authVerifier.findAccount(repo, {});
    const uri = `at://${account.did}/${collection}/${rkey}`;
    const existing = await ctx.actorStore.read(account.did, (s) => s.record.getRecord(uri as any, null));
    const op: Op = existing ? { action: "update", collection, rkey, value: record } : { action: "create", collection, rkey, value: record };
    const { commit, writes } = await delegatedWrite(req, res, "com.atproto.repo.putRecord", repo, [op], { validate, swapCommit });
    const w = writes[0] as any;
    res.json({ uri: w.uri.toString(), cid: w.cid.toString(), commit: { cid: commit.cid.toString(), rev: commit.rev }, validationStatus: w.validationStatus });
  });

  delegatedOnly("com.atproto.repo.deleteRecord", async (req, res) => {
    const { repo, collection, rkey, swapCommit } = req.body;
    const { commit } = await delegatedWrite(req, res, "com.atproto.repo.deleteRecord", repo, [{ action: "delete", collection, rkey }], { swapCommit });
    res.json({ commit: { cid: commit.cid.toString(), rev: commit.rev } });
  });

  delegatedOnly("com.atproto.repo.applyWrites", async (req, res) => {
    const { repo, validate, swapCommit, writes: raw } = req.body;
    if (!Array.isArray(raw) || raw.length > 200) throw new XrpcError(400, "InvalidRequest", "writes must be an array of at most 200");
    const ops: Op[] = raw.map((w: any) => {
      const t = String(w.$type ?? "");
      if (t.endsWith("#create")) return { action: "create", collection: w.collection, rkey: w.rkey, value: w.value };
      if (t.endsWith("#update")) return { action: "update", collection: w.collection, rkey: w.rkey, value: w.value };
      if (t.endsWith("#delete")) return { action: "delete", collection: w.collection, rkey: w.rkey };
      throw new XrpcError(400, "InvalidRequest", `unsupported write ${t}`);
    });
    const { commit, writes } = await delegatedWrite(req, res, "com.atproto.repo.applyWrites", repo, ops, { validate, swapCommit });
    res.json({
      commit: { cid: commit.cid.toString(), rev: commit.rev },
      results: writes.map((w: any) =>
        w.action === "delete"
          ? { $type: "com.atproto.repo.applyWrites#deleteResult" }
          : { $type: `com.atproto.repo.applyWrites#${w.action}Result`, uri: w.uri.toString(), cid: w.cid.toString(), validationStatus: w.validationStatus },
      ),
    });
  });

  // --- A delegated session, seen by the client -------------------------------
  // getSession is what every client calls after login. For a delegated
  // session it says whose session it is and who is acting: `act` mirrors the
  // token's claim. Upstream: one field in getSession's output.
  router.get("/xrpc/com.atproto.server.getSession", (req, res, next) => {
    const p = peekJwt(req);
    if (!isDelegatedSessionShaped(p)) return next();
    (async () => {
      const verify = ctx.authVerifier.authorization({ authorize: () => {} } as any);
      const out = await verify({ req, res, params: {} } as any);
      if (!("credentials" in out)) throw new XrpcError(out.status, out.error ?? "AuthRequired", out.message ?? "authentication required");
      const did = (out.credentials as any).did as string;
      const s = store.getSession(p!.jti);
      const account = await ctx.accountManager.getAccount(did as any, { includeDeactivated: true });
      if (!account) throw new XrpcError(400, "InvalidRequest", "account not found");
      res.json({
        did,
        handle: account.handle ?? "handle.invalid",
        active: !account.deactivatedAt,
        ...(account.deactivatedAt ? { status: "deactivated" } : {}),
        ...(s ? { act: { sub: s.delegate } } : {}),
      });
    })().catch((e) => sendError(res, e));
  });

  // --- Management, by the account itself ------------------------------------
  // Upstream: api/com/atproto/server/, next to createAppPassword.ts. RFC
  // § Managing delegates: an OAuth session holding `account:delegates`, or a
  // legacy full-access session. Never an app password, never a delegate.

  async function accountOf(req: Request, res: Response): Promise<string> {
    const p = peekJwt(req);
    if (isDelegatedSessionShaped(p)) {
      throw new XrpcError(403, "DelegateForbidden", "a delegated session cannot manage delegates");
    }
    const verify = ctx.authVerifier.authorization({
      scopes: ["com.atproto.access"] as any,
      authorize: (permissions: any) => {
        // `delegates` is the attribute the RFC adds; scripts/patch-account-delegates.mjs
        // teaches the installed scope parser about it.
        if (!permissions.allowsAccount({ attr: "delegates", action: "manage" })) {
          throw new XrpcError(403, "ScopeMissing", "this session lacks account:delegates?action=manage");
        }
      },
    } as any);
    const out = await verify({ req, res, params: {} } as any);
    if (!("credentials" in out)) throw new XrpcError(out.status, out.error ?? "AuthRequired", out.message ?? "authentication required");
    return out.credentials.did;
  }

  const managed = (method: "get" | "post", lxm: string, handler: (account: string, req: Request) => Promise<unknown>) =>
    router[method](`/xrpc/${lxm}`, json, async (req, res) => {
      try {
        const account = await accountOf(req, res);
        res.json(await handler(account, req));
      } catch (err) {
        sendError(res, err);
      }
    });

  managed("get", "com.atproto.server.getDelegateConfig", async (account) => ({
    ...store.getConfig(account),
    delegates: store.listDelegates(account),
  }));

  managed("post", "com.atproto.server.updateDelegateConfig", async (account, req) => {
    const { policy, managingApp } = req.body;
    if (policy !== "delegate-list" && policy !== "managing-app") throw new XrpcError(400, "InvalidRequest", "policy must be delegate-list or managing-app");
    if (policy === "managing-app" && typeof managingApp !== "string") throw new XrpcError(400, "InvalidRequest", "managing-app policy needs a managingApp");
    store.setConfig(account, { policy, managingApp });
    resolver.clearCache();
    log(`  ${short(account)}: policy = ${policy}${managingApp ? ` (${managingApp})` : ""}`);
    return store.getConfig(account);
  });

  managed("post", "com.atproto.server.putDelegate", async (account, req) => {
    const { did, permissions, label, expiresAt } = req.body;
    if (typeof did !== "string" || !did.startsWith("did:")) throw new XrpcError(400, "InvalidRequest", "did required");
    if (did === account) throw new XrpcError(400, "InvalidRequest", "an account is not its own delegate");
    if (!Array.isArray(permissions) || !permissions.every((p) => typeof p === "string")) throw new XrpcError(400, "InvalidRequest", "permissions must be strings");
    // Only repo:, space:, blob: are meaningful; nothing that reaches the account itself.
    const bad = permissions.find((p: string) => !/^(repo|space|blob):/.test(p));
    if (bad) throw new XrpcError(400, "InvalidPermission", `${bad}: a delegate may hold only repo:, space:, and blob: permissions`);
    store.putDelegate(account, { did, permissions, label, expiresAt });
    log(`  ${short(account)}: delegate ${short(did)} = ${permissions.join(" ")}${label ? ` (${label})` : ""}`);
    return store.getDelegate(account, did);
  });

  managed("post", "com.atproto.server.removeDelegate", async (account, req) => {
    const { did } = req.body;
    store.removeDelegate(account, did);
    log(`  ${short(account)}: delegate ${short(did)} removed`);
    return {};
  });

  managed("get", "com.atproto.server.listDelegatedWrites", async (account, req) => ({
    writes: store.listWrites(account, Number(req.query.limit ?? 50)),
  }));

  managed("get", "com.atproto.server.listDelegatedSessions", async (account) => ({
    sessions: store.listSessions(account),
  }));

  return router;
}

export { short };
