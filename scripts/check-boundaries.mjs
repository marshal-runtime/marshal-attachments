import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.join(repositoryRoot, "packages");
const failures = [];
const allowedInternalEdges = new Map([
  ["@marshal/attachments", new Set([
    "@marshal/agent-runtime-provider-attachments",
    "@marshal/content-to-markdown",
  ])],
  ["@marshal/agent-runtime-provider-attachments", new Set([
    "@marshal/content-to-markdown",
  ])],
  ["@marshal/content-to-markdown", new Set()],
]);
const packageDirectories = (await readdir(packagesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const manifests = new Map();
const internalNames = new Set();
let scannedFiles = 0;

for (const directory of packageDirectories) {
  const manifest = JSON.parse(await readFile(path.join(packagesRoot, directory, "package.json"), "utf8"));
  manifests.set(directory, manifest);
  internalNames.add(manifest.name);
}

for (const directory of packageDirectories) {
  const packageRoot = path.join(packagesRoot, directory);
  const manifest = manifests.get(directory);
  const productionDependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const developmentDependencies = new Set([
    ...productionDependencies,
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  const files = await TypeScriptFiles(packageRoot);

  for (const filePath of files) {
    scannedFiles += 1;
    const relativeFile = path.relative(packageRoot, filePath).replaceAll("\\", "/");
    const sourceFile = relativeFile.startsWith("src/");
    const declaredDependencies = sourceFile ? productionDependencies : developmentDependencies;
    const text = await readFile(filePath, "utf8");

    if (/@openai\/codex|(?:^|[/"'])electron(?:[/"']|$)|chatgpt/i.test(text)) {
      failures.push(`${manifest.name}:${relativeFile}: portable attachment packages cannot import harness code`);
    }
    if (
      /\.\.\/(?:agent-runtime-core|agent-runtime-effects|agent-runtime-host|agent-runtime-providers|agent-runtime-typescript|agent-runtime-provider-kit|runtime)\//.test(text)
    ) {
      failures.push(`${manifest.name}:${relativeFile}: source URL references a package outside this workspace`);
    }

    for (const specifier of importSpecifiers(text)) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
        const resolved = path.resolve(path.dirname(filePath), specifier);
        const relative = path.relative(packageRoot, resolved);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          failures.push(`${manifest.name}:${relativeFile}: relative import escapes package root: ${specifier}`);
        }
        continue;
      }

      const dependency = packageName(specifier);
      if (!declaredDependencies.has(dependency)) {
        failures.push(`${manifest.name}:${relativeFile}: undeclared import ${specifier}`);
      }
      if (sourceFile && internalNames.has(dependency)) {
        const allowed = allowedInternalEdges.get(manifest.name) ?? new Set();
        if (!allowed.has(dependency)) {
          failures.push(`${manifest.name}:${relativeFile}: forbidden internal edge to ${dependency}`);
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Validated package import boundaries across ${scannedFiles} TypeScript files.`);

async function TypeScriptFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await TypeScriptFiles(child));
    else if (/\.(?:ts|mts|cts|tsx)$/.test(entry.name)) found.push(child);
  }
  return found;
}

function importSpecifiers(text) {
  const found = [];
  const pattern = /(?:from\s+|import\s*(?:\(\s*)?|(?:vi\.)?mock\s*\(\s*)["']([^"']+)["']/g;
  for (const match of text.matchAll(pattern)) found.push(match[1]);
  return found;
}

function packageName(specifier) {
  if (!specifier.startsWith("@")) return specifier.split("/")[0];
  return specifier.split("/").slice(0, 2).join("/");
}
