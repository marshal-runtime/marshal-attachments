import { describe, expect, it } from 'vitest';
import * as canonical from '@marshal/attachments/content-to-markdown';
import * as legacy from '../src/index.js';

describe('@marshal/content-to-markdown compatibility', () => {
  it('re-exports the canonical converter without a wrapper implementation', () => {
    expect(Object.keys(legacy).sort()).toEqual([
      '__internal',
      'convertAttachmentToMarkdown',
      'convertContentToMarkdown',
      'extractImageMetadataSummary',
      'isTextLikeAttachment',
      'renderPdfPageItems',
    ]);
    expect(legacy.__internal).toBe(canonical.__internal);
    expect(legacy.convertAttachmentToMarkdown).toBe(canonical.convertAttachmentToMarkdown);
    expect(legacy.convertContentToMarkdown).toBe(canonical.convertContentToMarkdown);
    expect(legacy.extractImageMetadataSummary).toBe(canonical.extractImageMetadataSummary);
    expect(legacy.isTextLikeAttachment).toBe(canonical.isTextLikeAttachment);
    expect(legacy.renderPdfPageItems).toBe(canonical.renderPdfPageItems);
  });

  it('preserves plain-text conversion behavior', async () => {
    const converted = await legacy.convertContentToMarkdown(
      'compatibility.txt',
      Buffer.from('legacy converter compatibility'),
      { mimeType: 'text/plain' },
    );

    expect(converted).toMatchObject({
      kind: 'text',
      sourceLabel: 'compatibility.txt',
      markdown: expect.stringContaining('legacy converter compatibility'),
      capabilityErrors: [],
      analysisHandles: [],
    });
  });
});
