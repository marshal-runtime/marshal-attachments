import assert from "node:assert/strict";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  stageArchiveRecords,
  validateCandidateRecords,
} from "../candidate-lock.mjs";
import { dependencyReferenceFailure } from "../dependency-policy.mjs";
import {
  assertSupportedNodeVersion,
  validatePackageManagerIdentity,
} from "../package-manager.mjs";
import { validatePackedManifest } from "../packed-manifest.mjs";
import {
  expectedSourceProvenance,
  verifySourceProvenance,
} from "../provenance.mjs";
import {
  installFromCommittedValidationLock,
  sha256,
  validatePortableLockText,
  workspaceLockName,
} from "../validation-lock.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("source provenance rejects transferred content tamper", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "marshal-provenance-negative-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await cp(
    path.join(repositoryRoot, "packages"),
    path.join(temporaryRoot, "packages"),
    {
      recursive: true,
      filter(source) {
        return !source.split(path.sep).some((segment) =>
          ["coverage", "dist", "node_modules"].includes(segment));
      },
    },
  );

  const clean = await verifySourceProvenance({
    repositoryRoot: temporaryRoot,
    provenance: expectedSourceProvenance,
  });
  assert.deepEqual(clean.failures, []);

  await appendFile(
    path.join(
      temporaryRoot,
      "packages",
      "attachments",
      "src",
      "content-to-markdown",
      "index.ts",
    ),
    "\n// negative provenance tamper\n",
  );
  const tampered = await verifySourceProvenance({
    repositoryRoot: temporaryRoot,
    provenance: expectedSourceProvenance,
  });
  assert.match(tampered.failures.join("\n"), /current tree|source tree|current blob/);
});

test("candidate validation rejects wrong, missing, and extra candidates", () => {
  const fixture = candidateFixture();

  const wrong = structuredClone(fixture.records);
  wrong[0].manifest.name = "@marshal/wrong";
  assert.throws(
    () => validateCandidateRecords({ ...fixture, records: wrong }),
    /name is @marshal\/wrong; expected @marshal\/a/,
  );

  assert.throws(
    () => validateCandidateRecords({ ...fixture, records: fixture.records.slice(0, 1) }),
    /missing candidate marshal-b-1.0.0.tgz/,
  );

  const extra = [
    ...fixture.records,
    {
      filename: "marshal-extra-1.0.0.tgz",
      manifest: { name: "@marshal/extra", version: "1.0.0" },
      sha256: "3".repeat(64),
    },
  ];
  assert.throws(
    () => validateCandidateRecords({ ...fixture, records: extra }),
    /extra candidate marshal-extra-1.0.0.tgz/,
  );
});

test("candidate validation rejects bad digest, version, and dependency edge", () => {
  const fixture = candidateFixture();

  const badDigest = structuredClone(fixture.records);
  badDigest[0].sha256 = "f".repeat(64);
  assert.throws(
    () => validateCandidateRecords({ ...fixture, records: badDigest }),
    /sha256 is f{64}/,
  );

  const badVersion = structuredClone(fixture.records);
  badVersion[0].manifest.version = "1.0.1";
  assert.throws(
    () => validateCandidateRecords({ ...fixture, records: badVersion }),
    /version is 1.0.1; expected 1.0.0/,
  );

  const badEdge = structuredClone(fixture.records);
  badEdge[0].manifest.dependencies["@marshal/b"] = "2.0.0";
  assert.throws(
    () => validateCandidateRecords({ ...fixture, records: badEdge }),
    /@marshal\/b archive version is 1.0.0; @marshal\/a requires 2.0.0/,
  );
});

test("unsupported Node and wrong pnpm fail hard", () => {
  assert.throws(
    () => assertSupportedNodeVersion(">=24.14.0", "24.13.0"),
    /Node 24.13.0 is unsupported/,
  );
  assert.doesNotThrow(() => assertSupportedNodeVersion(">=24.14.0", "24.14.0"));

  assert.throws(
    () => validatePackageManagerIdentity({
      expected: "pnpm@10.32.1",
      current: "pnpm/10.31.0",
      cliVersion: "10.31.0",
    }),
    /Package manager mismatch/,
  );
});

test("packed manifests reject extra dependency keys", () => {
  const failures = validatePackedManifest({
    sourceManifest: {
      name: "@marshal/example",
      version: "1.0.0",
      dependencies: {
        "@marshal/internal": "workspace:*",
      },
    },
    packedManifest: {
      name: "@marshal/example",
      version: "1.0.0",
      dependencies: {
        "@marshal/internal": "2.0.0",
        "@marshal/unexpected": "1.0.0",
      },
    },
    workspaceVersions: new Map([["@marshal/internal", "2.0.0"]]),
  });
  assert.match(failures.join("\n"), /dependencies\.@marshal\/unexpected is unexpected/);
});

test("all workspace, path, tarball, and sibling references are forbidden", () => {
  const forbidden = [
    "workspace:*",
    "file:../sibling",
    "link:../sibling",
    "portal:../sibling",
    "path:../sibling",
    "../sibling",
    "./sibling.tgz",
    "C:\\candidate\\package.tgz",
    "\\\\server\\share\\package.tgz",
    "/tmp/package.tgz",
    "https://example.invalid/package.tgz",
    "git+file:../sibling",
  ];
  for (const range of forbidden) {
    assert.ok(dependencyReferenceFailure(range), `expected ${range} to be forbidden`);
  }
  assert.equal(
    dependencyReferenceFailure("workspace:*", { allowWorkspace: true }),
    undefined,
  );
});

test("frozen verification ignores registry metadata and alternate vite availability", async (t) => {
  const fixture = await validationLockFixture(t);
  const observed = [];
  const originalRegistry = process.env.npm_config_registry;
  const originalVite = process.env.MARSHAL_TEST_VITE_AVAILABLE;
  t.after(() => {
    setOrDeleteEnvironment("npm_config_registry", originalRegistry);
    setOrDeleteEnvironment("MARSHAL_TEST_VITE_AVAILABLE", originalVite);
  });

  for (const variant of [
    { registry: "https://registry-one.invalid/", vite: "7.3.5" },
    { registry: "https://registry-two.invalid/", vite: "7.3.6" },
  ]) {
    process.env.npm_config_registry = variant.registry;
    process.env.MARSHAL_TEST_VITE_AVAILABLE = variant.vite;
    const installRoot = await mkdtemp(path.join(os.tmpdir(), "marshal-lock-registry-"));
    t.after(() => rm(installRoot, { recursive: true, force: true }));
    const lockSha = await installFromCommittedValidationLock({
      repositoryRoot: fixture.repositoryRoot,
      cwd: installRoot,
      lockName: workspaceLockName,
      expectedArchiveReferences: fixture.expectedArchiveReferences,
      runPnpm(arguments_) {
        observed.push({
          arguments_,
          registry: process.env.npm_config_registry,
          vite: process.env.MARSHAL_TEST_VITE_AVAILABLE,
        });
      },
    });
    assert.equal(lockSha, fixture.lockSha256);
    assert.deepEqual(await readFile(path.join(installRoot, "pnpm-lock.yaml")), fixture.lockBytes);
  }

  assert.deepEqual(
    observed.map((entry) => entry.arguments_),
    [
      ["install", "--frozen-lockfile", "--strict-peer-dependencies"],
      ["install", "--frozen-lockfile", "--strict-peer-dependencies"],
    ],
  );
  assert.deepEqual(observed.map(({ registry, vite }) => ({ registry, vite })), [
    { registry: "https://registry-one.invalid/", vite: "7.3.5" },
    { registry: "https://registry-two.invalid/", vite: "7.3.6" },
  ]);
});

test("committed validation locks reject missing and modified bytes", async (t) => {
  const missingFixture = await validationLockFixture(t);
  const missingInstallRoot = await mkdtemp(path.join(os.tmpdir(), "marshal-lock-missing-"));
  t.after(() => rm(missingInstallRoot, { recursive: true, force: true }));
  await rm(missingFixture.lockPath);
  await assert.rejects(
    installFromCommittedValidationLock({
      repositoryRoot: missingFixture.repositoryRoot,
      cwd: missingInstallRoot,
      lockName: workspaceLockName,
      expectedArchiveReferences: missingFixture.expectedArchiveReferences,
      runPnpm() {},
    }),
    /Committed validation lock is missing/,
  );

  const modifiedFixture = await validationLockFixture(t);
  const modifiedInstallRoot = await mkdtemp(path.join(os.tmpdir(), "marshal-lock-modified-"));
  t.after(() => rm(modifiedInstallRoot, { recursive: true, force: true }));
  await appendFile(modifiedFixture.lockPath, "\n# modified\n");
  await assert.rejects(
    installFromCommittedValidationLock({
      repositoryRoot: modifiedFixture.repositoryRoot,
      cwd: modifiedInstallRoot,
      lockName: workspaceLockName,
      expectedArchiveReferences: modifiedFixture.expectedArchiveReferences,
      runPnpm() {},
    }),
    /sha256 is .*; expected/,
  );
});

test("candidate staging rejects copied identity mismatch", async (t) => {
  const destinationDirectory = await mkdtemp(path.join(os.tmpdir(), "marshal-stage-mismatch-"));
  await rm(destinationDirectory, { recursive: true, force: true });
  t.after(() => rm(destinationDirectory, { recursive: true, force: true }));
  const record = {
    archivePath: "source.tgz",
    filename: "marshal-a-1.0.0.tgz",
    manifest: { name: "@marshal/a", version: "1.0.0" },
    sha256: "1".repeat(64),
  };
  await assert.rejects(
    stageArchiveRecords({
      records: [record],
      destinationDirectory,
      async copyArchive(_source, destination) {
        await writeFile(destination, "tampered");
      },
      async readStagedRecord(stagedPath) {
        return {
          ...record,
          archivePath: stagedPath,
          sha256: "2".repeat(64),
        };
      },
    }),
    /Archive staging mismatch/,
  );
});

test("validation locks reject absolute candidate paths", () => {
  const failures = validatePortableLockText(
    "lockfileVersion: '9.0'\n"
    + "packages:\n"
    + "  '@marshal/a@file:C:/session/candidates/marshal-a-1.0.0.tgz': {}\n",
    {
      expectedArchiveReferences: [
        ".candidate-validation/candidates/marshal-a-1.0.0.tgz",
      ],
    },
  );
  assert.match(failures.join("\n"), /absolute file paths are forbidden/);
});

test("frozen verification rejects generated lock byte drift", async (t) => {
  const fixture = await validationLockFixture(t);
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "marshal-lock-drift-"));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  await assert.rejects(
    installFromCommittedValidationLock({
      repositoryRoot: fixture.repositoryRoot,
      cwd: installRoot,
      lockName: workspaceLockName,
      expectedArchiveReferences: fixture.expectedArchiveReferences,
      runPnpm() {
        appendFileSync(path.join(installRoot, "pnpm-lock.yaml"), "\n# drift\n");
      },
    }),
    /generated lock byte drift/,
  );
});

test("normal verification never invokes live lock resolution or lock update", async () => {
  const verificationFiles = [
    "scripts/verify.mjs",
    "scripts/verify-with-candidates.mjs",
    "scripts/pack-install-smoke.mjs",
    "scripts/validation-lock.mjs",
    ".github/workflows/ci.yml",
  ];
  for (const relativePath of verificationFiles) {
    const text = await readFile(path.join(repositoryRoot, ...relativePath.split("/")), "utf8");
    assert.doesNotMatch(text, /--lockfile-only|--no-frozen-lockfile|lock:update/);
  }
  const updater = await readFile(
    path.join(repositoryRoot, "scripts", "update-validation-locks.mjs"),
    "utf8",
  );
  assert.match(updater, /--lockfile-only/);
  assert.match(updater, /--no-frozen-lockfile/);
  assert.match(updater, /MARSHAL_ALLOW_LOCK_UPDATE/);
});

function candidateFixture() {
  const lock = {
    formatVersion: 1,
    algorithm: "sha256",
    packages: [
      {
        name: "@marshal/a",
        version: "1.0.0",
        filename: "marshal-a-1.0.0.tgz",
        sha256: "1".repeat(64),
      },
      {
        name: "@marshal/b",
        version: "1.0.0",
        filename: "marshal-b-1.0.0.tgz",
        sha256: "2".repeat(64),
      },
    ],
  };
  const records = [
    {
      filename: "marshal-a-1.0.0.tgz",
      manifest: {
        name: "@marshal/a",
        version: "1.0.0",
        dependencies: { "@marshal/b": "1.0.0" },
      },
      sha256: "1".repeat(64),
    },
    {
      filename: "marshal-b-1.0.0.tgz",
      manifest: {
        name: "@marshal/b",
        version: "1.0.0",
      },
      sha256: "2".repeat(64),
    },
  ];
  return {
    lock,
    records,
    rootRequirements: new Map([["@marshal/a", "1.0.0"]]),
  };
}

async function validationLockFixture(t) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "marshal-lock-fixture-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const validationRoot = path.join(repositoryRoot, "validation");
  await mkdir(validationRoot, { recursive: true });
  const archiveReference = ".candidate-validation/candidates/marshal-a-1.0.0.tgz";
  const lockBytes = Buffer.from([
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  overrides:",
    `    '@marshal/a': file:${archiveReference}`,
    "    vite: 7.3.5",
    "",
    "packages:",
    `  '@marshal/a@file:${archiveReference}':`,
    `    resolution: {tarball: file:${archiveReference}}`,
    "",
    "  vite@7.3.5:",
    "    resolution: {integrity: sha512-reviewed}",
    "",
  ].join("\n"));
  const lockPath = path.join(validationRoot, "workspace-pnpm-lock.yaml");
  await writeFile(lockPath, lockBytes);
  const lockSha256 = sha256(lockBytes);
  await writeFile(path.join(validationRoot, "locks.json"), `${JSON.stringify({
    formatVersion: 1,
    workspace: {
      path: "validation/workspace-pnpm-lock.yaml",
      sha256: lockSha256,
      graphPins: { vite: "7.3.5" },
    },
    freshConsumer: {
      path: "validation/workspace-pnpm-lock.yaml",
      sha256: lockSha256,
      graphPins: {},
    },
    targetPacks: [
      {
        name: "@marshal/example",
        version: "1.0.0",
        filename: "marshal-example-1.0.0.tgz",
        sha256: "3".repeat(64),
      },
    ],
  }, null, 2)}\n`);
  return {
    repositoryRoot,
    lockPath,
    lockBytes,
    lockSha256,
    expectedArchiveReferences: [archiveReference],
  };
}

function setOrDeleteEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
