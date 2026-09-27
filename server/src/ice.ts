// TURN relay for peers that cannot reach each other directly: symmetric NAT,
// carrier CGNAT, firewalls that only let 443 out. Configured here rather than
// in the clients so neither the renter page nor the host .exe has to be
// rebuilt to change it, and so the renter never has to be asked for anything.
//
//   TURN_URLS        comma-separated, e.g. "turn:turn.example.com:3478,turns:turn.example.com:443?transport=tcp"
//   TURN_USERNAME
//   TURN_CREDENTIAL
//
// Phase 1 has no auth, so whoever can reach the signaling server can read
// these. Use a TURN account you can rotate, not one that bills without limit.

export function turnServersFromEnv(env: NodeJS.ProcessEnv): RTCIceServer[] {
  const urls = (env.TURN_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (urls.length === 0) return [];
  const server: RTCIceServer = { urls };
  if (env.TURN_USERNAME) server.username = env.TURN_USERNAME;
  if (env.TURN_CREDENTIAL) server.credential = env.TURN_CREDENTIAL;
  return [server];
}
