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
OP-side revocation. It does not access a hosted account or a real Passkey.
On the isolated `https://cfos.mikaki.org` installation, owner sign-in and
existing workspace visibility have been checked after the domain migration.
Managed Workers AI onboarding and a real AI response were also checked.
Physical Passkey Vault unlock and a reviewed hosted save/restore still require
the [Vault qualification journey](mikaki-vault.md#hosted-installation-and-qualification);
neither deployment nor the local virtual-Passkey test proves that roundtrip.
