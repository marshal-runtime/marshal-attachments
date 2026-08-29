import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

export function configuredPackageManager(
  rootManifest,
  {
    env = process.env,
    execPath = process.execPath,
    nodeVersion = process.versions.node,
    spawn = spawnSync,
  } = {},
) {
  assertSupportedNodeVersion(rootManifest.engines?.node, nodeVersion);
  const expected = rootManifest.packageManager;
  const separator = expected.lastIndexOf("@");
  const expectedName = expected.slice(0, separator);
  const expectedVersion = expected.slice(separator + 1);
  const current = env.npm_config_user_agent?.split(" ")[0];
  const [currentName, currentVersion] = current?.split("/") ?? [];
  const cli = env.npm_execpath;

  if (!cli || currentName !== expectedName || currentVersion !== expectedVersion) {
    throw new Error(
      `This command requires ${expected}; run it through Corepack or the repository's configured pnpm. ` +
        `(current: ${current ?? "unknown"})`,
    );
  }

  const commandEnvironment = packageManagerEnvironment(env, execPath);
  const versionResult = spawn(execPath, [cli, "--version"], {
    encoding: "utf8",
    env: commandEnvironment,
  });
  if (versionResult.error) throw versionResult.error;
  if (versionResult.status !== 0) {
    throw new Error(
      `Could not execute configured package manager ${cli}: `
      + `${(versionResult.stderr || versionResult.stdout).trim()}`,
    );
  }
  const cliVersion = versionResult.stdout.trim();
  validatePackageManagerIdentity({
    expected,
    current: `${currentName}/${currentVersion}`,
    cliVersion,
  });

  return { cli, expected, env: commandEnvironment };
}

export function assertSupportedNodeVersion(requiredRange, currentVersion) {
  const match = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(requiredRange ?? "");
  if (!match) throw new Error(`Unsupported engines.node policy: ${requiredRange ?? "<missing>"}`);
  const minimum = match.slice(1).map(Number);
  const current = String(currentVersion).split(".").map(Number);
  if (
    current.length !== 3
    || current.some((part) => !Number.isSafeInteger(part) || part < 0)
    || compareVersion(current, minimum) < 0
  ) {
    throw new Error(`Node ${currentVersion} is unsupported; this repository requires ${requiredRange}`);
  }
}

export function validatePackageManagerIdentity({ expected, current, cliVersion }) {
  const separator = expected.lastIndexOf("@");
  const expectedName = expected.slice(0, separator);
  const expectedVersion = expected.slice(separator + 1);
  if (current !== `${expectedName}/${expectedVersion}` || cliVersion !== expectedVersion) {
    throw new Error(
      `Package manager mismatch: expected ${expected}, `
      + `invocation=${current ?? "unknown"}, cli=${cliVersion ?? "unknown"}`,
    );
  }
}

export function packageManagerEnvironment(env = process.env, execPath = process.execPath) {
  const result = { ...env };
  const pathKeys = Object.keys(result).filter((key) => key.toLowerCase() === "path");
  const pathKey = pathKeys[0] ?? "PATH";
  for (const duplicateKey of pathKeys.slice(1)) delete result[duplicateKey];

  const nodeDirectory = path.dirname(execPath);
  const currentPath = result[pathKey] ?? "";
  const pathParts = currentPath.split(path.delimiter).filter(Boolean);
  const normalizedNodeDirectory = normalizePath(nodeDirectory);
  const withoutNodeDirectory = pathParts.filter(
    (entry) => normalizePath(entry) !== normalizedNodeDirectory,
  );
  result[pathKey] = [nodeDirectory, ...withoutNodeDirectory].join(path.delimiter);
  return result;
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function normalizePath(value) {
  return path.resolve(value).toLowerCase();
}
