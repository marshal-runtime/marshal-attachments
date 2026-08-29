import { createHash } from "node:crypto";
import {
  copyFile as copyFileArchive,
  mkdir,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import {
  dependencyReferenceFailure,
  dependencySections,
  isExactVersion,
  productionDependencySections,
} from "./dependency-policy.mjs";
import { readTarEntries } from "./packed-manifest.mjs";

export async function readCandidateLock(lockPath) {
  return JSON.parse(await readFile(lockPath, "utf8"));
}

export function validateCandidateLock(lock) {
  const failures = [];
  if (lock?.formatVersion !== 1) failures.push("formatVersion must be 1");
  if (lock?.algorithm !== "sha256") failures.push("algorithm must be sha256");
  if (!Array.isArray(lock?.packages) || lock.packages.length === 0) {
    failures.push("packages must be a non-empty array");
  }

  const names = new Set();
  const filenames = new Set();
  for (const entry of lock?.packages ?? []) {
    if (typeof entry?.name !== "string" || !entry.name.startsWith("@marshal/")) {
      failures.push("every locked package must have an @marshal/ name");
    }
    if (!isExactVersion(entry?.version)) {
      failures.push(`${entry?.name ?? "<unknown>"}: version must be exact`);
    }
    if (typeof entry?.filename !== "string" || !entry.filename.endsWith(".tgz")) {
      failures.push(`${entry?.name ?? "<unknown>"}: filename must be an exact .tgz basename`);
    } else if (path.basename(entry.filename) !== entry.filename) {
      failures.push(`${entry.name}: filename must not contain a path`);
    }
    if (typeof entry?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      failures.push(`${entry?.name ?? "<unknown>"}: sha256 must be 64 lowercase hex characters`);
    }
    if (names.has(entry?.name)) failures.push(`duplicate locked package name ${entry.name}`);
    if (filenames.has(entry?.filename)) failures.push(`duplicate locked filename ${entry.filename}`);
    names.add(entry?.name);
    filenames.add(entry?.filename);
  }

  throwFailures("Candidate lock is invalid", failures);
  return lock.packages;
}

export async function loadAndValidateCandidateDirectory({
  candidateDirectory,
  lock,
  rootRequirements,
}) {
  const entries = await readdir(candidateDirectory, { withFileTypes: true });
  const archives = entries
    .filter((entry) => entry.name.endsWith(".tgz"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const records = [];

  for (const entry of archives) {
    if (!entry.isFile()) {
      throw new Error(`Candidate archive must be a regular file: ${entry.name}`);
    }
    const archivePath = path.join(candidateDirectory, entry.name);
    records.push(await readArchiveRecord(archivePath));
  }

  return validateCandidateRecords({ lock, records, rootRequirements });
}

export async function readArchiveRecord(archivePath) {
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

export async function stageArchiveRecords({
  records,
  destinationDirectory,
  copyArchive = copyFileArchive,
  readStagedRecord = readArchiveRecord,
}) {
  await mkdir(destinationDirectory, { recursive: true });
  const existingEntries = await readdir(destinationDirectory);
  if (existingEntries.length > 0) {
    throw new Error(`Archive staging directory is not empty: ${destinationDirectory}`);
  }

  const stagedRecords = [];
  for (const record of [...records].sort((left, right) =>
    left.filename.localeCompare(right.filename))) {
    const stagedPath = path.join(destinationDirectory, record.filename);
    await copyArchive(record.archivePath, stagedPath);
    const stagedRecord = await readStagedRecord(stagedPath);
    if (
      stagedRecord.filename !== record.filename
      || stagedRecord.manifest.name !== record.manifest.name
      || stagedRecord.manifest.version !== record.manifest.version
      || stagedRecord.sha256 !== record.sha256
    ) {
      throw new Error(`Archive staging mismatch for ${record.filename}`);
    }
    stagedRecords.push(stagedRecord);
  }

  const stagedFilenames = (await readdir(destinationDirectory)).sort();
  const expectedFilenames = stagedRecords.map((record) => record.filename).sort();
  if (JSON.stringify(stagedFilenames) !== JSON.stringify(expectedFilenames)) {
    throw new Error(
      `Archive staging set mismatch: ${stagedFilenames.join(", ")}; `
      + `expected ${expectedFilenames.join(", ")}`,
    );
  }
  return stagedRecords;
}

export function validateCandidateRecords({ lock, records, rootRequirements }) {
  const lockedPackages = validateCandidateLock(lock);
  const failures = [];
  const recordsByFilename = new Map();
  const recordsByName = new Map();

  for (const record of records) {
    if (recordsByFilename.has(record.filename)) {
      failures.push(`duplicate candidate filename ${record.filename}`);
    }
    recordsByFilename.set(record.filename, record);
    const name = record.manifest?.name;
    if (recordsByName.has(name)) failures.push(`duplicate candidate package ${name}`);
    recordsByName.set(name, record);
  }

  const lockedFilenames = new Set(lockedPackages.map((entry) => entry.filename));
  for (const locked of lockedPackages) {
    const record = recordsByFilename.get(locked.filename);
    if (!record) {
      failures.push(`missing candidate ${locked.filename}`);
      continue;
    }
    if (record.manifest?.name !== locked.name) {
      failures.push(`${locked.filename}: name is ${record.manifest?.name ?? "<missing>"}; expected ${locked.name}`);
    }
    if (record.manifest?.version !== locked.version) {
      failures.push(
        `${locked.filename}: version is ${record.manifest?.version ?? "<missing>"}; expected ${locked.version}`,
      );
    }
    if (record.sha256 !== locked.sha256) {
      failures.push(`${locked.filename}: sha256 is ${record.sha256}; expected ${locked.sha256}`);
    }
  }
  for (const record of records) {
    if (!lockedFilenames.has(record.filename)) failures.push(`extra candidate ${record.filename}`);
  }

  failures.push(...firstPartyClosureFailures({
    records,
    rootRequirements,
    rejectExtras: true,
  }));
  throwFailures("Candidate directory does not match the immutable lock", failures);
  return [...records].sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

export function validateFirstPartyClosure({ records, rootRequirements, rejectExtras = true }) {
  const failures = firstPartyClosureFailures({ records, rootRequirements, rejectExtras });
  throwFailures("First-party dependency closure is invalid", failures);
}

export function firstPartyClosureFailures({ records, rootRequirements, rejectExtras = true }) {
  const failures = [];
  const recordsByName = new Map();
  for (const record of records) {
    const name = record.manifest?.name;
    if (typeof name !== "string") {
      failures.push(`${record.filename ?? "<archive>"}: package name is missing`);
      continue;
    }
    if (recordsByName.has(name)) failures.push(`duplicate first-party archive ${name}`);
    recordsByName.set(name, record);

    for (const section of dependencySections) {
      for (const [dependency, range] of Object.entries(record.manifest?.[section] ?? {})) {
        const referenceFailure = dependencyReferenceFailure(range);
        if (referenceFailure) {
          failures.push(`${name}: ${section}.${dependency} ${referenceFailure}: ${range}`);
        }
      }
    }
  }

  const pending = [...requirementEntries(rootRequirements)]
    .map(([name, version]) => ({ name, version, requiredBy: "root" }));
  const requiredVersions = new Map();
  const visited = new Set();

  while (pending.length > 0) {
    const requirement = pending.pop();
    const previousVersion = requiredVersions.get(requirement.name);
    if (previousVersion && previousVersion !== requirement.version) {
      failures.push(
        `${requirement.name} is required as both ${previousVersion} and ${requirement.version}`,
      );
      continue;
    }
    requiredVersions.set(requirement.name, requirement.version);
    if (visited.has(requirement.name)) continue;
    visited.add(requirement.name);

    if (!isExactVersion(requirement.version)) {
      failures.push(
        `${requirement.requiredBy} has non-exact first-party dependency `
        + `${requirement.name}@${requirement.version}`,
      );
      continue;
    }

    const record = recordsByName.get(requirement.name);
    if (!record) {
      failures.push(`missing first-party archive ${requirement.name}@${requirement.version}`);
      continue;
    }
    if (record.manifest.version !== requirement.version) {
      failures.push(
        `${requirement.name} archive version is ${record.manifest.version}; `
        + `${requirement.requiredBy} requires ${requirement.version}`,
      );
    }

    for (const section of productionDependencySections) {
      for (const [dependency, range] of Object.entries(record.manifest?.[section] ?? {})) {
        if (!dependency.startsWith("@marshal/")) continue;
        if (!isExactVersion(range)) {
          failures.push(`${requirement.name} has non-exact first-party edge ${dependency}@${range}`);
          continue;
        }
        pending.push({
          name: dependency,
          version: range,
          requiredBy: requirement.name,
        });
      }
    }
  }

  if (rejectExtras) {
    for (const name of recordsByName.keys()) {
      if (!visited.has(name)) failures.push(`extra first-party archive outside the closure: ${name}`);
    }
  }

  return [...new Set(failures)];
}

export async function externalFirstPartyRequirements(packagesRoot) {
  const manifests = [];
  for (const entry of (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const manifestPath = path.join(packagesRoot, entry.name, "package.json");
    try {
      manifests.push(JSON.parse(await readFile(manifestPath, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const localNames = new Set(manifests.map((manifest) => manifest.name));
  const requirements = new Map();
  for (const manifest of manifests) {
    for (const section of productionDependencySections) {
      for (const [dependency, range] of Object.entries(manifest[section] ?? {})) {
        if (!dependency.startsWith("@marshal/") || localNames.has(dependency)) continue;
        if (!isExactVersion(range)) {
          throw new Error(`${manifest.name}: ${dependency} must use an exact version, not ${range}`);
        }
        const previous = requirements.get(dependency);
        if (previous && previous !== range) {
          throw new Error(`${dependency} is required as both ${previous} and ${range}`);
        }
        requirements.set(dependency, range);
      }
    }
  }
  return requirements;
}

function requirementEntries(requirements) {
  return requirements instanceof Map
    ? requirements.entries()
    : Object.entries(requirements ?? {});
}

function throwFailures(prefix, failures) {
  const uniqueFailures = [...new Set(failures)];
  if (uniqueFailures.length > 0) {
    throw new Error(`${prefix}:\n${uniqueFailures.join("\n")}`);
  }
}
