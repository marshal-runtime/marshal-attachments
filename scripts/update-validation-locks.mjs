import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  externalFirstPartyRequirements,
  loadAndValidateCandidateDirectory,
  readArchiveRecord,
  readCandidateLock,
  stageArchiveRecords,
  validateFirstPartyClosure,
} from "./candidate-lock.mjs";
import {
  configuredPackageManager,
  packageManagerEnvironment,
} from "./package-manager.mjs";
import {
  archiveReferencePaths,
  consumerStageDirectory,
  consumerWorkspaceText,
  createFreshConsumerManifest,
  createWorkspaceValidationManifest,
  reviewedViteVersion,
  stageDirectoryPath,
  targetPackageNames,
  workspaceStageDirectory,
} from "./validation-layout.mjs";
import {
  sha256,
  validatePortableLockText,
} from "./validation-lock.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.join(repositoryRoot, "packages");
const candidateDirectory = process.env.MARSHAL_CANDIDATE_DIR
  ? path.resolve(process.env.MARSHAL_CANDIDATE_DIR)
  : undefined;
if (process.env.MARSHAL_ALLOW_LOCK_UPDATE !== "1") {
  console.error(
    "lock:update is maintainer-only. Set MARSHAL_ALLOW_LOCK_UPDATE=1 after reviewing "
    + "the exact candidate directory and registry inputs.",
  );
  process.exit(1);
}
if (!candidateDirectory) {
  console.error("MARSHAL_CANDIDATE_DIR must point to the exact immutable prerequisite tarballs.");
  process.exit(1);
}

const rootManifestText = await readFile(path.join(repositoryRoot, "package.json"), "utf8");
const rootManifest = JSON.parse(rootManifestText);
const packageManager = configuredPackageManager(rootManifest);
const candidateLock = await readCandidateLock(path.join(repositoryRoot, "candidate-lock.json"));
const rootRequirements = await externalFirstPartyRequirements(packagesRoot);
const candidates = await loadAndValidateCandidateDirectory({
  candidateDirectory,
  lock: candidateLock,
  rootRequirements,
});
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "marshal-attachments-lock-update-"));
const workspaceRoot = path.join(temporaryRoot, "workspace");
const targetArchiveRoot = path.join(temporaryRoot, "target-archives");
const consumerRoot = path.join(temporaryRoot, "consumer");

try {
  await cp(repositoryRoot, workspaceRoot, {
    recursive: true,
    filter(source) {
      if (source === repositoryRoot) return true;
      const relative = path.relative(repositoryRoot, source);
      const segments = relative.split(path.sep);
      if (
        segments.some((segment) =>
          [".candidate-validation", ".git", "node_modules", "dist", "coverage"].includes(segment))
      ) {
        return false;
      }
      return !source.endsWith(".tgz");
    },
  });

  await stageArchiveRecords({
    records: candidates,
    destinationDirectory: stageDirectoryPath(workspaceRoot, workspaceStageDirectory),
  });
  await writeFile(
    path.join(workspaceRoot, "package.json"),
    `${JSON.stringify(createWorkspaceValidationManifest(rootManifest, candidates), null, 2)}\n`,
  );
  const workspaceLock = await generateLiveLock(workspaceRoot);
  assertPortableLock(workspaceLock, {
    expectedArchiveReferences: archiveReferencePaths(
      workspaceStageDirectory,
      candidates.map((candidate) => candidate.filename),
    ),
    graphPins: { vite: reviewedViteVersion },
  });
  await assertFrozenInstall(workspaceRoot, workspaceLock);
  runPnpm(["build"], workspaceRoot);

  await mkdir(targetArchiveRoot, { recursive: true });
  runPnpm(["pack:check"], workspaceRoot, {
    MARSHAL_PACK_OUTPUT_DIR: targetArchiveRoot,
  });
  const targetRecords = [];
  for (const entry of (await readdir(targetArchiveRoot, { withFileTypes: true }))
    .filter((candidate) => candidate.isFile() && candidate.name.endsWith(".tgz"))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    targetRecords.push(await readArchiveRecord(path.join(targetArchiveRoot, entry.name)));
  }
  const targetNames = targetRecords.map((record) => record.manifest.name).sort();
  if (JSON.stringify(targetNames) !== JSON.stringify([...targetPackageNames].sort())) {
    throw new Error(`Packed targets differ: ${targetNames.join(", ")}`);
  }

  const archiveRecords = [...candidates, ...targetRecords];
  validateFirstPartyClosure({
    records: archiveRecords,
    rootRequirements: new Map(
      targetRecords.map((record) => [record.manifest.name, record.manifest.version]),
    ),
    rejectExtras: true,
  });
  await mkdir(consumerRoot, { recursive: true });
  await stageArchiveRecords({
    records: archiveRecords,
    destinationDirectory: stageDirectoryPath(consumerRoot, consumerStageDirectory),
  });
  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify(createFreshConsumerManifest({ targetRecords, archiveRecords }), null, 2)}\n`,
  );
  await writeFile(path.join(consumerRoot, "pnpm-workspace.yaml"), consumerWorkspaceText);
  const consumerLock = await generateLiveLock(consumerRoot);
  assertPortableLock(consumerLock, {
    expectedArchiveReferences: archiveReferencePaths(
      consumerStageDirectory,
      archiveRecords.map((record) => record.filename),
    ),
  });
  await assertFrozenInstall(consumerRoot, consumerLock);

  const validationRoot = path.join(repositoryRoot, "validation");
  const workspaceLockPath = path.join(validationRoot, "workspace-pnpm-lock.yaml");
  const consumerLockPath = path.join(validationRoot, "fresh-consumer-pnpm-lock.yaml");
  await mkdir(validationRoot, { recursive: true });
  await writeFile(workspaceLockPath, workspaceLock);
  await writeFile(consumerLockPath, consumerLock);
  const metadata = {
    formatVersion: 1,
    workspace: {
      path: "validation/workspace-pnpm-lock.yaml",
      sha256: sha256(workspaceLock),
      graphPins: {
        vite: reviewedViteVersion,
      },
    },
    freshConsumer: {
      path: "validation/fresh-consumer-pnpm-lock.yaml",
      sha256: sha256(consumerLock),
      graphPins: {},
    },
    targetPacks: targetRecords
      .map((record) => ({
        name: record.manifest.name,
        version: record.manifest.version,
        filename: record.filename,
        sha256: record.sha256,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  await writeFile(
    path.join(validationRoot, "locks.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );

  console.log(`Updated workspace validation lock sha256=${metadata.workspace.sha256}.`);
  console.log(`Updated fresh-consumer lock sha256=${metadata.freshConsumer.sha256}.`);
  for (const target of metadata.targetPacks) {
    console.log(`${target.name}@${target.version}: ${target.filename} sha256=${target.sha256}`);
  }
  console.log("Review and commit the validation/ lock diff separately from normal verification.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function generateLiveLock(cwd) {
  const lockPath = path.join(cwd, "pnpm-lock.yaml");
  await rm(lockPath, { force: true });
  runPnpm([
    "install",
    "--lockfile-only",
    "--no-frozen-lockfile",
    "--ignore-scripts",
    "--strict-peer-dependencies",
  ], cwd);
  return canonicalizeRegistryTransport(await readFile(lockPath));
}

async function assertFrozenInstall(cwd, lockBytes) {
  const lockPath = path.join(cwd, "pnpm-lock.yaml");
  await rm(path.join(cwd, "node_modules"), { recursive: true, force: true });
  await writeFile(lockPath, lockBytes);
  runPnpm(["install", "--frozen-lockfile", "--strict-peer-dependencies"], cwd);
  const installedLock = await readFile(lockPath);
  if (!lockBytes.equals(installedLock)) {
    throw new Error(`Generated lock changed during frozen install in ${cwd}`);
  }
}

function assertPortableLock(lockBytes, options) {
  const failures = validatePortableLockText(lockBytes.toString("utf8"), options);
  if (failures.length > 0) {
    throw new Error(`Generated validation lock is not portable:\n${failures.join("\n")}`);
  }
}

function canonicalizeRegistryTransport(lockBytes) {
  return Buffer.from(
    lockBytes.toString("utf8").replace(
      /https:\/\/ms-feed-\d+\.pkgs\.visualstudio\.com\/1es-public\/_packaging\/npm-public\/npm\/registry\//g,
      "https://packagefeedproxy.microsoft.io/npm/",
    ),
    "utf8",
  );
}

function runPnpm(arguments_, cwd, envOverrides = {}) {
  const result = spawnSync(process.execPath, [packageManager.cli, ...arguments_], {
    cwd,
    env: packageManagerEnvironment({
      ...packageManager.env,
      ...envOverrides,
    }),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${arguments_.join(" ")} exited with status ${result.status}`);
}
