// A stand-in for what Windows does when it provisions a PC's TPM, for the VM
// tests and the seal's tests: swtpm's TCP command channel (`swtpm socket
// --server type=tcp,...`) as a transport for tpm-seal.cjs, and the storage root
// key Windows persists at 0x81000001. Test tooling: never shipped.
//
//   node swtpm.cjs srk <host:port>     make the SRK on that swtpm, unless it has one

const net = require("node:net");
const { SRK_HANDLE, b2, run } = require("../tpm-seal.cjs");

const TPM_RH_OWNER = 0x40000001;
const CC = { EvictControl: 0x120, CreatePrimary: 0x131, FlushContext: 0x165, ReadPublic: 0x173 };

/**
 * The TCG SRK template Windows makes its storage root key from: RSA 2048,
 * fixedTPM fixedParent sensitiveDataOrigin userWithAuth noDA restricted
 * decrypt, AES-128-CFB, its unique field 256 zero bytes.
 */
const SRK_TEMPLATE = Buffer.from(
  `${"0001 000b 00030472 0000 0006 0080 0043 0010 0800 00000000 0100".replace(/ /g, "")}${"00".repeat(256)}`,
  "hex",
);

/** One command in, its response out, on swtpm's TCP command channel at `host`:`port`. */
function tcpTransport(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    let pending = Buffer.alloc(0);
    /** The sends waiting for their response, in order. */
    const waiting = [];
    const fail = (error) => {
      for (const w of waiting.splice(0)) w.reject(error);
    };
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (waiting.length && pending.length >= 6 && pending.length >= pending.readUInt32BE(2)) {
        const size = pending.readUInt32BE(2);
        const response = pending.subarray(0, size);
        pending = pending.subarray(size);
        waiting.shift().resolve(response);
      }
    });
    socket.once("error", (error) => {
      reject(error);
      fail(error);
    });
    socket.once("close", () => fail(new Error("swtpm closed its command channel.")));
    socket.once("connect", () =>
      resolve({
        send: (command) =>
          new Promise((resolveSend, rejectSend) => {
            if (socket.destroyed) return rejectSend(new Error("swtpm closed its command channel."));
            waiting.push({ resolve: resolveSend, reject: rejectSend });
            socket.write(command);
          }),
        close: () => socket.destroy(),
      }),
    );
  });
}

/**
 * Make the storage root key at SRK_HANDLE as Windows does: TPM2_CreatePrimary
 * under TPM_RH_OWNER from SRK_TEMPLATE, persisted with TPM2_EvictControl, the
 * transient object flushed. Nothing when SRK_HANDLE already holds an object.
 */
async function makeSrk(transport) {
  const held = await run(transport, CC.ReadPublic, { handles: [SRK_HANDLE] }).then(
    () => true,
    () => false,
  );
  if (held) return;
  const r = await run(transport, CC.CreatePrimary, {
    handles: [TPM_RH_OWNER],
    auth: true,
    params: Buffer.concat([b2(Buffer.alloc(4)), b2(SRK_TEMPLATE), b2(Buffer.alloc(0)), Buffer.alloc(4)]),
  });
  const handle = r.u32();
  try {
    const persistent = Buffer.alloc(4);
    persistent.writeUInt32BE(SRK_HANDLE);
    await run(transport, CC.EvictControl, {
      handles: [TPM_RH_OWNER, handle],
      auth: true,
      params: persistent,
    });
  } finally {
    const flush = Buffer.alloc(4);
    flush.writeUInt32BE(handle);
    await run(transport, CC.FlushContext, { params: flush });
  }
}

module.exports = { SRK_TEMPLATE, makeSrk, tcpTransport };

if (require.main === module) {
  const [cmd, at] = process.argv.slice(2);
  const m = /^(.+):(\d+)$/.exec(at ?? "");
  if (cmd !== "srk" || !m) {
    console.error("usage: swtpm.cjs srk <host:port>");
    process.exit(2);
  }
  tcpTransport(m[1], Number(m[2]))
    .then(async (transport) => {
      try {
        await makeSrk(transport);
      } finally {
        transport.close();
      }
    })
    .then(
      () => process.exit(0),
      (error) => {
        console.error(error.message);
        process.exit(1);
      },
    );
}
