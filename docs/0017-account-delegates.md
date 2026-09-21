# 0017 Account Delegates

## Introduction

Some atproto accounts are not people. A community, a brand, a newsroom, a bot fleet, a band: one DID, one repo, and several humans who legitimately write to it. Today the protocol offers those humans exactly one thing, the account's credentials. In practice that means a shared password, or app passwords handed around a group chat. Every write looks the same on the wire, nobody can be removed without rotating the secret, and nothing records who actually did what.

The permissioned data proposal makes this sharper. A community is naturally a space authority: a DID with spaces under it, a host that decides who may read, and members whose records live in their own repos inside those spaces. Almost everything a community does fits that shape without the community itself ever writing anything. But a few things do not. Pinning a thread, accepting a submission into a pool, applying a label, publishing the community's own profile in an app: these are records the *community* has to author, and the person authoring them is a moderator who should never hold the community's keys.

The obvious answer is to let a person sign in *as* the account. The account's OAuth authorization server, when an app signs in with the account's identifier, runs a nested login against the person's own PDS, looks up their standing, and narrows the grant to what that standing allows. This can be made to work end to end with no changes in the app. But it needs hooks in the OAuth provider, a second session in every app, a nested login on every sign-in, and above all it requires the account to live on a PDS whose authorization server has been taught the policy. A community run this way cannot be an ordinary account on an ordinary PDS.

This proposal takes the role lookup out of the authorization server and puts the *fact* it was looking up where it belongs: on the account. An account names its **delegates**, the DIDs that may write to it and how far. A delegate writes to the account by authenticating **as themselves**, with a service auth token from their own PDS, and naming the account as the `repo`. The account's PDS checks the delegation, bounds the write, commits it under the account's key, and remembers who asked. No new token class, no OAuth change, no second session, and the account can live anywhere.

### Relationship to existing mechanisms

| | Shared password / app passwords | Sign in as the account | Account delegates (this proposal) |
|---|---|---|---|
| Who authenticates | nobody in particular | the person, via a nested login at the account's AS | the person, at their own PDS |
| What the app holds | a session for the account | a second session for the account | its ordinary session for the person |
| Where the policy lives | nowhere | hooks inside the account's OAuth provider | the account's delegate config on its PDS |
| Account can be on any PDS | yes | no | yes |
| Attribution | none | `act` claim, host-side audit | recorded by the account's PDS per write |
| Revocation | rotate the secret | revoke tokens | remove the delegate |
| Protocol change | none | OAuth provider hooks | account config + one auth path on write methods |

## Goals

- A DID can let other DIDs write to its repos, bounded by collection and action, without sharing any secret.
- The delegate authenticates with what they already have: their own account, their own PDS, their own app session.
- The account's PDS enforces the bounds itself, with the same permission matching it already applies to OAuth tokens.
- Every delegated write is attributable to the delegate after the fact, and revocable by the account.
- Both static lists and dynamic policy (a service that computes "who is a moderator right now") are supported, mirroring `simplespace`.
- No change to the OAuth authorization server, the token format, the firehose, or the repo format.

## Non-goals

- Delegated **reads** of an account's public repo (already public) or of spaces the delegate is a member of (they read as themselves). A delegate obtaining a space credential *as the account* is included, narrowly, because a community's own private records are otherwise unreachable to its moderators.
- Transitive delegation. A delegate cannot name delegates.
- Governance. Who *should* be a delegate is the account's business, or its managing app's.
- Visible attribution in the record or on the firehose. The commit is the account's. An app that wants "posted by alice on behalf of the club" puts that in its own record schema.

## Overview

```
┌────────────┐      ┌──────────────┐        ┌────────────────────┐
│  Alice     │      │  Alice's PDS │        │  Club's PDS        │
│  (in app)  │      │  (any)       │        │  (any)             │
└─────┬──────┘      └──────┬───────┘        └─────────┬──────────┘
      │  1. accept gallery        │                    │
      │──────────────────────────►│                    │
      │  2. getServiceAuth(aud = club's PDS,           │
      │       lxm = com.atproto.repo.createRecord)     │
      │◄──────────────────────────│                    │
      │  3. createRecord(repo = did:plc:club, …)       │
      │     Authorization: Bearer <service auth>       │
      │───────────────────────────────────────────────►│
      │                           │   4. is alice a delegate of club?
      │                           │      (list, or ask the managing app)
      │                           │   5. do her permissions cover
      │                           │      create social.grain.group.item?
      │                           │   6. commit under club's key,
      │                           │      record (uri, alice, now)
      │◄───────────────────────────────────────────────│
      │  7. { uri, cid }          │                    │
```

Step 2 is what any app already does before calling an AppView or a feed generator on the user's behalf; it is gated by the app's `rpc:` OAuth permission at Alice's PDS. Step 3 is the ordinary write method with one difference, `repo` is not the caller. Steps 4 through 6 are the whole of this proposal.

## Delegates

A delegate is a DID that an account has authorized to write to it. The account's PDS keeps, per account, a **delegate configuration**:

| Field | Values | Description |
|---|---|---|
| `policy` | `delegate-list` \| `managing-app` | How the PDS decides whether a DID is a delegate and what it may do. Default `delegate-list`. |
| `managingApp` | service identifier (DID + fragment) | Consulted when `policy` is `managing-app`. |
| delegates | list of delegate entries | Consulted when `policy` is `delegate-list`. |

A **delegate entry**:

| Field | Type | Description |
|---|---|---|
| `did` | DID | The delegate. |
| `permissions` | array of permission strings | What the delegate may do, in the [auth scopes](../0011-auth-scopes/) string syntax. Only `repo:`, `space:`, and `blob:` permissions are meaningful; a PDS MUST reject entries containing anything else (`rpc:`, `account:`, `identity:`, `include:`). |
| `label` | string, optional | Free text for the account's own settings screen ("alice, moderator"). |
| `expiresAt` | datetime, optional | After which the entry is ignored. |
| `createdAt` | datetime | Set by the PDS. |

Permissions are the same strings an OAuth grant carries, matched by the same code. A delegate entry therefore reads exactly like a granted scope, and the PDS enforces it with the matcher it already has:

```
repo:social.grain.group.item?action=create&action=delete
space:social.grain.group?authority=self&skey=pool&collection=*&action=create&action=update&action=delete
blob:*/*
```

`authority=self` in a `space:` permission refers to the account being written to, not the delegate.

### The default is no delegates

An account with no configuration behaves exactly as today. `policy` defaults to `delegate-list` with an empty list, so a delegated write to an account that has never heard of delegates is refused with the same error it gets now.

### Managing delegates

Delegates are a credential-equivalent setting, like an app password. The management methods (below) require an OAuth session for the account itself holding the new `account:delegates` permission, or a legacy full-access session. They are never available through a delegated write, through an app password, or to a delegate. A delegate cannot add, change, or remove delegates, including their own entry.

### The `managing-app` policy

When `policy` is `managing-app`, the PDS does not keep a list. On a delegated write it asks the named service whether the writer is a delegate and what they may do, by calling `com.atproto.server.checkDelegate` on the managing app, exactly as a `simplespace` authority calls `checkUserAccess`. The PDS signs the call as the account (`iss` = the account DID, `aud` = the managing app's service identifier), so the managing app can verify it comes from the account's actual host.

The managing app answers with the delegate's permissions and an optional `expiresAt`. An empty permission list means "not a delegate". The PDS MAY cache the answer until `expiresAt` or, absent one, for a short implementation-defined period (the reference implementation proposes five minutes). A managing app that wants fast revocation returns short expiries.

This is the policy a community host uses. The host holds the roles; the community's account, on whatever PDS it lives on, says "ask `did:web:host.example#community` who may write as me". The host needs no repos, no keys, and no credential for the community. When a moderator is ejected, the host's next answer is empty.

### Trust

A managing app is trusted exactly as far as the account's controller is, since only the controller can name one. A compromised managing app can make anyone a delegate with any permission over that one account's repos. That is the same blast radius as a compromised `simplespace` managing app deciding who may read a space, and the same as the controller themselves misbehaving. A PDS operator MAY restrict which services accounts on their PDS may name, as operator policy rather than protocol.

## The delegated write

### Authentication

A delegate authenticates with an atproto [service auth](https://atproto.com/specs/xrpc#inter-service-authentication-jwt) token, as revised in [0014](../0014-service-auth-revised/):

| Claim | Value |
|---|---|
| `iss` | the delegate's DID |
| `aud` | the account's PDS, as `did:web:pds.example#atproto_pds` (a bare DID accepted during the 0014 transition) |
| `lxm` | the method being called, required |
| `exp` | at most 60 seconds out |
| `jti` | required; the PDS MUST refuse a `jti` it has already accepted within the token's lifetime |

The token is minted by the delegate's own PDS through `com.atproto.server.getServiceAuth`, which is available to an app only under a covering `rpc:` OAuth permission (see [the app side](#the-app-side)). The PDS verifies the signature against the delegate's `#atproto` key by resolving their DID document, the verification every PDS already performs for `notifyWrite` and for inbound account migration.

This is deliberately *not* a new token class. The permissioned data delegation token is its own class because it is exchanged for a credential and must not be usable as a call. A delegated write *is* a call, method-bound and short-lived, and service auth is the credential atproto already has for one party calling a service on another party's behalf.

### Authorization

On a write method, the PDS resolves `repo` to an account as it does today. If the account is the caller, nothing changes. If it is not:

1. The request MUST be authenticated with service auth. An OAuth or app-password session for a different account is refused as today.
2. The account MUST have the caller as a delegate under its policy: present in its list, unexpired, or affirmed by its managing app.
3. The write MUST be covered by the delegate's permissions, evaluated per record with the same `repo:` / `space:` / `blob:` matching an OAuth session gets. `applyWrites` is covered only if every operation in the batch is.
4. The account MUST be active: the existing takedown and deactivation checks apply to the account being written to, not only to the caller.

Only then is the write applied, committed and signed by the account's own signing key, indistinguishable on the firehose and in the repo from any other write by that account.

### Surface

The methods that accept a delegated caller, and the permission that covers each:

| Method | Covered by |
|---|---|
| `com.atproto.repo.createRecord` / `putRecord` / `deleteRecord` / `applyWrites` | `repo:` |
| `com.atproto.repo.uploadBlob` | `blob:` (see note) |
| `com.atproto.space.createRecord` / `putRecord` / `deleteRecord` / `applyWrites` | `space:` with a write action |
| `com.atproto.space.getDelegationToken` | `space:` with `read` |
| `com.atproto.simplespace.createSpace` / `updateSpace` / `deleteSpace` / `putMember` / `removeMember` | `space:` with the matching `manage` verb |

`uploadBlob` has no `repo` parameter today because the blob always lands in the caller's store. This proposal adds an optional `repo` parameter so a delegate can upload into the account's blob store; the blob is then referenced from a delegated record write as usual.

`getDelegationToken` is the one read on the list. A community's own records in its own private space are readable only with a space credential obtained *as the community*. Letting a delegate with `space:…?action=read` mint the delegation token as the account closes that gap without introducing any other form of delegated read. The resulting space credential is bound to the delegate's app key and expires like any other.

Every other method refuses a delegated caller, including all of `com.atproto.server.*`, `com.atproto.identity.*`, and the account, email, and password surface. There is no path from delegate to controller.

### Attribution

For every delegated write the PDS records the delegate's DID, the URI and CID written, the method, and the time. This is account state, exposed to the account through `listDelegatedWrites` and kept for as long as the PDS keeps its other per-account logs. It is not on the firehose and not in the commit.

A delegate is not a co-author. If an application wants a reader to see "accepted by alice", it defines that in its own record. What the protocol guarantees is that the account can always find out.

### Rate limits

Repo write rate limits are keyed by the caller's DID today. For delegated writes the PDS SHOULD count against both the account and the delegate, so a delegate cannot exhaust an account's budget and an account cannot launder writes through many delegates.

## The app side

An app acting for a delegate needs nothing new from the protocol; it needs to do two things it already knows how to do.

**Request the permission.** At the person's PDS, the app asks for an `rpc:` permission covering the write methods at the account's PDS:

```
rpc:com.atproto.repo.applyWrites?aud=did:web:pds.example#atproto_pds
```

`aud=*` also works and is what a general-purpose client would request, since it cannot know in advance where the accounts its user is a delegate of are hosted. The consent screen today renders `rpc:` permissions as a generic "perform actions on your behalf at …". A permission set published under `com.atproto` would make this legible in one line:

```
com.atproto.repo.delegatedWrites
  "Write to accounts that have made you a delegate"
  rpc: com.atproto.repo.{createRecord,putRecord,deleteRecord,applyWrites,uploadBlob}
       aud=*
```

Two constraints of permission sets as they stand shape this. An `include:` scope may carry an `aud`, but only a specific service, never `*`; so a set meant for general-purpose clients has to carry `aud=*` itself, and an app that only ever acts for one host asks for the raw `rpc:` permission with that host as `aud` instead. And a set may only include methods under its own NSID authority, so the `com.atproto.space.*` write methods need a sibling set, `com.atproto.space.delegatedWrites`, of the same shape.

**Make the call.** For each write the app mints a service auth token from the user's session (`getServiceAuth` with the account's PDS as `aud` and the method as `lxm`) and sends the write to the account's PDS with `repo` set to the account. The app finds the account's PDS the way it finds anything about a DID, by resolving its document. An SDK can hide all of this behind something like `agent.asDelegateOf(did)`.

The app does not need to know why the user may write to that account, and does not learn it. A refusal is a `403` with a named error. The user experience is one login, one session, and a button that either works or says why not.

### There is no sign-in as the account

This is the point most worth being explicit about, because it is the opposite of how the shared-account problem is usually solved. A person never logs in as the community. The flow, from their side:

1. **Sign in as yourself, once.** Ordinary OAuth against your own PDS. Among the permissions the app requests is the delegated-writes set above. That is the only consent that ever happens.
2. **Choose the account in the app.** "Acting as Peninsula Riders" is a mode the app shows, not a second session. Nothing about the person's session changes.
3. **Each write, the app addresses the account.** It resolves the account's DID to its PDS, asks the person's own PDS for a service auth token for that PDS and that method, and sends the write with `repo` set to the account.
4. **The account's PDS decides.** It verifies the token against the person's DID document, checks the delegation under the account's policy, bounds the write, commits it as the account, and logs the person.
5. **Reads need nothing new.** The account's public repo is public. Its permissioned spaces the person reads as themselves, with whatever standing they have there.

The account's own credentials still exist, but they are the controller's root credential, like a PDS password: used to set the policy and edit the list, never to post.

Compare a sign-in-as design, where the app signs in with the account's identifier, lands on the account's authorization server, and that server must authenticate the person and know their standing before it can issue a narrowed session. That is two logins, two sessions, and an authorization server that has to be taught the policy. Here there is one login, one session, and the policy is a fact on the account that a stock PDS reads. Apps that cannot address a `repo` other than the session's own are the case for [sign-in-as done generically](#future-work), on top of this primitive.

### Discovery

Nothing above tells an app which accounts a person may act for. `getDelegateConfig` is the account's view; there is no delegate's view, and the proposal does not add one. An app learns it out of band today: a community host publishes its roster, a brand tells its staff, or the person picks an account and the write either works or says `NotDelegate`.

That is a real gap, and the options each cost something:

- **A query on the person's PDS**, `listDelegations`, answering "which accounts name me". Their PDS has no way to know; it would need every account's PDS to notify it on `putDelegate` and every managing app to notify it on a role change, which is a fan-out the rest of the design avoids.
- **A record the account or its managing app publishes.** In the account's public repo it is simple and crawlable but makes the list public, which a brand may not want. In a [permissioned space](../0016-permissioned-data/) under the account, readable by the people it names, it is private and needs no new machinery: a delegate reads the account's space as themselves and finds their own entry. This is where a community keeps its membership and roles already, so for communities discovery is a space read the app is doing anyway. It answers "does this account name me, and as what", not "which accounts name me"; and it states what the account intends, while the write remains the enforcement.
- **Leave it to the managing app.** A community host already knows its members and roles, and can answer "your communities" for a caller through its own methods. A brand account with a list can answer from `getDelegateConfig` through whatever tooling its staff use.

The proposal takes the second, in its permissioned-space form, as the recommended convention, and the third as the fallback where there is no space to read. Neither is protocol: discovery is a product surface, and the one option that would make it protocol, the first, fans out to every PDS. It is listed under [open questions](#open-questions) because that judgment may not survive contact with general-purpose clients, which know no community in advance and would want an enumeration.

## Managing-app interaction

```
┌──────────────┐                     ┌──────────────────────┐
│  Club's PDS  │                     │  Community host      │
│              │  checkDelegate      │  did:web:host#comm   │
│   iss = club │────────────────────►│                      │
│   aud = host │  { account, did }   │  reads roles         │
│              │◄────────────────────│  { permissions: […], │
│              │                     │    expiresAt }       │
└──────────────┘                     └──────────────────────┘
```

The managing app is the only party that knows what a "moderator" is. It projects that onto the permission strings the PDS understands. The PDS never learns the word.

## Lifecycle

**Revocation.** Removing a delegate takes effect on the next write. Under `managing-app`, revocation is bounded by the cache lifetime the managing app itself chose. There are no long-lived tokens to hunt down, because there are no tokens: each delegated write carries a fresh 60-second service auth token.

**The account is deactivated or taken down.** Delegated writes are refused with the account's own status errors.

**The delegate's account is deactivated or deleted.** Their PDS stops minting service auth for them. An account SHOULD also be able to see delegates whose DIDs no longer resolve and clean them up; the PDS MAY do this on its own.

**Migration.** The delegate configuration is host state, like preferences and app passwords. It is not in the repo and does not move with the CAR. Migration tooling SHOULD carry it (`getDelegateConfig` on the old host, `updateDelegateConfig` and `putDelegate` on the new), and the specification should say so explicitly rather than let it be discovered.

**Key rotation.** Unaffected. Delegates are identified by DID, not by key.

## Security considerations

**A delegate is bounded, not trusted.** A delegate's permissions are the ceiling on what a compromise of the delegate, their PDS, or any app they authorized can do to the account. The account's identity, email, password, and delegate list are never reachable. This is strictly better than an app password, which today is the tool people actually use for this job.

**Confused deputy.** An app holding `rpc:…?aud=*` can write, on the user's behalf, to *any* account that has made them a delegate. The user consented to that at their PDS, but the consent screen should say it plainly, which is what the permission set above is for. Apps that only ever act for one host SHOULD request an `aud`-specific permission. The account's own permission bounds apply regardless of what the app was granted.

**Replay.** Service auth tokens are bearer tokens. The `jti` single-use requirement and the 60-second window limit a captured token to one write within a minute, and the reference PDS already has the machinery: the replay store it uses for DPoP proofs, and the single-use check it applies to permissioned-data delegation tokens.

**Impersonating the account's PDS.** A managing app verifies `checkDelegate` calls by resolving the account's DID document and checking the call was signed by its `#atproto` key. A managing app MUST NOT accept calls signed by anything else, and MUST check `aud` names itself.

**Content responsibility.** The record is the account's. The account's PDS hosts it, the account's controller answers for it, and moderation applies to the account. The delegate log exists so that the controller can answer the question "who did this", and so that a PDS operator has something to act on when a delegate abuses many accounts at once.

**Operator policy.** A hosted PDS may reasonably require that a `managing-app` be on an allowlist, or cap the number of delegates, or forbid `repo:*`. None of that is protocol.

## Worked example

Peninsula Riders is a cycling club. Its account `did:plc:club` lives on `pds.example`, an ordinary PDS. Its community host, `did:web:host.example#community`, holds the roles.

1. At creation the founder, holding the club's session, sets `policy: managing-app, managingApp: did:web:host.example#community`. The founder's own account is `did:plc:fay` on `bsky.social`.
2. The host, needing to write the club's public roster, is itself a delegate: it answers its own `checkDelegate` for `did:web:host.example` with `repo:community.example.roster`. The host holds no credential for the club, ever.
3. Alice, `did:plc:alice` on `bsky.social`, is made a moderator on the host. Nothing happens at `pds.example`.
4. Alice opens Grain, an app that knows nothing about the club's host. Her session there has `rpc:com.atproto.repo.applyWrites?aud=*` from the delegated-writes permission set she approved at sign-in.
5. A member offered a gallery to the club's pool. Alice taps *Accept*. Grain resolves `did:plc:club` to `pds.example`, asks `bsky.social` for a service auth token addressed to `did:web:pds.example#atproto_pds` bound to `applyWrites`, and calls `applyWrites` at `pds.example` with `repo: did:plc:club` and one create of `social.grain.group.item`.
6. `pds.example` sees `repo ≠ iss`, verifies the token against Alice's DID document, asks `host.example` `checkDelegate({ account: did:plc:club, did: did:plc:alice })`, and receives `repo:social.grain.group.item?action=create&action=delete` with a five-minute expiry.
7. The write is covered. `pds.example` commits it under the club's key, emits it on the firehose as the club, and logs `(uri, did:plc:alice, applyWrites, now)`.
8. Grain's indexer sees the club create an item, as it would have if the club had a person behind a keyboard.
9. A week later the host ejects Alice. Its next `checkDelegate` answer is empty, and within five minutes her *Accept* button returns `NotDelegate`.
10. The club moves to another PDS. Its records move as a CAR; its delegate configuration is one `updateDelegateConfig` call on the new host, because it is two fields.

## XRPC API

All under `com.atproto.server`, alongside the app-password methods they resemble.

| Method | Served by | Type | Auth | Description |
|---|---|---|---|---|
| `getDelegateConfig` | PDS | query | OAuth `account:delegates` | The account's policy, managing app, and delegates. |
| `updateDelegateConfig` | PDS | procedure | OAuth `account:delegates` | Set `policy` and `managingApp`. |
| `putDelegate` | PDS | procedure | OAuth `account:delegates` | Add or replace a delegate entry. |
| `removeDelegate` | PDS | procedure | OAuth `account:delegates` | Remove a delegate. |
| `listDelegatedWrites` | PDS | query | OAuth `account:delegates` | The attribution log, newest first, with a cursor. |
| `checkDelegate` | managing app | query | service auth from the account | Given `account` and `did`, the delegate's permissions and an optional `expiresAt`. |

### Lexicon sketches

```json
{
  "lexicon": 1,
  "id": "com.atproto.server.defs",
  "defs": {
    "delegate": {
      "type": "object",
      "required": ["did", "permissions", "createdAt"],
      "properties": {
        "did": { "type": "string", "format": "did" },
        "permissions": {
          "type": "array",
          "items": { "type": "string", "maxLength": 512 },
          "description": "Permission strings in auth-scope syntax. Only repo:, space:, and blob: are accepted."
        },
        "label": { "type": "string", "maxGraphemes": 64 },
        "expiresAt": { "type": "string", "format": "datetime" },
        "createdAt": { "type": "string", "format": "datetime" }
      }
    },
    "delegateListPolicy": { "type": "object", "properties": {} },
    "managingAppPolicy": {
      "type": "object",
      "required": ["managingApp"],
      "properties": {
        "managingApp": { "type": "string", "description": "Service identifier: a DID with a service fragment." }
      }
    }
  }
}
```

```json
{
  "lexicon": 1,
  "id": "com.atproto.server.checkDelegate",
  "defs": {
    "main": {
      "type": "query",
      "description": "Served by an account's managing app. Asked by the account's PDS whether a DID may write as the account, and how far.",
      "parameters": {
        "type": "params",
        "required": ["account", "did"],
        "properties": {
          "account": { "type": "string", "format": "did" },
          "did": { "type": "string", "format": "did" }
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["permissions"],
          "properties": {
            "permissions": {
              "type": "array",
              "items": { "type": "string" },
              "description": "Empty when the DID is not a delegate."
            },
            "expiresAt": { "type": "string", "format": "datetime" }
          }
        }
      }
    }
  }
}
```

`uploadBlob` gains an optional `repo` parameter (DID or handle) with the same semantics as on the record methods.

## Reference implementation notes

Against the `permissioned-data-alpha` branch of `bluesky-social/atproto` at `3827ed0a`, the change is contained:

- **Account manager.** A `delegate_config` and a `delegate` table, one migration after `007-lexicon-failures-index`, plus a `delegated_write` log table. Four methods under `api/com/atproto/server/`, siblings of `createAppPassword.ts`.
- **Auth.** A `delegatedWrite` verifier in `auth-verifier.ts` that accepts either the existing `authorization()` output or a service auth token with `audience` checked against the PDS's own DID, `lxm` required, and `jti` consumed. `verifyServiceJwt` already resolves the issuer's `#atproto` key.
- **Handlers.** The `did !== auth.credentials.did` checks in `repo/createRecord.ts`, `putRecord.ts`, `deleteRecord.ts`, `applyWrites.ts` and the `repo must match authenticated user` checks in `space/*.ts` and `space/util.ts` become one `assertRepoAccess(auth, repo, writes)` that, for a service-auth caller, loads the delegate's permissions and evaluates them with `@atproto/oauth-scopes`' `ScopePermissions`, the class the OAuth path already uses. `uploadBlob` learns the `repo` parameter.
- **Managing app.** `simplespace/manager.ts` already implements the pattern of signing a call as the authority and caching a policy answer; `checkDelegate` follows it.
- **Nothing** in `@atproto/oauth-provider`, `@atproto/oauth-provider-ui`, the token store, the repo format, or the sync protocol.

A community host built this way is a managing app that answers `checkDelegate` from its role records. It holds no keys and no credential for any community, and the community's account can live on any PDS.

## Future work

**Sign-in-as, done generically.** An OAuth provider can be taught to let a person sign in as an account by consulting domain-specific hooks. With delegates on the account, a provider could offer the same thing with *no* hooks: when a client asks to sign in as account X and the person authenticating is a delegate of X, issue a token for X narrowed to their delegate permissions, with `act.sub` set. The delegate configuration is exactly the policy those hooks were standing in for. This would give apps that must never learn about delegation a session-shaped alternative, on top of the same primitive.

**Permission sets in delegate entries.** A managing app projecting "moderator" onto twenty permission strings would rather name one set. Sets today are scoped to their publisher's NSID authority, which is the wrong boundary here; whether to relax that for delegate entries, or to define a role-shaped set type, is open.

**Client restriction.** A delegate entry could name the apps (`client_id`) through which it may be exercised, enforced via a client attestation as spaces do with `appAccess`. Left out to keep the first version small.

## Open questions

- Is service auth the right carrier, or does the 60-second, single-use token become an annoyance for apps that write in bursts? `applyWrites` batches most of it away; a longer `exp` under the delegate's own PDS policy is the escape hatch.
- Should `checkDelegate` receive the intended collection and action, so a managing app can answer narrowly per write rather than return a delegate's whole ceiling? The whole-ceiling answer caches better and mirrors how OAuth grants work; the per-write answer leaks less.
- Should delegated writes be marked in the account's repo at all, for example as an optional commit field that relays ignore? This proposal says no, on the grounds that the account chose to let this happen and readers should not have to reason about it. It is the question most likely to come back.
- Whether `getDelegationToken` belongs on the delegated surface, or whether communities should simply keep the records their moderators need to read in a space those moderators are members of.
- Delegate-side discovery. A person can learn whether a given account names them by reading that account's permissioned space, but has no protocol-level way to enumerate the accounts that do; see [Discovery](#discovery). Whether general-purpose clients need the enumeration, and what would provide it without fan-out, is open.
