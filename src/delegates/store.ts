// The account's delegate configuration, as the RFC describes it: host state
// on the account's PDS, next to app passwords and preferences. SQLite via
// node:sqlite so a clone needs no native build.
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

export type DelegatedWrite = {
  id: number;
  account: string;
  delegate: string;
  lxm: string;
  uri: string;
  cid?: string;
  at: string;
};

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
      create table if not exists delegated_write (
        id integer primary key autoincrement,
        account text not null,
        delegate text not null,
        lxm text not null,
        uri text not null,
        cid text,
        at text not null
      );
      create table if not exists used_jti (
        jti text primary key,
        exp integer not null
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
        "insert into delegated_write (account, delegate, lxm, uri, cid, at) values (?, ?, ?, ?, ?, ?)",
      )
      .run(w.account, w.delegate, w.lxm, w.uri, w.cid ?? null, new Date().toISOString());
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
