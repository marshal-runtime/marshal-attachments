import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { configuredPackageManager } from "./package-manager.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceOnly = process.argv.includes("--source-only");
const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
try {
  configuredPackageManager(rootManifest);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (!sourceOnly && !process.env.MARSHAL_CANDIDATE_DIR) {
  console.error(
    "Authoritative verification requires MARSHAL_CANDIDATE_DIR. "
    + "Registry publication is not yet available, so readiness fails closed.",
  );
  process.exit(1);
}

const commands = [
  [path.join(repositoryRoot, "scripts", "check-repository.mjs")],
  [path.join(repositoryRoot, "scripts", "check-manifests.mjs")],
  [path.join(repositoryRoot, "scripts", "check-provenance.mjs")],
  [path.join(repositoryRoot, "scripts", "check-boundaries.mjs")],
  ["--test", path.join(repositoryRoot, "scripts", "__tests__", "verification.test.mjs")],
  ["--test", path.join(repositoryRoot, "scripts", "__tests__", "consolidation.test.mjs")],
];

if (!sourceOnly) {
  commands.push(
    [path.join(repositoryRoot, "scripts", "run-workspace-script.mjs"), "build"],
    [path.join(repositoryRoot, "scripts", "check-api-compatibility.mjs")],
    [path.join(repositoryRoot, "scripts", "run-workspace-script.mjs"), "typecheck"],
    [path.join(repositoryRoot, "scripts", "run-workspace-script.mjs"), "test"],
    [path.join(repositoryRoot, "scripts", "check-packs.mjs")],
    [path.join(repositoryRoot, "scripts", "pack-install-smoke.mjs")],
  );
}

for (const arguments_ of commands) {
  const result = spawnSync(
    process.execPath,
    arguments_,
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
