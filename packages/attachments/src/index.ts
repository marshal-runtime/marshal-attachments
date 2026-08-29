import { join } from 'node:path';
import {
  createAttachmentProvider,
  type AttachmentProviderOptions,
} from '@marshal/agent-runtime-provider-attachments';
import type { RuntimeHostProviderSource } from '@marshal/runtime';

export * from '@marshal/agent-runtime-provider-attachments';
export * from '@marshal/content-to-markdown';
export * from './packageDeclaration.js';

export interface AttachmentsSourceOptions extends Omit<
  AttachmentProviderOptions,
  'allowedRoots' | 'deniedRoots' | 'artifactDirectory' | 'artifactDirectoryRoot'
> {
  readonly allowedRoots?: readonly string[];
  readonly deniedRoots?: readonly string[];
  readonly artifactDirectory?: string;
}

export function createAttachmentsSource(
  options: AttachmentsSourceOptions = {},
): RuntimeHostProviderSource {
  return (context) => {
    const usesDefaultArtifactDirectory = options.artifactDirectory === undefined;
    return createAttachmentProvider({
      ...options,
      allowedRoots: options.allowedRoots ?? [context.workspacePath],
      deniedRoots: options.deniedRoots ?? [context.stateRoot],
      artifactDirectory:
        options.artifactDirectory ?? join(context.stateRoot, 'attachment-artifacts'),
      artifactDirectoryRoot: usesDefaultArtifactDirectory ? context.stateRoot : undefined,
    });
  };
}
