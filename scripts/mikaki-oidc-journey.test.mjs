// Opt-in interoperability test against a built Mikaki checkout; never uses a hosted account.
// MIKAKI_SOURCE=/path/to/mikaki pnpm exec node --test scripts/mikaki-oidc-journey.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("Cloudflare OS RP interoperates with real Mikaki Passkey login, code exchange and session revocation", {
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
  const { build } = await import(pathToFileURL(requireBackend.resolve("esbuild")).href);
  const { journeyServer } = await load("local/conformance/support/journey-server.ts");
  const { activateWorkerPolicy } = await load("scripts/worker-policy-store.ts");
  const { issueBootstrapInvite } = await load("scripts/enrollment-store.ts");
  let dispatch = async () => { throw new Error("Not ready"); };
  const server = await journeyServer((url, init) => dispatch(url, init));
  let harness, rp, browser;
  try {
    const issuer = `https://mikaki.test:${server.port}`;
    const origin = `https://journey-rp.test:${server.port}`;
    const clientId = "cloudflare-os-journey";
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
      DB.prepare("INSERT INTO client_key VALUES(?,'rp',1,1,'ES256',?)").bind(clientId,
        Buffer.concat([Buffer.from([4]), Buffer.from(rpPublic.x, "base64url"), Buffer.from(rpPublic.y, "base64url")])),
      DB.prepare("INSERT INTO signing_key VALUES('op',1,1,'ES256',?)").bind(JSON.stringify(opPublic)),
    ]);
    const { invitation } = await issueBootstrapInvite(DB, "test", "Cloudflare OS fixture owner");
    const result = await build({
      stdin: { contents: `
        import {handleMikakiAuth,currentMikakiSession} from ${JSON.stringify(resolve(root, "packages/workshop-backend/src/auth/mikaki.ts"))};
        export default {async fetch(request,env) {
          const path=new URL(request.url).pathname;
          if(path.startsWith('/api/auth/')) return handleMikakiAuth(request,env);
          const session=await currentMikakiSession(request,env,false);
          return new Response(session?'<h1>Signed in to Cloudflare OS</h1>':'<h1>Cloudflare OS</h1><form action="/api/auth/mikaki/login" method="post"><input name="csrf"><button>Mikakiでログイン</button></form><script>fetch("/api/auth/mikaki/csrf").then(r=>r.json()).then(v=>document.querySelector("input").value=v.csrf)</script>',{headers:{'Content-Type':'text/html; charset=utf-8','Referrer-Policy':'strict-origin'}});
        }};
      `, resolveDir: root }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
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
  } finally {
    await browser?.close(); await rp?.dispose(); await harness?.close(); await server.close();
  }
});
