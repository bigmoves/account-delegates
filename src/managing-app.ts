// The managing app: what a community host becomes under proposal 0017. It
// holds roles, and answers one question from an account's PDS: is this DID a
// delegate of that account, and with what permissions. It holds no keys and
// no credential for any account.
import { IdResolver } from "@atproto/identity";
import { verifyJwt } from "@atproto/xrpc-server";
import express from "express";

const CHECK_DELEGATE = "com.atproto.server.checkDelegate";
/** The host's own method, in its own namespace: nothing in the protocol defines it. */
const LIST_MEMBERSHIPS = "community.example.listMemberships";

export type Role = "admin" | "moderator" | "member";

/** The host's projection of a role onto permission strings the PDS understands. */
export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: ["repo:*"],
  moderator: ["repo:social.grain.group.item?action=create&action=delete"],
  member: [],
};

export async function startManagingApp(opts: {
  port: number;
  plcUrl: string;
  /** How long a PDS may cache an answer. The RFC leaves this to the managing app. */
  ttlMs: number;
  log: (line: string) => void;
}) {
  const { port, plcUrl, ttlMs, log } = opts;
  const url = `http://localhost:${port}`;
  const did = `did:web:localhost%3A${port}`;
  const serviceRef = `${did}#community`;
  const idResolver = new IdResolver({ plcUrl });
  const roles = new Map<string, Map<string, Role>>(); // account → did → role

  const app = express();
  app.get("/.well-known/did.json", (_req, res) => {
    res.json({
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: did,
      service: [{ id: "#community", type: "CommunityHost", serviceEndpoint: url }],
    });
  });

  app.get(`/xrpc/${CHECK_DELEGATE}`, async (req, res) => {
    const account = String(req.query.account ?? "");
    const who = String(req.query.did ?? "");
    const h = req.headers.authorization;
    if (typeof h !== "string" || !h.startsWith("Bearer ")) {
      return res.status(401).json({ error: "AuthMissing", message: "service auth required" });
    }
    try {
      // Signed by the account's own key, addressed to this service, bound to this method.
      const payload = await verifyJwt(h.slice(7), serviceRef, CHECK_DELEGATE, (iss, force) =>
        idResolver.did.resolveAtprotoKey(iss, force),
      );
      if (payload.iss !== account) {
        return res.status(403).json({ error: "WrongIssuer", message: "only an account's PDS may ask about its delegates" });
      }
    } catch (err: any) {
      return res.status(401).json({ error: "InvalidToken", message: err?.message ?? String(err) });
    }
    const role = roles.get(account)?.get(who);
    const permissions = role ? ROLE_PERMISSIONS[role] : [];
    log(`  host: ${account.slice(0, 16)}… asks about ${who.slice(0, 16)}… → ${role ?? "no role"}`);
    res.json({ permissions, expiresAt: new Date(Date.now() + ttlMs).toISOString() });
  });

  // Discovery, the host's way: "which accounts hold a role for this DID here".
  // This is the RFC's third option, the managing app answering from what it
  // already knows. It is host-scoped by nature: a host can only list its own
  // communities. Left unauthenticated for the demo; a real host would want the
  // caller's service auth before revealing their memberships.
  app.get(`/xrpc/${LIST_MEMBERSHIPS}`, (req, res) => {
    const who = String(req.query.did ?? "");
    const memberships: { account: string; role: Role }[] = [];
    for (const [account, byDid] of roles) {
      const role = byDid.get(who);
      if (role) memberships.push({ account, role });
    }
    log(`  host: ${who.slice(0, 16)}… asks for their memberships → ${memberships.length}`);
    res.json({ memberships });
  });

  const server = app.listen(port);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return {
    url,
    did,
    serviceRef,
    setRole(account: string, who: string, role: Role | null) {
      if (!roles.has(account)) roles.set(account, new Map());
      if (role) roles.get(account)!.set(who, role);
      else roles.get(account)!.delete(who);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
