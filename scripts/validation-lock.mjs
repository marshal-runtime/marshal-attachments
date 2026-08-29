import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  archiveReferencePaths,
  consumerStageDirectory,
  workspaceStageDirectory,
} from "./validation-layout.mjs";

export const validationLockMetadataPath = "validation/locks.json";
export const workspaceLockName = "workspace";
export const freshConsumerLockName = "freshConsumer";

export async function readValidationLockMetadata(repositoryRoot) {
  const metadataPath = path.join(
    repositoryRoot,
    ...validationLockMetadataPath.split("/"),
  );
  return JSON.parse(await readFile(metadataPath, "utf8"));
}

export async function readCommittedValidationLock({
  repositoryRoot,
  lockName,
  expectedArchiveReferences,
  metadata,
}) {
  const resolvedMetadata = metadata ?? await readValidationLockMetadata(repositoryRoot);
  const definition = validationLockDefinition(resolvedMetadata, lockName);
  const lockPath = resolveRepositoryPath(repositoryRoot, definition.path);
  let lockBytes;
  try {
    lockBytes = await readFile(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Committed validation lock is missing: ${definition.path}`);
    }
    throw error;
  }

  const actualSha256 = sha256(lockBytes);
  if (actualSha256 !== definition.sha256) {
    throw new Error(
      `${definition.path} sha256 is ${actualSha256}; expected ${definition.sha256}`,
    );
  }
  const failures = validatePortableLockText(lockBytes.toString("utf8"), {
    expectedArchiveReferences,
    graphPins: definition.graphPins ?? {},
  });
  if (failures.length > 0) {
    throw new Error(`${definition.path} is not portable:\n${failures.join("\n")}`);
  }
  return {
    bytes: lockBytes,
    definition,
    path: lockPath,
    sha256: actualSha256,
  };
}

export async function installFromCommittedValidationLock({
  repositoryRoot,
  cwd,
  lockName,
  expectedArchiveReferences,
  runPnpm,
  metadata,
}) {
  const committedLock = await readCommittedValidationLock({
    repositoryRoot,
    lockName,
    expectedArchiveReferences,
    metadata,
  });
  const installedLockPath = path.join(cwd, "pnpm-lock.yaml");
  await mkdir(cwd, { recursive: true });
  await writeFile(installedLockPath, committedLock.bytes);
  runPnpm(["install", "--frozen-lockfile", "--strict-peer-dependencies"], cwd);
  const installedLock = await readFile(installedLockPath);
  if (!committedLock.bytes.equals(installedLock)) {
    throw new Error(`${lockName} generated lock byte drift during frozen install`);
  }
  return committedLock.sha256;
}

export async function validateCommittedValidationLocks({
  repositoryRoot,
  candidateFilenames,
  targetFilenames,
}) {
  const metadata = await readValidationLockMetadata(repositoryRoot);
  validateValidationLockMetadata(metadata);
  await readCommittedValidationLock({
    repositoryRoot,
    lockName: workspaceLockName,
    expectedArchiveReferences: archiveReferencePaths(
      workspaceStageDirectory,
      candidateFilenames,
    ),
    metadata,
  });
  await readCommittedValidationLock({
    repositoryRoot,
    lockName: freshConsumerLockName,
    expectedArchiveReferences: archiveReferencePaths(
      consumerStageDirectory,
      [...candidateFilenames, ...targetFilenames],
    ),
    metadata,
  });
  return metadata;
}

export function validateValidationLockMetadata(metadata) {
  const failures = [];
  if (metadata?.formatVersion !== 1) failures.push("formatVersion must be 1");
  for (const lockName of [workspaceLockName, freshConsumerLockName]) {
    const definition = metadata?.[lockName];
    if (!definition || typeof definition !== "object") {
      failures.push(`${lockName} lock definition is missing`);
      continue;
    }
    if (
      typeof definition.path !== "string"
      || path.isAbsolute(definition.path)
      || definition.path.includes("\\")
      || definition.path.startsWith("../")
      || !definition.path.startsWith("validation/")
    ) {
      failures.push(`${lockName}.path must be a repo-relative validation/ path`);
    }
    if (
      typeof definition.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(definition.sha256)
    ) {
      failures.push(`${lockName}.sha256 must be 64 lowercase hex characters`);
    }
    for (const [packageName, version] of Object.entries(definition.graphPins ?? {})) {
      if (typeof packageName !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
        failures.push(`${lockName}.graphPins must contain exact package versions`);
      }
    }
  }
  if (!Array.isArray(metadata?.targetPacks) || metadata.targetPacks.length === 0) {
    failures.push("targetPacks must be a non-empty array");
  }
  const targetNames = new Set();
  const targetFilenames = new Set();
  for (const target of metadata?.targetPacks ?? []) {
    if (typeof target?.name !== "string" || typeof target?.version !== "string") {
      failures.push("every target pack must have a name and version");
    }
    if (typeof target?.filename !== "string" || !target.filename.endsWith(".tgz")) {
      failures.push(`${target?.name ?? "<target>"}: filename must be a .tgz basename`);
    }
    if (typeof target?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(target.sha256)) {
      failures.push(`${target?.name ?? "<target>"}: sha256 must be 64 lowercase hex characters`);
    }
    if (targetNames.has(target?.name)) failures.push(`duplicate target pack ${target.name}`);
    if (targetFilenames.has(target?.filename)) {
      failures.push(`duplicate target pack filename ${target.filename}`);
    }
    targetNames.add(target?.name);
    targetFilenames.add(target?.filename);
  }
  if (failures.length > 0) {
    throw new Error(`Validation lock metadata is invalid:\n${failures.join("\n")}`);
  }
}

export function validateTargetPackRecords(metadata, records) {
  validateValidationLockMetadata(metadata);
  const expected = [...metadata.targetPacks]
    .sort((left, right) => left.name.localeCompare(right.name));
  const actual = records
    .map((record) => ({
      name: record.manifest.name,
      version: record.manifest.version,
      filename: record.filename,
      sha256: record.sha256,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Packed target identities differ from validation/locks.json:\n`
      + `actual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`,
    );
  }
}

export function validatePortableLockText(
  lockText,
  { expectedArchiveReferences, graphPins = {} },
) {
  const failures = [];
  if (/file:[A-Za-z]:[\\/]/.test(lockText) || /file:(?:\/|\\\\)/.test(lockText)) {
    failures.push("absolute file paths are forbidden");
  }

  const actualReferences = new Set(
    [...lockText.matchAll(/file:([^,\s"'{}[\]()]+?\.tgz)/g)]
      .map((match) => normalizeArchiveReference(match[1])),
  );
  const expectedReferences = new Set(expectedArchiveReferences);
  for (const reference of expectedReferences) {
    if (!actualReferences.has(reference)) {
      failures.push(`missing archive reference ${reference}`);
    }
  }
  for (const reference of actualReferences) {
    if (!expectedReferences.has(reference)) {
      failures.push(`unexpected archive reference ${reference}`);
    }
  }

  for (const [packageName, expectedVersion] of Object.entries(graphPins)) {
    const versions = lockPackageVersions(lockText, packageName);
    if (versions.length !== 1 || versions[0] !== expectedVersion) {
      failures.push(
        `${packageName} lock versions are ${versions.join(", ") || "<missing>"}; `
        + `expected only ${expectedVersion}`,
      );
    }
  }
  return failures;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validationLockDefinition(metadata, lockName) {
  validateValidationLockMetadata(metadata);
  const definition = metadata[lockName];
  if (!definition) throw new Error(`Unknown validation lock ${lockName}`);
  return definition;
}

function resolveRepositoryPath(repositoryRoot, relativePath) {
  const absolutePath = path.resolve(repositoryRoot, ...relativePath.split("/"));
  const relative = path.relative(repositoryRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Validation lock path escapes repository: ${relativePath}`);
  }
  return absolutePath;
}

function lockPackageVersions(lockText, packageName) {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^\\s{2}['"]?${escapedName}@([^:'"]+)['"]?:\\s*$`,
    "gm",
  );
  return [...new Set(
    [...lockText.matchAll(pattern)].map((match) => match[1].split("(")[0]),
  )].sort();
}

function normalizeArchiveReference(reference) {
  const normalized = reference.replaceAll("\\", "/");
  if (normalized.startsWith("../../.candidate-validation/")) {
    return normalized.slice("../../".length);
  }
  return normalized;
}
