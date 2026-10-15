import { createRemoteJWKSet, decodeProtectedHeader, importJWK, jwtVerify, SignJWT } from "jose";

const PREFIX = "/api/auth/mikaki";
const BROWSER = "__Host-cfos-mikaki-browser";
const SESSION = "__Host-cfos-mikaki-session";
const now = () => Math.floor(Date.now() / 1000);
const random = () => crypto.randomUUID() + crypto.randomUUID();
const encoder = new TextEncoder();
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "strict-origin", "X-Content-Type-Options": "nosniff" };

type Config = {
  db: D1Database;
  issuer: string;
  origin: string;
  clientId: string;
  privateJwk: string;
  subjects: string[];
};

/** Server-side, issuer-bound application session. No OIDC token reaches page JavaScript. */
export type MikakiSession = {
  token_hash: string;
  sid: string;
  sub: string;
  auth_time: number;
  lease_until: number;
  parent_expires_at: number;
  idle_expires_at: number;
  idle_timeout: number;
};

class AuthError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function fail(status: number, message: string): never { throw new AuthError(status, message); }

function config(env: Cloudflare.Env): Config {
  const issuer = env.MIKAKI_ISSUER;
  const origin = env.PUBLIC_BASE_URL;
  if (!issuer || !origin || !env.MIKAKI_CLIENT_ID || !env.MIKAKI_PRIVATE_JWK ||
      !env.MIKAKI_AUTH_DB || env.CF_ACCESS_AUD) fail(503, "Mikaki sign-in is not configured.");
  for (const value of [issuer, origin]) {
    const url = new URL(value);
    if (url.origin !== value || url.protocol !== "https:") fail(503, "Invalid sign-in origin.");
  }
  const subjects: unknown = JSON.parse(env.MIKAKI_ALLOWED_SUBJECTS ?? "[]");
  if (!Array.isArray(subjects) || !subjects.every(s => typeof s === "string" && s.length > 0)) {
    fail(503, "Invalid membership configuration.");
  }
  return { db: env.MIKAKI_AUTH_DB, issuer, origin, clientId: env.MIKAKI_CLIENT_ID,
    privateJwk: env.MIKAKI_PRIVATE_JWK, subjects };
}

async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** A separate namespace from email/password accounts; no implicit account linking. */
export async function mikakiUserName(issuer: string, subject: string): Promise<string> {
  return "mikaki-" + await hash(JSON.stringify([issuer, subject]));
}

function cookie(request: Request, name: string): string {
  const values = (request.headers.get("Cookie") ?? "").split(";").map(s => s.trim())
    .filter(s => s.startsWith(name + "="));
  if (values.length > 1) fail(400, "Duplicate sign-in cookie.");
  return values[0]?.slice(name.length + 1) ?? "";
}
function setCookie(name: string, value: string, age: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, age)}`;
}
function redirect(location: string, cookies: string[] = []): Response {
  const response = new Response(null, { status: 303, headers: { ...headers, Location: location } });
  for (const value of cookies) response.headers.append("Set-Cookie", value);
  return response;
}

async function boundedText(response: Request | Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) fail(400, "Missing request body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); fail(413, "Sign-in message too large."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}
async function form(request: Request): Promise<URLSearchParams> {
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/x-www-form-urlencoded") {
    fail(415, "Expected a form.");
  }
  const result = new URLSearchParams(await boundedText(request, 16384));
  if ([...result].length > 12 || new Set(result.keys()).size !== [...result].length) {
    fail(400, "Invalid sign-in form.");
  }
  return result;
}
async function protectedForm(request: Request, cfg: Config): Promise<URLSearchParams> {
  if (request.headers.get("Origin") !== cfg.origin) fail(403, "Invalid request origin.");
  const result = await form(request);
  const browser = cookie(request, BROWSER);
  if (!browser || result.get("csrf") !== await hash(browser)) fail(403, "Invalid sign-in request.");
  return result;
}

async function issuerPost(cfg: Config, path: string, values: Record<string, string>) {
  const endpoint = cfg.issuer + path;
  const jwk = JSON.parse(cfg.privateJwk);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.kid !== "string") {
    fail(503, "Sign-in key unavailable.");
  }
  const assertion = await new SignJWT({ sub: cfg.clientId, jti: random() })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: jwk.kid })
    .setIssuer(cfg.clientId).setAudience(endpoint).setIssuedAt(now()).setExpirationTime(now() + 60)
    .sign(await importJWK(jwk, "ES256"));
  const body = { ...values, client_id: cfg.clientId,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion };
  const json = path === "/session/check";
  const response = await fetch(endpoint, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded" },
    body: json ? JSON.stringify(body) : new URLSearchParams(body),
  });
  if (!response.ok) fail(503, "Mikaki is temporarily unavailable. Please sign in again.");
  return JSON.parse(await boundedText(response, 16384)) as Record<string, unknown>;
}

async function checkLease(cfg: Config, session: Pick<MikakiSession, "sid" | "sub" | "auth_time">) {
  const started = now();
  const result = await issuerPost(cfg, "/session/check", { sid: session.sid });
  if (result.active !== true || result.sub !== session.sub || result.auth_time !== session.auth_time ||
      typeof result.expires_at !== "number" || !Number.isSafeInteger(result.expires_at) ||
      typeof result.lease_ttl !== "number" || !Number.isSafeInteger(result.lease_ttl) ||
      result.lease_ttl <= 0 || result.lease_ttl > 300 ||
      typeof result.app_idle_timeout !== "number" || !Number.isSafeInteger(result.app_idle_timeout) ||
      result.app_idle_timeout <= 0) fail(401, "Your Mikaki session has ended. Please sign in again.");
  const lease = Math.min(started + result.lease_ttl, result.expires_at);
  if (lease <= now()) fail(401, "Your Mikaki session has expired.");
  return { lease, parent: result.expires_at, idle: result.app_idle_timeout };
}

/** Check the primary session store on every inbound RPC message, including retained capabilities. */
export async function currentMikakiSession(request: Request, env: Cloudflare.Env,
    touch = true): Promise<MikakiSession | null> {
  const cfg = config(env);
  const secret = cookie(request, SESSION);
  if (!secret) return null;
  const db = cfg.db.withSession("first-primary");
  const session = await db.prepare(
    "SELECT * FROM mikaki_session WHERE token_hash=? AND issuer=? AND client_id=? AND idle_expires_at>? AND parent_expires_at>?",
  ).bind(await hash(secret), cfg.issuer, cfg.clientId, now(), now()).first<MikakiSession>();
  if (!session || !cfg.subjects.includes(session.sub)) return null;
  let valid: Awaited<ReturnType<typeof checkLease>> | undefined;
  if (session.lease_until <= now()) {
    try { valid = await checkLease(cfg, session); }
    catch (error) {
      if (error instanceof AuthError && error.status === 401) {
        await db.prepare("DELETE FROM mikaki_session WHERE token_hash=?").bind(session.token_hash).run();
      }
      throw error;
    }
  }
  const timestamp = now();
  const parent = Math.min(session.parent_expires_at, valid?.parent ?? session.parent_expires_at);
  if (valid && valid.lease <= timestamp) fail(401, "Your Mikaki session has expired.");
  // UPDATE ... RETURNING cannot recreate a session deleted by logout during lease renewal.
  return db.prepare(
    "UPDATE mikaki_session SET lease_until=MIN(MAX(lease_until,?),?),parent_expires_at=MIN(parent_expires_at,?),idle_timeout=?,idle_expires_at=MIN(?,parent_expires_at,?) WHERE token_hash=? AND idle_expires_at>? AND parent_expires_at>? AND (lease_until>? OR ?=1) RETURNING *",
  ).bind(valid?.lease ?? session.lease_until, parent, parent, valid?.idle ?? session.idle_timeout,
    touch ? timestamp + (valid?.idle ?? session.idle_timeout) : session.idle_expires_at,
    parent, session.token_hash, timestamp, timestamp, timestamp, valid ? 1 : 0).first<MikakiSession>();
}

async function begin(request: Request, cfg: Config): Promise<Response> {
  const values = await protectedForm(request, cfg);
  const prompt = values.get("prompt");
  if (prompt !== null && prompt !== "select_account") fail(400, "Invalid sign-in prompt.");
  const returnTo = values.get("return_to") ?? "/";
  // Only app paths survive the trip; reject network-path references and auth-loop destinations.
  if (!returnTo.startsWith("/") || returnTo.startsWith("//") || returnTo.includes("\\") ||
      returnTo.startsWith("/api/") || returnTo.length > 2048 || [...returnTo].some(character => character.charCodeAt(0) < 32)) {
    fail(400, "Invalid return destination.");
  }
  const state = random(), nonce = random(), verifier = random();
  await cfg.db.batch([
    cfg.db.prepare("DELETE FROM mikaki_login WHERE expires_at<=?").bind(now()),
    cfg.db.prepare("DELETE FROM mikaki_session WHERE idle_expires_at<=? OR parent_expires_at<=?").bind(now(), now()),
    cfg.db.prepare("DELETE FROM mikaki_logout WHERE expires_at<=?").bind(now()),
  ]);
  await cfg.db.prepare(
    "INSERT INTO mikaki_login(state_hash,browser_hash,issuer,client_id,nonce,verifier,return_to,expires_at) VALUES(?,?,?,?,?,?,?,?)",
  ).bind(await hash(state), await hash(cookie(request, BROWSER)), cfg.issuer, cfg.clientId,
    nonce, verifier, returnTo, now() + 300).run();
  const target = new URL(cfg.issuer + "/authorize");
  target.search = new URLSearchParams({ client_id: cfg.clientId,
    redirect_uri: cfg.origin + PREFIX + "/callback", response_type: "code", scope: "openid",
    state, nonce, code_challenge: await hash(verifier), code_challenge_method: "S256",
    ui_locales: "ja", ...(prompt ? { prompt } : {}) }).toString();
  return redirect(target.href);
}

async function verifiedToken(cfg: Config, token: string, typ: "JWT" | "logout+jwt") {
  if (token.length > 16384) fail(400, "Invalid sign-in token.");
  const header = decodeProtectedHeader(token);
  if (header.alg !== "ES256" || header.typ !== typ || !header.kid || header.jku || header.jwk || header.x5u) {
    fail(400, "Invalid sign-in token.");
  }
  // Never follow token-supplied key URLs. A fresh resolver also handles signing-key rotation.
  const { payload } = await jwtVerify(token,
    createRemoteJWKSet(new URL(cfg.issuer + "/jwks"), { timeoutDuration: 5000 }), {
      issuer: cfg.issuer, audience: cfg.clientId, algorithms: ["ES256"], typ,
      clockTolerance: 30, requiredClaims: ["iss", "aud", "iat", "exp"],
    });
  if (payload.aud !== cfg.clientId || typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" || !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) || payload.iat > now() + 30 || payload.exp <= payload.iat ||
      payload.exp - payload.iat > (typ === "JWT" ? 600 : 300)) fail(400, "Invalid sign-in token.");
  return payload;
}

async function callback(request: Request, cfg: Config): Promise<Response> {
  const values = new URL(request.url).searchParams;
  if ([...values].length !== new Set(values.keys()).size || !values.get("state") ||
      values.get("iss") !== cfg.issuer) fail(400, "Invalid sign-in callback.");
  const browser = cookie(request, BROWSER);
  if (!browser) fail(400, "Sign-in browser cookie is missing. Please try again.");
  const tx = await cfg.db.prepare(
    "DELETE FROM mikaki_login WHERE state_hash=? AND browser_hash=? AND issuer=? AND client_id=? AND expires_at>? RETURNING nonce,verifier,return_to",
  ).bind(await hash(values.get("state")!), await hash(browser), cfg.issuer, cfg.clientId, now())
    .first<{ nonce: string; verifier: string; return_to: string }>();
  if (!tx) fail(400, "This sign-in attempt has expired or already completed.");
  if (values.has("error") || !values.get("code")) fail(400, "Sign-in was cancelled. Please try again.");
  const token = await issuerPost(cfg, "/token", { grant_type: "authorization_code",
    code: values.get("code")!, redirect_uri: cfg.origin + PREFIX + "/callback", code_verifier: tx.verifier });
  if (typeof token.id_token !== "string") fail(401, "Missing sign-in token.");
  const payload = await verifiedToken(cfg, token.id_token, "JWT");
  if (payload.nonce !== tx.nonce || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255 ||
      typeof payload.sid !== "string" || !payload.sid || payload.sid.length > 128 ||
      typeof payload.auth_time !== "number" || !Number.isSafeInteger(payload.auth_time) ||
      payload.auth_time > payload.iat! || (payload.azp !== undefined && payload.azp !== cfg.clientId)) {
    fail(401, "Invalid sign-in identity.");
  }
  if (!cfg.subjects.includes(payload.sub)) fail(403, "This Mikaki account is not a member of this installation.");
  const valid = await checkLease(cfg, { sid: payload.sid, sub: payload.sub, auth_time: payload.auth_time });
  const secret = random();
  const result = await cfg.db.prepare(
    "INSERT INTO mikaki_session(token_hash,issuer,client_id,sid,sub,auth_time,lease_until,parent_expires_at,idle_expires_at,idle_timeout) SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM mikaki_logout WHERE issuer=? AND client_id=? AND sid=? AND expires_at>?)",
  ).bind(await hash(secret), cfg.issuer, cfg.clientId, payload.sid, payload.sub, payload.auth_time,
    valid.lease, valid.parent, Math.min(now() + valid.idle, valid.parent), valid.idle,
    cfg.issuer, cfg.clientId, payload.sid, now()).run();
  if (result.meta.changes !== 1) fail(401, "This sign-in session has already ended.");
  // Account switching removes the previous app session; it never links the two users.
  const previous = cookie(request, SESSION);
  if (previous) await cfg.db.prepare("DELETE FROM mikaki_session WHERE token_hash=?").bind(await hash(previous)).run();
  return redirect(tx.return_to, [setCookie(SESSION, secret, valid.parent - now())]);
}

async function backchannel(request: Request, cfg: Config): Promise<Response> {
  const values = await form(request);
  const token = values.get("logout_token");
  if (!token) fail(400, "Missing logout token.");
  const payload = await verifiedToken(cfg, token, "logout+jwt");
  const events = payload.events;
  const marker = events && typeof events === "object" && !Array.isArray(events)
    && "http://schemas.openid.net/event/backchannel-logout" in events
    ? events["http://schemas.openid.net/event/backchannel-logout"] : null;
  if (typeof payload.sid !== "string" || !payload.sid || payload.sid.length > 128 ||
      typeof payload.jti !== "string" || !payload.jti || Object.hasOwn(payload, "nonce") ||
      (payload.sub !== undefined && (typeof payload.sub !== "string" || !payload.sub)) ||
      !marker || typeof marker !== "object" || Array.isArray(marker) || Object.keys(marker).length !== 0) {
    fail(400, "Invalid logout token.");
  }
  const existing = await cfg.db.withSession("first-primary").prepare(
    "SELECT sub FROM mikaki_session WHERE issuer=? AND client_id=? AND sid=? LIMIT 1",
  ).bind(cfg.issuer, cfg.clientId, payload.sid).first<{ sub: string }>();
  if (existing && payload.sub !== undefined && existing.sub !== payload.sub) fail(400, "Invalid logout identity.");
  await cfg.db.batch([
    cfg.db.prepare("INSERT INTO mikaki_logout(issuer,client_id,sid,expires_at) VALUES(?,?,?,?) ON CONFLICT(issuer,client_id,sid) DO UPDATE SET expires_at=MAX(expires_at,excluded.expires_at)")
      .bind(cfg.issuer, cfg.clientId, payload.sid, now() + 32 * 86400),
    cfg.db.prepare("DELETE FROM mikaki_session WHERE issuer=? AND client_id=? AND sid=?")
      .bind(cfg.issuer, cfg.clientId, payload.sid),
  ]);
  return new Response(null, { headers });
}

/** Handle the optional Mikaki RP's same-origin HTTP endpoints, leaving other deployments unchanged. */
export async function handleMikakiAuth(request: Request, env: Cloudflare.Env): Promise<Response> {
  try {
    const cfg = config(env);
    if (new URL(request.url).origin !== cfg.origin) fail(403, "Invalid installation origin.");
    const path = new URL(request.url).pathname.slice(PREFIX.length);
    if ((path === "/session" || path === "/csrf") && request.method === "GET") {
      const browser = cookie(request, BROWSER) || random();
      let session: MikakiSession | null = null;
      if (path === "/session") {
        try { session = await currentMikakiSession(request, env, false); }
        catch (error) { if (!(error instanceof AuthError && error.status === 401)) throw error; }
      }
      return Response.json({ signedIn: session !== null, csrf: await hash(browser) }, {
        headers: { ...headers, "Set-Cookie": setCookie(BROWSER, browser, 32 * 86400) },
      });
    }
    if (path === "/login" && request.method === "POST") return await begin(request, cfg);
    if (path === "/callback" && request.method === "GET") return await callback(request, cfg);
    if (path === "/backchannel-logout" && request.method === "POST") return await backchannel(request, cfg);
    if (path === "/logout" && request.method === "POST") {
      await protectedForm(request, cfg);
      const secret = cookie(request, SESSION);
      if (secret) await cfg.db.prepare("DELETE FROM mikaki_session WHERE token_hash=?").bind(await hash(secret)).run();
      return new Response(null, { status: 204,
        headers: { ...headers, "Set-Cookie": setCookie(SESSION, "", 0) } });
    }
    return new Response("Not Found", { status: 404, headers });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    const message = error instanceof AuthError ? error.message : "Sign-in is temporarily unavailable. Please try again.";
    // No exception details: provider errors can contain tokens or callback parameters.
    if (new URL(request.url).pathname.endsWith("/session")) {
      return Response.json({ error: message }, { status, headers });
    }
    const escaped = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mikaki sign-in</title><main><h1>ログインを完了できませんでした</h1><p>${escaped}</p><a href="/">Cloudflare OSへ戻る</a></main></html>`, {
      status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
    });
  }
}
