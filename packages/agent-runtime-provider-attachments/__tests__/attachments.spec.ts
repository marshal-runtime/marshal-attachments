import { describe, expect, it } from 'vitest';
import * as canonical from '@marshal/attachments/provider';
import * as legacy from '../src/index.js';

describe('@marshal/agent-runtime-provider-attachments compatibility', () => {
  it('re-exports the canonical provider without a wrapper implementation', () => {
    expect(Object.keys(legacy).sort()).toEqual(['createAttachmentProvider']);
    expect(legacy.createAttachmentProvider).toBe(canonical.createAttachmentProvider);
  });

  it('preserves inline conversion behavior', async () => {
    const provider = legacy.createAttachmentProvider();
    const context = { principal: { id: 'compatibility-test', kind: 'agent' as const } };
    const invocation = await provider.invoke('attachments.convert', {
      filePath: 'compatibility.txt',
      contentBase64: Buffer.from('legacy provider compatibility').toString('base64'),
      mimeType: 'text/plain',
    }, context);

    expect(invocation).toMatchObject({
      output: {
        kind: 'text',
        markdown: expect.stringContaining('legacy provider compatibility'),
      },
      receipt: {
        providerId: 'marshal.attachments',
        capability: 'attachments.convert',
      },
    });
  });
});
