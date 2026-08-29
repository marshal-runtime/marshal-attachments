import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL, fileURLToPath } from "node:url";
import tsModule from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicApi = JSON.parse(
  await readFile(path.join(repositoryRoot, "validation", "public-api.json"), "utf8"),
);
const packageEntrypoints = new Map([
  [
    "@marshal/attachments",
    path.join(repositoryRoot, "packages", "attachments", "dist", "index.js"),
  ],
  [
    "@marshal/agent-runtime-provider-attachments",
    path.join(
      repositoryRoot,
      "packages",
      "agent-runtime-provider-attachments",
      "dist",
      "index.js",
    ),
  ],
  [
    "@marshal/content-to-markdown",
    path.join(repositoryRoot, "packages", "content-to-markdown", "dist", "index.js"),
  ],
]);
const canonicalEntrypoints = new Map([
  [
    "@marshal/attachments/provider",
    path.join(repositoryRoot, "packages", "attachments", "dist", "provider", "index.js"),
  ],
  [
    "@marshal/attachments/content-to-markdown",
    path.join(
      repositoryRoot,
      "packages",
      "attachments",
      "dist",
      "content-to-markdown",
      "index.js",
    ),
  ],
]);
const failures = [];
const loadedModules = new Map();

for (const [packageName, expected] of Object.entries(publicApi.packages)) {
  const entrypoint = packageEntrypoints.get(packageName);
  if (!entrypoint) {
    failures.push(`${packageName}: no built entrypoint configured`);
    continue;
  }
  const moduleNamespace = await import(pathToFileURL(entrypoint).href);
  loadedModules.set(packageName, moduleNamespace);
  const actualExports = Object.keys(moduleNamespace).sort();
  if (!sameJson(actualExports, expected.runtimeExports)) {
    failures.push(
      `${packageName}: runtime exports are ${actualExports.join(", ")}; `
      + `expected ${expected.runtimeExports.join(", ")}`,
    );
  }
}

for (const [specifier, definition] of Object.entries(publicApi.canonicalSubpaths)) {
  const entrypoint = canonicalEntrypoints.get(specifier);
  const compatibilityModule = loadedModules.get(definition.compatibilityPackage);
  if (!entrypoint || !compatibilityModule) {
    failures.push(`${specifier}: compatibility mapping is incomplete`);
    continue;
  }
  const canonicalModule = await import(pathToFileURL(entrypoint).href);
  const canonicalExports = Object.keys(canonicalModule).sort();
  const compatibilityExports = Object.keys(compatibilityModule).sort();
  if (!sameJson(canonicalExports, compatibilityExports)) {
    failures.push(
      `${specifier}: runtime exports differ from ${definition.compatibilityPackage}`,
    );
  }
  for (const exportName of canonicalExports) {
    if (canonicalModule[exportName] !== compatibilityModule[exportName]) {
      failures.push(
        `${definition.compatibilityPackage}.${exportName} is not the canonical export identity`,
      );
    }
  }
}

const ts = tsModule.default ?? tsModule;
const configPath = path.join(repositoryRoot, "validation", "tsconfig.api.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  failures.push(formatDiagnostic(configFile.error));
} else {
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
  const checker = program.getTypeChecker();
  const diagnostics = [
    ...parsed.errors,
    ...ts.getPreEmitDiagnostics(program),
  ];
  failures.push(...diagnostics.map(formatDiagnostic));

  for (const [packageName, expected] of Object.entries(publicApi.packages)) {
    validateDeclarationExports(
      checker,
      program,
      declarationPath(packageEntrypoints.get(packageName)),
      [...new Set([...expected.runtimeExports, ...expected.typeExports])].sort(),
      packageName,
    );
  }
  for (const [specifier, definition] of Object.entries(publicApi.canonicalSubpaths)) {
    const expected = publicApi.packages[definition.compatibilityPackage];
    validateDeclarationExports(
      checker,
      program,
      declarationPath(canonicalEntrypoints.get(specifier)),
      [...new Set([...expected.runtimeExports, ...expected.typeExports])].sort(),
      specifier,
    );
  }
}

if (failures.length > 0) {
  console.error([...new Set(failures)].join("\n"));
  process.exit(1);
}

console.log(
  "Validated recorded runtime exports, canonical shim identity, and TypeScript API compatibility.",
);

function formatDiagnostic(diagnostic) {
  return ts.formatDiagnostic(diagnostic, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => repositoryRoot,
    getNewLine: () => "\n",
  }).trim();
}

function declarationPath(entrypoint) {
  return entrypoint?.replace(/\.js$/, ".d.ts");
}

function validateDeclarationExports(checker, program, declarationFile, expectedExports, label) {
  if (!declarationFile) {
    failures.push(`${label}: no declaration entrypoint configured`);
    return;
  }
  const sourceFile = program.getSourceFile(declarationFile);
  const moduleSymbol = sourceFile && (
    checker.getSymbolAtLocation(sourceFile)
    ?? sourceFile.symbol
  );
  if (!moduleSymbol) {
    failures.push(`${label}: declaration module was not loaded from ${declarationFile}`);
    return;
  }
  const actualExports = checker.getExportsOfModule(moduleSymbol)
    .map((symbol) => symbol.getName())
    .filter((name) => name !== "default")
    .sort();
  if (!sameJson(actualExports, expectedExports)) {
    failures.push(
      `${label}: declaration exports are ${actualExports.join(", ")}; `
      + `expected ${expectedExports.join(", ")}`,
    );
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
