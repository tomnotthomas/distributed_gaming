// swiff-hostd: the rental-mode agent, run by systemd as root (swiff-hostd.service).
//
//   node src/main.ts                     run the agent for this boot
//   node src/main.ts status              ask the running agent where it stands
//   node src/main.ts return-to-windows   ask for the PC back (honoured only when idle: D8)
//   node src/main.ts session-env <file>  write the renter session's error-tracking
//                                        project to <file> (swiff-error-tracking.service)
//   node src/main.ts provision           write this boot's config from what the owner's app
//                                        provisioned (swiff-provision.service, provision.ts)
//
// The config file is SWIFF_HOSTD_CONFIG, or /var/lib/swiff/hostd.json. A run
// of the agent reports what nothing caught to PostHog, when its environment or
// the file LANTEREL_ERROR_TRACKING_FILE names a project (errors.ts); the other
// commands do not.

import { createAgent } from "./agent.ts";
import { createHostApi } from "./api.ts";
import { DEFAULT_CONFIG_PATH, HARDWARE_FLOOR, loadConfig, OWNER_TAKEOVER, readMachineKey } from "./config.ts";
import { COMMANDS, sendControl, serveControl, type Command } from "./control.ts";
import { errorTrackingEnv, errorTrackingFile, hostdTracker, writeSessionEnv } from "./errors.ts";
import { KEEP, linuxKeep, PATHS, provision, tpmSeal, tpmUnseal } from "./provision.ts";
import { fileResumeStore } from "./resume.ts";
import { openMachineSocket } from "./socket.ts";
import {
  announcedUnlock,
  ATTEST_TIMEOUT_MS,
  commandAttestation,
  linuxStateDisk,
  stateKeyApi,
  stateUnlock,
  tpmLocalShare,
} from "./state-key.ts";
import { streamerLauncher } from "./streamer.ts";
import { linuxSystem, run, runWithin } from "./system.ts";
import { trackProcess } from "../../../packages/error-tracking/src/index.ts";

const command = process.argv[2];
// Before the config: it needs only the error-tracking file, and runs before the agent.
if (command === "session-env") {
  const out = process.argv[3];
  if (!out) {
    console.error("usage: swiff-hostd session-env <file>");
    process.exit(2);
  }
  await writeSessionEnv(out, {
    ...process.env,
    ...(await errorTrackingFile(process.env.LANTEREL_ERROR_TRACKING_FILE)),
  });
  process.exit(0);
}
// Cut from every report: the machine id and key, once they are read.
const secrets: string[] = [];
const env =
  command === undefined
    ? { ...process.env, ...(await errorTrackingFile(process.env.LANTEREL_ERROR_TRACKING_FILE)) }
    : process.env;
if (command === undefined) trackProcess(hostdTracker(env, secrets), process);

if (command === "provision") {
  // Not provisioned is no failure: swiff-hostd simply does not start (its unit's condition).
  await provision({
    keep: linuxKeep(KEEP, run),
    seal: tpmSeal(),
    unseal: tpmUnseal(),
    paths: PATHS,
    log: (message) => console.log(`[swiff-provision] ${message}`),
  });
  process.exit(0);
}

const config = await loadConfig(process.env.SWIFF_HOSTD_CONFIG ?? DEFAULT_CONFIG_PATH);
secrets.push(config.machineId);

if (command !== undefined) {
  if (!(COMMANDS as readonly string[]).includes(command)) {
    console.error(`usage: swiff-hostd [${[...COMMANDS, "provision"].join(" | ")}]`);
    process.exit(2);
  }
  console.log(JSON.stringify(await sendControl(config.controlSocket, command as Command)));
} else {
  const machineKey = await readMachineKey(config.machineKeyFile);
  secrets.push(machineKey);
  const agent = createAgent({
    api: createHostApi({ serverUrl: config.serverUrl, machineId: config.machineId, machineKey }),
    openSocket: (onEvent) =>
      openMachineSocket({ url: config.serverUrl, hostId: config.machineId, machineKey, onEvent }),
    launchStreamer: streamerLauncher(config.streamer, config.serverUrl, config.machineId, {
      env: errorTrackingEnv(env),
    }),
    system: linuxSystem(HARDWARE_FLOOR),
    resume: fileResumeStore(config.stateDir),
    ...(config.state && {
      state: announcedUnlock(
        stateUnlock({
          attest: commandAttestation(config.state.attestCommand, runWithin(ATTEST_TIMEOUT_MS)),
          api: stateKeyApi(config.serverUrl, config.machineId),
          local: tpmLocalShare(config.state.localShare),
          disk: linuxStateDisk(config.state, run),
          log: (message) => console.log(`[swiff-hostd] ${message}`),
        }),
      ),
    }),
    ownerTakeover: OWNER_TAKEOVER,
  });
  const control = await serveControl(config.controlSocket, agent);
  const outcome = await agent.run();
  console.log(`[swiff-hostd] restarting into ${outcome === "reset" ? "rental mode" : "Windows"}`);
  control.close();
}
