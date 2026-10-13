// Types for swtpm.cjs, so the tests can use it.

export type TcpTransport = { send(command: Buffer): Promise<Buffer>; close(): void };

export const SRK_TEMPLATE: Buffer;
export function tcpTransport(host: string, port: number): Promise<TcpTransport>;
export function makeSrk(transport: { send(command: Buffer): Promise<Buffer> }): Promise<void>;
