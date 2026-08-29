import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const generatedSegments = new Set(["coverage", "dist", "node_modules"]);

export const expectedSourceProvenance = {
  formatVersion: 2,
  sourceRepository: "marshal-agent-runtime",
  sourceCommit: "1cb5f31105790c7318fd4c6ac1bc418e87240cc8",
  hashFormat: "git-sha1",
  reviewedBaseCommit: "ebdc6b48dfed4fb82dfb3800092b5793a70e2d74",
  reviewedBaseTree: "dc1f3f3b61b23964452f6f7cc9ae2774779e0b08",
  reviewedBasePackages: {
    "packages/attachments": {
      tree: "a6051fc73f938fbbec18dc5bf32a282e879a0bb2",
      extractedTree: "76c13ae0c7e4121ca7949f27741c1e94f1dda30d",
      target: "packages/attachments",
      transforms: [
        {
          path: "package.json",
          sourceBlob: "1e3eddc2fd8e33890cdd112f765667e3ce03c628",
          extractedBlob: "afba1329435409cbf9712adfa81f1e613f4ccbfa",
        },
        {
          path: "vitest.config.ts",
          sourceBlob: "5f5659db6c5193068d6333a28965abbb255fdb4f",
          extractedBlob: "61db4baef94592b920e9be33cae12363d64b0d78",
        },
      ],
    },
    "packages/agent-runtime-provider-attachments": {
      tree: "580946e41e910fd45a1f295c94bcd77fb8bd7edc",
      extractedTree: "989a10061e11b919c5e4efc44aa70f47ac16c013",
      target: "packages/agent-runtime-provider-attachments",
      transforms: [
        {
          path: "package.json",
          sourceBlob: "20a2918f17d1edfb1f000c2515fda2b820b3d5dd",
          extractedBlob: "f1e0d67394bd52c1de11d23f648fcf8d118c931d",
        },
      ],
    },
    "packages/content-to-markdown": {
      tree: "c8a74d1e5a80316b3c826b1fda125505e677ebaa",
      extractedTree: "665980afbc27de14d87c301aecb62ec551be8573",
      target: "packages/content-to-markdown",
      transforms: [
        {
          path: "package.json",
          sourceBlob: "469bc3a77da7bc72f103be504d7cb54f67090b86",
          extractedBlob: "897a9d3564a1808457b6b5bca7dd9b8f44dfa2b4",
        },
        {
          path: "vitest.config.ts",
          sourceBlob: "7b49350006b7b3a4dcd1cc5288c1c06aee738895",
          extractedBlob: "bd71fd210cd3e0332f5171a4a31ce69fa76fcc6f",
        },
      ],
    },
  },
  consolidation: {
    canonicalOwner: "@marshal/attachments",
    currentPackageTrees: {
      "packages/attachments": "38e87c32205808feb008a416f2d3e9ef02937397",
      "packages/agent-runtime-provider-attachments": "9da398f2716274053262622a70a10ae0814e9d5b",
      "packages/content-to-markdown": "a760d4f02c9774847215455833192831eef33ae8",
    },
    implementationModules: {
      provider: {
        sourcePackage: "packages/agent-runtime-provider-attachments",
        sourceTree: "da124ed62e08f2024c382b6fba6b47ef9315e353",
        target: "packages/agent-runtime-provider-attachments/src",
        currentTree: "da124ed62e08f2024c382b6fba6b47ef9315e353",
        transforms: [],
      },
      contentToMarkdown: {
        sourcePackage: "packages/content-to-markdown",
        sourceTree: "fb514e354ac5429f28557f94137e6f7df65c8bf2",
        target: "packages/content-to-markdown/src",
        currentTree: "fb514e354ac5429f28557f94137e6f7df65c8bf2",
        transforms: [],
      },
    },
    legacyShims: {
      "@marshal/agent-runtime-provider-attachments": "@marshal/attachments/provider",
      "@marshal/content-to-markdown": "@marshal/attachments/content-to-markdown",
    },
  },
};

export async function verifySourceProvenance({ repositoryRoot, provenance } = {}) {
  const metadata = provenance ?? JSON.parse(
    await readFile(path.join(repositoryRoot, "source-provenance.json"), "utf8"),
  );
  const failures = [];
  const evidence = [];

  if (!sameJson(metadata, expectedSourceProvenance)) {
    failures.push("source-provenance.json differs from the reviewed consolidation provenance");
  }

  for (
    const [packagePath, expectedTree]
    of Object.entries(expectedSourceProvenance.consolidation.currentPackageTrees)
  ) {
    const packageRoot = path.join(repositoryRoot, ...packagePath.split("/"));
    const result = await hashPackageTrees(packageRoot, [], failures);
    if (result.currentTree !== expectedTree) {
      failures.push(
        `${packagePath}: current tree is ${result.currentTree}; expected ${expectedTree}`,
      );
    }
    evidence.push({
      label: packagePath,
      currentTree: result.currentTree,
      transformedFiles: 0,
    });
  }

  for (
    const [moduleName, expected]
    of Object.entries(expectedSourceProvenance.consolidation.implementationModules)
  ) {
    const moduleRoot = path.join(repositoryRoot, ...expected.target.split("/"));
    const transforms = expected.transforms.map((transform) => ({
      path: transform.path,
      sourceBlob: transform.sourceBlob,
      currentBlob: transform.currentBlob,
    }));
    const result = await hashPackageTrees(moduleRoot, transforms, failures);
    if (result.currentTree !== expected.currentTree) {
      failures.push(
        `${expected.target}: current tree is ${result.currentTree}; expected ${expected.currentTree}`,
      );
    }
    if (result.sourceTree !== expected.sourceTree) {
      failures.push(
        `${expected.target}: reconstructed source tree is ${result.sourceTree}; `
        + `expected ${expected.sourceTree}`,
      );
    }
    evidence.push({
      label: `${moduleName} implementation`,
      currentTree: result.currentTree,
      sourceTree: result.sourceTree,
      transformedFiles: transforms.length,
    });
  }

  return { failures: [...new Set(failures)], evidence };
}

async function hashPackageTrees(packageRoot, transforms, failures) {
  const transformsByPath = new Map(transforms.map((entry) => [entry.path, entry]));
  const seenTransforms = new Set();

  async function walk(directory, relativeDirectory = "") {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => !generatedSegments.has(entry.name))
      .map((entry) => ({
        entry,
        sortKey: Buffer.from(`${entry.name}${entry.isDirectory() ? "/" : ""}`, "utf8"),
      }))
      .sort((left, right) => Buffer.compare(left.sortKey, right.sortKey));
    const currentEntries = [];
    const sourceEntries = [];

    for (const { entry } of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isSymbolicLink()) {
        failures.push(`${relativePath}: symbolic links cannot participate in source provenance`);
        continue;
      }

      let mode;
      let extractedObject;
      let sourceObject;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        mode = "40000";
        const child = await walk(absolutePath, relativePath);
        extractedObject = child.currentTree;
        sourceObject = child.sourceTree;
      } else if (entry.isFile()) {
        mode = "100644";
        const bytes = await readFile(absolutePath);
        extractedObject = gitObjectId("blob", bytes);
        const transform = transformsByPath.get(relativePath);
        if (transform) {
          seenTransforms.add(relativePath);
          if (extractedObject !== transform.currentBlob) {
            failures.push(
              `${relativePath}: current blob is ${extractedObject}; expected ${transform.currentBlob}`,
            );
          }
          sourceObject = transform.sourceBlob;
        } else {
          sourceObject = extractedObject;
        }
      } else {
        failures.push(`${relativePath}: unsupported filesystem entry`);
        continue;
      }

      currentEntries.push(treeEntry(mode, entry.name, extractedObject));
      sourceEntries.push(treeEntry(mode, entry.name, sourceObject));
    }

    return {
      currentTree: gitObjectId("tree", Buffer.concat(currentEntries)),
      sourceTree: gitObjectId("tree", Buffer.concat(sourceEntries)),
    };
  }

  const result = await walk(packageRoot);
  for (const transform of transforms) {
    if (!seenTransforms.has(transform.path)) {
      failures.push(`${transform.path}: declared provenance transform is missing`);
    }
  }
  return result;
}

function treeEntry(mode, name, objectId) {
  return Buffer.concat([
    Buffer.from(`${mode} ${name}\0`, "utf8"),
    Buffer.from(objectId, "hex"),
  ]);
}

function gitObjectId(type, content) {
  return createHash("sha1")
    .update(`${type} ${content.length}\0`, "utf8")
    .update(content)
    .digest("hex");
}

function sameJson(left, right) {
  return JSON.stringify(sortObject(left)) === JSON.stringify(sortObject(right));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortObject(child)]),
  );
}
