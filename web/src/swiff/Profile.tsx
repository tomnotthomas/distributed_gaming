import { Avatar, Button, Segment, SettingRow, SteamButton } from "@swiff/ui";
import type { Device, Quality, Swiff } from "./useSwiff";

const QUALITY = [
  { value: "auto", label: "Best available" },
  { value: "fps", label: "Prefer 120 fps" },
  { value: "resolution", label: "Prefer 4K" },
] as const satisfies readonly { value: Quality; label: string }[];

const DEVICES: { id: Device; name: string; path: string }[] = [
  { id: "kb", name: "Keyboard", path: "M224 48H32a16 16 0 0 0-16 16v128a16 16 0 0 0 16 16h192a16 16 0 0 0 16-16V64a16 16 0 0 0-16-16ZM56 88h16v16H56Zm40 0h16v16H96Zm40 0h16v16h-16Zm40 0h16v16h-16ZM56 128h16v16H56Zm40 0h16v16H96Zm40 0h16v16h-16Zm40 0h16v16h-16ZM72 168h112v16H72Z" },
  { id: "mouse", name: "Mouse", path: "M144 16.5V96h64V96a80.1 80.1 0 0 0-64-79.5ZM112 16.5A80.1 80.1 0 0 0 48 96h64ZM48 112v48a80 80 0 0 0 160 0v-48Z" },
  { id: "pad", name: "Controller", path: "M176 56H80a72 72 0 0 0 0 144h96a72 72 0 0 0 0-144Zm-40 80H88v24a8 8 0 0 1-16 0v-24H48a8 8 0 0 1 0-16h24V96a8 8 0 0 1 16 0v24h48a8 8 0 0 1 0 16Zm40 24a12 12 0 1 1 12-12 12 12 0 0 1-12 12Zm16-40a12 12 0 1 1 12-12 12 12 0 0 1-12 12Z" },
];

/** Who you are on Steam, and the three settings that change how a session feels. */
export function Profile({ swiff }: { swiff: Swiff }) {
  const { profile, games, devices, quality, motion, sound } = swiff;
  const owned = games.filter((game) => game.owned).length;
  const persona = profile?.persona || "Not signed in";

  return (
    <main className="profile">
      <header className="profile-head">
        <Avatar initial={(profile?.persona ?? "?")[0]!.toUpperCase()} size={72} />
        <div className="profile-id">
          <div className="profile-name">{persona}</div>
          {profile ? (
            <div className="profile-line">
              <span className="live-dot" />
              Steam connected · {owned} games · {profile.size} in your library
            </div>
          ) : (
            <div className="profile-connect">
              <span className="profile-sub">Connect Steam to see the games you own.</span>
              <SteamButton small />
            </div>
          )}
        </div>
      </header>

      <hr className="profile-rule" />

      <section className="profile-section">
        <h2 className="profile-kicker">Streaming</h2>
        <div className="profile-grid">
          <SettingRow
            layout="stacked"
            label="Picture"
            hint="Swiff picks the machine that can deliver it."
            control={
              <Segment
                name="quality"
                aria-label="Picture"
                options={QUALITY}
                value={quality}
                onChange={swiff.setQuality}
              />
            }
          />

          <SettingRow
            layout="stacked"
            label="Controls"
            hint="Only machines that support them are offered."
            control={
              <div className="device-row">
                {DEVICES.map((device) => (
                  <button
                    key={device.id}
                    type="button"
                    className={devices.includes(device.id) ? "device device-on glass" : "device glass"}
                    onClick={() => swiff.toggleDevice(device.id)}
                    aria-pressed={devices.includes(device.id)}
                    aria-label={device.name}
                    title={device.name}
                  >
                    <svg width="20" height="20" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
                      <path d={device.path} />
                    </svg>
                  </button>
                ))}
              </div>
            }
          />
        </div>

        <div className="profile-grid">
          <SettingRow
            label="Motion on the wall"
            hint="Clips play on the hero and on hover. Off shows stills."
            control={<input type="checkbox" checked={motion} onChange={(e) => swiff.setMotion(e.target.checked)} />}
          />
          <SettingRow
            label="Interface sounds"
            hint="A tick on focus, a thump on launch, a chime when a machine frees up."
            control={<input type="checkbox" checked={sound} onChange={(e) => swiff.setSound(e.target.checked)} />}
          />
        </div>
        <p className="profile-fine">
          Changes save instantly. Name, avatar and library come from Steam.
        </p>
      </section>

      <div>
        <Button variant="secondary" onClick={swiff.goHome}>
          Back to the wall
        </Button>
      </div>
    </main>
  );
}
