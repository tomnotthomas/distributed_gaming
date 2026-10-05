// swiff-hostd: the rental-mode agent, run by systemd as root (swiff-hostd.service).
//
//   node src/main.ts                     run the agent for this boot
//   node src/main.ts status              ask the running agent where it stands
//   node src/main.ts return-to-windows   ask for the PC back (honoured only when idle: D8)
//
// The config file is SWIFF_HOSTD_CONFIG, or /var/lib/swiff/hostd.json.

import { createAgent } from "./agent.ts";
import { createHostApi } from "./api.ts";
import { DEFAULT_CONFIG_PATH, HARDWARE_FLOOR, loadConfig, OWNER_TAKEOVER, readMachineKey } from "./config.ts";
import { COMMANDS, sendControl, serveControl, type Command } from "./control.ts";
import { fileResumeStore } from "./resume.ts";
import { openMachineSocket } from "./socket.ts";
import { commandAttestation, linuxStateDisk, stateKeyApi, stateUnlock, tpmLocalShare } from "./state-key.ts";
import { streamerLauncher } from "./streamer.ts";
import { linuxSystem, run } from "./system.ts";

const config = await loadConfig(process.env.SWIFF_HOSTD_CONFIG ?? DEFAULT_CONFIG_PATH);
const command = process.argv[2];

if (command !== undefined) {
  if (!(COMMANDS as readonly string[]).includes(command)) {
    console.error(`usage: swiff-hostd [${COMMANDS.join(" | ")}]`);
    process.exit(2);
  }
  console.log(JSON.stringify(await sendControl(config.controlSocket, command as Command)));
} else {
  const machineKey = await readMachineKey(config.machineKeyFile);
  const agent = createAgent({
    api: createHostApi({ serverUrl: config.serverUrl, machineId: config.machineId, machineKey }),
    openSocket: (onEvent) =>
      openMachineSocket({ url: config.serverUrl, hostId: config.machineId, machineKey, onEvent }),
    launchStreamer: streamerLauncher(config.streamer, config.serverUrl, config.machineId),
    system: linuxSystem(HARDWARE_FLOOR),
    resume: fileResumeStore(config.stateDir),
    ...(config.state && {
      state: stateUnlock({
        attest: commandAttestation(config.state.attestCommand, run),
        api: stateKeyApi(config.serverUrl, config.machineId),
        local: tpmLocalShare(config.state.localShare),
        disk: linuxStateDisk(config.state, run),
        log: (message) => console.log(`[swiff-hostd] ${message}`),
      }),
    }),
    ownerTakeover: OWNER_TAKEOVER,
  });
  const control = await serveControl(config.controlSocket, agent);
  const outcome = await agent.run();
  console.log(`[swiff-hostd] restarting into ${outcome === "reset" ? "rental mode" : "Windows"}`);
  control.close();
}
