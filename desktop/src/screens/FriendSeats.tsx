// Seats for friends: up to four named seats at this PC, each with its own link
// to send. A friend who takes one plays their own Steam games here, signed in
// as themselves. Taking a seat back asks once more, inline.

import { useEffect, useId, useState } from "react";
import {
  seatErrorLine,
  seatLine,
  seatMessage,
  type SeatClient,
  type SeatError,
  type SeatList,
} from "../seats";
import { Notice } from "../ui/Notice";
import { Pill } from "../ui/Pill";
import { Zone } from "../ui/parts";

/** The most seats the platform keeps at one PC, until it says. */
const DEFAULT_MAX = 4;

export function FriendSeats({ client, now }: { client: SeatClient | null; now: number }) {
  const id = useId();
  const [list, setList] = useState<SeatList | null>(null);
  const [error, setError] = useState<SeatError | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let live = true;
    void client.list().then((read) => {
      if (!live) return;
      if (read.ok) {
        setList(read.value);
        setError(null);
      } else setError(read.error);
    });
    return () => {
      live = false;
    };
  }, [client]);

  if (!client) return null;
  const seats = list?.seats ?? [];
  const max = list?.max ?? DEFAULT_MAX;
  const full = seats.length >= max;

  const save = async () => {
    const friend = name.trim();
    if (!friend || busy || full) return;
    setBusy(true);
    const made = await client.make(friend);
    setBusy(false);
    if (!made.ok) return setError(made.error);
    setError(null);
    setName("");
    setList((was) => ({ max: was?.max ?? max, seats: [...(was?.seats ?? []), made.value] }));
  };

  const revoke = async (seatId: string) => {
    setBusy(true);
    const left = await client.revoke(seatId);
    setBusy(false);
    setConfirming(null);
    if (!left.ok) return setError(left.error);
    setError(null);
    setList(left.value);
  };

  const copy = async (seatId: string, link: string) => {
    try {
      await navigator.clipboard.writeText(seatMessage(link));
      setCopied(seatId);
    } catch {
      setError("failed");
    }
  };

  return (
    <Zone title="Seats for friends">
      <p className="soft">
        Save up to {max} seats at this PC, each for a friend by name. Whoever takes one plays their own Steam
        games here, on their own account.
      </p>
      {seats.length ? (
        <ul className="seats" aria-label="Seats at this PC">
          {seats.map((seat) => {
            const link = client.link(seat);
            return (
              <li key={seat.id} className="krow seat">
                <span>
                  <b>
                    Seat {seat.number} · {seat.friend}
                  </b>
                  <small>{seatLine(seat, now)}</small>
                </span>
                {confirming === seat.id ? (
                  <span className="seat-acts">
                    <button
                      type="button"
                      className="lnk"
                      disabled={busy}
                      onClick={() => void revoke(seat.id)}
                    >
                      Yes, take it back
                    </button>
                    <button type="button" className="lnk" onClick={() => setConfirming(null)}>
                      Keep it
                    </button>
                  </span>
                ) : (
                  <span className="seat-acts">
                    {seat.state === "open" && link ? (
                      <button type="button" className="lnk" onClick={() => void copy(seat.id, link)}>
                        {copied === seat.id ? "Copied" : "Copy link"}
                      </button>
                    ) : null}
                    <button type="button" className="lnk" onClick={() => setConfirming(seat.id)}>
                      Take back
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {full ? (
        <p className="note6">All {max} seats are given out.</p>
      ) : (
        <form
          className="seat-add"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="fld">
            <label className="mono" htmlFor={`${id}-name`}>
              Friend's name
            </label>
            <input
              id={`${id}-name`}
              value={name}
              maxLength={24}
              autoComplete="off"
              placeholder="Jonas"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="acts">
            <Pill icon="arrow" small type="submit" disabled={busy || !name.trim()}>
              Save a seat
            </Pill>
          </div>
        </form>
      )}
      {error ? <Notice>{seatErrorLine(error, max)}</Notice> : null}
    </Zone>
  );
}
