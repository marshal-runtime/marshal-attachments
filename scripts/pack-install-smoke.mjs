import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  externalFirstPartyRequirements,
  loadAndValidateCandidateDirectory,
  readCandidateLock,
  stageArchiveRecords,
  validateFirstPartyClosure,
} from "./candidate-lock.mjs";
import { configuredPackageManager } from "./package-manager.mjs";
import {
  canonicalizePackedArchive,
  readTarEntries,
  validatePackedManifest,
} from "./packed-manifest.mjs";
import {
  archiveReferencePaths,
  consumerStageDirectory,
  consumerWorkspaceText,
  createFreshConsumerManifest,
  stageDirectoryPath,
} from "./validation-layout.mjs";
import {
  freshConsumerLockName,
  installFromCommittedValidationLock,
  readValidationLockMetadata,
  validateTargetPackRecords,
} from "./validation-lock.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.join(repositoryRoot, "packages");
const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const packageManager = configuredPackageManager(rootManifest);
const candidateDirectory = process.env.MARSHAL_CANDIDATE_DIR
  ? path.resolve(process.env.MARSHAL_CANDIDATE_DIR)
  : undefined;
if (!candidateDirectory) {
  throw new Error(
    "Packed install readiness requires MARSHAL_CANDIDATE_DIR; "
    + "registry publication is not yet available.",
  );
}

const candidateLock = await readCandidateLock(path.join(repositoryRoot, "candidate-lock.json"));
const rootRequirements = await externalFirstPartyRequirements(packagesRoot);
const candidateRecords = await loadAndValidateCandidateDirectory({
  candidateDirectory,
  lock: candidateLock,
  rootRequirements,
});
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "marshal-attachments-install-smoke-"));
const targetArchiveRoot = path.join(temporaryRoot, "target-archives");
const consumerRoot = path.join(temporaryRoot, "consumer");

try {
  await mkdir(targetArchiveRoot, { recursive: true });
  await mkdir(consumerRoot, { recursive: true });
  const packageSources = [];
  const workspaceVersions = new Map();
  for (const directory of (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const packageRoot = path.join(packagesRoot, directory.name);
    try {
      const sourceManifest = JSON.parse(
        await readFile(path.join(packageRoot, "package.json"), "utf8"),
      );
      packageSources.push({ packageRoot, sourceManifest });
      workspaceVersions.set(sourceManifest.name, sourceManifest.version);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const targetArchives = [];
  for (const packageSource of packageSources) {
    targetArchives.push(await packPackage(packageSource, targetArchiveRoot, workspaceVersions));
  }

  const targetRecords = [];
  for (const archivePath of targetArchives) targetRecords.push(await archiveRecord(archivePath));
  validateTargetPackRecords(
    await readValidationLockMetadata(repositoryRoot),
    targetRecords,
  );
  const archiveRecords = [...candidateRecords, ...targetRecords];
  validateFirstPartyClosure({
    records: archiveRecords,
    rootRequirements: new Map(
      targetRecords.map((record) => [record.manifest.name, record.manifest.version]),
    ),
    rejectExtras: true,
  });

  await stageArchiveRecords({
    records: archiveRecords,
    destinationDirectory: stageDirectoryPath(consumerRoot, consumerStageDirectory),
  });
  const consumerManifest = createFreshConsumerManifest({
    targetRecords,
    archiveRecords,
  });
  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify(consumerManifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(consumerRoot, "pnpm-workspace.yaml"),
    consumerWorkspaceText,
  );
  await writeFile(path.join(consumerRoot, "smoke.mjs"), [
    "import assert from 'node:assert/strict';",
    "import * as attachments from '@marshal/attachments';",
    "import * as canonicalProvider from '@marshal/attachments/provider';",
    "import * as canonicalContent from '@marshal/attachments/content-to-markdown';",
    "import * as legacyProvider from '@marshal/agent-runtime-provider-attachments';",
    "import * as legacyContent from '@marshal/content-to-markdown';",
    "",
    "assert.equal(attachments.ATTACHMENTS_PACKAGE_DECLARATION.packageId, '@marshal/attachments');",
    "assert.equal(attachments.ATTACHMENTS_PACKAGE_DECLARATION.packageVersion, '0.1.0');",
    "assert.deepEqual(Object.keys(canonicalProvider).sort(), ['createAttachmentProvider']);",
    "assert.deepEqual(Object.keys(legacyProvider).sort(), Object.keys(canonicalProvider).sort());",
    "assert.deepEqual(Object.keys(legacyContent).sort(), Object.keys(canonicalContent).sort());",
    "assert.equal(legacyProvider.createAttachmentProvider, canonicalProvider.createAttachmentProvider);",
    "assert.equal(attachments.createAttachmentProvider, canonicalProvider.createAttachmentProvider);",
    "for (const name of Object.keys(canonicalContent)) {",
    "  assert.equal(legacyContent[name], canonicalContent[name]);",
    "  assert.equal(attachments[name], canonicalContent[name]);",
    "}",
    "const converted = await legacyContent.convertContentToMarkdown(",
    "  'packed-smoke.txt',",
    "  Buffer.from('packed attachment smoke'),",
    "  { mimeType: 'text/plain' },",
    ");",
    "assert.equal(converted.kind, 'text');",
    "assert.match(converted.markdown, /packed attachment smoke/);",
    "const provider = legacyProvider.createAttachmentProvider();",
    "const [descriptor] = await provider.list({ principal: { id: 'packed-smoke', kind: 'agent' } });",
    "assert.equal(descriptor.name, 'attachments.convert');",
    "assert.deepEqual(descriptor.permissions, [",
    "  { permission: 'attachments.read', scope: 'runtime', risk: 'medium' },",
    "]);",
    "console.log('Packed attachment imports, conversion, descriptor, and permissions are valid.');",
    "",
  ].join("\n"));

  const lockSha256 = await installFromCommittedValidationLock({
    repositoryRoot,
    cwd: consumerRoot,
    lockName: freshConsumerLockName,
    expectedArchiveReferences: archiveReferencePaths(
      consumerStageDirectory,
      archiveRecords.map((record) => record.filename),
    ),
    runPnpm,
  });
  const smoke = spawnSync(process.execPath, ["smoke.mjs"], {
    cwd: consumerRoot,
    env: packageManager.env,
    stdio: "inherit",
  });
  if (smoke.error) throw smoke.error;
  if (smoke.status !== 0) throw new Error(`Packed smoke exited with status ${smoke.status}`);

  for (const record of archiveRecords.sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name))) {
    console.log(
      `${record.manifest.name}@${record.manifest.version}: `
      + `${record.filename} sha256=${record.sha256}`,
    );
  }
  console.log(`Fresh-consumer frozen lock sha256=${lockSha256}.`);
  console.log(`Packed install smoke passed with locked candidates from ${candidateDirectory}.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function packPackage({ packageRoot, sourceManifest }, outputDirectory, workspaceVersions) {
  const result = spawnSync(
    process.execPath,
    [packageManager.cli, "pack", "--json", "--pack-destination", outputDirectory],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: packageManager.env,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`Pack failed in ${packageRoot}: ${(result.stderr || result.stdout).trim()}`);
  }
  const parsed = JSON.parse(result.stdout);
  const pack = Array.isArray(parsed) ? parsed[0] : parsed;
  const direct = path.resolve(outputDirectory, path.basename(pack.filename));
  await access(direct);
  const archive = await readFile(direct);
  const canonicalArchive = canonicalizePackedArchive({
    compressedArchive: archive,
    sourceManifest,
  });
  if (!archive.equals(canonicalArchive)) await writeFile(direct, canonicalArchive);
  const packedManifestBytes = readTarEntries(canonicalArchive).get("package/package.json");
  if (!packedManifestBytes) throw new Error(`${direct} has no package/package.json`);
  const packedManifest = JSON.parse(packedManifestBytes.toString("utf8"));
  const manifestFailures = validatePackedManifest({
    sourceManifest,
    packedManifest,
    workspaceVersions,
  });
  if (manifestFailures.length > 0) {
    throw new Error(`${sourceManifest.name}: ${manifestFailures.join("\n")}`);
  }
  return direct;
}

async function archiveRecord(archivePath) {
  const archive = await readFile(archivePath);
  const manifestBytes = readTarEntries(archive).get("package/package.json");
  if (!manifestBytes) throw new Error(`${archivePath} has no package/package.json`);
  return {
    archivePath,
    filename: path.basename(archivePath),
    manifest: JSON.parse(manifestBytes.toString("utf8")),
    sha256: createHash("sha256").update(archive).digest("hex"),
  };
}

function runPnpm(arguments_, cwd) {
  const result = spawnSync(process.execPath, [packageManager.cli, ...arguments_], {
    cwd,
    env: packageManager.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${arguments_.join(" ")} exited with status ${result.status}`);
}
