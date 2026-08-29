import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  convertContentToMarkdown,
  type MarkdownConversionServices,
} from '../content-to-markdown/index.js';
import type {
  CapabilityDescriptor,
  CapabilityProvider,
  InvocationContext,
  JsonSchema,
} from '@marshal/agent-runtime-core';
import {
  PROTOCOL_VERSION,
  assertRecord,
  createProvider,
  initializeSafeDirectory,
  isContained,
  optionalString,
  requireString,
  result,
} from '@marshal/agent-runtime-provider-kit';

export interface AttachmentProviderOptions {
  /** Filesystem roots from which path-based inputs may be read. Empty disables path reads. */
  readonly allowedRoots?: readonly string[];
  /** Subtrees that must remain unreadable even when nested under an allowed root. */
  readonly deniedRoots?: readonly string[];
  /** Optional destination used by converters for extracted images and other derived files. */
  readonly artifactDirectory?: string;
  /** Optional canonical root that artifactDirectory must remain within. */
  readonly artifactDirectoryRoot?: string;
  readonly services?: MarkdownConversionServices;
  readonly maxInputBytes?: number;
  readonly maxArchiveEntries?: number;
  readonly maxArchiveDepth?: number;
  readonly providerId?: string;
  readonly resolveAttachmentHandle?: AttachmentHandleResolver;
}

export interface AttachmentHandleResolution {
  readonly filePath: string;
  readonly contentBase64?: string;
  readonly mimeType?: string;
}

export type AttachmentHandleResolver = (
  handle: string,
  context: InvocationContext,
) => Promise<AttachmentHandleResolution>;

const ATTACHMENT_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: [
    'kind', 'markdown', 'sourceLabel', 'notes', 'artifacts',
    'capabilityErrors', 'analysisHandles',
  ],
  properties: {
    kind: {
      enum: [
        'text', 'html', 'pdf', 'docx', 'spreadsheet', 'presentation',
        'archive', 'audio', 'video', 'epub', 'unsupported',
      ],
    },
    markdown: { type: 'string', maxLength: 268_435_456 },
    sourceLabel: { type: 'string', maxLength: 4_096 },
    notes: { type: 'array', maxItems: 1_000_000, items: { type: 'string', maxLength: 1_000_000 } },
    detectedMimeType: { type: 'string', maxLength: 255 },
    artifacts: {
      type: 'array',
      maxItems: 1_000_000,
      items: { $ref: '#/$defs/artifact' },
    },
    metadata: { $ref: '#/$defs/dynamicMetadata' },
    capabilityErrors: {
      type: 'array',
      maxItems: 1_000_000,
      items: { $ref: '#/$defs/capabilityError' },
    },
    analysisHandles: {
      type: 'array',
      maxItems: 1_000_000,
      items: { $ref: '#/$defs/analysisHandle' },
    },
  },
  additionalProperties: false,
  $defs: {
    dynamicMetadata: {
      type: 'object',
      maxProperties: 256,
      additionalProperties: {},
    },
    artifact: {
      type: 'object',
      required: ['kind', 'path', 'label'],
      properties: {
        kind: { enum: ['image', 'page-image', 'audio', 'video', 'derived', 'other'] },
        path: { type: 'string', maxLength: 32_768 },
        label: { type: 'string', maxLength: 4_096 },
        mimeType: { type: 'string', maxLength: 255 },
      },
      additionalProperties: false,
    },
    capabilityError: {
      type: 'object',
      required: ['code', 'capability', 'message'],
      properties: {
        code: { enum: ['PROVIDER_MISSING', 'PROVIDER_UNAVAILABLE', 'MODALITY_UNSUPPORTED', 'ANALYSIS_FAILED'] },
        capability: {
          enum: [
            'image-analysis', 'document-image-analysis', 'audio-transcription',
            'audio-analysis', 'video-analysis', 'pdf-ocr',
          ],
        },
        message: { type: 'string', maxLength: 20_000 },
        providerId: { type: 'string', maxLength: 1_024 },
      },
      additionalProperties: false,
    },
    analysisHandle: {
      type: 'object',
      required: ['id', 'providerId', 'capability', 'sourceLabel', 'state'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 1_024 },
        providerId: { type: 'string', minLength: 1, maxLength: 1_024 },
        capability: { enum: ['audio-analysis', 'video-analysis'] },
        sourceLabel: { type: 'string', maxLength: 4_096 },
        state: { $ref: '#/$defs/dynamicMetadata' },
      },
      additionalProperties: false,
    },
  },
};

const DESCRIPTOR: CapabilityDescriptor = {
  protocolVersion: PROTOCOL_VERSION,
  name: 'attachments.convert',
  version: '1.0.0',
  description: 'Convert an attachment to markdown using host-injected modality providers when needed.',
  tags: ['attachments', 'markdown', 'documents', 'multimodal'],
  permissions: [{ permission: 'attachments.read', scope: 'runtime', risk: 'medium' }],
  inputSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string' },
      attachmentHandle: { type: 'string' },
      contentBase64: { type: 'string' },
      mimeType: { type: 'string' },
    },
    anyOf: [{ required: ['filePath'] }, { required: ['attachmentHandle'] }],
    additionalProperties: false,
  },
  outputSchema: ATTACHMENT_OUTPUT_SCHEMA,
};

export function createAttachmentProvider(options: AttachmentProviderOptions = {}): CapabilityProvider {
  const providerId = options.providerId ?? 'marshal.attachments';
  const maxInputBytes = options.maxInputBytes ?? 64 * 1024 * 1024;
  if (maxInputBytes < 1) throw new Error('maxInputBytes must be positive.');
  const rootsPromise = initializeRoots(options.allowedRoots ?? []);
  const deniedRootsPromise = initializeRoots(options.deniedRoots ?? [], true);

  return createProvider(providerId, [DESCRIPTOR], async (name, rawInput, context) => {
    const supplied = assertRecord(rawInput);
    const attachmentHandle = optionalString(supplied, 'attachmentHandle', 4_096);
    const resolved = attachmentHandle
      ? await resolveAttachmentHandle(attachmentHandle, context, options.resolveAttachmentHandle)
      : undefined;
    const input = { ...supplied, ...(resolved ?? {}) };
    const requestedPath = requireString(input, 'filePath', { maxLength: 4_096 });
    const mimeType = optionalString(input, 'mimeType', 255);
    const inline = optionalString(input, 'contentBase64', Math.ceil(maxInputBytes * 4 / 3) + 4);
    let content: Buffer;
    let sourcePath: string | undefined;

    if (inline !== undefined) {
      if (!isCanonicalBase64(inline)) throw new Error('contentBase64 is not valid canonical base64.');
      content = Buffer.from(inline, 'base64');
    } else {
      const roots = await rootsPromise;
      const deniedRoots = await deniedRootsPromise;
      if (roots.length === 0) {
        throw new Error('Path-based attachment reads are disabled; supply contentBase64.');
      }

      sourcePath = await resolveAllowedFile(requestedPath, roots, deniedRoots);
      const stat = await fs.stat(sourcePath);
      if (stat.size > maxInputBytes) throw new Error(`Attachment exceeds the ${maxInputBytes} byte limit.`);
      content = await fs.readFile(sourcePath);
    }
    if (content.length > maxInputBytes) throw new Error(`Attachment exceeds the ${maxInputBytes} byte limit.`);
    const artifactDirectory = options.artifactDirectory
      ? await initializeDirectory(options.artifactDirectory, options.artifactDirectoryRoot)
      : undefined;

    const converted = await convertContentToMarkdown(requestedPath, content, {
      mimeType,
      sourcePath,
      artifactDirectory,
      services: options.services,
      maxArchiveEntries: options.maxArchiveEntries,
      maxArchiveDepth: options.maxArchiveDepth,
    });
    const output = stripUndefined(converted) as typeof converted;
    return result(output, providerId, name, rawInput, context, {
      diagnostics: converted.capabilityErrors.map((error) => ({
        level: 'warning' as const,
        code: error.code,
        message: error.message,
        details: { capability: error.capability, providerId: error.providerId },
      })),
      artifacts: converted.artifacts.map((artifact, index) => ({
        id: `attachment-derived-${index + 1}`,
        kind: artifact.kind,
        uri: toFileUri(artifact.path),
        mediaType: artifact.mimeType,
        metadata: { label: artifact.label },
      })),
      provenance: [{
        source: providerId,
        uri: sourcePath ? toFileUri(sourcePath) : `inline:${requestedPath}`,
        trust: sourcePath ? 'authoritative' : 'unverified',
      }],
    });
  });
}

async function resolveAttachmentHandle(
  handle: string,
  context: InvocationContext,
  resolver: AttachmentHandleResolver | undefined,
): Promise<AttachmentHandleResolution> {
  if (!resolver) {
    throw new Error('Attachment handles are unavailable in this runtime adapter.');
  }
  const resolved = await resolver(handle, context);
  if (!resolved || typeof resolved.filePath !== 'string' || !resolved.filePath.trim()) {
    throw new Error('Attachment handle resolver returned no usable filePath.');
  }
  return resolved;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, stripUndefined(child)]),
  );
}

async function initializeRoots(roots: readonly string[], create = false): Promise<readonly string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    if (!path.isAbsolute(root)) throw new Error('Every attachment root must be absolute.');
    if (create) await fs.mkdir(root, { recursive: true });
    const stat = await fs.lstat(root);
    if (!stat.isDirectory()) throw new Error(`Attachment root is not a directory: ${root}`);
    resolved.push(await fs.realpath(root));
  }
  return resolved;
}

async function initializeDirectory(
  directory: string,
  containmentRoot: string | undefined,
): Promise<string> {
  return initializeSafeDirectory(directory, 'artifactDirectory', containmentRoot);
}

async function resolveAllowedFile(
  requestedPath: string,
  roots: readonly string[],
  deniedRoots: readonly string[],
): Promise<string> {
  if (!path.isAbsolute(requestedPath)) throw new Error('Path-based attachment filePath must be absolute.');
  const absolute = path.resolve(requestedPath);
  const matchingRoot = roots.find((root) => isContained(root, absolute));
  if (!matchingRoot) throw new Error('Attachment path is outside every configured allowed root.');
  const relative = path.relative(matchingRoot, absolute);
  let current = matchingRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed in attachment paths.');
  }
  const real = await fs.realpath(absolute);
  if (!isContained(matchingRoot, real)) throw new Error('Attachment path escaped its allowed root.');
  if (deniedRoots.some((root) => isContained(root, real))) {
    throw new Error('Attachment path is inside a configured denied root.');
  }
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error('Attachment path is not a regular file.');
  return real;
}

function isCanonicalBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function toFileUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}
