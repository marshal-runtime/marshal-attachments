import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const packagesRoot = path.join(repositoryRoot, "packages");
const reviewedBaseCommit = "ebdc6b48dfed4fb82dfb3800092b5793a70e2d74";
const providerRuntimeExports = ["createAttachmentProvider"];
const providerTypeExports = [
  "AttachmentHandleResolution",
  "AttachmentHandleResolver",
  "AttachmentProviderOptions",
];
const contentRuntimeExports = [
  "__internal",
  "convertAttachmentToMarkdown",
  "convertContentToMarkdown",
  "extractImageMetadataSummary",
  "isTextLikeAttachment",
  "renderPdfPageItems",
];
const contentTypeExports = [
  "AttachmentArtifact",
  "AttachmentConversionKind",
  "AttachmentConversionOptions",
  "AttachmentConversionResult",
  "AttachmentConversionServices",
  "AttachmentTranscriptionRequest",
  "AttachmentTranscriptionResult",
  "AttachmentVisionAnalysisRequest",
  "AttachmentVisionAnalysisResult",
  "ContentAnalysisHandle",
  "ImageAnalysisRequest",
  "ImageAnalysisResult",
  "ImageMetadataSummary",
  "MarkdownArtifact",
  "MarkdownCapabilityError",
  "MarkdownCapabilityErrorCode",
  "MarkdownConversionKind",
  "MarkdownConversionOptions",
  "MarkdownConversionResult",
  "MarkdownConversionServices",
  "MarkdownProviderCapability",
  "MediaAnalysisRequest",
  "MediaAnalysisResult",
  "MediaConversationRequest",
  "MediaConversationTurnResult",
];

test("records the exact pre-consolidation public surfaces", async () => {
  const publicApi = await readJson(path.join(repositoryRoot, "validation", "public-api.json"));
  assert.equal(publicApi.formatVersion, 1);
  assert.equal(publicApi.reviewedBaseCommit, reviewedBaseCommit);
  assert.deepEqual(publicApi.packages, {
    "@marshal/attachments": {
      version: "0.1.0",
      exports: ["."],
      runtimeExports: [
        "ATTACHMENTS_PACKAGE_DECLARATION",
        ...contentRuntimeExports,
        ...providerRuntimeExports,
        "createAttachmentsSource",
      ].sort(),
      typeExports: [
        ...contentTypeExports,
        ...providerTypeExports,
        "AttachmentsSourceOptions",
      ].sort(),
    },
    "@marshal/agent-runtime-provider-attachments": {
      version: "0.1.0",
      exports: ["."],
      runtimeExports: providerRuntimeExports,
      typeExports: providerTypeExports,
    },
    "@marshal/content-to-markdown": {
      version: "1.0.0",
      exports: ["."],
      runtimeExports: contentRuntimeExports,
      typeExports: contentTypeExports,
    },
  });
  assert.deepEqual(publicApi.canonicalSubpaths, {
    "@marshal/attachments/provider": {
      compatibilityPackage: "@marshal/agent-runtime-provider-attachments",
    },
    "@marshal/attachments/content-to-markdown": {
      compatibilityPackage: "@marshal/content-to-markdown",
    },
  });
});

test("reverses internal dependencies without a package cycle", async () => {
  const attachments = await packageManifest("attachments");
  const provider = await packageManifest("agent-runtime-provider-attachments");
  const content = await packageManifest("content-to-markdown");

  assert.deepEqual(provider.dependencies, {
    "@marshal/attachments": "workspace:*",
  });
  assert.deepEqual(content.dependencies, {
    "@marshal/attachments": "workspace:*",
  });
  assert.equal(attachments.dependencies["@marshal/agent-runtime-provider-attachments"], undefined);
  assert.equal(attachments.dependencies["@marshal/content-to-markdown"], undefined);
  assert.deepEqual(Object.keys(attachments.exports), [
    ".",
    "./provider",
    "./content-to-markdown",
  ]);
  assert.deepEqual(Object.keys(provider.exports), ["."]);
  assert.deepEqual(Object.keys(content.exports), ["."]);
});

test("keeps both legacy source trees shim-only", async () => {
  await assertShim(
    "agent-runtime-provider-attachments",
    "export * from '@marshal/attachments/provider';\n",
  );
  await assertShim(
    "content-to-markdown",
    "export * from '@marshal/attachments/content-to-markdown';\n",
  );
});

test("owns each implementation file only under the canonical package", async () => {
  const providerFiles = await relativeFiles(
    path.join(packagesRoot, "attachments", "src", "provider"),
  );
  assert.deepEqual(providerFiles, ["attachments.ts", "index.ts"]);

  const contentFiles = await relativeFiles(
    path.join(packagesRoot, "attachments", "src", "content-to-markdown"),
  );
  assert.deepEqual(contentFiles, [
    "detection.ts",
    "docxMath.ts",
    "index.ts",
    "markdown.ts",
    "pdf-js-default.d.ts",
    "pdf-parse.d.ts",
    "pdfParseDefault.ts",
    "turndown-plugin-gfm.d.ts",
    "types.ts",
    "xml.ts",
  ]);

  const canonicalSource = await readSourceTree(
    path.join(packagesRoot, "attachments", "src"),
  );
  assert.doesNotMatch(
    canonicalSource,
    /@marshal\/(?:agent-runtime-provider-attachments|content-to-markdown)/,
  );
});

async function assertShim(directory, expectedSource) {
  const sourceRoot = path.join(packagesRoot, directory, "src");
  assert.deepEqual(await relativeFiles(sourceRoot), ["index.ts"]);
  const source = normalizeNewlines(await readFile(path.join(sourceRoot, "index.ts"), "utf8"));
  assert.equal(source, expectedSource);
}

async function packageManifest(directory) {
  return readJson(path.join(packagesRoot, directory, "package.json"));
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function relativeFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await relativeFiles(root, entryPath));
    else files.push(path.relative(root, entryPath).replaceAll("\\", "/"));
  }
  return files.sort();
}

async function readSourceTree(root) {
  const files = await relativeFiles(root);
  return Promise.all(
    files.map((relativePath) => readFile(path.join(root, ...relativePath.split("/")), "utf8")),
  ).then((values) => values.join("\n"));
}

function normalizeNewlines(value) {
  return value.replaceAll("\r\n", "\n");
}
