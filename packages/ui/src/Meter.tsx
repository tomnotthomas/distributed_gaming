/**
 * Four segments, however many are lit. The prototype shows Picture and Response
 * this way in two places each — machine card and launch summary — because a
 * player reads "three of four bars" faster than "1440p 120".
 */
export function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <div className="meter-bars" role="img" aria-label={`${label} ${value} of 4`}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={i < value ? "meter-seg meter-on" : "meter-seg"} />
        ))}
      </div>
    </div>
  );
}
