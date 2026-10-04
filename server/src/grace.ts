// Reconnect grace: a renter whose socket drops in the middle of a session gets
// RECONNECT_GRACE_S to come back before the session ends.
//
//   renter socket drops ──► host: peer-left { grace: 120 } ──► timer
//        │                                                       │
//   join, same ticket ──► timer cancelled, host: peer-joined     │
//                                                     120 s ──► session ends as grace_expired
//
// The PC keeps the game running meanwhile and lets go of whatever the renter
// was holding. The renter's page comes back with POST /api/bookings/:id/rejoin,
// which hands out the same seat (the claim's ticket id) again, so its join takes
// the seat back rather than being refused as somebody else. Only the renter's
// explicit End (POST /api/bookings/:id/end, or /api/sessions/:id/leave) and the
// owner taking the machine back skip the grace: both end the session at once,
// which cancels the timer here.
//
// The timers live in memory. A server restart forgets them; the renter's
// ticket still runs out at the booked end, as before this existed.

/** How long a renter who dropped has to come back, in seconds. Sent to the host with peer-left. */
export const RECONNECT_GRACE_S = 120;

export type RenterGrace = {
  /** The renter holding `ticketId` dropped out of `hostId`'s room: start its clock, replacing any other. */
  start(hostId: string, ticketId: string): void;
  /**
   * Stop `hostId`'s clock: when the renter with `ticketId` came back, or, with
   * no ticket, whenever its session ended. True when a clock was stopped.
   */
  cancel(hostId: string, ticketId?: string): boolean;
  /** The ticket whose clock runs for `hostId`, or null. */
  pending(hostId: string): string | null;
  /** When `hostId`'s clock runs out (Unix ms), or null when none runs. */
  until(hostId: string): number | null;
};

export type RenterGraceOptions = {
  graceMs: number;
  /** The renter with `ticketId` did not come back to `hostId` in time. */
  onExpire: (hostId: string, ticketId: string) => void;
};

export function createRenterGrace({ graceMs, onExpire }: RenterGraceOptions): RenterGrace {
  const clocks = new Map<string, { ticketId: string; until: number; timer: NodeJS.Timeout }>();

  const cancel = (hostId: string, ticketId?: string) => {
    const clock = clocks.get(hostId);
    if (!clock || (ticketId !== undefined && clock.ticketId !== ticketId)) return false;
    clearTimeout(clock.timer);
    clocks.delete(hostId);
    return true;
  };

  return {
    start(hostId, ticketId) {
      cancel(hostId);
      const timer = setTimeout(() => {
        if (clocks.get(hostId)?.timer !== timer) return;
        clocks.delete(hostId);
        onExpire(hostId, ticketId);
      }, graceMs);
      timer.unref();
      clocks.set(hostId, { ticketId, until: Date.now() + graceMs, timer });
    },
    cancel,
    pending: (hostId) => clocks.get(hostId)?.ticketId ?? null,
    until: (hostId) => clocks.get(hostId)?.until ?? null,
  };
}
