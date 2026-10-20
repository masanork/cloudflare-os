// Build the cfos.mikaki.org installation with its committed public UI settings.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const settings = parseEnv(readFileSync(
  new URL("../deployments/mikaki-vault-preview/frontend.env", import.meta.url), "utf8",
));
execFileSync("pnpm", ["exec", "vp", "run", "-F", "@gadgets/workshop-frontend", "build"], {
  cwd: root,
  env: { ...process.env, ...settings },
  stdio: "inherit",
});
