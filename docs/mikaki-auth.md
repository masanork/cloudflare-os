# Sign in to Cloudflare OS with Mikaki

This optional deployment mode uses Mikaki directly as an OIDC provider. The
installation shows **Mikakiでログイン**, then returns to the original application
path after Passkey sign-in and connection review. **アカウントを選ぶ** requests
Mikaki's account-selection screen. App logout removes only this installation's
session and returns to the sign-in button; it does not immediately start SSO.

Vault custody remains a separate operation. Configure the existing
`VITE_MIKAKI_VAULT_URL` for reviewed workspace saves/restores. Signing in neither
unlocks the Vault nor gives Cloudflare OS its keys.

## Configure an installation

Use an installation-specific confidential client and ES256 signing key. Register
its public key and exact callback with the Mikaki operator, and register its
Back-Channel Logout URL:

- Callback: `https://<installation>/api/auth/mikaki/callback`
- Back-Channel Logout: `https://<installation>/api/auth/mikaki/backchannel-logout`

The public registration for the Vault staging instance is in
`deployments/mikaki-vault-preview/client-registration.json`. Its private key is
only a backend Worker secret, never in this repository or the frontend bundle.

The staging installation's canonical origin is `https://cfos.mikaki.org`. Its
back-channel URL is `https://cfos.mikaki.org/api/auth/mikaki/backchannel-logout`.
The October 2026 domain migration retains the existing client ID, signing key,
pairwise subject and application storage. Its dedicated sector namespace moves
with that subject; it must not be regenerated as a new identity. The internal
Context Library `sharingDomain` remains its original namespace so existing
collections stay accessible. Browser cookies are host-only, so the new origin
requires sign-in again.

For legacy page links, set the router's optional `PUBLIC_BASE_URL` to the same
canonical origin and enable `assets.run_worker_first=true` on that installation.
GET/HEAD page requests redirect temporarily with their path and query intact.
API and connector callbacks and POST requests retain their original handlers,
so callback credentials are never replayed across origins by this redirect.

Backend bindings/variables:

| Name | Value |
| --- | --- |
| `PUBLIC_BASE_URL` | Exact HTTPS origin, without trailing slash |
| `MIKAKI_ISSUER` | Exact HTTPS Mikaki issuer, normally `https://auth.mikaki.org` |
| `MIKAKI_CLIENT_ID` | Registered client ID |
| `MIKAKI_PRIVATE_JWK` | Secret: registered P-256 private JWK with `kid` |
| `MIKAKI_AUTH_DB` | Dedicated RP D1, with `migrations/0001_mikaki_auth.sql` applied |
| `MIKAKI_ALLOWED_SUBJECTS` | JSON array of explicitly admitted pairwise subjects; unset/empty admits nobody |
| `ADMINS` | Existing admin-name array, using `mikakiUserName(issuer, sub)` for an admitted admin |

Do not bind the issuer's D1 as `MIKAKI_AUTH_DB`. This database holds only this
app's login transactions, hashed app sessions and logout tombstones. Expired
records are pruned when a new login starts. Do not configure `CF_ACCESS_AUD` or
`CF_ACCESS_ISS` in this mode. Remove any Access gate on the installation origin
only after the RP is configured and deployed, so the OP can deliver logout.
Keep the backend private behind its router service binding.

Build the frontend with `VITE_MIKAKI_AUTH_MODE=true`,
`VITE_CF_ACCESS_MODE=false` and, for Vault, the existing Vault URL flag. Vite's
build cache already fingerprints `VITE_*` values. Default builds retain the
existing password/gatekeeper/Access deployment behavior. The native app's
device-session handoff is explicitly unavailable in this first web-only mode.

## Offer Workers AI without personal tokens

Mikaki sign-in does not configure a model provider. For an installation that
offers Workers AI immediately, keep the backend's `WORKERS_AI` binding and set:

| Backend variable | Value |
| --- | --- |
| `CF_AI_GATEWAY` | An existing AI Gateway in this Worker's Cloudflare account |
| `CF_AI_GATEWAY_ACCOUNT_ID` | That Cloudflare account's ID |
| `CF_AI_GATEWAY_PROVIDERS` | `cloudflare` |
| `CF_AI_GATEWAY_USE_BINDING` | `true` |

The same-account binding authenticates inference and cost-log reads, so neither
the backend nor the browser needs a personal API token for this configuration.
Onboarding lists the deployment's enabled models for selection. Inference uses
the installation's Cloudflare account; its gateway billing and model access
must already be configured. Without these variables, onboarding asks users to
add their own model credentials. Do not use a deployment-management API token
as an inference credential.

## Identity and session boundaries

The app uses `mikaki-<SHA256(JSON([issuer, sub]))>` as its own user name. The
hyphenated namespace cannot be registered by the legacy password username
validator. No email is requested or invented, and no existing email-keyed
account is merged. Display names start as `Mikaki user` and are set during
onboarding. Admitting a subject and granting an app role are deployment
operations, independent of authenticating successfully with Mikaki.

Only the configured issuer's `/authorize`, `/token`, `/jwks` and `/session/check`
endpoints are used. Browser-bound state, nonce, PKCE S256 and one-time callback
consumption protect each login. The server uses ES256 `private_key_jwt` with a
fresh assertion for every token exchange and session check. It pins token
algorithm, purpose, issuer, audience, authorized party, time and nonce, then
confirms the SID/subject/authentication time before creating a session.

Browser cookies are host-only, Secure, HttpOnly and SameSite=Lax. The RP never
returns ID/access tokens, client assertions or private keys to frontend code or
localStorage. State/CSRF failure and cancellation have a clean retry link.

Every inbound and outbound WebSocket RPC message checks the primary RP session
store, including calls on previously returned workspace capabilities. Timers
renew the issuer lease without extending the application's idle deadline;
revocation, expired idle time or failed renewal closes the connection. The
socket cannot keep authority after its lease expires. Logout atomically records
an SID tombstone and deletes its sessions, including when delivery precedes the
callback. No retained authenticated capability can bypass the connection guard.

## Verification

```sh
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/mikaki-auth.test.ts
pnpm --filter @gadgets/workshop-frontend exec vitest run src/features/auth/mikakiSession.test.tsx src/useAuth.test.tsx
MIKAKI_SOURCE=/path/to/built/mikaki pnpm exec node --test scripts/mikaki-oidc-journey.test.mjs
pnpm lint
```

The opt-in interoperability test uses an actual Rust Mikaki Worker, isolated
D1 databases and a Chromium virtual Passkey. It validates enrollment, first
connection review, real code exchange/ID Token/SID checks, callback replay and
OP-side revocation. It also logs out through the real OP UI and Queue sender,
delivers its signed Back-Channel Logout token to the actual RP receiver, and
checks that an unexpired RP session is deleted and its SID tombstoned. A retained
RPC capability can no longer increment a fixture counter, duplicate delivery is
acknowledged, and the old browser session returns to sign-in. The counter is a
minimal RPC fixture using the real session guard, rather than the full Workshop
application. It does not access a hosted account or a real Passkey, or qualify
hosted notification delivery.
On the isolated `https://cfos.mikaki.org` installation, owner sign-in and
existing workspace visibility have been checked after the domain migration.
Managed Workers AI onboarding and a real AI response were also checked.
The [hosted Vault qualification journey](mikaki-vault.md#hosted-installation-and-qualification)
also passed on 2026-10-17 with a real Passkey, reviewed save/restore, reloaded
business data and an unchanged source. App logout forced an already-open tab
back to sign-in on its next read, and normal SSO reopened the restored copy.
The hosted session checks below cover issuer-side revocation and injected RP
expiry separately from that save/restore journey and the local fixture.

### Hosted session failure qualification

On **2026-10-17**, the isolated Chrome/macOS installation passed these checks
with its restored synthetic gadget open on an existing WebSocket:

| Check | Injection and observed result |
| --- | --- |
| Issuer revocation without a notification | An operator revoked exactly the current Cloudflare OS `client_session` in the issuer's D1. The RP's existing 300-second lease was left unchanged and no logout delivery was queued. Reads still worked within the lease. At its natural deadline the open connection stopped, the page returned to sign-in without another user operation or reload, and the RP session row was deleted. |
| RP idle expiry | Only that test RP session's `idle_expires_at` was shortened. After the deadline, **Add restored note** through the retained gadget capability returned the page to sign-in. Reopening still showed exactly the original two SQL rows: the attempted write did not run. |
| RP absolute expiry | Only a new test RP session's cached `parent_expires_at` was shortened. A read before the deadline capped both its lease and idle deadline at that time. The open page returned to sign-in automatically after the deadline. |

Each retry used the normal sign-in button, obtained a different app SID and
reopened the same workspace with its code, SQL and KV intact. The actual parent
SSO expiry, other app sessions, and issuer policy (300-second checks and
seven-day app idle timeout) were unchanged. The revoked SID was not reactivated.

These are scoped operator fault-injection checks. They do not qualify hosted
signed Back-Channel Logout delivery, a real 30-day SSO expiry, or physical mobile
Passkey/popup behavior. For a repeat, use a dedicated synthetic workspace and
record the exact current RP session before changing anything. Identify the
issuer row by its client ID and SID; do not revoke an account or change global
policy. Keep session values private. After expiry, sign in normally rather than
restoring an expired or revoked row, and verify that a refused write did not
change the gadget's persisted data.

### Hosted signed Back-Channel Logout qualification

On **2026-10-19**, Chrome/macOS passed the hosted journey using a real Passkey
and a separate private-window SSO with only Cloudflare OS attached. After the
synthetic restored gadget was opened, normal Mikaki logout completed through
the OP UI. Worker telemetry confirmed a successful Queue invocation, and the
delivery record reported `delivered`, HTTP **200**, on its first attempt.

The target RP session was deleted and its SID tombstoned while **158 seconds**
remained on its original lease. The already-open gadget returned to the sign-in
screen without a page reload; the recorded screen still preceded the original
lease deadline by **138 seconds**. A separate existing browser session reopened
the same workspace and confirmed its three SQL rows and code/KV markers were
unchanged. The other nine attached client sessions retained their previous
revocation state, and all three other RP sessions remained present.

The page had already returned to sign-in before an explicit retained gadget
write could be attempted. Retained-counter write denial and duplicate signed
delivery acknowledgement remain covered by the local real-OP interoperability
test above; neither was exercised separately in this hosted run. Physical
mobile Passkey and Vault popup behavior also remain unqualified.

For a repeat, use a separate test SSO with only Cloudflare OS attached: normal
Mikaki logout also revokes the other applications derived from that SSO. Check
the attachment set and remaining RP lease immediately before logout, keep
session values private, and preserve existing owner sessions. No session-policy
or deployment change was needed for this qualification.
