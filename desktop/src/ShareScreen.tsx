import { useEffect, useRef, useState } from "react";
import { Button, Field, Notice, PageShell, Stage, StatusLine, Tag } from "@swiff/ui";
import { DEFAULT_HOST_ID, loadUrl, saveUrl } from "./settings";
import { useScreenShare } from "./useScreenShare";

/** The whole app: paste an address, share the screen, watch the connection. */
export function ShareScreen() {
  const [url, setUrl] = useState(loadUrl);
  const { stream, pc, peerHere, error, start, stop } = useScreenShare();
  const previewRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = stream;
  }, [stream]);

  const share = () => {
    saveUrl(url);
    void start(url);
  };

  return (
    <>
      <div className="titlebar" />
      <PageShell
        title="Swiff Host"
        subtitle="This machine's screen, streamed to whoever rents it."
        meta={<Tag label="Room" value={DEFAULT_HOST_ID} />}
      >
        <Field
          id="signaling"
          label="Signaling server"
          value={url}
          disabled={!!stream}
          placeholder="hushed-otter-42.trycloudflare.com"
          hint="The address the renter opens. Paste it exactly as given."
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !stream && share()}
        />

        <div className="row">
          {!stream ? (
            <Button size="lg" onClick={share}>
              Start sharing
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={stop}>
                Stop sharing
              </Button>
              <span className="muted">
                {peerHere ? "A renter is connected." : "Waiting for a renter…"}
              </span>
            </>
          )}
        </div>

        {error ? <Notice>{error}</Notice> : null}

        <StatusLine pc={pc} note={stream ? undefined : "not capturing"} />

        <Stage ref={previewRef} muted small empty={!stream} placeholder="not capturing" />
      </PageShell>
    </>
  );
}
