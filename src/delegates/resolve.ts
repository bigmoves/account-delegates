// "Is this DID a delegate of that account, and how far?" Answered from the
// account's delegate configuration under either policy. Shared by the two
// ways a delegate is exercised: a delegated write (service auth, per call)
// and a delegated session (sign-in as the account, narrowed at the token).
import type { AppContext } from "@atproto/pds";
import { createServiceJwt } from "@atproto/xrpc-server";
import type { DelegateStore } from "./store.ts";
import { XrpcError, short } from "./xrpc-error.ts";

const CHECK_DELEGATE = "com.atproto.server.checkDelegate";
const DEFAULT_MANAGING_APP_TTL_MS = 5 * 60 * 1000;

export class DelegateResolver {
  private cache = new Map<string, { permissions: string[]; expiresAt: number }>();

  constructor(
    private opts: { ctx: AppContext; store: DelegateStore; log: (line: string) => void },
  ) {}

  clearCache() {
    this.cache.clear();
  }

  /**
   * Everything the account grants this DID: write permissions as a delegate,
   * and whether they may manage the configuration as a controller. Null when
   * the DID is neither. A controller with no delegate entry may sign in as
   * the account and manage it, but write nothing.
   */
  async standing(account: string, did: string): Promise<{ permissions: string[]; controller: boolean } | null> {
    const controller = this.opts.store.isController(account, did);
    const permissions = await this.resolve(account, did);
    if (!permissions && !controller) return null;
    return { permissions: permissions ?? [], controller };
  }

  /** The delegate's permissions for this account, or null. RFC § Delegates, § The managing-app policy. */
  async resolve(account: string, did: string): Promise<string[] | null> {
    const { ctx, store, log } = this.opts;
    const cfg = store.getConfig(account);
    if (cfg.policy === "delegate-list") {
      const d = store.getDelegate(account, did);
      if (!d) return null;
      if (d.expiresAt && Date.parse(d.expiresAt) < Date.now()) return null;
      return d.permissions;
    }
    const key = `${account}|${did}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      log(`  ${short(account)}: ${short(did)} is cached from the managing app (${cached.permissions.length} permissions)`);
      return cached.permissions.length ? cached.permissions : null;
    }
    const managingApp = cfg.managingApp!;
    const endpoint = await this.resolveServiceEndpoint(managingApp);
    // Signed as the account, with the account's own repo signing key: the
    // managing app verifies it against the account's DID document.
    const keypair = await ctx.actorStore.keypair(account as any);
    const token = await createServiceJwt({ iss: account, aud: managingApp, lxm: CHECK_DELEGATE, keypair });
    const url = new URL(`${endpoint}/xrpc/${CHECK_DELEGATE}`);
    url.searchParams.set("account", account);
    url.searchParams.set("did", did);
    log(`  ${short(account)} → ${managingApp}: checkDelegate(${short(did)})`);
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new XrpcError(502, "ManagingAppUnavailable", `checkDelegate: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { permissions: string[]; expiresAt?: string };
    const expiresAt = body.expiresAt ? Date.parse(body.expiresAt) : Date.now() + DEFAULT_MANAGING_APP_TTL_MS;
    this.cache.set(key, { permissions: body.permissions, expiresAt });
    log(`  ← ${body.permissions.length ? body.permissions.join(" ") : "(not a delegate)"}`);
    return body.permissions.length ? body.permissions : null;
  }

  private async resolveServiceEndpoint(serviceRef: string): Promise<string> {
    const [did, fragment] = serviceRef.split("#");
    const doc = await this.opts.ctx.idResolver.did.resolve(did!);
    const svc = (doc?.service ?? []).find((s: any) => s.id === `#${fragment}` || s.id === serviceRef);
    if (!svc || typeof svc.serviceEndpoint !== "string") {
      throw new XrpcError(502, "ManagingAppUnresolvable", `no service ${serviceRef}`);
    }
    return svc.serviceEndpoint;
  }
}
