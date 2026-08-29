import { gunzipSync, gzipSync } from "node:zlib";
import {
  dependencyReferenceFailure,
  dependencySections,
} from "./dependency-policy.mjs";

export function readTarEntries(compressedArchive) {
  const { entries } = parseTarArchive(compressedArchive);
  return new Map(
    [...entries].map(([entryPath, entry]) => [entryPath, entry.content]),
  );
}

export function canonicalizePackedArchive({
  compressedArchive,
  sourceManifest,
}) {
  const { archive, entries } = parseTarArchive(compressedArchive);
  const manifestEntry = entries.get("package/package.json");
  if (!manifestEntry) throw new Error("Packed archive has no package/package.json");
  const packedManifest = JSON.parse(manifestEntry.content.toString("utf8"));
  const canonicalManifest = {};
  for (const [key, value] of Object.entries(packedManifest)) {
    if (!dependencySections.includes(key) || !value || typeof value !== "object") {
      canonicalManifest[key] = value;
      continue;
    }
    const sourceNames = Object.keys(sourceManifest[key] ?? {});
    const orderedDependencies = {};
    for (const name of sourceNames) {
      if (Object.hasOwn(value, name)) orderedDependencies[name] = value[name];
    }
    for (const name of Object.keys(value).sort()) {
      if (!Object.hasOwn(orderedDependencies, name)) orderedDependencies[name] = value[name];
    }
    canonicalManifest[key] = orderedDependencies;
  }

  const canonicalBytes = Buffer.from(JSON.stringify(canonicalManifest, null, 2), "utf8");
  if (canonicalBytes.length !== manifestEntry.content.length) {
    throw new Error(
      `Canonical packed manifest changed size from ${manifestEntry.content.length} `
      + `to ${canonicalBytes.length}`,
    );
  }
  canonicalBytes.copy(archive, manifestEntry.contentStart);
  return gzipSync(archive);
}

function parseTarArchive(compressedArchive) {
  const archive = gunzipSync(compressedArchive);
  const entries = new Map();
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const sizeText = readTarString(header, 124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid tar entry size for ${entryPath || "<unnamed>"}`);
    }

    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > archive.length) throw new Error(`Truncated tar entry: ${entryPath}`);
    entries.set(entryPath, {
      content: archive.subarray(contentStart, contentEnd),
      contentStart,
    });
    offset = contentStart + Math.ceil(size / 512) * 512;
  }

  return { archive, entries };
}

export function validatePackedManifest({ sourceManifest, packedManifest, workspaceVersions }) {
  const failures = [];
  if (packedManifest.name !== sourceManifest.name) failures.push("packed name differs from package.json");
  if (packedManifest.version !== sourceManifest.version) failures.push("packed version differs from package.json");
  if (packedManifest.private === true) failures.push("packed manifest is private");

  for (const section of dependencySections) {
    const sourceDependencies = sourceManifest[section] ?? {};
    const packedDependencies = packedManifest[section] ?? {};
    const expectedDependencies = {};
    for (const [name, sourceRange] of Object.entries(sourceDependencies)) {
      const workspaceVersion = workspaceVersions.get(name);
      expectedDependencies[name] = (
        workspaceVersion !== undefined
        && typeof sourceRange === "string"
        && sourceRange.startsWith("workspace:")
      )
        ? packedWorkspaceRange(sourceRange, workspaceVersion)
        : sourceRange;
    }

    const expectedNames = Object.keys(expectedDependencies).sort();
    const packedNames = Object.keys(packedDependencies).sort();
    for (const name of expectedNames) {
      if (!Object.hasOwn(packedDependencies, name)) {
        failures.push(`${section}.${name} is missing from the packed manifest`);
      } else if (packedDependencies[name] !== expectedDependencies[name]) {
        failures.push(
          `${section}.${name} is ${packedDependencies[name]}; expected ${expectedDependencies[name]}`,
        );
      }
    }
    for (const name of packedNames) {
      if (!Object.hasOwn(expectedDependencies, name)) {
        failures.push(`${section}.${name} is unexpected in the packed manifest`);
      }
      const referenceFailure = dependencyReferenceFailure(packedDependencies[name]);
      if (referenceFailure) {
        failures.push(`${section}.${name} ${referenceFailure}: ${packedDependencies[name]}`);
      }
    }
  }

  for (const section of ["bundleDependencies", "bundledDependencies"]) {
    if ((packedManifest[section]?.length ?? 0) > 0) {
      failures.push(`${section} must be empty`);
    }
  }

  return failures;
}

export function declaredEntrypoints(manifest) {
  const entrypoints = new Set();
  addEntrypoint(entrypoints, manifest.main);
  addEntrypoint(entrypoints, manifest.module);
  addEntrypoint(entrypoints, manifest.types);
  if (typeof manifest.bin === "string") addEntrypoint(entrypoints, manifest.bin);
  else for (const value of Object.values(manifest.bin ?? {})) addEntrypoint(entrypoints, value);
  collectExportEntrypoints(entrypoints, manifest.exports);
  return [...entrypoints].sort();
}

function packedWorkspaceRange(sourceRange, version) {
  const selector = sourceRange.slice("workspace:".length);
  if (selector === "*" || selector === "") return version;
  if (selector === "^") return `^${version}`;
  if (selector === "~") return `~${version}`;
  return selector;
}

function collectExportEntrypoints(entrypoints, value) {
  if (typeof value === "string") {
    addEntrypoint(entrypoints, value);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const child of Object.values(value)) collectExportEntrypoints(entrypoints, child);
}

function addEntrypoint(entrypoints, value) {
  if (typeof value !== "string") return;
  const normalized = value.replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || normalized.startsWith("/")) return;
  entrypoints.add(normalized);
}

function readTarString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  const boundedEnd = end < 0 || end > offset + length ? offset + length : end;
  return buffer.toString("utf8", offset, boundedEnd);
}
