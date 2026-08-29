import { describe, expect, it } from 'vitest';
import * as root from '../src/index.js';
import * as content from '../src/content-to-markdown/index.js';
import * as provider from '../src/provider/index.js';

describe('canonical attachment subpaths', () => {
  it('exposes the provider API through the root and provider subpath', () => {
    expect(Object.keys(provider).sort()).toEqual(['createAttachmentProvider']);
    expect(root.createAttachmentProvider).toBe(provider.createAttachmentProvider);
  });

  it('exposes the conversion API through the root and conversion subpath', () => {
    expect(Object.keys(content).sort()).toEqual([
      '__internal',
      'convertAttachmentToMarkdown',
      'convertContentToMarkdown',
      'extractImageMetadataSummary',
      'isTextLikeAttachment',
      'renderPdfPageItems',
    ]);
    expect(root.__internal).toBe(content.__internal);
    expect(root.convertAttachmentToMarkdown).toBe(content.convertAttachmentToMarkdown);
    expect(root.convertContentToMarkdown).toBe(content.convertContentToMarkdown);
    expect(root.extractImageMetadataSummary).toBe(content.extractImageMetadataSummary);
    expect(root.isTextLikeAttachment).toBe(content.isTextLikeAttachment);
    expect(root.renderPdfPageItems).toBe(content.renderPdfPageItems);
  });
});
