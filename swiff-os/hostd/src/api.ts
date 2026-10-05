// The host API calls swiff-hostd makes, over HTTPS to the signaling server's own
// origin, each with the machine key as `Authorization: Bearer`. The same calls
// the host app makes (docs/system-design/host.md §5, session-keys.md):
//
//   POST   /api/machines/:id/heartbeat     where the machine stands, and its session
//   PUT    /api/machines/:id/availability  offer it, or take it off offer
//   POST   /api/machines/:id/session       start the claimed session's host session: a session key
//   DELETE /api/machines/:id/session       end it: every key of it dies
//   POST   /api/sessions/:id/end           end the platform session itself
//
// A call that fails on the network or answers 5xx is tried again, up to three
// tries in all, as the host app does; any other answer is returned at once.

import type { MachineView } from "../../../server/src/platform.ts";
import { sessionPath, type SessionGrant } from "../../../server/src/protocol.ts";

export type { MachineView };

/** A call the server answered with a refusal. Carries the status and error code, never the body otherwise. */
export class HostApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(call: string, status: number, code: string | null) {
    super(`${call} answered ${status}${code ? ` ${code}` : ""}`);
    this.status = status;
    this.code = code;
  }
}

export type HostApi = {
  heartbeat(): Promise<MachineView>;
  /**
   * Offer the machine or take it off offer. `until` (Unix ms) is the owner's
   * share-until, sent back as it was: the server replaces it on every call.
   * Taking it off offer ends a live session as the owner taking it back,
   * except with `reset`: a session claimed and not yet started is kept, held
   * through the restart, and named in the answer (the reset hold, host.md).
   */
  setAvailability(
    available: boolean,
    until: number | null,
    options?: { reset?: boolean },
  ): Promise<MachineView>;
  startHostSession(sessionId: string): Promise<SessionGrant>;
  /** Answers once the host session is over, whether or not one was live. */
  endHostSession(): Promise<void>;
  /** End the platform session as the host: the renter is done here. */
  endSession(sessionId: string): Promise<void>;
};

export type HostApiOptions = {
  serverUrl: string;
  machineId: string;
  machineKey: string;
  /** Waits between tries of a call that failed on the network or the server. */
  retryDelaysMs?: readonly number[];
};

const RETRY_DELAYS_MS = [500, 1_000];

export function createHostApi({
  serverUrl,
  machineId,
  machineKey,
  retryDelaysMs = RETRY_DELAYS_MS,
}: HostApiOptions): HostApi {
  const origin = new URL(serverUrl);
  origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
  const machine = `/api/machines/${encodeURIComponent(machineId)}`;

  /** `fetch`, tried again after a network error or a 5xx answer. */
  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${machineKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    for (let attempt = 0; ; attempt++) {
      const last = attempt === retryDelaysMs.length;
      try {
        const res = await fetch(new URL(path, origin), init);
        if (res.status < 500 || last) return res;
        await res.body?.cancel();
      } catch (cause) {
        if (last) throw cause;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    }
  }

  /** The answer's JSON when it is `expected`; otherwise a HostApiError with its error code. */
  async function call<T>(name: string, expected: number, res: Response): Promise<T> {
    if (res.status === expected) return (expected === 204 ? undefined : await res.json()) as T;
    let code: string | null = null;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") code = body.error;
    } catch {
      // No JSON body: the status says enough.
    }
    throw new HostApiError(name, res.status, code);
  }

  return {
    heartbeat: async () => call("heartbeat", 200, await send("POST", `${machine}/heartbeat`, {})),
    setAvailability: async (available, until, { reset = false } = {}) =>
      call(
        "availability",
        200,
        await send("PUT", `${machine}/availability`, {
          available,
          ...(until === null ? {} : { until }),
          ...(reset ? { reset } : {}),
        }),
      ),
    startHostSession: async (sessionId) =>
      call("session start", 201, await send("POST", sessionPath(machineId), { sessionId })),
    endHostSession: async () => call("session end", 204, await send("DELETE", sessionPath(machineId))),
    endSession: async (sessionId) => {
      await call(
        "platform session end",
        200,
        await send("POST", `/api/sessions/${encodeURIComponent(sessionId)}/end`, {}),
      );
    },
  };
}
