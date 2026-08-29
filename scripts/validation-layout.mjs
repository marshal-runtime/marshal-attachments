import path from "node:path";

export const workspaceStageDirectory = ".candidate-validation/candidates";
export const consumerStageDirectory = ".candidate-validation/archives";
export const reviewedViteVersion = "7.3.5";
export const targetPackageNames = [
  "@marshal/attachments",
  "@marshal/agent-runtime-provider-attachments",
  "@marshal/content-to-markdown",
];
export const targetArchiveFilenames = [
  "marshal-attachments-0.1.0.tgz",
  "marshal-agent-runtime-provider-attachments-0.1.0.tgz",
  "marshal-content-to-markdown-1.0.0.tgz",
];
export const consumerWorkspaceText =
  "allowBuilds:\n  esbuild: true\n\nautoInstallPeers: false\nnodeLinker: hoisted\n";

export function createWorkspaceValidationManifest(rootManifest, candidateRecords) {
  const overrideEntries = candidateRecords.map((record) => [
    record.manifest.name,
    relativeArchiveSpecifier(workspaceStageDirectory, record.filename),
  ]);
  overrideEntries.push(["vite", reviewedViteVersion]);
  overrideEntries.sort(([left], [right]) => left.localeCompare(right));

  return {
    ...rootManifest,
    pnpm: {
      ...(rootManifest.pnpm ?? {}),
      overrides: Object.fromEntries(overrideEntries),
    },
  };
}

export function createFreshConsumerManifest({ targetRecords, archiveRecords }) {
  const targetByName = new Map(
    targetRecords.map((record) => [record.manifest.name, record]),
  );
  const dependencies = {};
  for (const packageName of targetPackageNames) {
    const record = targetByName.get(packageName);
    if (!record) throw new Error(`Missing packed target ${packageName}`);
    dependencies[packageName] = relativeArchiveSpecifier(
      consumerStageDirectory,
      record.filename,
    );
  }

  const overrides = Object.fromEntries(
    [...archiveRecords]
      .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
      .map((record) => [
        record.manifest.name,
        relativeArchiveSpecifier(consumerStageDirectory, record.filename),
      ]),
  );

  return {
    name: "marshal-attachments-packed-smoke",
    private: true,
    version: "0.0.0",
    type: "module",
    packageManager: "pnpm@10.32.1",
    dependencies,
    pnpm: { overrides },
  };
}

export function archiveReferencePaths(stageDirectory, filenames) {
  return [...filenames]
    .sort()
    .map((filename) => `${stageDirectory}/${filename}`);
}

export function stageDirectoryPath(root, stageDirectory) {
  return path.join(root, ...stageDirectory.split("/"));
}

function relativeArchiveSpecifier(stageDirectory, filename) {
  return `file:${stageDirectory}/${filename}`;
}
