/**
 * A labelled pill. Phase 1 uses it for the room id, which both peers must show:
 * connecting to the wrong room looks identical to a broken connection.
 */
export function Tag({ label, value }: { label: string; value: string }) {
  return (
    <span className="tag">
      <span className="tag-label">{label}</span>
      {value}
    </span>
  );
}
