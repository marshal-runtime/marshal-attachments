import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { configuredPackageManager } from "./package-manager.mjs";
import {
  canonicalizePackedArchive,
  declaredEntrypoints,
  readTarEntries,
  validatePackedManifest,
} from "./packed-manifest.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.join(repositoryRoot, "packages");
const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const packageManager = configuredPackageManager(rootManifest);
const requestedOutput = process.env.MARSHAL_PACK_OUTPUT_DIR;
const archiveRoot = requestedOutput
  ? path.resolve(requestedOutput)
  : await mkdtemp(path.join(os.tmpdir(), "marshal-attachments-pack-"));
const removeArchiveRoot = !requestedOutput;
const errors = [];
const evidence = [];
const packageDirectories = [];

await mkdir(archiveRoot, { recursive: true });
for (const entry of (await readdir(packagesRoot, { withFileTypes: true }))
  .filter((candidate) => candidate.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name))) {
  try {
    await access(path.join(packagesRoot, entry.name, "package.json"));
    packageDirectories.push(entry.name);
  } catch {
    // Ignore support directories without package manifests.
  }
}

const workspaceVersions = new Map();
for (const directory of packageDirectories) {
  const manifest = JSON.parse(await readFile(path.join(packagesRoot, directory, "package.json"), "utf8"));
  workspaceVersions.set(manifest.name, manifest.version);
}

try {
  for (const directory of packageDirectories) {
    const packageRoot = path.join(packagesRoot, directory);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    const result = spawnSync(
      process.execPath,
      [packageManager.cli, "pack", "--json", "--pack-destination", archiveRoot],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: packageManager.env,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.status !== 0) {
      errors.push(`${manifest.name}: pack failed: ${(result.stderr || result.stdout).trim()}`);
      continue;
    }

    let pack;
    try {
      const parsed = JSON.parse(result.stdout);
      pack = Array.isArray(parsed) ? parsed[0] : parsed;
    } catch {
      errors.push(`${manifest.name}: pack did not return valid JSON`);
      continue;
    }

    const archivePath = await resolveArchivePath(archiveRoot, pack.filename);
    let archive = await readFile(archivePath);
    const canonicalArchive = canonicalizePackedArchive({
      compressedArchive: archive,
      sourceManifest: manifest,
    });
    if (!archive.equals(canonicalArchive)) {
      await writeFile(archivePath, canonicalArchive);
      archive = canonicalArchive;
    }
    const entries = readTarEntries(archive);
    const packedManifestBytes = entries.get("package/package.json");
    if (!packedManifestBytes) {
      errors.push(`${manifest.name}: archive is missing package/package.json`);
      continue;
    }
    const packedManifest = JSON.parse(packedManifestBytes.toString("utf8"));
    for (const failure of validatePackedManifest({
      sourceManifest: manifest,
      packedManifest,
      workspaceVersions,
    })) {
      errors.push(`${manifest.name}: ${failure}`);
    }

    const reportedFiles = new Set(
      (pack.files ?? [])
        .map((file) => file.path.replaceAll("\\", "/").replace(/^package\//, "")),
    );
    const packedFiles = new Set();
    for (const entryPath of entries.keys()) {
      if (!entryPath.startsWith("package/")) {
        errors.push(`${manifest.name}: tarball contains path outside package/: ${entryPath}`);
        continue;
      }
      if (entryPath.endsWith("/")) continue;
      packedFiles.add(entryPath.slice("package/".length));
    }
    if (!sameSet(packedFiles, reportedFiles)) {
      errors.push(`${manifest.name}: pnpm pack file report differs from the actual tarball`);
    }
    const requiredFiles = ["package.json", "README.md", ...declaredEntrypoints(manifest)]
      .filter(Boolean)
      .map((file) => file.replace(/^\.\//, ""));
    for (const requiredFile of requiredFiles) {
      if (!packedFiles.has(requiredFile)) errors.push(`${manifest.name}: tarball is missing ${requiredFile}`);
    }
    if (![...packedFiles].some((file) => /(^|\/)LICENSE(?:\.[^/]+)?$/i.test(file))) {
      errors.push(`${manifest.name}: tarball is missing a license file`);
    }
    for (const packedFile of packedFiles) {
      if (
        packedFile === "node_modules"
        || packedFile.startsWith("node_modules/")
        || packedFile === ".git"
        || packedFile.startsWith(".git/")
        || /(^|\/)__tests__(\/|$)/i.test(packedFile)
        || /\.(?:spec|test)\.[^/]+$/i.test(packedFile)
      ) {
        errors.push(`${manifest.name}: tarball contains forbidden path ${packedFile}`);
      }
    }
    for (const failure of consolidatedPackFailures({
      manifest: packedManifest,
      packedFiles,
    })) {
      errors.push(`${manifest.name}: ${failure}`);
    }

    evidence.push({
      name: manifest.name,
      version: manifest.version,
      filename: path.basename(archivePath),
      bytes: archive.length,
      files: packedFiles.size,
      sha256: createHash("sha256").update(archive).digest("hex"),
    });
  }
} finally {
  if (removeArchiveRoot) await rm(archiveRoot, { recursive: true, force: true });
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

for (const item of evidence) {
  console.log(
    `${item.name}@${item.version}: ${item.filename}, ${item.files} files, ${item.bytes} bytes, sha256=${item.sha256}`,
  );
}
console.log(`Validated packed archives and rewritten manifests for ${evidence.length} packages.`);

async function resolveArchivePath(directory, reportedFilename) {
  const direct = path.isAbsolute(reportedFilename)
    ? reportedFilename
    : path.resolve(directory, path.basename(reportedFilename));
  try {
    await access(direct);
    return direct;
  } catch {
    const candidates = (await readdir(directory))
      .filter((entry) => entry.endsWith(".tgz"))
      .map((entry) => path.join(directory, entry));
    if (candidates.length === 1) return candidates[0];
    throw new Error(`Could not resolve packed archive ${reportedFilename}`);
  }

}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function consolidatedPackFailures({ manifest, packedFiles }) {
  const failures = [];
  if (manifest.name === "@marshal/attachments") {
    for (const legacyName of [
      "@marshal/agent-runtime-provider-attachments",
      "@marshal/content-to-markdown",
    ]) {
      if (Object.hasOwn(manifest.dependencies ?? {}, legacyName)) {
        failures.push(`canonical manifest must not depend on ${legacyName}`);
      }
    }
    for (const requiredFile of [
      "dist/provider/index.js",
      "dist/provider/index.d.ts",
      "dist/content-to-markdown/index.js",
      "dist/content-to-markdown/index.d.ts",
    ]) {
      if (!packedFiles.has(requiredFile)) {
        failures.push(`canonical implementation entrypoint is missing ${requiredFile}`);
      }
    }
    if ([...packedFiles].some((file) => file.startsWith("src/"))) {
      failures.push("canonical tarball must publish compiled implementation only");
    }
    return failures;
  }

  if (
    manifest.name !== "@marshal/agent-runtime-provider-attachments"
    && manifest.name !== "@marshal/content-to-markdown"
  ) {
    return failures;
  }
  if (
    JSON.stringify(manifest.dependencies ?? {})
    !== JSON.stringify({ "@marshal/attachments": "0.1.0" })
  ) {
    failures.push("compatibility manifest must depend only on @marshal/attachments@0.1.0");
  }
  const sourceFiles = [...packedFiles].filter((file) => file.startsWith("src/")).sort();
  if (JSON.stringify(sourceFiles) !== JSON.stringify(["src/index.ts"])) {
    failures.push(`compatibility source must contain only src/index.ts: ${sourceFiles.join(", ")}`);
  }
  const nestedDistFiles = [...packedFiles].filter((file) =>
    file.startsWith("dist/") && file.slice("dist/".length).includes("/"));
  if (nestedDistFiles.length > 0) {
    failures.push(`compatibility dist contains implementation subpaths: ${nestedDistFiles.join(", ")}`);
  }
  return failures;
}
