// Request helpers shared by every HTTP handler on this server: the bearer
// credential, a size-capped JSON body, and a size-capped body read and dropped.

import type { IncomingMessage } from "node:http";

/** Most bodies this server reads are a handful of fields. */
const MAX_BODY_BYTES = 16 * 1024;

/** A refusal with the HTTP status to answer it with. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The credential from `Authorization: Bearer …`, or null. Never logged. */
export function bearer(req: IncomingMessage): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  return match?.[1] ?? null;
}

/** The body as a JSON object; empty is {}. 413 when over `limit` bytes, 400 when not an object. */
export async function readJson(
  req: IncomingMessage,
  limit = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpError(400, "body is not an object");
  return body as Record<string, unknown>;
}

/** Read the body and keep none of it: its size in bytes. 413 when over `limit` bytes. */
export async function discardBody(req: IncomingMessage, limit: number): Promise<number> {
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "body too large");
  }
  return size;
}
