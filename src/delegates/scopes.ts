// Narrowing a requested OAuth scope to what a delegate may do. A delegated
// session is issued for the account, but its scope is the intersection of
// what the client asked for and the delegate's permissions: never more than
// the account allowed the delegate, never more than the client asked for.
//
// Only repo:, blob:, and space: permissions can survive, because those are
// the only kinds a delegate entry may hold. rpc:, account:, identity:, and the
// transition:* scopes are dropped outright: a delegate is bounded to writes,
// and there is no path from a delegate to the account itself.
import { BlobPermission, RepoPermission } from "@atproto/oauth-scopes";

type Rp = NonNullable<ReturnType<typeof RepoPermission.fromString>>;
type Bp = NonNullable<ReturnType<typeof BlobPermission.fromString>>;

function intersectRepo(r: Rp, d: Rp): string | null {
  const collection = r.collection.includes("*")
    ? [...d.collection]
    : d.collection.includes("*")
      ? [...r.collection]
      : r.collection.filter((c) => d.collection.includes(c));
  const action = r.action.filter((a) => d.action.includes(a));
  if (!collection.length || !action.length) return null;
  return new RepoPermission(collection as any, action as any).toString();
}

/** Does accept pattern `a` cover mime pattern `b`? */
const covers = (a: string, b: string) => a === "*/*" || a === b || (a.endsWith("/*") && b.startsWith(a.slice(0, -1)));

function intersectBlob(r: Bp, d: Bp): string | null {
  const accept = new Set<string>();
  for (const x of r.accept) {
    for (const y of d.accept) {
      if (covers(y, x)) accept.add(x);
      else if (covers(x, y)) accept.add(y);
    }
  }
  if (!accept.size) return null;
  return new BlobPermission([...accept] as any).toString();
}

/**
 * The intersection of a requested scope (already expanded, no `include:`)
 * with a delegate's permission strings, as a scope string. `atproto` is kept
 * when requested; everything a delegate may not hold is dropped.
 */
export function narrowScope(requested: string, permissions: string[]): string {
  const out = new Set<string>();
  const repoPerms = permissions.map((p) => RepoPermission.fromString(p)).filter((p): p is Rp => !!p);
  const blobPerms = permissions.map((p) => BlobPermission.fromString(p)).filter((p): p is Bp => !!p);
  for (const scope of requested.split(" ").filter(Boolean)) {
    if (scope === "atproto") {
      out.add(scope);
    } else if (scope.startsWith("repo:")) {
      const r = RepoPermission.fromString(scope);
      if (!r) continue;
      for (const d of repoPerms) {
        const s = intersectRepo(r, d);
        if (s) out.add(s);
      }
    } else if (scope.startsWith("blob:")) {
      const r = BlobPermission.fromString(scope);
      if (!r) continue;
      for (const d of blobPerms) {
        const s = intersectBlob(r, d);
        if (s) out.add(s);
      }
    } else if (scope.startsWith("space:")) {
      // Space permissions carry several parameters; the prototype keeps one
      // only when the delegate holds it verbatim. A full intersection follows
      // the repo pattern above.
      if (permissions.includes(scope)) out.add(scope);
    }
    // rpc:, account:, identity:, transition:* — never in a delegated session.
  }
  return [...out].join(" ");
}
