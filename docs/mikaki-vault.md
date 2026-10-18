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

The apps retain independent sessions. Deployments can optionally use
[direct Mikaki sign-in](mikaki-auth.md), which identifies the app user by issuer
and pairwise subject without merging existing email-keyed accounts. Signing in
does not unlock the Vault. This save does not change the server/AI plaintext
boundary into live E2EE.

Cloudflare OS keeps chat/history in its workspace Overseer DO and code in that
DO's Git object store. Gadget runtime state is separate DO storage. Context
Library's optional Artifacts collections do not back up all of these.

```sh
pnpm --filter @gadgets/workshop-frontend test:run src/features/chat/vaultArchive.test.ts
pnpm exec tsc -p packages/workshop-frontend/tsconfig.json
```

Receiver checks and the paired local browser fixture are described in Mikaki's
`docs/cloudflare-os-vault.md`. Set `MIKAKI_CLOUDFLARE_OS_SOURCE` in that fixture
to this checkout root to bundle its actual sender. Local fixtures do not qualify
hosted sessions, popup policy or physical Passkeys; see the hosted checklist below.


## Bounded workspace save and restore

The same URL setting enables the owner's **Workspace in Vault** section above
the chat pane, including in a workspace with no selected conversation. Expand
it to use **Save workspace to Vault** or **Restore workspace from Vault**. Save uses owner-only `Overseer.exportWorkspaceSnapshot(origin)`.
It captures supervisor chat/history, attachment bytes, Git code/history and
permanent gadget metadata, durably journals every planned clone name, rechecks
the supervisor state, then reads each gadget's SQL/KV from a private frozen
facet clone. No archived gadget code runs during inspection. The source keeps
running; supervisor changes during capture refuse that attempt. Each facet is
individually frozen, without claiming a transaction across all application DOs.

The version-1 portable snapshot is bounded to 2 MiB minus 29 bytes of Vault
framing, 16 workpieces (gadgets and attachment scratch worktrees), 10,000 supervisor records and 10,000 rows/entries per SQL
table/KV store. SQL databases above 8 MiB fail before scanning. Dates, bytes,
undefined, arrays, objects, maps and sets have explicit tags; RPC capabilities,
virtual tables and unsupported values fail rather than being silently omitted.
SQL row IDs, ordinary schemas, generated columns and AUTOINCREMENT high-water
marks are retained. Runtime bookkeeping tables are excluded. Finish
agents/actions and queued agent calls and commit proposed changes first;
provisional gadgets/bindings refuse export. Attachment scratch worktrees retain their
Git files, owning chat and local binding map without creating executable facets or
copying live agent context. Other private worktrees and deleted-worktree archives
refuse export until a separate private-worktree contract exists.
Spawned/callable agent chat scopes also refuse export until their frozen
capabilities have a separate portable contract. Callback history is retained
without bindings to omitted argument capabilities. SQL import refuses
data-producing table DDL and appended statements before staging writes; normal
trigger bodies, CASE expressions and quoted semicolons remain supported.

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
against the source backend/AI. The optional [Mikaki OIDC mode](mikaki-auth.md)
uses the same identity provider for app login, while keeping the app session
and Vault unlock separate.

The trusted `WorkspaceStorageInspector` class is registered by migration `v4`
and used only as a supervisor-owned facet. It has no public route. Deployment
configuration generation must retain this migration. The isolated hosted
installation below includes this implementation.

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
another user's lack of access. These local fixtures do not exercise real
Passkeys or hosted session/popup policies; the hosted journey below records
the separate physical-device evidence.

## Complete local Workshop UI qualification

Mikaki's optional `MIKAKI_CLOUDFLARE_OS_UI=1` browser scenario also loads this
checkout's complete production React bundle. Build it with the exact test Vault
destination before running the paired scenario:

```sh
VITE_MIKAKI_VAULT_URL=https://mikaki.test/vault \
  pnpm exec vp run -F @gadgets/workshop-frontend build
pnpm exec vp run -F @gadgets/integration-tests build:test-gatekeeper
cd /path/to/mikaki
MIKAKI_CLOUDFLARE_OS_SOURCE=/path/to/cloudflare-os \
MIKAKI_CLOUDFLARE_OS_RPC=1 MIKAKI_CLOUDFLARE_OS_UI=1 \
  node --expose-gc --test local/conformance/vault-owner-workspace-browser.test.ts
```

The test serves the unmodified production assets on the local backend's origin.
The real Workshop buttons talk directly to the authenticated WebSocket API in
the browser; no replacement controls or exposed RPC callbacks drive this part.
It exercises reviewed encrypted save, selecting a same-origin snapshot,
restore into a new workspace, navigation and reload. A new RPC session checks
registration, output indexing, chat/attachment data and writable gadget SQL/KV,
and verifies that the source workspace is unchanged and another user is refused.
The Workshop account/session and Mikaki's login/Passkey PRF remain test fixtures.

## Hosted installation and qualification

The isolated Vault installation is deployed at **https://cfos.mikaki.org**,
with **https://auth.mikaki.org/vault** as its receiver. It uses direct Mikaki
OIDC sign-in and a server-managed Workers AI binding, so the owner does not
enter a personal AI API token. Owner sign-in, existing workspace visibility and
a real AI response have been checked. The old staging page URLs redirect to
the canonical domain; snapshots saved from a different origin cannot be
restored into this origin.

Mikaki login does not unlock Vault. Saving and restoring require the owner's
Passkey PRF unlock and the review shown in each Vault popup.

On **2026-10-17**, a hosted Chrome/macOS journey with a real Passkey completed
the reviewed encrypted save and restore into a distinct workspace. The copy
retained chat, committed code, SQL rows, a KV marker and a 106-byte attachment
whose SHA-256 matched the source file. After reloading, a new SQL row persisted
only in the restored gadget; the original retained its single initial row.
The gadget did not seed data from its constructor or read methods.

Closing a save popup before unlock reported cancellation and allowed a fresh
save. After app logout in another tab, the already-open restored app required
sign-in when it next attempted a read. A fresh Mikaki SSO login reopened the
same restored data. This qualifies that controlled desktop fixture, rather
than every device/browser or snapshot size. Separate hosted
[session failure checks](mikaki-auth.md#hosted-session-failure-qualification)
passed issuer revocation without a notification and injected RP idle/absolute
expiry. Existing connections stopped, an expired session could not write, and
normal sign-in preserved the restored data. Hosted signed logout delivery and
mobile physical-device coverage remain separate checks.

Use synthetic data in a dedicated test workspace:

1. Create a short conversation with a small attachment and one permanent
   gadget. Give its code, SQL row and KV value distinct markers. Initialize
   the data explicitly, rather than seeding it in the constructor, so an empty
   restored database cannot appear to pass.
2. Finish the agent and commit every proposed change. Open **Workspace in
   Vault**, then **Save workspace to Vault**. Unlock the popup, review the
   `https://cfos.mikaki.org` source and save the encrypted copy. Check the
   completion receipt in Cloudflare OS.
3. Choose **Restore workspace from Vault**, select that test snapshot and
   review the plaintext disclosure to the same origin. Restore into a new
   workspace; record the distinct source and restored URLs.
4. Reload the restored workspace. Verify chat, attachment contents, code,
   SQL rows and KV marker. Add a row to the restored gadget, reload again,
   then check that the source retains only its original data.
5. Check cancellation and a fresh retry, and verify app logout/session
   invalidation on the hosted installation. Record physical-device and popup
   results separately from local fixture coverage.
6. Qualify issuer revocation and RP expiry using the scoped
   [session failure procedure](mikaki-auth.md#hosted-session-failure-qualification).
   Confirm rejection on an existing connection and unchanged SQL after an
   expired-session write attempt. Do not change account-wide session policy.

A new installation needs isolated storage and an explicit authentication mode.
Follow [direct Mikaki sign-in](mikaki-auth.md) for OIDC; do not configure an
Access gate or `CF_ACCESS_AUD`/`CF_ACCESS_ISS` in that mode. The generic Access
preview workflow remains available through `pnpm preview:deploy --dry-run`.
Do not reuse an unrelated live instance's storage for this qualification.
