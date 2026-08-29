import * as Attachments from '@marshal/attachments';
import * as CanonicalContent from '@marshal/attachments/content-to-markdown';
import * as CanonicalProvider from '@marshal/attachments/provider';
import * as LegacyContent from '@marshal/content-to-markdown';
import * as LegacyProvider from '@marshal/agent-runtime-provider-attachments';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
        ? true
        : false
    : false;
type Expect<Value extends true> = Value;

type ProviderCompatibility = [
  Expect<Equal<
    LegacyProvider.AttachmentHandleResolution,
    CanonicalProvider.AttachmentHandleResolution
  >>,
  Expect<Equal<
    LegacyProvider.AttachmentHandleResolver,
    CanonicalProvider.AttachmentHandleResolver
  >>,
  Expect<Equal<
    LegacyProvider.AttachmentProviderOptions,
    CanonicalProvider.AttachmentProviderOptions
  >>,
  Expect<Equal<
    CanonicalProvider.AttachmentHandleResolution,
    Attachments.AttachmentHandleResolution
  >>,
  Expect<Equal<
    CanonicalProvider.AttachmentHandleResolver,
    Attachments.AttachmentHandleResolver
  >>,
  Expect<Equal<
    CanonicalProvider.AttachmentProviderOptions,
    Attachments.AttachmentProviderOptions
  >>,
];

type ContentCompatibility = [
  Expect<Equal<LegacyContent.AttachmentArtifact, CanonicalContent.AttachmentArtifact>>,
  Expect<Equal<LegacyContent.AttachmentConversionKind, CanonicalContent.AttachmentConversionKind>>,
  Expect<Equal<LegacyContent.AttachmentConversionOptions, CanonicalContent.AttachmentConversionOptions>>,
  Expect<Equal<LegacyContent.AttachmentConversionResult, CanonicalContent.AttachmentConversionResult>>,
  Expect<Equal<LegacyContent.AttachmentConversionServices, CanonicalContent.AttachmentConversionServices>>,
  Expect<Equal<LegacyContent.AttachmentTranscriptionRequest, CanonicalContent.AttachmentTranscriptionRequest>>,
  Expect<Equal<LegacyContent.AttachmentTranscriptionResult, CanonicalContent.AttachmentTranscriptionResult>>,
  Expect<Equal<LegacyContent.AttachmentVisionAnalysisRequest, CanonicalContent.AttachmentVisionAnalysisRequest>>,
  Expect<Equal<LegacyContent.AttachmentVisionAnalysisResult, CanonicalContent.AttachmentVisionAnalysisResult>>,
  Expect<Equal<LegacyContent.ContentAnalysisHandle, CanonicalContent.ContentAnalysisHandle>>,
  Expect<Equal<LegacyContent.ImageAnalysisRequest, CanonicalContent.ImageAnalysisRequest>>,
  Expect<Equal<LegacyContent.ImageAnalysisResult, CanonicalContent.ImageAnalysisResult>>,
  Expect<Equal<LegacyContent.ImageMetadataSummary, CanonicalContent.ImageMetadataSummary>>,
  Expect<Equal<LegacyContent.MarkdownArtifact, CanonicalContent.MarkdownArtifact>>,
  Expect<Equal<LegacyContent.MarkdownCapabilityError, CanonicalContent.MarkdownCapabilityError>>,
  Expect<Equal<LegacyContent.MarkdownCapabilityErrorCode, CanonicalContent.MarkdownCapabilityErrorCode>>,
  Expect<Equal<LegacyContent.MarkdownConversionKind, CanonicalContent.MarkdownConversionKind>>,
  Expect<Equal<LegacyContent.MarkdownConversionOptions, CanonicalContent.MarkdownConversionOptions>>,
  Expect<Equal<LegacyContent.MarkdownConversionResult, CanonicalContent.MarkdownConversionResult>>,
  Expect<Equal<LegacyContent.MarkdownConversionServices, CanonicalContent.MarkdownConversionServices>>,
  Expect<Equal<LegacyContent.MarkdownProviderCapability, CanonicalContent.MarkdownProviderCapability>>,
  Expect<Equal<LegacyContent.MediaAnalysisRequest, CanonicalContent.MediaAnalysisRequest>>,
  Expect<Equal<LegacyContent.MediaAnalysisResult, CanonicalContent.MediaAnalysisResult>>,
  Expect<Equal<LegacyContent.MediaConversationRequest, CanonicalContent.MediaConversationRequest>>,
  Expect<Equal<LegacyContent.MediaConversationTurnResult, CanonicalContent.MediaConversationTurnResult>>,
  Expect<Equal<CanonicalContent.AttachmentArtifact, Attachments.AttachmentArtifact>>,
  Expect<Equal<CanonicalContent.AttachmentConversionKind, Attachments.AttachmentConversionKind>>,
  Expect<Equal<CanonicalContent.AttachmentConversionOptions, Attachments.AttachmentConversionOptions>>,
  Expect<Equal<CanonicalContent.AttachmentConversionResult, Attachments.AttachmentConversionResult>>,
  Expect<Equal<CanonicalContent.AttachmentConversionServices, Attachments.AttachmentConversionServices>>,
  Expect<Equal<CanonicalContent.AttachmentTranscriptionRequest, Attachments.AttachmentTranscriptionRequest>>,
  Expect<Equal<CanonicalContent.AttachmentTranscriptionResult, Attachments.AttachmentTranscriptionResult>>,
  Expect<Equal<CanonicalContent.AttachmentVisionAnalysisRequest, Attachments.AttachmentVisionAnalysisRequest>>,
  Expect<Equal<CanonicalContent.AttachmentVisionAnalysisResult, Attachments.AttachmentVisionAnalysisResult>>,
  Expect<Equal<CanonicalContent.ContentAnalysisHandle, Attachments.ContentAnalysisHandle>>,
  Expect<Equal<CanonicalContent.ImageAnalysisRequest, Attachments.ImageAnalysisRequest>>,
  Expect<Equal<CanonicalContent.ImageAnalysisResult, Attachments.ImageAnalysisResult>>,
  Expect<Equal<CanonicalContent.ImageMetadataSummary, Attachments.ImageMetadataSummary>>,
  Expect<Equal<CanonicalContent.MarkdownArtifact, Attachments.MarkdownArtifact>>,
  Expect<Equal<CanonicalContent.MarkdownCapabilityError, Attachments.MarkdownCapabilityError>>,
  Expect<Equal<CanonicalContent.MarkdownCapabilityErrorCode, Attachments.MarkdownCapabilityErrorCode>>,
  Expect<Equal<CanonicalContent.MarkdownConversionKind, Attachments.MarkdownConversionKind>>,
  Expect<Equal<CanonicalContent.MarkdownConversionOptions, Attachments.MarkdownConversionOptions>>,
  Expect<Equal<CanonicalContent.MarkdownConversionResult, Attachments.MarkdownConversionResult>>,
  Expect<Equal<CanonicalContent.MarkdownConversionServices, Attachments.MarkdownConversionServices>>,
  Expect<Equal<CanonicalContent.MarkdownProviderCapability, Attachments.MarkdownProviderCapability>>,
  Expect<Equal<CanonicalContent.MediaAnalysisRequest, Attachments.MediaAnalysisRequest>>,
  Expect<Equal<CanonicalContent.MediaAnalysisResult, Attachments.MediaAnalysisResult>>,
  Expect<Equal<CanonicalContent.MediaConversationRequest, Attachments.MediaConversationRequest>>,
  Expect<Equal<CanonicalContent.MediaConversationTurnResult, Attachments.MediaConversationTurnResult>>,
];

type RootOnlySurface = Attachments.AttachmentsSourceOptions;
type RuntimeCompatibility = [
  Expect<Equal<
    typeof LegacyProvider.createAttachmentProvider,
    typeof CanonicalProvider.createAttachmentProvider
  >>,
  Expect<Equal<
    typeof CanonicalProvider.createAttachmentProvider,
    typeof Attachments.createAttachmentProvider
  >>,
  Expect<Equal<
    typeof LegacyContent.convertAttachmentToMarkdown,
    typeof CanonicalContent.convertAttachmentToMarkdown
  >>,
  Expect<Equal<
    typeof LegacyContent.convertContentToMarkdown,
    typeof CanonicalContent.convertContentToMarkdown
  >>,
  Expect<Equal<
    typeof LegacyContent.extractImageMetadataSummary,
    typeof CanonicalContent.extractImageMetadataSummary
  >>,
  Expect<Equal<
    typeof LegacyContent.isTextLikeAttachment,
    typeof CanonicalContent.isTextLikeAttachment
  >>,
  Expect<Equal<
    typeof LegacyContent.renderPdfPageItems,
    typeof CanonicalContent.renderPdfPageItems
  >>,
  Expect<Equal<typeof LegacyContent.__internal, typeof CanonicalContent.__internal>>,
  Expect<Equal<
    typeof CanonicalContent.convertAttachmentToMarkdown,
    typeof Attachments.convertAttachmentToMarkdown
  >>,
  Expect<Equal<
    typeof CanonicalContent.convertContentToMarkdown,
    typeof Attachments.convertContentToMarkdown
  >>,
  Expect<Equal<
    typeof CanonicalContent.extractImageMetadataSummary,
    typeof Attachments.extractImageMetadataSummary
  >>,
  Expect<Equal<
    typeof CanonicalContent.isTextLikeAttachment,
    typeof Attachments.isTextLikeAttachment
  >>,
  Expect<Equal<
    typeof CanonicalContent.renderPdfPageItems,
    typeof Attachments.renderPdfPageItems
  >>,
  Expect<Equal<typeof CanonicalContent.__internal, typeof Attachments.__internal>>,
];

const runtimeValues = [
  Attachments.ATTACHMENTS_PACKAGE_DECLARATION,
  Attachments.createAttachmentsSource,
  Attachments.createAttachmentProvider,
  Attachments.convertAttachmentToMarkdown,
  Attachments.convertContentToMarkdown,
  Attachments.extractImageMetadataSummary,
  Attachments.isTextLikeAttachment,
  Attachments.renderPdfPageItems,
  Attachments.__internal,
  CanonicalProvider.createAttachmentProvider,
  CanonicalContent.convertContentToMarkdown,
  LegacyProvider.createAttachmentProvider,
  LegacyContent.convertContentToMarkdown,
];

void runtimeValues;
void (0 as unknown as ProviderCompatibility);
void (0 as unknown as ContentCompatibility);
void (0 as unknown as RootOnlySurface);
void (0 as unknown as RuntimeCompatibility);
