// Opt-in interoperability test against a built Mikaki checkout; never uses a hosted account.
// MIKAKI_SOURCE=/path/to/mikaki pnpm exec node --test scripts/mikaki-oidc-journey.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("Cloudflare OS RP interoperates with real Mikaki login, leased revocation and signed Back-Channel Logout", {
  skip: !process.env.MIKAKI_SOURCE, timeout: 180_000,
}, async () => {
  const root = resolve(import.meta.dirname, "..");
  const source = resolve(process.env.MIKAKI_SOURCE);
  const requireMikaki = createRequire(resolve(source, "package.json"));
  const requireBackend = createRequire(resolve(root, "packages/workshop-backend/package.json"));
  const load = (path) => import(pathToFileURL(resolve(source, path)).href);
  const { createTestHarness } = await import(pathToFileURL(requireMikaki.resolve("wrangler")).href);
  const { Miniflare, Response: RuntimeResponse, convertV4MiniflareOptions } =
    await import(pathToFileURL(requireMikaki.resolve("miniflare")).href);
  const playwright = await import(pathToFileURL(requireMikaki.resolve("@playwright/test")).href);
  const { chromium, expect } = playwright.default ?? playwright;
  const { generateKeyPair, exportJWK } = await import(pathToFileURL(requireBackend.resolve("jose")).href);
  const { newWebSocketRpcSession } = await import(pathToFileURL(requireBackend.resolve("capnweb")).href);
  const { build } = await import(pathToFileURL(requireBackend.resolve("esbuild")).href);
  const { journeyServer } = await load("local/conformance/support/journey-server.ts");
  const { activateWorkerPolicy } = await load("scripts/worker-policy-store.ts");
  const { issueBootstrapInvite } = await load("scripts/enrollment-store.ts");
  let dispatch = async () => { throw new Error("Not ready"); };
  const server = await journeyServer((url, init) => dispatch(url, init));
  let harness, rp, browser, rpc, counter;
  const originalFetch = globalThis.fetch;
  try {
    const issuer = `https://mikaki.test:${server.port}`;
    const origin = `https://journey-rp.test:${server.port}`;
    const clientId = "cloudflare-os-journey";
    let deliveredRequest;
    const deliveryResponses = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url !== origin + "/api/auth/mikaki/backchannel-logout") return originalFetch(input, init);
      assert.equal(request.method, "POST");
      assert.match(request.headers.get("Content-Type"), /^application\/x-www-form-urlencoded/i);
      deliveredRequest = request.clone();
      const response = await rp.dispatchFetch(request.url, {
        method: request.method, headers: Object.fromEntries(request.headers), body: await request.text(),
      });
      deliveryResponses.push(response.status);
      return new Response(await response.arrayBuffer(), { status: response.status,
        headers: Object.fromEntries(response.headers) });
    };
    const opKeys = await generateKeyPair("ES256", { extractable: true });
    const rpKeys = await generateKeyPair("ES256", { extractable: true });
    const opPublic = { ...await exportJWK(opKeys.publicKey), kid: "op", alg: "ES256", use: "sig" };
    const opPrivate = { ...await exportJWK(opKeys.privateKey), kid: "op", alg: "ES256", use: "sig" };
    const rpPublic = await exportJWK(rpKeys.publicKey);
    const rpPrivate = { ...await exportJWK(rpKeys.privateKey), kid: "rp" };
    harness = createTestHarness({ root: source, workers: [{
      configPath: resolve(source, "crates/worker/wrangler.jsonc"), vars: { MIKAKI_ISSUER: issuer },
      secrets: { OP_PRIVATE_JWK: JSON.stringify(opPrivate) },
    }] });
    await harness.listen();
    const op = harness.getWorker("mikaki-op-worker");
    await op.applyD1Migrations("DB");
    const { DB } = await op.getEnv();
    const policy = JSON.parse(await readFile(resolve(source, "local/generated/worker-policy.json"), "utf8"));
    await activateWorkerPolicy(DB, policy, { actor: "test", reason: "Cloudflare OS interoperability" });
    await DB.batch([
      DB.prepare("INSERT INTO client(client_id,revision,active,sector_identifier) VALUES(?,1,1,'journey-rp.test')").bind(clientId),
      DB.prepare("INSERT INTO client_redirect_uri(client_id,redirect_uri) VALUES(?,?)")
        .bind(clientId, origin + "/api/auth/mikaki/callback"),
      DB.prepare("INSERT INTO client_backchannel_logout_uri(client_id,logout_uri,active) VALUES(?,?,1)")
        .bind(clientId, origin + "/api/auth/mikaki/backchannel-logout"),
      DB.prepare("INSERT INTO client_key VALUES(?,'rp',1,1,'ES256',?)").bind(clientId,
        Buffer.concat([Buffer.from([4]), Buffer.from(rpPublic.x, "base64url"), Buffer.from(rpPublic.y, "base64url")])),
      DB.prepare("INSERT INTO signing_key VALUES('op',1,1,'ES256',?)").bind(JSON.stringify(opPublic)),
    ]);
    const { invitation } = await issueBootstrapInvite(DB, "test", "Cloudflare OS fixture owner");
    const result = await build({
      stdin: { contents: `
        import {handleMikakiAuth,currentMikakiSession} from ${JSON.stringify(resolve(root, "packages/workshop-backend/src/auth/mikaki.ts"))};
        import {newMikakiRpcSession} from ${JSON.stringify(resolve(root, "packages/workshop-backend/src/auth/mikaki-rpc.ts"))};
        import {RpcTarget} from 'capnweb';
        class Counter extends RpcTarget {
          constructor(db) { super(); this.db=db; }
          async increment() { return this.db.prepare('UPDATE fixture_counter SET value=value+1 RETURNING value').first('value'); }
        }
        class Main extends RpcTarget {
          constructor(db) { super(); this.db=db; }
          counter() { return new Counter(this.db); }
        }
        export default {async fetch(request,env) {
          const path=new URL(request.url).pathname;
          if(path.startsWith('/api/auth/')) return handleMikakiAuth(request,env);
          const session=await currentMikakiSession(request,env,false);
          if(path==='/rpc') {
            if(!session) return new Response(null,{status:401});
            const pair=new WebSocketPair(); pair[1].accept();
            newMikakiRpcSession(pair[1],new Main(env.MIKAKI_AUTH_DB),async touch=>{
              const current=await currentMikakiSession(request,env,touch);
              if(!current) throw new Error('Mikaki session ended');
              return Math.min(current.lease_until,current.idle_expires_at,current.parent_expires_at)*1000;
            });
            return new Response(null,{status:101,webSocket:pair[0]});
          }
          return new Response(session?'<h1>Signed in to Cloudflare OS</h1>':'<h1>Cloudflare OS</h1><form action="/api/auth/mikaki/login" method="post"><input name="csrf"><button>Mikakiでログイン</button></form><script>fetch("/api/auth/mikaki/csrf").then(r=>r.json()).then(v=>document.querySelector("input").value=v.csrf)</script>',{headers:{'Content-Type':'text/html; charset=utf-8','Referrer-Policy':'strict-origin'}});
        }};
      `, resolveDir: resolve(root, "packages/workshop-backend") }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    });
    const options = () => convertV4MiniflareOptions({ name: "cfos-rp", modules: true,
      script: result.outputFiles[0].text, compatibilityDate: "2026-09-04",
      bindings: { PUBLIC_BASE_URL: origin, MIKAKI_ISSUER: issuer, MIKAKI_CLIENT_ID: clientId,
        MIKAKI_PRIVATE_JWK: JSON.stringify(rpPrivate), MIKAKI_ALLOWED_SUBJECTS: JSON.stringify([subject]) },
      d1Databases: { MIKAKI_AUTH_DB: "cfos-rp-auth" },
      outboundService: async request => {
        assert.equal(new URL(request.url).origin, issuer);
        const response = await op.fetch(request.url, { method: request.method,
          headers: Object.fromEntries(request.headers),
          ...(request.method === "POST" ? { body: await request.text() } : {}), redirect: "manual" });
        return new RuntimeResponse(await response.arrayBuffer(), { status: response.status,
          headers: Object.fromEntries(response.headers) });
      },
    });
    let subject = "not-yet-enrolled";
    rp = new Miniflare(options());
    const rpDb = await rp.getD1Database("MIKAKI_AUTH_DB");
    const schema = await readFile(resolve(root, "packages/workshop-backend/migrations/0001_mikaki_auth.sql"), "utf8");
    await rpDb.batch(schema.split(";").map(s => s.trim()).filter(Boolean).map(s => rpDb.prepare(s)));
    await rpDb.exec("CREATE TABLE fixture_counter(value INTEGER NOT NULL); INSERT INTO fixture_counter VALUES(0);");
    let callback = "";
    dispatch = async (url, init) => {
      if (new URL(url).origin === issuer) return op.fetch(url, { ...init, redirect: "manual" });
      if (new URL(url).pathname === "/api/auth/mikaki/callback") callback = url;
      return rp.dispatchFetch(url, { ...init, redirect: "manual" });
    };
    browser = await chromium.launch({ headless: true,
      args: ["--host-resolver-rules=MAP mikaki.test 127.0.0.1, MAP journey-rp.test 127.0.0.1", "--no-proxy-server"] });
    const context = await browser.newContext({ locale: "en-US", ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, automaticPresenceSimulation: true, isUserVerified: true,
    } });
    await page.goto(issuer + "/?lang=en");
    await page.getByRole("link", { name: "Register with an invitation", exact: true }).click();
    await page.getByLabel("Invitation code", { exact: true }).fill(invitation);
    await page.getByRole("button", { name: "Register with invitation", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Registration complete", exact: true })).toBeVisible();
    const account = await DB.prepare("SELECT account_id FROM account_security WHERE active=1").first();
    subject = crypto.randomUUID();
    await DB.prepare("INSERT INTO pairwise_subject VALUES(?,'journey-rp.test',?)").bind(account.account_id, subject).run();
    await rp.setOptions(options());
    await page.goto(origin);
    await expect(page.locator("input[name=csrf]")).not.toHaveValue("");
    await page.getByRole("button", { name: "Mikakiでログイン" }).click();
    await expect(page.getByRole("heading", { name: "接続先を確認してください", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "この接続を続ける", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Signed in to Cloudflare OS", exact: true })).toBeVisible();
    assert.ok(callback);
    const cookies = await context.cookies(origin);
    const appCookie = cookies.find(c => c.name === "__Host-cfos-mikaki-session");
    assert.ok(appCookie?.httpOnly && appCookie.secure);
    assert.equal((await page.goto(callback)).status(), 400);
    await page.goto(origin);
    await expect(page.getByRole("heading", { name: "Signed in to Cloudflare OS", exact: true })).toBeVisible();
    await mkdir(resolve(root, "artifacts/mikaki-oidc"), { recursive: true });
    await page.screenshot({ path: resolve(root, "artifacts/mikaki-oidc/local-real-op.png"), fullPage: true });
    // A real OP SID check sees revocation, rather than a mocked active=false response.
    await DB.prepare("UPDATE client_session SET revoked=1 WHERE client_id=?").bind(clientId).run();
    const currentRpDb = await rp.getD1Database("MIKAKI_AUTH_DB");
    await currentRpDb.prepare("UPDATE mikaki_session SET lease_until=0").run();
    const checked = await rp.dispatchFetch(origin + "/api/auth/mikaki/session", {
      headers: { Cookie: `${appCookie.name}=${appCookie.value}` },
    });
    assert.equal((await checked.json()).signedIn, false);

    // A new app SID uses the still-active SSO. Leave its lease valid so only the real signed
    // notification, not a forced lease check, can invalidate this session before the deadline.
    await page.goto(origin);
    await expect(page.locator("input[name=csrf]")).not.toHaveValue("");
    await page.getByRole("button", { name: "Mikakiでログイン" }).click();
    await expect(page.getByRole("heading", { name: "Signed in to Cloudflare OS", exact: true })).toBeVisible();
    const nextCookie = (await context.cookies(origin)).find(c => c.name === appCookie.name);
    assert.ok(nextCookie && nextCookie.value !== appCookie.value);
    const cookieHeader = `${nextCookie.name}=${nextCookie.value}`;
    const session = await currentRpDb.prepare("SELECT sid,lease_until FROM mikaki_session").first();
    assert.ok(session.lease_until > Date.now() / 1000 + 60);
    const socket = (await rp.dispatchFetch(origin + "/rpc", {
      headers: { Cookie: cookieHeader, Upgrade: "websocket" },
    })).webSocket;
    assert.ok(socket);
    socket.accept();
    rpc = newWebSocketRpcSession(socket);
    counter = await rpc.counter();
    assert.equal(await counter.increment(), 1);

    const logoutPage = await context.newPage();
    await logoutPage.goto(issuer + "/logout?lang=en");
    await logoutPage.getByRole("button", { name: "Log out", exact: true }).click();
    await expect(logoutPage.getByRole("heading", { name: "You have logged out", exact: true })).toBeVisible();
    await expect.poll(async () => DB.prepare(
      "SELECT state,last_status,attempts FROM logout_delivery WHERE client_id=? AND sid=?",
    ).bind(clientId, session.sid).first(), { timeout: 15_000 }).toMatchObject({ state: "delivered", last_status: 200 })
      .catch(error => { throw new Error(`Receiver responses: ${JSON.stringify(deliveryResponses)}`, { cause: error }); });
    assert.equal((await DB.prepare("SELECT last_status FROM logout_delivery WHERE client_id=? AND sid=?")
      .bind(clientId, session.sid).first()).last_status, 200);
    assert.ok(deliveredRequest, "the real Rust sender must deliver the signed notification");
    assert.ok(session.lease_until > Date.now() / 1000 + 30, "the original lease must not have expired");
    assert.equal(await currentRpDb.prepare("SELECT COUNT(*) FROM mikaki_session").first("COUNT(*)"), 0);
    assert.equal(await currentRpDb.prepare("SELECT COUNT(*) FROM mikaki_logout WHERE sid=?")
      .bind(session.sid).first("COUNT(*)"), 1);
    await assert.rejects(async () => counter.increment());
    assert.equal(await currentRpDb.prepare("SELECT value FROM fixture_counter").first("value"), 1);
    assert.equal((await rp.dispatchFetch(deliveredRequest.url, {
      method: deliveredRequest.method,
      headers: Object.fromEntries(deliveredRequest.headers),
      body: await deliveredRequest.text(),
    })).status, 200);
    const ended = await rp.dispatchFetch(origin + "/api/auth/mikaki/session", {
      headers: { Cookie: cookieHeader },
    });
    assert.equal((await ended.json()).signedIn, false);
    await page.goto(origin);
    await expect(page.getByRole("heading", { name: "Cloudflare OS", exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(root, "artifacts/mikaki-oidc/local-real-op-backchannel.png"), fullPage: true });
  } finally {
    try {
      counter?.[Symbol.dispose](); rpc?.[Symbol.dispose]();
      await browser?.close(); await rp?.dispose(); await harness?.close(); await server.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});
