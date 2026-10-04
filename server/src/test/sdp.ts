// Probe descriptions as a browser writes them, with every kind of candidate:
// the sender's LAN address, an mDNS name, its public address as STUN and the
// peer saw it, IPv6, and one relay candidate on the TURN server.

/** Addresses that say where the sender is: none may cross a probe. */
export const OWN_ADDRESSES = ["192.168.1.20", "203.0.113.7", "abcd-1234.local", "2001:db8::1", "51234"];
/** The TURN server's address and port: what a relay candidate is. */
export const RELAY_ADDRESS = "198.51.100.9 3478";

const lines = (type: "offer" | "answer", candidates: string[]) =>
  [
    "v=0",
    "o=- 4611731400430051336 2 IN IP4 192.168.1.20",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "m=application 51234 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 203.0.113.7",
    "a=rtcp:51234 IN IP4 203.0.113.7",
    ...candidates,
    "a=end-of-candidates",
    "a=ice-ufrag:Zx4r",
    "a=ice-pwd:o3UYYp0BjVmhrT5OSqzH1Rxp",
    "a=fingerprint:sha-256 6B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08",
    `a=setup:${type === "offer" ? "actpass" : "active"}`,
    "a=mid:0",
    "a=sctp-port:5000",
    "",
  ].join("\r\n");

const STRAIGHT = [
  "a=candidate:1 1 udp 2122260223 192.168.1.20 51234 typ host generation 0",
  "a=candidate:2 1 udp 2122260223 abcd-1234.local 51235 typ host generation 0",
  "a=candidate:3 1 udp 1686052607 203.0.113.7 51234 typ srflx raddr 192.168.1.20 rport 51234 generation 0",
  "a=candidate:4 1 udp 1686052607 203.0.113.7 51236 typ prflx raddr 192.168.1.20 rport 51236 generation 0",
  "a=candidate:5 1 tcp 1518280447 2001:db8::1 9 typ host tcptype active generation 0",
];
const RELAY =
  "a=candidate:6 1 udp 41885439 198.51.100.9 3478 typ relay raddr 203.0.113.7 rport 51234 generation 0";

/** A description with every kind of candidate. */
export const sdpOf = (type: "offer" | "answer") => ({ type, sdp: lines(type, [...STRAIGHT, RELAY]) });
/** A description that could only connect straight: no relay candidate. */
export const straightSdpOf = (type: "offer" | "answer") => ({ type, sdp: lines(type, STRAIGHT) });
