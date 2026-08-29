import { spawnSync } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedRoots = new Set([
  ".gitattributes",
  ".github",
  ".gitignore",
  "LICENSE",
  "README.md",
  "candidate-lock.json",
  "package.json",
  "packages",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "runtime-extension.json",
  "scripts",
  "source-provenance.json",
  "src",
  "tsconfig.extension.json",
  "validation",
]);
const forbiddenSegments = new Set([
  ".candidate-validation",
  "node_modules",
  "dist",
  "coverage",
]);
const failures = [];
const paths = await repositoryPaths();

for (const relativePath of paths) {
  const normalized = relativePath.replaceAll("\\", "/");
  const [root] = normalized.split("/");
  if (!allowedRoots.has(root)) {
    failures.push(`unexpected repository root: ${root}`);
  }
  if (normalized.split("/").some((segment) => forbiddenSegments.has(segment))) {
    failures.push(`generated path must not be committed: ${normalized}`);
  }
  if (normalized.endsWith(".tgz")) {
    failures.push(`candidate archive must not be committed: ${normalized}`);
  }
  const stat = await lstat(path.join(repositoryRoot, relativePath));
  if (stat.isSymbolicLink()) {
    failures.push(`symbolic links are not allowed in the extracted repository: ${normalized}`);
  }
}

if (failures.length > 0) {
  console.error([...new Set(failures)].join("\n"));
  process.exit(1);
}

console.log(`Validated repository contents (${paths.length} files).`);

async function repositoryPaths() {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (result.status === 0) {
    return result.stdout.split("\0").filter(Boolean).sort();
  }
  return walk(repositoryRoot);
}

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || forbiddenSegments.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(repositoryRoot, absolute);
    if (entry.isDirectory()) found.push(...await walk(absolute));
    else found.push(relative);
  }
  return found.sort();
}
