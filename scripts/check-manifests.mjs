import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readCandidateLock, validateCandidateLock } from "./candidate-lock.mjs";
import { dependencyReferenceFailure } from "./dependency-policy.mjs";
import { expectedSourceProvenance } from "./provenance.mjs";
import { targetArchiveFilenames } from "./validation-layout.mjs";
import { validateCommittedValidationLocks } from "./validation-lock.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.join(repositoryRoot, "packages");
const failures = [];
const canonicalLicense = normalizeNewlines(await readFile(path.join(repositoryRoot, "LICENSE"), "utf8"));
const rootManifest = await readJson(path.join(repositoryRoot, "package.json"));
const provenance = await readJson(path.join(repositoryRoot, "source-provenance.json"));
const candidateLock = await readCandidateLock(path.join(repositoryRoot, "candidate-lock.json"));
const expectedPackages = {
  "agent-runtime-provider-attachments": {
    name: "@marshal/agent-runtime-provider-attachments",
    version: "0.1.0",
    engine: ">=22.13.0",
    files: ["dist", "src", "README.md"],
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    },
    dependencies: {
      "@marshal/attachments": "workspace:*",
    },
    devDependencies: {
      "@types/node": "^25.2.3",
      "typescript": "^5.3.2",
      "vitest": "^3.2.4",
    },
  },
  "attachments": {
    name: "@marshal/attachments",
    version: "0.1.0",
    engine: ">=24.14.0",
    files: ["dist", "README.md", "LICENSE"],
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
      "./provider": {
        types: "./dist/provider/index.d.ts",
        default: "./dist/provider/index.js",
      },
      "./content-to-markdown": {
        types: "./dist/content-to-markdown/index.d.ts",
        default: "./dist/content-to-markdown/index.js",
      },
    },
    dependencies: {
      "@marshal/agent-runtime-core": "0.1.0",
      "@marshal/agent-runtime-provider-kit": "0.1.0",
      "@marshal/runtime": "0.1.0",
      "@xmldom/xmldom": "^0.8.11",
      "exifr": "^7.1.3",
      "file-type": "^19.6.0",
      "jszip": "^3.10.1",
      "mammoth": "^1.10.0",
      "music-metadata": "^10.7.0",
      "pdf-parse": "^1.1.1",
      "turndown": "^7.2.1",
      "turndown-plugin-gfm": "^1.0.2",
      "xlsx": "^0.18.5",
    },
    devDependencies: {
      "@types/node": "25.9.5",
      "@types/turndown": "^5.0.5",
      "typescript": "5.9.3",
      "vitest": "^3.2.4",
    },
  },
  "content-to-markdown": {
    name: "@marshal/content-to-markdown",
    version: "1.0.0",
    engine: ">=22.13.0",
    files: ["dist", "src", "README.md"],
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    },
    dependencies: {
      "@marshal/attachments": "workspace:*",
    },
    devDependencies: {
      "@types/turndown": "^5.0.5",
      "@types/node": "^25.2.3",
      "typescript": "^5.3.2",
      "vitest": "^3.2.4",
    },
  },
};
const internalNames = new Set(Object.values(expectedPackages).map((entry) => entry.name));

if (rootManifest.name !== "@marshal/attachments-workspace") {
  failures.push("root package name must be @marshal/attachments-workspace");
}
if (rootManifest.private !== true) failures.push("root package must remain private");
if (rootManifest.type !== "commonjs") failures.push("root package type must be commonjs");
if (rootManifest.main !== "dist/extension.cjs") {
  failures.push("root package main must be dist/extension.cjs");
}
if (!sameJson(rootManifest.files, ["dist", "runtime-extension.json", "LICENSE"])) {
  failures.push("root package files must contain only the extension payload");
}
if (rootManifest.packageManager !== "pnpm@10.32.1") {
  failures.push("root packageManager must be pnpm@10.32.1");
}
if (rootManifest.engines?.node !== ">=24.14.0") {
  failures.push("root engines.node must be >=24.14.0");
}
if (rootManifest.license !== "MIT") failures.push("root license must be MIT");
if (!sameJson(rootManifest.devDependencies, {
  "@marshal/runtime": "0.1.0",
  esbuild: "0.27.7",
  typescript: "5.9.3",
})) {
  failures.push("root extension build dependencies differ");
}
const expectedRootScripts = {
  repository: "node scripts/check-repository.mjs",
  manifests: "node scripts/check-manifests.mjs",
  provenance: "node scripts/check-provenance.mjs",
  boundaries: "node scripts/check-boundaries.mjs",
  build: "node scripts/run-workspace-script.mjs build",
  typecheck: "node scripts/run-workspace-script.mjs typecheck",
  test: "node scripts/run-workspace-script.mjs test",
  "api:check": "node scripts/check-api-compatibility.mjs",
  "pack:check": "node scripts/check-packs.mjs",
  "test:pack-install": "node scripts/pack-install-smoke.mjs",
  "lock:update": "node scripts/update-validation-locks.mjs",
  "verify:negative": "node --test scripts/__tests__/verification.test.mjs",
  "verify:structure": "node --test scripts/__tests__/consolidation.test.mjs",
  "verify:readiness": "node scripts/verify-readiness.mjs",
  "verify:source": "node scripts/verify.mjs --source-only",
  "verify:with-candidates": "node scripts/verify-with-candidates.mjs",
  verify: "node scripts/verify.mjs",
};
if (!sameJson(rootManifest.scripts, expectedRootScripts)) {
  failures.push("root verification scripts differ from the reviewed policy");
}

const extensionManifest = await readJson(path.join(repositoryRoot, "runtime-extension.json"));
if (
  extensionManifest.schemaVersion !== 1
  || extensionManifest.identity !== rootManifest.name
  || extensionManifest.version !== rootManifest.version
  || extensionManifest.entrypoint !== rootManifest.main
  || extensionManifest.moduleFormat !== "commonjs-bundle-v1"
) {
  failures.push("runtime-extension.json identity, version, entrypoint, or format differs");
}
if (!extensionManifest.contributes?.capabilities?.includes("attachments.convert")) {
  failures.push("runtime-extension.json must contribute attachments.convert");
}
if (!sameJson(extensionManifest.configuration?.defaults, {
  maxInputBytes: 64 * 1024 * 1024,
  maxArchiveEntries: 50,
  maxArchiveDepth: 3,
})) {
  failures.push("runtime-extension.json defaults differ from bounded provider defaults");
}

const workspaceText = (await readFile(path.join(repositoryRoot, "pnpm-workspace.yaml"), "utf8"))
  .replaceAll("\r\n", "\n");
const expectedWorkspace = [
  "packages:",
  "  - \"packages/*\"",
  "",
  "allowBuilds:",
  "  esbuild: true",
  "",
  "autoInstallPeers: false",
  "nodeLinker: hoisted",
  "",
].join("\n");
if (workspaceText !== expectedWorkspace) {
  failures.push("pnpm-workspace.yaml differs from the independent workspace policy");
}

if (!sameJson(provenance, expectedSourceProvenance)) {
  failures.push("source-provenance.json differs from the reviewed extraction provenance");
}
try {
  const lockedCandidates = validateCandidateLock(candidateLock);
  const validationMetadata = await validateCommittedValidationLocks({
    repositoryRoot,
    candidateFilenames: lockedCandidates.map((candidate) => candidate.filename),
    targetFilenames: targetArchiveFilenames,
  });
  const targetIdentities = validationMetadata.targetPacks
    .map(({ name, version, filename }) => ({ name, version, filename }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const expectedTargetIdentities = [
    {
      name: "@marshal/agent-runtime-provider-attachments",
      version: "0.1.0",
      filename: "marshal-agent-runtime-provider-attachments-0.1.0.tgz",
    },
    {
      name: "@marshal/attachments",
      version: "0.1.0",
      filename: "marshal-attachments-0.1.0.tgz",
    },
    {
      name: "@marshal/content-to-markdown",
      version: "1.0.0",
      filename: "marshal-content-to-markdown-1.0.0.tgz",
    },
  ].sort((left, right) => left.name.localeCompare(right.name));
  if (!sameJson(targetIdentities, expectedTargetIdentities)) {
    failures.push("validation target pack identities differ from the reviewed packages");
  }
} catch (error) {
  failures.push(error.message);
}

const actualDirectories = (await readdir(packagesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const expectedDirectories = Object.keys(expectedPackages).sort();
if (!sameJson(actualDirectories, expectedDirectories)) {
  failures.push(`workspace packages differ: ${actualDirectories.join(", ")}`);
}

for (const [directory, expected] of Object.entries(expectedPackages)) {
  const packageRoot = path.join(packagesRoot, directory);
  const manifest = await readJson(path.join(packageRoot, "package.json"));
  const label = manifest.name ?? directory;

  if (manifest.name !== expected.name) failures.push(`${directory}: package name differs`);
  if (manifest.version !== expected.version) failures.push(`${label}: version must be ${expected.version}`);
  if (manifest.private === true) failures.push(`${label}: package must remain publishable`);
  if (manifest.type !== "module") failures.push(`${label}: type must be module`);
  if (manifest.license !== "MIT") failures.push(`${label}: license must be MIT`);
  if (manifest.engines?.node !== expected.engine) {
    failures.push(`${label}: engines.node must be ${expected.engine}`);
  }
  if (manifest.publishConfig?.access !== "public") {
    failures.push(`${label}: publishConfig.access must be public`);
  }
  if (manifest.main !== "dist/index.js" || manifest.types !== "dist/index.d.ts") {
    failures.push(`${label}: main and types must retain the dist entrypoint`);
  }
  if (!sameJson(manifest.exports, expected.exports)) failures.push(`${label}: exports differ`);
  if (!sameJson(manifest.files, expected.files)) failures.push(`${label}: files list changed`);
  if (!sameJson(manifest.dependencies, expected.dependencies)) {
    failures.push(`${label}: dependencies differ from the extraction policy`);
  }
  if (!sameJson(manifest.devDependencies, expected.devDependencies)) {
    failures.push(`${label}: devDependencies differ from the source package`);
  }
  for (const script of ["build", "typecheck", "test"]) {
    if (typeof manifest.scripts?.[script] !== "string") failures.push(`${label}: missing ${script} script`);
  }

  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dependency, rangeValue] of Object.entries(manifest[section] ?? {})) {
      const range = String(rangeValue);
      const allowedWorkspace = internalNames.has(dependency) && range === "workspace:*";
      const referenceFailure = dependencyReferenceFailure(range, {
        allowWorkspace: allowedWorkspace,
      });
      if (referenceFailure) {
        failures.push(
          `${label}: ${section}.${dependency} ${referenceFailure}: ${range}`,
        );
      }
      if (range.startsWith("workspace:")) {
        if (!internalNames.has(dependency) || range !== "workspace:*") {
          failures.push(`${label}: workspace range is only allowed as workspace:* for extracted packages`);
        }
      } else if (internalNames.has(dependency)) {
        failures.push(`${label}: internal dependency ${dependency} must use workspace:*`);
      } else if (dependency.startsWith("@marshal/") && !/^\d+\.\d+\.\d+$/.test(range)) {
        failures.push(`${label}: cross-repository dependency ${dependency} must use an exact version`);
      }
    }
  }
  for (const section of ["bundleDependencies", "bundledDependencies"]) {
    if ((manifest[section]?.length ?? 0) > 0) {
      failures.push(`${label}: ${section} must be empty`);
    }
  }

  try {
    const packageLicense = normalizeNewlines(await readFile(path.join(packageRoot, "LICENSE"), "utf8"));
    if (packageLicense !== canonicalLicense) failures.push(`${label}: LICENSE differs from the root license`);
    await access(path.join(packageRoot, "README.md"));
  } catch {
    failures.push(`${label}: README.md and LICENSE are required`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Validated three publishable package manifests and exact dependency boundaries.");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sameJson(left, right) {
  return JSON.stringify(sortObject(left)) === JSON.stringify(sortObject(right));
}

function sortObject(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortObject(child)]),
  );
}

function normalizeNewlines(value) {
  return value.replaceAll("\r\n", "\n");
}
