// RTP packets out of a byte stream framed as RFC 4571: each packet preceded by
// its length as a 16-bit big-endian number. That is what rtpstreampay writes to
// the capture helper's stdout, which arrives here in arbitrary chunks.

/** Feed it chunks; it calls `onPacket` once per whole packet, in order. */
export function createRtpDeframer(onPacket: (packet: Buffer) => void): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let at = 0;
    while (pending.length - at >= 2) {
      const length = pending.readUInt16BE(at);
      if (pending.length - at - 2 < length) break;
      // A copy, so a packet held by the sender's retransmit cache does not pin the whole chunk.
      if (length) onPacket(Buffer.from(pending.subarray(at + 2, at + 2 + length)));
      at += 2 + length;
    }
    pending = pending.subarray(at);
  };
}
