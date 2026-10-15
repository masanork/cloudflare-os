import { RpcSession, WebSocketTransport, type RpcSessionOptions } from "capnweb";

/** Fence every capability on this socket with the current RP session, in both directions. */
export function newMikakiRpcSession(socket: WebSocket, main: unknown,
    authorize: (touch: boolean) => Promise<number>, options?: RpcSessionOptions) {
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const transport = new WebSocketTransport(socket);
  const check = async (touch: boolean) => {
    const expiresAt = await authorize(touch);
    if (expiresAt <= Date.now()) throw new Error("Mikaki session lease expired.");
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => { void check(false).catch(reason => transport.abort(reason)); },
        Math.max(0, expiresAt - Date.now()));
  };
  const session = new RpcSession({
    async send(message: string) { await check(false); return transport.send(message); },
    async receive() { const message = await transport.receive(); await check(true); return message; },
    abort(reason: unknown) { clearTimeout(expiryTimer); transport.abort(reason); },
  }, main, options);
  socket.addEventListener("close", () => clearTimeout(expiryTimer));
  return session.getRemoteMain();
}
