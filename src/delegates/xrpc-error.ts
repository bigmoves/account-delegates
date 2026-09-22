import type { Response } from "express";

export class XrpcError extends Error {
  constructor(
    public status: number,
    public error: string,
    message: string,
  ) {
    super(message);
  }
}

export function sendError(res: Response, err: any) {
  // xrpc-server's XRPCError keeps its HTTP status in `type`.
  const status = err?.status ?? err?.statusCode ?? (typeof err?.type === "number" && err.type >= 400 && err.type < 600 ? err.type : 500);
  const error = err?.error ?? err?.customErrorName ?? err?.name ?? "InternalServerError";
  res.status(status).json({ error, message: err?.message ?? String(err) });
}

export const short = (did: string) => (did.length > 28 ? `${did.slice(0, 16)}…${did.slice(-6)}` : did);
