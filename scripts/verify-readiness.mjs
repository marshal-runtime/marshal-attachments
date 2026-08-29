import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { configuredPackageManager } from "./package-manager.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const packageManager = configuredPackageManager(rootManifest);

if (!process.env.MARSHAL_CANDIDATE_DIR) {
  console.error(
    "READINESS BLOCKED: immutable first-party prerequisites are not published or provisioned. "
    + "Provide MARSHAL_CANDIDATE_DIR and run the authoritative candidate closure.",
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [path.join(repositoryRoot, "scripts", "verify-with-candidates.mjs")],
  {
    cwd: repositoryRoot,
    env: packageManager.env,
    stdio: "inherit",
  },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
