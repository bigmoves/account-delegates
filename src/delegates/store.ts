// The account's delegate configuration, as the RFC describes it: host state
// on the account's PDS, next to app passwords and preferences. SQLite via
// node:sqlite so a clone needs no native build.
//
// Besides the configuration and the write log, this holds the small amount
// of state a delegated *session* needs: which authorization request a
// delegate signed in for, which device account was created for it, and
// which tokens came out of it.
import { DatabaseSync } from "node:sqlite";

export type Policy = "delegate-list" | "managing-app";

export type DelegateConfig = {
  policy: Policy;
  managingApp?: string;
};

export type Delegate = {
  did: string;
  permissions: string[];
  label?: string;
  expiresAt?: string;
  createdAt: string;
};

/** How a delegated write reached the PDS. */
export type Via = "service-auth" | "session";

export type DelegatedWrite = {
  id: number;
  account: string;
  delegate: string;
  lxm: string;
  uri: string;
  cid?: string;
  via: Via;
  at: string;
};

type Binding = { account: string; delegate: string };

export class DelegateStore {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      create table if not exists delegate_config (
        account text primary key,
        policy text not null,
        managing_app text
      );
      create table if not exists delegate (
        account text not null,
        did text not null,
        permissions text not null,
        label text,
        expires_at text,
        created_at text not null,
        primary key (account, did)
      );
      -- Controllers: DIDs that may manage this configuration, for an account
      -- that has no password of its own (one created for a community from an app).
      create table if not exists delegate_controller (
        account text not null,
        did text not null,
        created_at text not null,
        primary key (account, did)
      );
      -- Accounts created with no usable credentials: their controllers are the
      -- only way in, so the last one may not be removed.
      create table if not exists delegated_account (
        account text primary key,
        created_by text not null,
        created_at text not null
      );
      create table if not exists delegated_write (
        id integer primary key autoincrement,
        account text not null,
        delegate text not null,
        lxm text not null,
        uri text not null,
        cid text,
        via text not null default 'service-auth',
        at text not null
      );
      create table if not exists used_jti (
        jti text primary key,
        exp integer not null
      );
      -- Sign-in as the account. Each row binds one step of the OAuth flow to
      -- the delegate who authenticated for it.
      create table if not exists delegated_request (
        request_id text primary key,
        account text not null,
        delegate text not null,
        device_id text not null,
        at text not null
      );
      create table if not exists delegated_device (
        device_id text not null,
        account text not null,
        delegate text not null,
        at text not null,
        primary key (device_id, account)
      );
      create table if not exists delegated_authorization (
        code_challenge text primary key,
        account text not null,
        delegate text not null,
        at text not null
      );
      create table if not exists delegated_session (
        jti text primary key,
        account text not null,
        delegate text not null,
        client_id text,
        at text not null
      );
    `);
  }

  getConfig(account: string): DelegateConfig {
    const row = this.db
      .prepare("select policy, managing_app from delegate_config where account = ?")
      .get(account) as { policy: Policy; managing_app: string | null } | undefined;
    if (!row) return { policy: "delegate-list" };
    return { policy: row.policy, managingApp: row.managing_app ?? undefined };
  }

  setConfig(account: string, cfg: DelegateConfig) {
    this.db
      .prepare(
        "insert into delegate_config (account, policy, managing_app) values (?, ?, ?) " +
          "on conflict(account) do update set policy = excluded.policy, managing_app = excluded.managing_app",
      )
      .run(account, cfg.policy, cfg.managingApp ?? null);
  }

  listControllers(account: string): string[] {
    return (this.db.prepare("select did from delegate_controller where account = ? order by created_at").all(account) as { did: string }[]).map((r) => r.did);
  }

  isController(account: string, did: string): boolean {
    return !!this.db.prepare("select 1 from delegate_controller where account = ? and did = ?").get(account, did);
  }

  setControllers(account: string, dids: string[]) {
    const now = new Date().toISOString();
    this.db.prepare("delete from delegate_controller where account = ?").run(account);
    const ins = this.db.prepare("insert or ignore into delegate_controller (account, did, created_at) values (?, ?, ?)");
    for (const did of dids) ins.run(account, did, now);
  }

  markDelegatedAccount(account: string, createdBy: string) {
    this.db.prepare("insert or ignore into delegated_account (account, created_by, created_at) values (?, ?, ?)").run(account, createdBy, new Date().toISOString());
  }

  /** True for an account this PDS created without usable credentials of its own. */
  isDelegatedAccount(account: string): boolean {
    return !!this.db.prepare("select 1 from delegated_account where account = ?").get(account);
  }

  listDelegates(account: string): Delegate[] {
    const rows = this.db
      .prepare("select * from delegate where account = ? order by created_at")
      .all(account) as any[];
    return rows.map(rowToDelegate);
  }

  getDelegate(account: string, did: string): Delegate | undefined {
    const row = this.db
      .prepare("select * from delegate where account = ? and did = ?")
      .get(account, did) as any;
    return row ? rowToDelegate(row) : undefined;
  }

  putDelegate(account: string, d: Omit<Delegate, "createdAt">) {
    this.db
      .prepare(
        "insert into delegate (account, did, permissions, label, expires_at, created_at) values (?, ?, ?, ?, ?, ?) " +
          "on conflict(account, did) do update set permissions = excluded.permissions, label = excluded.label, expires_at = excluded.expires_at",
      )
      .run(
        account,
        d.did,
        JSON.stringify(d.permissions),
        d.label ?? null,
        d.expiresAt ?? null,
        new Date().toISOString(),
      );
  }

  removeDelegate(account: string, did: string) {
    this.db.prepare("delete from delegate where account = ? and did = ?").run(account, did);
  }

  recordWrite(w: Omit<DelegatedWrite, "id" | "at">) {
    this.db
      .prepare(
        "insert into delegated_write (account, delegate, lxm, uri, cid, via, at) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(w.account, w.delegate, w.lxm, w.uri, w.cid ?? null, w.via, new Date().toISOString());
  }

  listWrites(account: string, limit = 50): DelegatedWrite[] {
    return this.db
      .prepare("select * from delegated_write where account = ? order by id desc limit ?")
      .all(account, limit) as unknown as DelegatedWrite[];
  }

  /** Single use: true the first time a jti is seen, false on every replay within its lifetime. */
  consumeJti(jti: string, exp: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare("delete from used_jti where exp < ?").run(now);
    try {
      this.db.prepare("insert into used_jti (jti, exp) values (?, ?)").run(jti, exp);
      return true;
    } catch {
      return false;
    }
  }

  // --- Sign-in as the account -------------------------------------------------

  /** A delegate authenticated for this authorization request, on this device. */
  putRequest(requestId: string, b: Binding & { deviceId: string }) {
    this.db.prepare("delete from delegated_request where at < ?").run(new Date(Date.now() - 15 * 60 * 1000).toISOString());
    this.db
      .prepare("insert or replace into delegated_request (request_id, account, delegate, device_id, at) values (?, ?, ?, ?, ?)")
      .run(requestId, b.account, b.delegate, b.deviceId, new Date().toISOString());
  }

  getRequest(requestId: string): (Binding & { deviceId: string }) | undefined {
    const row = this.db.prepare("select account, delegate, device_id from delegated_request where request_id = ?").get(requestId) as any;
    return row ? { account: row.account, delegate: row.delegate, deviceId: row.device_id } : undefined;
  }

  deleteRequest(requestId: string) {
    this.db.prepare("delete from delegated_request where request_id = ?").run(requestId);
  }

  /** The device account for `account` on this device was created by a delegate sign-in, not by the account's own credentials. */
  putDevice(deviceId: string, b: Binding) {
    this.db
      .prepare("insert or replace into delegated_device (device_id, account, delegate, at) values (?, ?, ?, ?)")
      .run(deviceId, b.account, b.delegate, new Date().toISOString());
  }

  getDevice(deviceId: string, account: string): Binding | undefined {
    const row = this.db.prepare("select account, delegate from delegated_device where device_id = ? and account = ?").get(deviceId, account) as any;
    return row ?? undefined;
  }

  deleteDevice(deviceId: string, account: string) {
    this.db.prepare("delete from delegated_device where device_id = ? and account = ?").run(deviceId, account);
  }

  /** The authorization (identified by its PKCE challenge, which every token minted from it carries) belongs to a delegate. */
  putAuthorization(codeChallenge: string, b: Binding) {
    this.db.prepare("delete from delegated_authorization where at < ?").run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    this.db
      .prepare("insert or replace into delegated_authorization (code_challenge, account, delegate, at) values (?, ?, ?, ?)")
      .run(codeChallenge, b.account, b.delegate, new Date().toISOString());
  }

  getAuthorization(codeChallenge: string): Binding | undefined {
    const row = this.db.prepare("select account, delegate from delegated_authorization where code_challenge = ?").get(codeChallenge) as any;
    return row ?? undefined;
  }

  /** A token (by jti) is a delegated session: issued for `account`, exercised by `delegate`. */
  putSession(jti: string, b: Binding & { clientId?: string }) {
    this.db
      .prepare("insert or replace into delegated_session (jti, account, delegate, client_id, at) values (?, ?, ?, ?, ?)")
      .run(jti, b.account, b.delegate, b.clientId ?? null, new Date().toISOString());
  }

  getSession(jti: string): (Binding & { clientId?: string }) | undefined {
    const row = this.db.prepare("select account, delegate, client_id from delegated_session where jti = ?").get(jti) as any;
    return row ? { account: row.account, delegate: row.delegate, clientId: row.client_id ?? undefined } : undefined;
  }

  listSessions(account: string): { jti: string; delegate: string; clientId?: string; at: string }[] {
    return (this.db.prepare("select jti, delegate, client_id as clientId, at from delegated_session where account = ? order by at desc").all(account) as any[]).map((r) => ({
      ...r,
      clientId: r.clientId ?? undefined,
    }));
  }
}

function rowToDelegate(row: any): Delegate {
  return {
    did: row.did,
    permissions: JSON.parse(row.permissions),
    label: row.label ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
  };
}
