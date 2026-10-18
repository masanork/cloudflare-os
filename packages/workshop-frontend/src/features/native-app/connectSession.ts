import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { AuthenticatedSession } from '../auth/authenticatedSession'

type Api = Pick<AuthenticatedApi, 'completeConnectHandoff'>
const connections = new WeakMap<Api, (ticket: string, nonce: string, signal: AbortSignal) => Promise<void>>()

/** The sign-in session also owns the native browser's single-use connection tickets. */
export class NativeConnectSession<SessionApi extends Api & Pick<RpcStub<AuthenticatedApi>, 'onRpcBroken'> =
  Api & Pick<RpcStub<AuthenticatedApi>, 'onRpcBroken'>> extends AuthenticatedSession<SessionApi> {
  override track(api: SessionApi, identity: Promise<AiChatAuthorInfo>): () => void {
    const untrack = super.track(api, identity)
    const run = this.capture()
    connections.set(api, (ticket, nonce, signal) =>
      run(current => current.completeConnectHandoff(ticket, nonce), signal))
    return untrack
  }
}

/** Capture the initiating identity now; redeem the single-use ticket on its current connection. */
export const nativeConnectCompletion = (api: Api, nonce: string) => {
  const complete = connections.get(api)
  return (ticket: string, signal: AbortSignal): Promise<void> => {
    if (!complete) throw new Error('The sign-in session is unavailable. Sign in and try again.')
    return complete(ticket, nonce, signal)
  }
}
