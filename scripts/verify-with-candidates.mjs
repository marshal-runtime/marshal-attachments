import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  externalFirstPartyRequirements,
  loadAndValidateCandidateDirectory,
  readCandidateLock,
  stageArchiveRecords,
} from "./candidate-lock.mjs";
import {
  configuredPackageManager,
  packageManagerEnvironment,
} from "./package-manager.mjs";
import {
  archiveReferencePaths,
  createWorkspaceValidationManifest,
  stageDirectoryPath,
  workspaceStageDirectory,
} from "./validation-layout.mjs";
import {
  installFromCommittedValidationLock,
  workspaceLockName,
} from "./validation-lock.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.join(repositoryRoot, "packages");
const candidateDirectory = process.env.MARSHAL_CANDIDATE_DIR
  ? path.resolve(process.env.MARSHAL_CANDIDATE_DIR)
  : undefined;
if (!candidateDirectory) {
  console.error("MARSHAL_CANDIDATE_DIR must point to immutable prerequisite tarballs.");
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

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "marshal-attachments-candidate-validation-"));
const validationRoot = path.join(temporaryRoot, "repository");
const keepValidation = process.env.MARSHAL_KEEP_VALIDATION_DIR === "1";

try {
  await cp(repositoryRoot, validationRoot, {
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

  const validationManifestPath = path.join(validationRoot, "package.json");
  await stageArchiveRecords({
    records: candidates,
    destinationDirectory: stageDirectoryPath(validationRoot, workspaceStageDirectory),
  });
  const validationManifest = createWorkspaceValidationManifest(
    JSON.parse(rootManifestText),
    candidates,
  );
  await writeFile(validationManifestPath, `${JSON.stringify(validationManifest, null, 2)}\n`);
  const lockSha256 = await installFromCommittedValidationLock({
    repositoryRoot: validationRoot,
    cwd: validationRoot,
    lockName: workspaceLockName,
    expectedArchiveReferences: archiveReferencePaths(
      workspaceStageDirectory,
      candidates.map((candidate) => candidate.filename),
    ),
    runPnpm,
  });
  await writeFile(validationManifestPath, rootManifestText);
  runPnpm(["verify"], validationRoot, {
    MARSHAL_CANDIDATE_DIR: candidateDirectory,
  });

  for (const candidate of candidates) {
    console.log(
      `${candidate.manifest.name}@${candidate.manifest.version}: `
      + `${candidate.filename} sha256=${candidate.sha256}`,
    );
  }
  console.log(`Reproducible frozen validation lock sha256=${lockSha256}.`);
  console.log(`Candidate validation passed in ${validationRoot}.`);
} finally {
  if (!keepValidation) await rm(temporaryRoot, { recursive: true, force: true });
  else console.log(`Preserved validation directory: ${validationRoot}`);
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
