import { join } from 'node:path';
import {
  createAttachmentProvider,
  type AttachmentProviderOptions,
} from './provider/index.js';
import type { RuntimeHostProviderSource } from '@marshal/runtime';

export * from './provider/index.js';
export * from './content-to-markdown/index.js';
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
