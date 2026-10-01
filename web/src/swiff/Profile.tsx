import {
  Avatar,
  Button,
  Divider,
  IconButton,
  Kicker,
  Segment,
  SettingRow,
  StatusDot,
  SteamButton,
} from "@swiff/ui";
import type { IconName } from "@swiff/ui";
import { initials } from "./Chrome";
import type { Device, Quality, Swiff } from "./useSwiff";

const QUALITY = [
  { value: "auto", label: "Best available" },
  { value: "fps", label: "Prefer 120 fps" },
  { value: "resolution", label: "Prefer 4K" },
] as const satisfies readonly { value: Quality; label: string }[];

const DEVICES: { id: Device; name: string; icon: IconName }[] = [
  { id: "kb", name: "Keyboard", icon: "keyboard" },
  { id: "mouse", name: "Mouse", icon: "mouse" },
  { id: "pad", name: "Controller", icon: "gamepad" },
];

/** Who you are on Steam, and the three settings that change how a session feels. */
export function Profile({ swiff }: { swiff: Swiff }) {
  const { profile, games, devices, quality, motion, sound } = swiff;
  const owned = games.filter((game) => game.owned).length;
  const persona = profile?.persona || "Not signed in";

  return (
    <main className="profile">
      <header className="profile-head">
        <Avatar initial={initials(profile?.persona || "?")} size={72} />
        <div className="profile-id">
          <div className="profile-name">{persona}</div>
          {profile ? (
            <div className="profile-line">
              <StatusDot />
              Steam connected · {owned} games · {profile.size} in your library
              <Button variant="link" size="sm" onClick={swiff.signOut}>
                Sign out
              </Button>
              {swiff.signOutFailed ? (
                <span className="profile-sub" role="alert">
                  Sign-out failed, so you are still signed in. Try again.
                </span>
              ) : null}
            </div>
          ) : (
            <div className="profile-connect">
              <span className="profile-sub">Connect Steam to see the games you own.</span>
              <SteamButton small />
            </div>
          )}
        </div>
      </header>

      <Divider />

      <section className="profile-section">
        <Kicker as="h2">Streaming</Kicker>
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
                  <IconButton
                    key={device.id}
                    icon={device.icon}
                    label={device.name}
                    shape="square"
                    size="lg"
                    pressed={devices.includes(device.id)}
                    onClick={() => swiff.toggleDevice(device.id)}
                  />
                ))}
              </div>
            }
          />
        </div>

        <div className="profile-grid">
          <SettingRow
            label="Motion on the wall"
            hint="Clips play on the hero and on hover. Off shows stills."
            control={
              <input type="checkbox" checked={motion} onChange={(e) => swiff.setMotion(e.target.checked)} />
            }
          />
          <SettingRow
            label="Interface sounds"
            hint="A tick on focus, a thump on launch, a chime when a machine frees up."
            control={
              <input type="checkbox" checked={sound} onChange={(e) => swiff.setSound(e.target.checked)} />
            }
          />
        </div>
        <p className="profile-fine">Changes save instantly. Name, avatar and library come from Steam.</p>
      </section>

      <div>
        <Button variant="secondary" onClick={swiff.goHome}>
          Back to the wall
        </Button>
      </div>
    </main>
  );
}
