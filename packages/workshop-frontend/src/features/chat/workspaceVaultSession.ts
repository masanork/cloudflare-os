import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { AuthenticatedOperation, AuthenticatedSession } from '../auth/authenticatedSession'
import { transferWorkspace, type WorkspaceTransfer } from './vaultWorkspace'

export type VaultApi = Pick<RpcStub<AuthenticatedApi>,
  'openGadget' | 'newGadgetFromWorkspaceSnapshot' | 'onRpcBroken'>

const empty = { workspaceId: '', busy: false, status: '', retry: false }

/** One document-local transfer, owned by sign-in rather than a reconnecting workspace view. */
export class WorkspaceVaultSession {
  private state = empty
  private listeners = new Set<() => void>()
  private control: AbortController | null = null
  private pending: {
    transfer: WorkspaceTransfer; snapshot: string; operationId: string;
    run: AuthenticatedOperation<VaultApi>; onRestored: (id: string) => void;
  } | null = null

  constructor(private session: Pick<AuthenticatedSession<VaultApi>, 'capture' | 'onEnd'>) {
    session.onEnd(() => this.cancel())
  }

  snapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private update(state: typeof empty) {
    this.state = state
    this.listeners.forEach(listener => listener())
  }

  /** Navigation and sign-out cancel; a temporary authentication/loading view does not. */
  setPath(pathname: string): void {
    if (this.state.workspaceId && pathname !== `/workspace/${this.state.workspaceId}` &&
        pathname !== `/gadget/${this.state.workspaceId}`) this.cancel()
  }

  cancel(): void {
    this.control?.abort()
    this.control = null
    this.pending = null
    this.update(empty)
  }

  discard(): void {
    if (this.state.busy) return
    this.pending = null
    this.update({ ...this.state, retry: false, status:
      'Pending restore discarded. If the earlier request completed, its workspace remains in your workspace list. You can now choose another snapshot.' })
  }

  async start(workspaceId: string, destination: URL, mode: 'save' | 'restore',
    onRestored: (id: string) => void): Promise<void> {
    if (this.state.busy) return
    if (this.state.workspaceId && this.state.workspaceId !== workspaceId) this.cancel()
    const abort = new AbortController()
    this.control = abort
    this.update({ workspaceId, busy: true, retry: this.pending !== null, status:
      mode === 'save' ? 'Unlock Mikaki and review the workspace copy before saving.' :
        'Unlock Mikaki, choose a saved snapshot and approve sending its contents here.' })
    try {
      if (!this.pending) {
        const run = this.session.capture()
        const transfer = await transferWorkspace(destination, mode, () => run(async api => {
          using workspace = api.openGadget(workspaceId)
          return await workspace.exportWorkspaceSnapshot(location.origin)
        }, abort.signal), abort.signal)
        abort.signal.throwIfAborted()
        if (mode === 'save') {
          this.update({ ...this.state, status: 'Mikaki confirmed the encrypted workspace snapshot was saved.' })
          return
        }
        if (!transfer.snapshot) throw new Error('No snapshot received.')
        this.pending = { transfer, snapshot: transfer.snapshot,
          operationId: crypto.randomUUID(), run, onRestored }
      }
      const attempt = this.pending
      const id = await attempt.run(api =>
        api.newGadgetFromWorkspaceSnapshot(attempt.snapshot, attempt.operationId), abort.signal)
      abort.signal.throwIfAborted()
      attempt.transfer.restored()
      this.pending = null
      this.update({ ...this.state, retry: false,
        status: 'A new workspace was restored. Reconnect external services there.' })
      attempt.onRestored(id)
    } catch (error) {
      if (!abort.signal.aborted) this.update({ ...this.state, retry: this.pending !== null,
        status: error instanceof Error ? error.message : 'Could not confirm the workspace transfer.' })
    } finally {
      if (!abort.signal.aborted) this.update({ ...this.state, busy: false })
    }
  }
}
