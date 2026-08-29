import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertRuntimeOutputSchema,
  type CapabilityInvocationResult,
  type InvocationContext,
} from '@marshal/agent-runtime-core';
import type { MarkdownConversionResult } from '../src/content-to-markdown/index.js';
import { createAttachmentProvider } from '../src/provider/attachments.js';

const tempDirectories: string[] = [];
const context: InvocationContext = { principal: { id: 'agent', kind: 'agent' } };

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('attachment provider', () => {
  it('converts inline text and emits provenance plus a receipt', async () => {
    const provider = createAttachmentProvider();
    const [descriptor] = await provider.list(context);
    expect(descriptor?.outputSchema).toMatchObject({
      type: 'object',
      properties: expect.any(Object),
      additionalProperties: false,
    });

    const invocation = await provider.invoke('attachments.convert', {
      filePath: 'notes.txt',
      contentBase64: Buffer.from('hello runtime').toString('base64'),
      mimeType: 'text/plain',
    }, context);
    const output = invocation.output as { markdown: string; kind: string };
    expect(output.kind).toBe('text');
    expect(output.markdown).toContain('hello runtime');
    expect(invocation.provenance?.[0]?.uri).toBe('inline:notes.txt');
    expect(invocation.receipt).toMatchObject({ capability: 'attachments.convert' });
    assertRuntimeOutputSchema(invocation.output, descriptor!.outputSchema);
  });

  it('resolves an adapter-owned attachment handle before containment and conversion', async () => {
    const allowed = await createTempDirectory();
    const filePath = path.join(allowed, 'handled.txt');
    await fs.writeFile(filePath, 'resolved attachment handle');
    const provider = createAttachmentProvider({
      allowedRoots: [allowed],
      resolveAttachmentHandle: async (handle) => {
        expect(handle).toBe('attachment-1');
        return { filePath, mimeType: 'text/plain' };
      },
    });

    await expect(provider.invoke(
      'attachments.convert',
      { attachmentHandle: 'attachment-1' },
      context,
    )).resolves.toMatchObject({
      output: { markdown: expect.stringContaining('resolved attachment handle') },
    });
  });

  it('uses an injected transcription service for audio', async () => {
    const artifacts = await createTempDirectory();
    const transcribeAudio = vi.fn(async () => ({
      markdown: 'transcribed by host',
      text: 'transcribed by host',
      providerId: 'test-transcriber',
    }));
    const provider = createAttachmentProvider({
      artifactDirectory: artifacts,
      services: { audioTranscription: { transcribeAudio } },
    });
    const invocation = await provider.invoke('attachments.convert', {
      filePath: 'clip.mp3',
      contentBase64: Buffer.from('not-a-real-mp3').toString('base64'),
      mimeType: 'audio/mpeg',
    }, context);
    expect(transcribeAudio).toHaveBeenCalledOnce();
    expect((invocation.output as { markdown: string }).markdown).toContain('transcribed by host');
  });

  it('keeps sequential materialized sources isolated and preserves invocation evidence', async () => {
    const artifacts = await createTempDirectory();
    const transcribeAudio = vi.fn(async (request: { readonly filePath: string }) => {
      const text = await fs.readFile(request.filePath, 'utf8');
      return { markdown: text, text, providerId: 'test-transcriber' };
    });
    const provider = createAttachmentProvider({
      artifactDirectory: artifacts,
      services: { audioTranscription: { transcribeAudio } },
    });

    const first = await provider.invoke('attachments.convert', {
      filePath: 'clip.mp3',
      contentBase64: Buffer.from('first provider audio').toString('base64'),
      mimeType: 'audio/mpeg',
    }, context);
    const second = await provider.invoke('attachments.convert', {
      filePath: 'clip.mp3',
      contentBase64: Buffer.from('second provider audio').toString('base64'),
      mimeType: 'audio/mpeg',
    }, context);
    const firstOutput = first.output as MarkdownConversionResult;
    const secondOutput = second.output as MarkdownConversionResult;
    const firstPath = firstOutput.artifacts[0]!.path;
    const secondPath = secondOutput.artifacts[0]!.path;

    expect(firstPath).not.toBe(secondPath);
    await expect(fs.readFile(firstPath, 'utf8')).resolves.toBe('first provider audio');
    await expect(fs.readFile(secondPath, 'utf8')).resolves.toBe('second provider audio');
    expectInvocationEvidence(first, 'clip.mp3');
    expectInvocationEvidence(second, 'clip.mp3');
  });

  it('requires a configured artifact directory to stay within its artifact root', async () => {
    const artifactRoot = await createTempDirectory();
    const outside = await createTempDirectory();
    const provider = createAttachmentProvider({
      artifactDirectory: outside,
      artifactDirectoryRoot: artifactRoot,
    });

    await expect(provider.invoke('attachments.convert', {
      filePath: 'notes.txt',
      contentBase64: Buffer.from('outside root').toString('base64'),
      mimeType: 'text/plain',
    }, context)).rejects.toThrow(/containment root/i);
  });

  it('rejects linked components in artifact output paths', async (testContext) => {
    const parent = await createTempDirectory();
    const outside = await createTempDirectory();
    const link = path.join(parent, 'linked');
    try {
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        testContext.skip();
        return;
      }
      throw error;
    }
    const provider = createAttachmentProvider({
      artifactDirectory: path.join(link, 'artifacts'),
    });

    await expect(provider.invoke('attachments.convert', {
      filePath: 'notes.txt',
      contentBase64: Buffer.from('linked output').toString('base64'),
      mimeType: 'text/plain',
    }, context)).rejects.toThrow(/symbolic link|junction/i);
  });

  it('revalidates the artifact root on every invocation', async (testContext) => {
    const parent = await createTempDirectory();
    const outside = await createTempDirectory();
    const artifactDirectory = path.join(parent, 'artifacts');
    const provider = createAttachmentProvider({ artifactDirectory });

    await provider.invoke('attachments.convert', {
      filePath: 'notes.txt',
      contentBase64: Buffer.from('first invocation').toString('base64'),
      mimeType: 'text/plain',
    }, context);
    await fs.rm(artifactDirectory, { recursive: true, force: true });
    try {
      await fs.symlink(
        outside,
        artifactDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        testContext.skip();
        return;
      }
      throw error;
    }

    await expect(provider.invoke('attachments.convert', {
      filePath: 'notes.txt',
      contentBase64: Buffer.from('second invocation').toString('base64'),
      mimeType: 'text/plain',
    }, context)).rejects.toThrow(/symbolic link|junction/i);
  });

  it.each([
    {
      kind: 'audio',
      filePath: 'clip.mp3',
      mimeType: 'audio/mpeg',
      missingCapability: 'audio-transcription',
    },
    {
      kind: 'video',
      filePath: 'clip.mp4',
      mimeType: 'video/mp4',
      missingCapability: 'video-analysis',
    },
  ] as const)('returns a typed missing-provider result for $kind without modality services', async ({
    kind,
    filePath,
    mimeType,
    missingCapability,
  }) => {
    const artifacts = await createTempDirectory();
    const provider = createAttachmentProvider({ artifactDirectory: artifacts });
    const [descriptor] = await provider.list(context);
    const invocation = await provider.invoke('attachments.convert', {
      filePath,
      contentBase64: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]).toString('base64'),
      mimeType,
    }, context);
    const output = invocation.output as MarkdownConversionResult;

    expect(output).toMatchObject({
      kind,
      notes: ['No model-backed media analysis was produced for this media file.'],
      artifacts: [{
        kind,
        label: `${kind} source file`,
        mimeType,
      }],
      capabilityErrors: [{
        code: 'PROVIDER_MISSING',
        capability: missingCapability,
      }],
      analysisHandles: [],
    });
    expect(output.markdown).toContain('_No structured media metadata extracted._');
    expect(output.markdown).not.toContain('## Transcript');
    expect(output.markdown).not.toContain('## Analysis');
    expect(invocation.diagnostics).toEqual([
      expect.objectContaining({
        level: 'warning',
        code: 'PROVIDER_MISSING',
        details: { capability: missingCapability },
      }),
    ]);
    expectInvocationEvidence(invocation, filePath);
    assertRuntimeOutputSchema(output, descriptor!.outputSchema);
  });

  it('returns a typed missing-provider result when sparse PDF OCR has no image service', async () => {
    const provider = createAttachmentProvider();
    const [descriptor] = await provider.list(context);
    const invocation = await provider.invoke('attachments.convert', {
      filePath: 'scan.pdf',
      contentBase64: Buffer.from('%PDF-1.4\n% sparse scan\n%%EOF\n').toString('base64'),
      mimeType: 'application/pdf',
    }, context);
    const output = invocation.output as MarkdownConversionResult;

    expect(output).toMatchObject({
      kind: 'pdf',
      artifacts: [],
      capabilityErrors: [{
        code: 'PROVIDER_MISSING',
        capability: 'pdf-ocr',
      }],
      analysisHandles: [],
    });
    expect(output.markdown).toContain('_No PDF text could be extracted._');
    expect(output.notes).toContain('pdf-text-and-layout-heuristics');
    expect(invocation.diagnostics).toEqual([
      expect.objectContaining({
        level: 'warning',
        code: 'PROVIDER_MISSING',
        details: { capability: 'pdf-ocr' },
      }),
    ]);
    expectInvocationEvidence(invocation, 'scan.pdf');
    assertRuntimeOutputSchema(output, descriptor!.outputSchema);
  });

  it('returns an explicit unsupported result for an image without an image service', async () => {
    const provider = createAttachmentProvider();
    const [descriptor] = await provider.list(context);
    const invocation = await provider.invoke('attachments.convert', {
      filePath: 'scan.png',
      contentBase64: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x00,
      ]).toString('base64'),
      mimeType: 'image/png',
    }, context);
    const output = invocation.output as MarkdownConversionResult;

    expect(output).toMatchObject({
      kind: 'unsupported',
      notes: ['unsupported'],
      detectedMimeType: 'image/png',
      artifacts: [],
      capabilityErrors: [],
      analysisHandles: [],
    });
    expect(output.markdown).toContain('# Unsupported attachment: scan.png');
    expect(output.markdown).toContain('No inline content was extracted for this file type.');
    expect(invocation.diagnostics).toEqual([]);
    expectInvocationEvidence(invocation, 'scan.png');
    assertRuntimeOutputSchema(output, descriptor!.outputSchema);
  });

  it('allows regular files under configured roots and rejects paths outside them', async () => {
    const allowed = await createTempDirectory();
    const outside = await createTempDirectory();
    const insidePath = path.join(allowed, 'inside.txt');
    const outsidePath = path.join(outside, 'outside.txt');
    await fs.writeFile(insidePath, 'inside');
    await fs.writeFile(outsidePath, 'outside');
    const provider = createAttachmentProvider({ allowedRoots: [allowed] });
    const invocation = await provider.invoke('attachments.convert', { filePath: insidePath }, context);
    expect((invocation.output as { markdown: string }).markdown).toContain('inside');
    await expect(provider.invoke('attachments.convert', { filePath: outsidePath }, context)).rejects.toThrow(/outside every configured/i);
  });

  it('rejects a denied state subtree nested beneath an allowed workspace', async () => {
    const allowed = await createTempDirectory();
    const denied = path.join(allowed, '.runtime-state');
    await fs.mkdir(denied);
    const db = path.join(denied, 'memory.sqlite');
    await fs.writeFile(db, 'private state');
    const provider = createAttachmentProvider({ allowedRoots: [allowed], deniedRoots: [denied] });
    await expect(provider.invoke('attachments.convert', { filePath: db }, context)).rejects.toThrow(/denied root/i);
  });

  it('does not follow a symlink inside an allowed root', async (testContext) => {
    const allowed = await createTempDirectory();
    const outside = await createTempDirectory();
    const secret = path.join(outside, 'secret.txt');
    const link = path.join(allowed, 'linked');
    await fs.writeFile(secret, 'secret');
    try {
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        testContext.skip();
        return;
      }
      throw error;
    }
    const provider = createAttachmentProvider({ allowedRoots: [allowed] });
    await expect(provider.invoke('attachments.convert', { filePath: path.join(link, 'secret.txt') }, context)).rejects.toThrow(/symbolic link/i);
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-attachment-test-'));
  tempDirectories.push(directory);
  return directory;
}

function expectInvocationEvidence(
  invocation: CapabilityInvocationResult,
  sourceLabel: string,
): void {
  expect(invocation.provenance).toEqual([{
    source: 'marshal.attachments',
    uri: `inline:${sourceLabel}`,
    trust: 'unverified',
  }]);
  expect(invocation.receipt).toMatchObject({
    providerId: 'marshal.attachments',
    capability: 'attachments.convert',
    inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    completedAt: expect.any(String),
  });
}
