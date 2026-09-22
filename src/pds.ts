// A PDS with account delegates: the stock alpha PDS, embedded as a library,
// with the delegate routes mounted in front of it. Nothing in the PDS package
// is modified; a request the delegate router does not claim falls through.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Secp256k1Keypair, randomStr } from "@atproto/crypto";
import { PDS } from "@atproto/pds";
import express from "express";
import * as ui8 from "uint8arrays";
import { DelegateResolver } from "./delegates/resolve.ts";
import { delegatesRouter } from "./delegates/router.ts";
import { installSignInAs } from "./delegates/sign-in-as.ts";
import { DelegateStore } from "./delegates/store.ts";

export type RunningPds = {
  name: string;
  url: string;
  did: string;
  pds: PDS;
  store: DelegateStore;
  close: () => Promise<void>;
};

export async function startPds(opts: {
  name: string;
  port: number;
  plcUrl: string;
  dataDir: string;
  log: (line: string) => void;
  /**
   * Resolve every lexicon (permission sets, spaces) from this DID's repo
   * instead of the NSID's DNS authority. Dev only; the browser demo uses it to
   * publish the delegated-writes permission set locally.
   */
  lexiconDidAuthority?: string;
  /**
   * PDSes to ask about a handle typed into the sign-in-as page. Dev only: the
   * demo's `.test` handles resolve nowhere else.
   */
  handleResolvers?: string[];
}): Promise<RunningPds> {
  const { name, port, plcUrl, dataDir, log, lexiconDidAuthority } = opts;
  const dir = join(dataDir, name);
  mkdirSync(join(dir, "blobs"), { recursive: true });
  const rotation = await Secp256k1Keypair.create({ exportable: true });
  const url = `http://localhost:${port}`;
  // Distinct per instance: two PDSes on localhost would otherwise share did:web:localhost.
  const did = `did:web:localhost%3A${port}`;
  const pds = await PDS.fromEnv({
    devMode: true,
    port,
    hostname: "localhost",
    serviceDid: did,
    dataDirectory: dir,
    blobstoreDiskLocation: join(dir, "blobs"),
    didPlcUrl: plcUrl,
    plcRotationKeyK256PrivateKeyHex: ui8.toString(await rotation.export(), "hex"),
    recoveryDidKey: (await Secp256k1Keypair.create()).did(),
    jwtSecret: randomStr(32, "base32"),
    adminPassword: randomStr(16, "base32"),
    serviceHandleDomains: [".test"],
    inviteRequired: false,
    disableSsrfProtection: true,
    serviceName: `${name} (with account delegates)`,
    lexiconDidAuthority,
    // required by the config schema; nothing here proxies to them
    bskyAppViewUrl: "https://appview.invalid",
    bskyAppViewDid: "did:example:invalid",
    bskyAppViewCdnUrlPattern: "http://cdn.invalid/%s/%s/%s",
    modServiceUrl: "https://moderator.invalid",
    modServiceDid: "did:example:invalid",
  });
  const store = new DelegateStore(join(dir, "delegates.sqlite"));
  const resolver = new DelegateResolver({ ctx: pds.ctx, store, log });
  const app = express();
  // Sign-in as the account: hooks into the provider, and the nested-login pages.
  app.use(installSignInAs({
    ctx: pds.ctx,
    store,
    resolver,
    publicUrl: url,
    loopbackUrl: `http://127.0.0.1:${port}`,
    plcUrl,
    handleResolvers: opts.handleResolvers ?? [url],
    log,
  }));
  app.use(delegatesRouter({ ctx: pds.ctx, store, resolver, serviceDid: did, log }));
  app.use(pds.app);
  await pds.ctx.sequencer.start();
  const server = app.listen(port);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return {
    name,
    url,
    did,
    pds,
    store,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pds.ctx.destroy();
    },
  };
}
