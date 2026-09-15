# Account delegates: a runnable prototype

A working model of [proposal 0017, Account Delegates](./docs/0017-account-delegates.md): writing to an atproto account you do not sign in to, bounded by that account, attributed to you, with no shared secret and no change to OAuth.

The problem it answers: a community, a brand, or any shared identity is one DID, and several people need to write to it. Today that means a shared password or app passwords passed around. The prototype shows the alternative the proposal describes. The account names its **delegates** and what each may do. A delegate authenticates **as themselves**, with a service auth token from their own PDS, names the account as `repo`, and the account's PDS commits the write under the account's key and remembers who asked.

## Run it

You need Node 22.13 or newer and pnpm. Nothing else: the atproto spaces alpha comes from npm.

```sh
pnpm install
pnpm demo
```

The demo brings up a PLC directory, two PDSes with account delegates, and a managing app, all in one process on ports 2700 to 2703 (override with `PLC_PORT`, `PDS_A_PORT`, `PDS_B_PORT`, `HOST_PORT`). Then it walks the flow and checks each outcome against the proposal:

1. A club account on one PDS, two people on the other.
2. Nobody is a delegate: a write as the club is refused with `NotDelegate`.
3. The club, with its own session, makes alice a delegate for one collection. An `rpc:` permission is refused. alice cannot manage the club's delegates.
4. alice writes as the club from her own PDS. The record lands under the club's DID, anyone can read it, the club's latest commit is that write, and the club's log names alice.
5. Bounds: a collection outside her permissions, a non-delegate, a replayed token, a token bound to the wrong method, and a batch with one uncovered write. Every one refused, nothing written.
6. `removeDelegate` takes effect on the next write.
7. The club switches to the `managing-app` policy. The host answers from roles only it holds, signed as the club, and the PDS caches the answer.
8. The host ejects alice. She succeeds inside the cache TTL and is refused after it.
9. The club's own writes are untouched; its session goes straight to the stock PDS.

It ends with `All checks passed.` and a non-zero exit if anything did not.

## What is in here

| Path | What it is |
|---|---|
| `src/delegates/router.ts` | The proposal's substance: the delegated write path (authenticate the delegate's service auth, resolve the delegate under the account's policy, bound the write with the same permission matcher OAuth uses, commit as the account, log it) and the management methods. Each block names where it would live in the PDS. |
| `src/delegates/store.ts` | The account's delegate configuration and write log, as host state in SQLite. |
| `src/pds.ts` | A stock alpha PDS embedded as a library with the delegate router mounted in front. No package is modified; requests the router does not claim fall through. |
| `src/managing-app.ts` | What a community host becomes: roles, and one `checkDelegate` answer. It holds no keys and no credential for any account. |
| `src/demo.ts` | The transcript above. |
| `lexicons/` | Lexicon sketches for the new methods. |
| `docs/0017-account-delegates.md` | The proposal, copied here so the repo stands alone. |

## What it proves, and what it does not

**Proved, against unmodified published packages:** a delegate writes to an account on another PDS with nothing but their own session; the write is committed and signed by the account's PDS as the account; a delegate entry expressed as `repo:` permission strings is enforced by the alpha's own `ScopePermissions` matcher; `applyWrites` is all-or-nothing; tokens are method-bound, sixty-second, and single-use; the account can list who wrote what; both policies work, with a `managing-app` consulted over real HTTP with a token the PDS signs as the account and the app verifies against the account's DID document.

**Not built here, on purpose:**

- The delegate router is an extension mounted in front of the PDS, not a patch to it. The proposal's reference-implementation notes say where each piece goes; this is the same logic one process boundary out, so that a clone runs from npm.
- The app side uses a password session and `getServiceAuth`. With OAuth the same call sits behind an `rpc:` permission, which the demo does not exercise. Nothing in the delegated path depends on how the token was minted.
- Space writes, `uploadBlob`, `getDelegationToken`, and the `simplespace` management methods are on the proposal's surface and not on the router's. They follow the `repo` pattern exactly.
- Rate limiting by both account and delegate.
- `putRecord` is served, but not shown in the demo.

## Why this shape

The opensocial community host embeds a PDS for one reason: to be the community account's OAuth authorization server, so that a person can sign in *as* the community and have their role turned into a scope. That took four patches to the OAuth provider, a nested login, and a second session in every app, and it meant a community could only live on that host. This prototype removes the reason. The policy that the provider hooks were consulting is now a fact on the account, and the host is an ordinary managing app.
