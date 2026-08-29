import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentRuntime, createAllowAllPermissionBroker } from '@marshal/runtime';
import { createAttachmentsSource } from '../src/index.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('createAttachmentsSource', () => {
  it('composes the public attachment source explicitly into a host', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-attachments-source-'));
    cleanup.push(root);
    const workspacePath = path.join(root, 'workspace');
    const protectedRoot = path.join(root, 'private');
    const filePath = path.join(workspacePath, 'notes.txt');
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(filePath, 'composed attachment source');

    const runtime = await createAgentRuntime({
      workspacePath,
      protectedLifecycleResultRoot: protectedRoot,
      permissionBroker: createAllowAllPermissionBroker(),
      providerSources: [createAttachmentsSource()],
    });

    try {
      expect(runtime.providers.map((provider) => provider.id)).toEqual(['marshal.attachments']);
      const execution = await runtime.kernel.execute({
        targetType: 'operation',
        target: 'attachments.convert',
        input: { filePath, mimeType: 'text/plain' },
      }, {
        sessionId: 'attachments-source-smoke',
      });

      expect(execution).toMatchObject({
        status: 'success',
        result: {
          output: {
            kind: 'text',
            markdown: expect.stringContaining('composed attachment source'),
          },
          provenance: [{
            source: 'marshal.attachments',
            uri: pathToFileURL(filePath).href,
            trust: 'authoritative',
          }],
          receipt: {
            providerId: 'marshal.attachments',
            capability: 'attachments.convert',
          },
        },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('contains default artifacts under stateRoot and keeps them after disposal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-attachments-artifacts-'));
    cleanup.push(root);
    const workspacePath = path.join(root, 'workspace');
    const protectedRoot = path.join(root, 'private');
    await fs.mkdir(workspacePath, { recursive: true });
    const runtime = await createAgentRuntime({
      workspacePath,
      protectedLifecycleResultRoot: protectedRoot,
      permissionBroker: createAllowAllPermissionBroker(),
      providerSources: [createAttachmentsSource({
        services: {
          audioTranscription: {
            async transcribeAudio(request) {
              const text = await fs.readFile(request.filePath, 'utf8');
              return { markdown: text, text, providerId: 'test-transcriber' };
            },
          },
        },
      })],
    });
    let artifactPaths: readonly string[] = [];

    try {
      const executions = await Promise.all([
        runtime.kernel.execute({
          targetType: 'operation',
          target: 'attachments.convert',
          input: {
            filePath: 'clip.mp3',
            contentBase64: Buffer.from('first facade audio').toString('base64'),
            mimeType: 'audio/mpeg',
          },
        }, { sessionId: 'attachments-artifacts-first' }),
        runtime.kernel.execute({
          targetType: 'operation',
          target: 'attachments.convert',
          input: {
            filePath: 'clip.mp3',
            contentBase64: Buffer.from('second facade audio').toString('base64'),
            mimeType: 'audio/mpeg',
          },
        }, { sessionId: 'attachments-artifacts-second' }),
      ]);
      artifactPaths = executions.map((execution) => {
        expect(execution.status).toBe('success');
        const output = execution.result?.output as {
          readonly artifacts: readonly [{ readonly path: string }];
        };
        return output.artifacts[0].path;
      });
      expect(new Set(artifactPaths)).toHaveLength(2);
      const canonicalStateRoot = await fs.realpath(runtime.stateRoot);
      for (const artifactPath of artifactPaths) {
        const canonicalArtifactPath = await fs.realpath(artifactPath);
        expect(isContained(canonicalStateRoot, canonicalArtifactPath)).toBe(true);
        expect(path.relative(canonicalStateRoot, canonicalArtifactPath))
          .toMatch(/^attachment-artifacts[\\/]+conversion-/);
      }
    } finally {
      await runtime.dispose();
    }

    await expect(fs.readFile(artifactPaths[0]!, 'utf8')).resolves.toBe('first facade audio');
    await expect(fs.readFile(artifactPaths[1]!, 'utf8')).resolves.toBe('second facade audio');
  });
});

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
