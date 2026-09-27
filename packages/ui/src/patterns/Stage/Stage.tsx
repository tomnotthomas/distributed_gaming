import { forwardRef } from "react";
import { cx } from "../../lib/cx";
import "./Stage.css";

type Props = {
  /** Shown until a track arrives, so a black rectangle is never ambiguous. */
  placeholder: string;
  empty: boolean;
  /** The host's own preview is a reference, not the product — render it small. */
  small?: boolean;
  muted?: boolean;
};

/**
 * The video surface. A fixed 16:9 frame that exists before the stream does:
 * a box that appears on connect makes the page jump at the worst moment.
 */
export const Stage = forwardRef<HTMLVideoElement, Props>(function Stage(
  { placeholder, empty, small, muted },
  ref,
) {
  return (
    <div className={cx("stage", small && "stage-sm")}>
      {/* The e2e suite selects this by test id. It used to key off a styling
          class, which a restructure like this one silently broke. */}
      <video ref={ref} autoPlay playsInline muted={muted} data-testid="stage-video" />
      {empty ? <div className="stage-empty">{placeholder}</div> : null}
    </div>
  );
});
