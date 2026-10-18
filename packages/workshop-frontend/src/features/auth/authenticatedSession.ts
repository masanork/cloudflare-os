import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'

type Transport = Pick<RpcStub<AuthenticatedApi>, 'onRpcBroken'>
type Connection<Api> = { api: Api; identity: Promise<AiChatAuthorInfo>; broken: boolean; epoch: number }
export type AuthenticatedOperation<Api = RpcStub<AuthenticatedApi>> = <T>(
  action: (api: Api) => Promise<T>, signal: AbortSignal,
) => Promise<T>

/** A single sign-in owner, including its replacement transports, until sign-out or unmount. */
export class AuthenticatedSession<Api extends Transport = RpcStub<AuthenticatedApi>> {
  private current: Connection<Api> | null = null
  private epoch = 0
  private ownerId: string | null = null
  private endedReason = 'You signed out. Start the operation again.'
  private changed = new Set<() => void>()
  private ended = new Set<() => void>()

  track(api: Api, identity: Promise<AiChatAuthorInfo>): () => void {
    const connection = { api, identity, broken: false, epoch: this.epoch }
    this.current = connection
    void identity.then(user => {
      if (this.current !== connection) return
      if (user.type !== 'user' || (this.ownerId !== null && this.ownerId !== user.id)) {
        this.end('The signed-in user changed. Start the operation again.')
        connection.epoch = this.epoch
        this.current = connection
      }
      this.ownerId = user.type === 'user' ? user.id : null
      this.notify()
    }).catch(() => {})
    this.notify()
    api.onRpcBroken(() => {
      connection.broken = true
      this.notify()
    })
    return () => {
      // Authentication temporarily removes the old API while its replacement is checked.
      // Only end(), not transport cleanup, ends the owner's pending operations.
      connection.broken = true
      this.notify()
    }
  }

  capture(): AuthenticatedOperation<Api> {
    const start = this.current
    if (!start) throw new Error('The sign-in session is unavailable. Sign in and try again.')
    return (action, signal) => this.run(start, action, signal)
  }

  onEnd(callback: () => void): void { this.ended.add(callback) }

  end(reason = 'You signed out. Start the operation again.'): void {
    this.endedReason = reason
    this.epoch++
    this.current = null
    this.ownerId = null
    this.ended.forEach(callback => callback())
    this.notify()
  }

  private notify() { this.changed.forEach(notify => notify()) }

  private waitForChange(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.changed.delete(changed)
        signal.removeEventListener('abort', aborted)
      }
      const changed = () => { cleanup(); resolve() }
      const aborted = () => { cleanup(); reject(signal.reason) }
      this.changed.add(changed)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
    })
  }

  private async run<T>(start: Connection<Api>, action: (api: Api) => Promise<T>,
    signal: AbortSignal): Promise<T> {
    const owner = await start.identity
    if (owner.type !== 'user') throw new Error('Sign in again to continue.')
    let completed: { value: T } | undefined
    for (;;) {
      signal.throwIfAborted()
      if (start.epoch !== this.epoch) throw new Error(this.endedReason)
      const connection = this.current
      if (!connection || connection.broken) {
        await this.waitForChange(signal)
        continue
      }
      try {
        const user = await connection.identity
        if (this.current !== connection || connection.broken) continue
        signal.throwIfAborted()
        if (user.type !== 'user' || user.id !== owner.id) {
          throw new Error('The signed-in user changed. Start the operation again.')
        }
        // A reply is a known success even if the socket is replaced before delivery to the UI.
        // Reconfirm its owner on the replacement without replaying a completed write.
        completed ??= { value: await action(connection.api) }
        signal.throwIfAborted()
        if (this.current !== connection || connection.broken) continue
        return completed.value
      } catch (error) {
        // Retry only a broken/replaced transport, never a rejection on a live session.
        if (this.current !== connection || connection.broken) continue
        throw error
      }
    }
  }
}

