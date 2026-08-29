import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { configuredPackageManager } from "./package-manager.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const workspaceScript = process.argv[2];

if (!new Set(["build", "typecheck", "test"]).has(workspaceScript)) {
  console.error("Expected one of: build, typecheck, test");
  process.exit(1);
}

let packageManager;
try {
  packageManager = configuredPackageManager(rootManifest);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    packageManager.cli,
    "--recursive",
    "--workspace-concurrency=1",
    "--filter",
    "./packages/**",
    workspaceScript,
  ],
  { cwd: repositoryRoot, env: packageManager.env, stdio: "inherit" },
);

if (result.error) {
  console.error(result.error.message);
}
if (result.status !== 0) process.exit(result.status ?? 1);

if (workspaceScript === "build") {
  const extensionBuild = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts", "build-extension.mjs")],
    { cwd: repositoryRoot, env: packageManager.env, stdio: "inherit" },
  );
  if (extensionBuild.error) console.error(extensionBuild.error.message);
  process.exit(extensionBuild.status ?? 1);
}

if (workspaceScript === "typecheck") {
  const extensionTypecheck = spawnSync(
    process.execPath,
    [
      packageManager.cli,
      "exec",
      "tsc",
      "-p",
      path.join(repositoryRoot, "tsconfig.extension.json"),
    ],
    { cwd: repositoryRoot, env: packageManager.env, stdio: "inherit" },
  );
  if (extensionTypecheck.error) console.error(extensionTypecheck.error.message);
  process.exit(extensionTypecheck.status ?? 1);
}
