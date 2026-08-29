import type {
  RuntimeExtensionConfiguration,
  RuntimeExtensionModule,
  RuntimeServiceAccessor,
  RuntimeServiceToken,
} from '@marshal/runtime';
import { join } from 'node:path';
import {
  createAttachmentProvider,
  type AttachmentHandleResolver,
} from '../packages/attachments/src/provider/index.js';
import type {
  MarkdownConversionServices,
} from '../packages/attachments/src/content-to-markdown/index.js';

export const ATTACHMENTS_RUNTIME_HOST_SERVICE_ID =
  '@marshal/attachments:host' as const;

export interface AttachmentsRuntimeHostService {
  readonly resolveAttachmentHandle?: AttachmentHandleResolver;
  readonly conversionServices?: MarkdownConversionServices;
}

export const ATTACHMENTS_RUNTIME_HOST_SERVICE =
  Symbol.for(
    ATTACHMENTS_RUNTIME_HOST_SERVICE_ID,
  ) as RuntimeServiceToken<AttachmentsRuntimeHostService>;

const RUNTIME_HOST_CONTEXT_SERVICE_ID =
  '@marshal/agent-runtime-host:context' as const;

interface RuntimeHostContextService {
  snapshot(): {
    readonly workspacePath: string;
    readonly stateRoot: string;
  };
}

const RUNTIME_HOST_CONTEXT_SERVICE =
  Symbol.for(
    RUNTIME_HOST_CONTEXT_SERVICE_ID,
  ) as RuntimeServiceToken<RuntimeHostContextService>;

type AttachmentsRuntimeExtensionConfiguration = RuntimeExtensionConfiguration & {
  readonly allowedRoots?: readonly string[];
  readonly deniedRoots?: readonly string[];
  readonly artifactDirectory?: string;
  readonly artifactDirectoryRoot?: string;
  readonly maxInputBytes?: number;
  readonly maxArchiveEntries?: number;
  readonly maxArchiveDepth?: number;
};

const extension: RuntimeExtensionModule<AttachmentsRuntimeExtensionConfiguration> = {
  activate(context) {
    const configuration = readConfiguration(
      context.configuration,
      context.services.tryGet(RUNTIME_HOST_CONTEXT_SERVICE)?.snapshot(),
    );

    return {
      capabilityProviders: [createAttachmentProvider({
        ...configuration,
        services: createLiveConversionServices(context.services),
        resolveAttachmentHandle: createLiveAttachmentHandleResolver(context.services),
      })],
    };
  },
};

export const activate: typeof extension.activate = (context) =>
  extension.activate(context);

function readConfiguration(
  configuration: Readonly<AttachmentsRuntimeExtensionConfiguration>,
  hostContext: ReturnType<RuntimeHostContextService['snapshot']> | undefined,
) {
  const allowedRoots = stringArray(configuration, 'allowedRoots');
  const deniedRoots = stringArray(configuration, 'deniedRoots');
  const artifactDirectory = optionalString(configuration, 'artifactDirectory');
  const artifactDirectoryRoot = optionalString(configuration, 'artifactDirectoryRoot');
  const usesHostArtifactDirectory = artifactDirectory === undefined && hostContext !== undefined;
  return {
    allowedRoots: allowedRoots ?? (
      hostContext ? Object.freeze([hostContext.workspacePath]) : undefined
    ),
    deniedRoots: deniedRoots ?? (
      hostContext ? Object.freeze([hostContext.stateRoot]) : undefined
    ),
    artifactDirectory: artifactDirectory ?? (
      hostContext ? join(hostContext.stateRoot, 'attachment-artifacts') : undefined
    ),
    artifactDirectoryRoot: artifactDirectoryRoot ?? (
      usesHostArtifactDirectory ? hostContext.stateRoot : undefined
    ),
    maxInputBytes: positiveInteger(configuration, 'maxInputBytes'),
    maxArchiveEntries: positiveInteger(configuration, 'maxArchiveEntries'),
    maxArchiveDepth: nonNegativeInteger(configuration, 'maxArchiveDepth'),
  };
}

function createLiveAttachmentHandleResolver(
  services: RuntimeServiceAccessor,
): AttachmentHandleResolver {
  return async (handle, invocationContext) => {
    const host = services.tryGet(ATTACHMENTS_RUNTIME_HOST_SERVICE);
    if (!host?.resolveAttachmentHandle) {
      throw new Error('Attachment handles are unavailable in this runtime adapter.');
    }
    return host.resolveAttachmentHandle(handle, invocationContext);
  };
}

function createLiveConversionServices(
  services: RuntimeServiceAccessor,
): MarkdownConversionServices {
  return Object.freeze({
    get images() {
      return services.tryGet(ATTACHMENTS_RUNTIME_HOST_SERVICE)
        ?.conversionServices?.images;
    },
    get documentImages() {
      return services.tryGet(ATTACHMENTS_RUNTIME_HOST_SERVICE)
        ?.conversionServices?.documentImages;
    },
    get audioTranscription() {
      return services.tryGet(ATTACHMENTS_RUNTIME_HOST_SERVICE)
        ?.conversionServices?.audioTranscription;
    },
    get audioAnalysis() {
      return services.tryGet(ATTACHMENTS_RUNTIME_HOST_SERVICE)
        ?.conversionServices?.audioAnalysis;
    },
    get videoAnalysis() {
      return services.tryGet(ATTACHMENTS_RUNTIME_HOST_SERVICE)
        ?.conversionServices?.videoAnalysis;
    },
  });
}

function stringArray(
  configuration: RuntimeExtensionConfiguration,
  key: string,
): readonly string[] | undefined {
  const value = configuration[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${key} must be an array of strings.`);
  }
  return Object.freeze([...value]);
}

function optionalString(
  configuration: RuntimeExtensionConfiguration,
  key: string,
): string | undefined {
  const value = configuration[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${key} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(
  configuration: RuntimeExtensionConfiguration,
  key: string,
): number | undefined {
  const value = configuration[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${key} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(
  configuration: RuntimeExtensionConfiguration,
  key: string,
): number | undefined {
  const value = configuration[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${key} must be a non-negative integer.`);
  }
  return value;
}
