# Save conversations and workspaces to Mikaki Vault

The optional frontend integration adds **Save conversation to Vault** to an open
chat. Configure build-time `VITE_MIKAKI_VAULT_URL` with an exact Mikaki `/vault`
URL without query/fragment. The button stays hidden if unset/invalid. Use HTTPS
for real endpoints; loopback HTTP is permitted for development fixtures.

The user opens Mikaki, signs in/unlocks the Vault, reviews the source/title/text
and explicitly saves an encrypted copy. There is no downloaded export or server
credential exchange. The browser pins the popup, origin and random channel.
Only a recipient receipt after its record commit is success. Closing, switching
chats, timeout and failed reads stop the transfer.

`Overseer.getChatHistory()` supplies the selected chat's current page, after its
latest context checkpoint. The copy retains human/AI text, speaker names,
timestamps, scoped source identity and original message sequences. It excludes
reasoning, attachment bytes, tool/operation logs, generated files and runtime
state. Limits are 200 messages and 24,000 serialized UTF-8 bytes; excess fails
rather than truncating. Each deliberate save adds a snapshot; it is not sync.

The apps retain independent sessions. This does not replace the Workshop's
email-keyed authentication gatekeepers with Mikaki OIDC or merge accounts.
Later SSO needs issuer/subject identity and linking rules. This save does not
change the server/AI plaintext boundary into live E2EE.

Cloudflare OS keeps chat/history in its workspace Overseer DO and code in that
DO's Git object store. Gadget runtime state is separate DO storage. Context
Library's optional Artifacts collections do not back up all of these.

```sh
pnpm --filter @gadgets/workshop-frontend test:run src/features/chat/vaultArchive.test.ts
pnpm exec tsc -p packages/workshop-frontend/tsconfig.json
```

Receiver checks and the paired local browser fixture are described in Mikaki's
`docs/cloudflare-os-vault.md`. Set `MIKAKI_CLOUDFLARE_OS_SOURCE` in that fixture
to this checkout root to bundle its actual sender. No hosted connection,
real-device or production qualification is claimed.


## Bounded workspace save and restore

The same URL setting enables the owner's **Workspace in Vault** section above
the chat pane, including in a workspace with no selected conversation. Expand
it to use **Save workspace to Vault** or **Restore workspace from Vault**. Save uses owner-only `Overseer.exportWorkspaceSnapshot(origin)`.
It captures supervisor chat/history, attachment bytes, Git code/history and
permanent gadget metadata, then reads each gadget's SQL/KV from a private frozen
facet clone. No archived gadget code runs during inspection. The source keeps
running; supervisor changes during capture refuse that attempt. Each facet is
individually frozen, without claiming a transaction across all application DOs.

The version-1 portable snapshot is bounded to 2 MiB minus 29 bytes of Vault
framing, 16 gadgets, 10,000 supervisor records and 10,000 rows/entries per SQL
table/KV store. SQL databases above 8 MiB fail before scanning. Dates, bytes,
undefined, arrays, objects, maps and sets have explicit tags; RPC capabilities,
virtual tables and unsupported values fail rather than being silently omitted.
SQL row IDs, ordinary schemas, generated columns and AUTOINCREMENT high-water
marks are retained. Runtime bookkeeping tables are excluded. Finish
agents/actions and queued agent calls and commit proposed changes first;
provisional gadgets/bindings and current or deleted private worktrees refuse
export until a separate private-worktree contract exists.

Workspaces marked `containsRestrictedData` or `ownerInvitesOnly` refuse export,
including when either flag changes during capture. The raw historical
`prohibitAllSharing` key is read through the current typed storage accessor.
Current version-5 storage is supported; version-4 snapshots run the existing
blueprint-upstream migration when restored. Allocation counters are retained,
including hook and agent-call IDs from closed history.

Mikaki's unlocked Owner UI explicitly saves the encrypted copy in its dedicated
`workspace-snapshots` collection. Its `mikaki-workspace-v1` protocol pins the
opener, exact origin, random channel and save/restore mode. Vault credentials
and keys stay in Mikaki. Source origin/workspace claims are not signatures.

Restore asks the owner to select a saved copy in Mikaki and approve disclosing
its plaintext back to the same app origin. The Cloudflare OS frontend calls
`AuthenticatedApi.newGadgetFromWorkspaceSnapshot(snapshot, operationId)` as the
current signed-in user. The broker derives a fresh workspace ID from that
caller and operation, stages gadget data, then publishes business rows and
rebuilt indexes. The original workspace is preserved. Durable owner/digest
receipts reject changed retries and make identical retries idempotent. After
an uncertain response, **Retry the same restore** retains that exact snapshot
and operation ID for the mounted view; nothing stores plaintext in browser
storage. Losing the view may create a second copy on a later deliberate restore.

External gatekeeper accounts/resources, shared links, collaborators, observers,
approval rules, hooks, live agent context/callback arguments, alarms and sessions
are not restored. Internal gadget-to-gadget bindings are kept; external
connections must be configured again. External Artifacts stores are not crawled.
This is a business-data copy contract, not native runtime serialization or E2EE
against the source backend/AI. App sessions remain independent; Mikaki OIDC SSO
is a separate increment.

The trusted `WorkspaceStorageInspector` class is registered by migration `v4`
and used only as a supervisor-owned facet. It has no public route. Deployment
configuration generation must retain this migration. No hosted deployment has
been performed for this implementation.

```sh
pnpm exec vp run -F @gadgets/typed-storage build
cd packages/workshop-backend
pnpm exec vitest run __tests__/workspace-storage.test.ts __tests__/workspace-snapshot.test.ts
cd ../workshop-frontend
pnpm exec vitest run src/features/chat/vaultWorkspace.test.ts src/features/chat/vaultArchive.test.ts
```

The backend tests run in workerd: clone/restore SQL and KV, multiple gadgets,
chat/Git/attachments, retry receipts, interrupted staging, owner-only export,
SQL rollback and generated/index/view/trigger schemas. Mikaki's paired browser
fixture bundles the actual frontend transfer module; it validates large
encrypted writes, lost responses, explicit plaintext disclosure, reopen,
mobile accessibility and lock cleanup. Optional `MIKAKI_CLOUDFLARE_OS_RPC=1`
connects its source-page fixture to the real authenticated WebSocket API via
Playwright callbacks. It saves an actual workspace through Mikaki, restores
through the public broker, then reopens on a new session and checks chat,
binary attachments and writable gadget SQL/KV while the original is unchanged.
Registration is marked active so the restored workspace is listed immediately;
its outputs index is refreshed. The source page and Passkey are fixtures.

```sh
pnpm exec vp run -F @gadgets/integration-tests build:test-gatekeeper
cd packages/integration-tests
pnpm exec vitest run __tests__/workspace-vault.test.ts
```

The RPC test also checks caller-scoped operation IDs, exact/changed retries and
another user's lack of access. Real devices, the complete hosted frontend,
account linking and popup policy still need deployed qualification.
