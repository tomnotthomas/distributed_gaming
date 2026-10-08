import { useCallback, useEffect, useRef, useState } from "react";
import type { Pairing } from "./model";
import { askPaired, keyHashOf, newMachineKey, PAIR_POLL_MS, pairingCode, pairLink } from "./pairing";

/** The pairing under way: the key made for it, and what the owner is shown. */
type Pending = { key: string; code: string; link: string; unanswered: boolean };

/**
 * Pairing this PC with its owner's Steam account (pairing.ts). `serverUrl` is
 * the server's ws:// or wss:// address; `saved` is the machine id and key the
 * app keeps, `loaded` once the key has been read. Pairing uses the saved key,
 * or makes one when there is none, opens the page to add the PC, and asks the
 * server every PAIR_POLL_MS until the owner has: `keep` then saves the machine
 * id and key, and says whether the key could be kept. `fresh` makes a new key
 * even with one saved: a new claim for a PC paired with the wrong account. A
 * paired PC asks the server whose it is, again every PAIR_POLL_MS while the
 * server doesn't answer.
 */
export function usePairing({
  serverUrl,
  saved,
  keep,
  open = (link) => void window.open(link, "_blank", "noopener"),
  pollMs = PAIR_POLL_MS,
}: {
  serverUrl: string;
  saved: { machineId: string; machineKey: string; loaded: boolean };
  keep: (machineId: string, machineKey: string) => Promise<boolean>;
  /** Open the page in the browser. */
  open?: (link: string) => void;
  /** How often to ask the server. */
  pollMs?: number;
}): { pairing: Pairing; pair(options?: { fresh?: boolean }): void; cancel(): void } {
  const [pending, setPending] = useState<Pending | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Whose the PC is, as the server last said, for the machine id it said it for.
  const [owner, setOwner] = useState<{ machineId: string; owner: string | null; unconfirmed?: true } | null>(
    null,
  );
  // Each pairing is its own: a click again, or Cancel, makes the one before answer nothing.
  const attempt = useRef(0);
  const keepNow = useRef(keep);
  keepNow.current = keep;
  const openNow = useRef(open);
  openNow.current = open;
  const savedKey = useRef(saved.machineKey);
  savedKey.current = saved.machineKey;

  const pair = useCallback(
    ({ fresh = false }: { fresh?: boolean } = {}) => {
      const n = ++attempt.current;
      setFailed(null);
      const key = (!fresh && savedKey.current.trim()) || newMachineKey();
      void keyHashOf(key).then((hash) => {
        if (n !== attempt.current) return;
        const link = pairLink(serverUrl, hash);
        if (!link) {
          setPending(null);
          setFailed("Lanterel's server address isn't valid, so this PC can't be paired: fix it in Settings.");
          return;
        }
        setPending({ key, code: pairingCode(hash), link, unanswered: false });
        openNow.current(link);
      });
    },
    [serverUrl],
  );

  const cancel = useCallback(() => {
    attempt.current++;
    setPending(null);
    setFailed(null);
  }, []);

  // While the owner adds the PC, ask the server whether they have.
  const key = pending?.key ?? null;
  useEffect(() => {
    if (!key) return;
    const n = attempt.current;
    let live = true;
    let timer = 0;
    const tick = async () => {
      const answer = await askPaired(serverUrl, key);
      if (!live || n !== attempt.current) return;
      if (typeof answer === "object") {
        const kept = await keepNow.current(answer.machineId, key).catch(() => false);
        if (n !== attempt.current) return;
        attempt.current++;
        setPending(null);
        setOwner(answer);
        if (!kept)
          setFailed(
            "Windows couldn't keep this PC's key encrypted, so the pairing wasn't saved: pair again.",
          );
        return;
      }
      const unanswered = answer === "unanswered";
      setPending((p) => (p && p.key === key && p.unanswered !== unanswered ? { ...p, unanswered } : p));
      timer = window.setTimeout(() => void tick(), pollMs);
    };
    timer = window.setTimeout(() => void tick(), pollMs);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [key, serverUrl, pollMs]);

  // A PC paired before this run: ask whose it is until the server answers; a key it pairs with no machine, or another, is unconfirmed.
  const pairedId = saved.loaded ? saved.machineId.trim() : "";
  const pairedKey = saved.loaded ? saved.machineKey.trim() : "";
  useEffect(() => {
    if (!pairedId || !pairedKey) return;
    let live = true;
    let timer = 0;
    const ask = async () => {
      const answer = await askPaired(serverUrl, pairedKey);
      if (!live) return;
      if (answer === "unanswered") timer = window.setTimeout(() => void ask(), pollMs);
      else
        setOwner(
          typeof answer === "object" && answer.machineId === pairedId
            ? answer
            : { machineId: pairedId, owner: null, unconfirmed: true },
        );
    };
    void ask();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [serverUrl, pairedId, pairedKey, pollMs]);

  const pairing: Pairing = failed
    ? { kind: "failed", why: failed }
    : pending
      ? { kind: "waiting", code: pending.code, link: pending.link, unanswered: pending.unanswered }
      : !saved.loaded
        ? { kind: "checking" }
        : saved.machineKey.trim() && saved.machineId.trim()
          ? owner?.machineId === saved.machineId.trim()
            ? { kind: "paired", ...owner }
            : { kind: "paired", machineId: saved.machineId.trim(), owner: undefined }
          : { kind: "unpaired" };
  return { pairing, pair, cancel };
}
