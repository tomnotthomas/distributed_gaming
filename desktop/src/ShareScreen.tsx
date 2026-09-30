import { useEffect, useRef, useState } from "react";
import { Button, Field, Input, Notice, PageShell, Stage, StatusLine, Tag } from "@swiff/ui";
import { loadMachineId, loadMachineKey, loadUrl, saveMachineId, saveMachineKey, saveUrl } from "./settings";
import { useScreenShare } from "./useScreenShare";

/** The whole app: paste an address, share the screen, watch the connection. */
export function ShareScreen() {
  const [url, setUrl] = useState(loadUrl);
  const [machineId, setMachineId] = useState(loadMachineId);
  const [machineKey, setMachineKey] = useState("");
  const [keyNote, setKeyNote] = useState<string | null>(null);
  const { stream, pc, peerHere, error, start, stop } = useScreenShare();

  useEffect(() => {
    void loadMachineKey().then((saved) => setMachineKey((typed) => typed || saved));
  }, []);
  const previewRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = stream;
  }, [stream]);

  const share = async () => {
    const id = machineId.trim();
    const key = machineKey.trim();
    saveUrl(url);
    saveMachineId(id);
    const kept = key ? await saveMachineKey(key) : true;
    setKeyNote(kept ? null : "This system cannot encrypt the key, so it was not saved.");
    void start(url, { machineId: id, machineKey: key });
  };

  return (
    <>
      <div className="titlebar" />
      <PageShell
        title="Swiff Host"
        subtitle="This machine's screen, streamed to whoever rents it."
        meta={<Tag label="Room">{machineId}</Tag>}
      >
        <Field label="Signaling server" hint="The address the renter opens. Paste it exactly as given.">
          <Input
            value={url}
            disabled={!!stream}
            placeholder="hushed-otter-42.trycloudflare.com"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !stream && void share()}
          />
        </Field>

        <Field label="Machine id" hint="The id the key was made for.">
          <Input value={machineId} disabled={!!stream} onChange={(e) => setMachineId(e.target.value)} />
        </Field>

        <Field label="Machine key" hint="From npm run machine-key. Stored encrypted on this PC.">
          <Input
            type="password"
            autoComplete="off"
            value={machineKey}
            disabled={!!stream}
            onChange={(e) => setMachineKey(e.target.value)}
          />
        </Field>

        <div className="row">
          {!stream ? (
            <Button size="lg" onClick={() => void share()}>
              Start sharing
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={stop}>
                Stop sharing
              </Button>
              <span className="muted">{peerHere ? "A renter is connected." : "Waiting for a renter…"}</span>
            </>
          )}
        </div>

        {error ? <Notice>{error}</Notice> : null}
        {keyNote ? <Notice>{keyNote}</Notice> : null}

        <StatusLine pc={pc} note={stream ? undefined : "not capturing"} />

        <Stage ref={previewRef} muted small empty={!stream} placeholder="not capturing" />
      </PageShell>
    </>
  );
}
