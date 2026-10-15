import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, jwtVerify } from "jose";
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import schema from "../migrations/0001_mikaki_auth.sql?raw";
import { currentMikakiSession, handleMikakiAuth, mikakiUserName } from "../src/auth/mikaki";
import { newMikakiRpcSession } from "../src/auth/mikaki-rpc";
import type { UserDurableObject } from "../src/user";

declare module "cloudflare:workers" {
  interface ProvidedEnv { MIKAKI_AUTH_DB: D1Database; TEST_USER: DurableObjectNamespace<UserDurableObject> }
}

const origin = "https://workshop.example";
const issuer = "https://mikaki.example";
const prefix = origin + "/api/auth/mikaki";
const timestamp = () => Math.floor(Date.now() / 1000);
const opKeys = await generateKeyPair("ES256");
const rpKeys = await generateKeyPair("ES256", { extractable: true });
const rpJwk = { ...await exportJWK(rpKeys.privateKey), kid: "rp-key" };
const opJwk = { ...await exportJWK(opKeys.publicKey), kid: "op-key", alg: "ES256", use: "sig" };
const cfg = { ...env, MIKAKI_ISSUER: issuer, MIKAKI_CLIENT_ID: "test-client",
  MIKAKI_PRIVATE_JWK: JSON.stringify(rpJwk), MIKAKI_ALLOWED_SUBJECTS: '["owner-sub"]',
  PUBLIC_BASE_URL: origin } as Cloudflare.Env;
let overrides: Record<string, unknown>;
let inactive: boolean;
let failCheck: boolean;
let beforeCheckResponse: (() => Promise<void>) | undefined;
let exchangeCount: number;
let authenticationTime: number;
const assertions = new Set<string>();

const request = (path: string, cookies = "", init: RequestInit = {}) => new Request(prefix + path, {
  ...init, headers: { Cookie: cookies, ...init.headers },
});
const post = (path: string, cookies: string, values: Record<string, string>, source = origin) =>
  request(path, cookies, { method: "POST", headers: { Origin: source,
    "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) });
const cookieValue = (response: Response) => response.headers.get("Set-Cookie")!.split(";")[0];

beforeEach(async () => {
  await env.MIKAKI_AUTH_DB.exec("DROP TABLE IF EXISTS mikaki_login; DROP TABLE IF EXISTS mikaki_session; DROP TABLE IF EXISTS mikaki_logout;");
  await env.MIKAKI_AUTH_DB.batch(schema.split(";").map(s => s.trim()).filter(Boolean).map(s => env.MIKAKI_AUTH_DB.prepare(s)));
  overrides = {}; inactive = false; failCheck = false; exchangeCount = 0;
  beforeCheckResponse = undefined; assertions.clear(); authenticationTime = timestamp() - 10;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === issuer + "/jwks") return Response.json({ keys: [opJwk] });
    const body = url.endsWith("/session/check")
      ? JSON.parse(String(init!.body)) : Object.fromEntries(new URLSearchParams(String(init!.body)));
    const { payload } = await jwtVerify(body.client_assertion, rpKeys.publicKey, {
      audience: url, issuer: "test-client", algorithms: ["ES256"],
    });
    expect(payload.sub).toBe("test-client");
    expect(assertions.has(payload.jti!)).toBe(false);
    assertions.add(payload.jti!);
    if (url === issuer + "/token") {
      exchangeCount++;
      const tx = await env.MIKAKI_AUTH_DB.prepare("SELECT nonce,verifier FROM mikaki_login LIMIT 1").first();
      // The callback consumed its transaction before making this request; test captures the nonce separately.
      expect(tx).toBeNull();
      expect(body.code_verifier).toBe(verifier);
      const token = await new SignJWT({ sub: "owner-sub", sid: "owner-sid", nonce,
        auth_time: authenticationTime, ...overrides })
        .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "op-key" })
        .setIssuer(issuer).setAudience("test-client").setIssuedAt(timestamp())
        .setExpirationTime(timestamp() + 300).sign(opKeys.privateKey);
      return Response.json({ id_token: token });
    }
    if (url === issuer + "/session/check") {
      if (failCheck) return new Response(null, { status: 503 });
      await beforeCheckResponse?.();
      return Response.json({ active: !inactive, sub: "owner-sub", auth_time: authenticationTime,
        expires_at: timestamp() + 3600, lease_ttl: 120, app_idle_timeout: 600 });
    }
    throw new Error("Unexpected issuer request");
  }));
});
afterEach(() => vi.unstubAllGlobals());
let nonce = "", verifier = "";

async function start() {
  const bootstrap = await handleMikakiAuth(request("/csrf"), cfg);
  const browser = cookieValue(bootstrap);
  const { csrf } = await bootstrap.json() as { csrf: string };
  const started = await handleMikakiAuth(post("/login", browser, { csrf, return_to: "/workspace/test?chat=1" }), cfg);
  expect(started.status).toBe(303);
  const target = new URL(started.headers.get("Location")!);
  expect(target.origin).toBe(issuer);
  expect(target.searchParams.get("scope")).toBe("openid");
  expect(target.searchParams.get("code_challenge_method")).toBe("S256");
  const tx = await env.MIKAKI_AUTH_DB.prepare("SELECT nonce,verifier FROM mikaki_login LIMIT 1")
    .first<{ nonce: string; verifier: string }>();
  nonce = tx!.nonce; verifier = tx!.verifier;
  return { browser, csrf, state: target.searchParams.get("state")!, target };
}
async function finish(login: Awaited<ReturnType<typeof start>>, browser = login.browser) {
  return handleMikakiAuth(request("/callback?" + new URLSearchParams({ state: login.state,
    code: "single-use-code", iss: issuer }), browser), cfg);
}
async function signedIn() {
  const login = await start();
  const response = await finish(login);
  expect(response.status).toBe(303);
  return { ...login, session: cookieValue(response), response };
}
async function logoutToken(values: Record<string, unknown> = {}) {
  return new SignJWT({ sid: "owner-sid", sub: "owner-sub", jti: crypto.randomUUID(),
    events: { "http://schemas.openid.net/event/backchannel-logout": {} }, ...values })
    .setProtectedHeader({ alg: "ES256", typ: "logout+jwt", kid: "op-key" })
    .setIssuer(issuer).setAudience("test-client").setIssuedAt(timestamp())
    .setExpirationTime(timestamp() + 120).sign(opKeys.privateKey);
}

describe("Mikaki RP", () => {
  it("creates an app-owned profile in its separate DO namespace without an email", async () => {
    const name = await mikakiUserName(issuer, crypto.randomUUID());
    const user = env.TEST_USER.getByName(name);
    let rejected: unknown;
    try { await user.authenticateFromMikaki(name, false); } catch (error) { rejected = error; }
    expect(String(rejected)).toContain("disabled");
    await user.authenticateFromMikaki(name, true);
    expect(await user.whoami()).toMatchObject({ id: name, name: "Mikaki user", type: "user" });
    await user.setOwnDisplayName("Owner");
    await user.authenticateFromMikaki(name, false);
    expect((await user.whoami()).name).toBe("Owner");
  });
  it("creates a browser-bound, single-use session without email or browser-readable OIDC tokens", async () => {
    const login = await signedIn();
    expect(login.response.headers.get("Location")).toBe("/workspace/test?chat=1");
    expect(login.response.headers.get("Set-Cookie")).toContain("Secure; HttpOnly; SameSite=Lax");
    const session = await currentMikakiSession(request("/session", login.session), cfg);
    expect(session?.sub).toBe("owner-sub");
    expect((await finish(login)).status).toBe(400);
    expect(exchangeCount).toBe(1);
    expect(await mikakiUserName(issuer, "owner-sub")).not.toBe(await mikakiUserName("https://other.example", "owner-sub"));
    expect(await mikakiUserName(issuer, "owner-sub")).toMatch(/^mikaki-[\w-]{43}$/);
  });

  it("rejects a foreign browser, wrong issuer and repeated callback parameters before exchanging a code", async () => {
    const login = await start();
    expect((await finish(login, "__Host-cfos-mikaki-browser=foreign")).status).toBe(400);
    expect((await handleMikakiAuth(request(`/callback?state=${login.state}&code=x&iss=https://evil.example`, login.browser), cfg)).status).toBe(400);
    expect((await handleMikakiAuth(request(`/callback?state=${login.state}&state=duplicate&iss=${issuer}&code=x`, login.browser), cfg)).status).toBe(400);
    expect(exchangeCount).toBe(0);
    expect((await finish(login)).status).toBe(303);
  });

  it.each([{ nonce: "wrong" }, { sub: "unlisted-sub" }, { azp: "other-client" }, { auth_time: timestamp() + 2000 }])(
    "refuses a mismatched identity: %j", async bad => {
      const login = await start(); overrides = bad;
      expect([400, 401, 403]).toContain((await finish(login)).status);
      expect(await env.MIKAKI_AUTH_DB.prepare("SELECT COUNT(*) AS n FROM mikaki_session").first("n")).toBe(0);
    });

  it("checks origin, CSRF, and local return targets", async () => {
    const login = await start();
    for (const return_to of ["//evil.example/", "/\\evil.example/", "/api/auth/mikaki/login"]) {
      expect((await handleMikakiAuth(post("/login", login.browser, { csrf: login.csrf, return_to }), cfg)).status).toBe(400);
    }
    expect((await handleMikakiAuth(post("/login", login.browser, { csrf: login.csrf }, "https://evil.example"), cfg)).status).toBe(403);
    expect((await handleMikakiAuth(post("/login", login.browser, { csrf: "wrong" }), cfg)).status).toBe(403);
  });

  it("does not establish a session when the issuer's initial session check fails", async () => {
    const login = await start(); failCheck = true;
    expect((await finish(login)).status).toBe(503);
    expect(await env.MIKAKI_AUTH_DB.prepare("SELECT COUNT(*) AS n FROM mikaki_session").first("n")).toBe(0);
  });

  it("cannot resurrect a session when backchannel logout arrives before its callback", async () => {
    const login = await start();
    const result = await handleMikakiAuth(post("/backchannel-logout", "", { logout_token: await logoutToken() }), cfg);
    expect(result.status).toBe(200);
    expect((await finish(login)).status).toBe(401);
  });

  it("revokes a session and safely accepts duplicate logout deliveries", async () => {
    const login = await signedIn();
    const token = await logoutToken();
    for (let n = 0; n < 2; n++) {
      expect((await handleMikakiAuth(post("/backchannel-logout", "", { logout_token: token }), cfg)).status).toBe(200);
    }
    expect(await currentMikakiSession(request("/session", login.session), cfg)).toBeNull();
  });

  it("does not accept another subject's logout or logout tokens bearing a nonce", async () => {
    const login = await signedIn();
    for (const values of [{ sub: "someone-else" }, { nonce: "not-allowed" }]) {
      expect((await handleMikakiAuth(post("/backchannel-logout", "", { logout_token: await logoutToken(values) }), cfg)).status).toBe(400);
    }
    expect(await currentMikakiSession(request("/session", login.session), cfg)).not.toBeNull();
  });

  it("fails closed after an expired lease and never revives a concurrent logout", async () => {
    const login = await signedIn();
    await env.MIKAKI_AUTH_DB.prepare("UPDATE mikaki_session SET lease_until=?").bind(timestamp() - 1).run();
    failCheck = true;
    await expect(currentMikakiSession(request("/session", login.session), cfg)).rejects.toThrow("unavailable");
    failCheck = false;
    beforeCheckResponse = async () => {
      await env.MIKAKI_AUTH_DB.prepare("DELETE FROM mikaki_session").run();
    };
    expect(await currentMikakiSession(request("/session", login.session), cfg)).toBeNull();
  });

  it("signs out only this app and rejects its old cookie without silently starting SSO", async () => {
    const login = await signedIn();
    const result = await handleMikakiAuth(post("/logout", login.browser + "; " + login.session, { csrf: login.csrf }), cfg);
    expect(result.status).toBe(204);
    expect(result.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await currentMikakiSession(request("/session", login.session), cfg)).toBeNull();
    expect((await handleMikakiAuth(request("/session", login.session), cfg)).status).toBe(200);
  });

  it("fences an already returned RPC capability after logout", async () => {
    const login = await signedIn();
    let reads = 0;
    class Child extends RpcTarget { async read() { return ++reads; } }
    class Main extends RpcTarget { async child() { return new Child(); } }
    const pair = new WebSocketPair(); pair[0].accept(); pair[1].accept();
    const server = newMikakiRpcSession(pair[0], new Main(), async touch => {
      const session = await currentMikakiSession(request("/session", login.session), cfg, touch);
      if (!session) throw new Error("Session ended");
      return session.lease_until * 1000;
    });
    const client = newWebSocketRpcSession<Main>(pair[1]);
    try {
      using child = await client.child();
      expect(await child.read()).toBe(1);
      await env.MIKAKI_AUTH_DB.prepare("DELETE FROM mikaki_session").run();
      await expect(child.read()).rejects.toThrow();
      expect(reads).toBe(1);
    } finally { client[Symbol.dispose](); server[Symbol.dispose](); }
  });

  it("closes an idle RPC connection at its lease deadline", async () => {
    class Main extends RpcTarget { async ping() { return "ok"; } }
    const pair = new WebSocketPair(); pair[0].accept(); pair[1].accept();
    const deadline = Date.now() + 100;
    const server = newMikakiRpcSession(pair[0], new Main(), async () => deadline);
    const client = newWebSocketRpcSession<Main>(pair[1]);
    try {
      expect(await client.ping()).toBe("ok");
      await new Promise(resolve => setTimeout(resolve, 130));
      await expect(client.ping()).rejects.toThrow();
    } finally { client[Symbol.dispose](); server[Symbol.dispose](); }
  });

  it("allows only one of two simultaneous callbacks to exchange the code", async () => {
    const login = await start();
    const results = await Promise.all([finish(login), finish(login)]);
    expect(results.map(r => r.status).toSorted()).toEqual([303, 400]);
    expect(exchangeCount).toBe(1);
  });
});
