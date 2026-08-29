export type MarkdownConversionKind =
	| 'text'
	| 'html'
	| 'pdf'
	| 'docx'
	| 'spreadsheet'
	| 'presentation'
	| 'archive'
	| 'audio'
	| 'video'
	| 'epub'
	| 'unsupported';

export type MarkdownProviderCapability =
	| 'image-analysis'
	| 'document-image-analysis'
	| 'audio-transcription'
	| 'audio-analysis'
	| 'video-analysis'
	| 'pdf-ocr';

export type MarkdownCapabilityErrorCode =
	| 'PROVIDER_MISSING'
	| 'PROVIDER_UNAVAILABLE'
	| 'MODALITY_UNSUPPORTED'
	| 'ANALYSIS_FAILED';

export interface MarkdownArtifact {
	readonly kind: 'image' | 'page-image' | 'audio' | 'video' | 'derived' | 'other';
	readonly path: string;
	readonly label: string;
	readonly mimeType?: string;
}

export interface MarkdownCapabilityError {
	readonly code: MarkdownCapabilityErrorCode;
	readonly capability: MarkdownProviderCapability;
	readonly message: string;
	readonly providerId?: string;
}

export interface ContentAnalysisHandle {
	readonly id: string;
	readonly providerId: string;
	readonly capability: Extract<MarkdownProviderCapability, 'audio-analysis' | 'video-analysis'>;
	readonly sourceLabel: string;
	readonly state: Readonly<Record<string, unknown>>;
}

export interface MarkdownConversionResult {
	readonly kind: MarkdownConversionKind;
	readonly markdown: string;
	readonly sourceLabel: string;
	readonly notes: readonly string[];
	readonly detectedMimeType?: string;
	readonly artifacts: readonly MarkdownArtifact[];
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly capabilityErrors: readonly MarkdownCapabilityError[];
	readonly analysisHandles: readonly ContentAnalysisHandle[];
}

export interface ImageMetadataSummary {
	readonly width?: number;
	readonly height?: number;
	readonly description?: string;
	readonly cameraModel?: string;
	readonly lensModel?: string;
	readonly capturedAt?: string;
	readonly latitude?: number;
	readonly longitude?: number;
}

export interface ImageAnalysisRequest {
	readonly sourceLabel: string;
	readonly mimeType: string;
	readonly prompt: string;
	readonly mode: 'ocr' | 'caption' | 'ocr+caption';
	readonly filePath?: string;
	readonly data?: Buffer;
}

export interface ImageAnalysisResult {
	readonly markdown: string;
	readonly providerId: string;
	readonly model?: string;
	readonly text?: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AudioTranscriptionRequest {
	readonly sourceLabel: string;
	readonly filePath: string;
	readonly mimeType?: string;
}

export interface AudioTranscriptionResult {
	readonly markdown: string;
	readonly providerId: string;
	readonly model?: string;
	readonly text: string;
	readonly durationSeconds?: number;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MediaAnalysisRequest {
	readonly sourceLabel: string;
	readonly filePath: string;
	readonly mimeType: string;
	readonly modality: 'audio' | 'video';
	readonly prompt: string;
}

export interface MediaAnalysisResult {
	readonly markdown: string;
	readonly providerId: string;
	readonly model?: string;
	readonly text?: string;
	readonly handle?: ContentAnalysisHandle | null;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MediaConversationRequest {
	readonly handle: ContentAnalysisHandle;
	readonly prompt: string;
}

export interface MediaConversationTurnResult {
	readonly markdown: string;
	readonly providerId: string;
	readonly model?: string;
	readonly text?: string;
	readonly handle: ContentAnalysisHandle;
}

export interface MarkdownConversionServices {
	readonly images?: {
		analyzeImage(request: ImageAnalysisRequest): Promise<ImageAnalysisResult | null>;
	};
	readonly documentImages?: {
		analyzeImage(request: ImageAnalysisRequest): Promise<ImageAnalysisResult | null>;
	};
	readonly audioTranscription?: {
		transcribeAudio(
			request: AudioTranscriptionRequest,
		): Promise<AudioTranscriptionResult | null>;
	};
	readonly audioAnalysis?: {
		analyzeMedia(request: MediaAnalysisRequest): Promise<MediaAnalysisResult | null>;
		continueAnalysis(
			request: MediaConversationRequest,
		): Promise<MediaConversationTurnResult>;
	};
	readonly videoAnalysis?: {
		analyzeMedia(request: MediaAnalysisRequest): Promise<MediaAnalysisResult | null>;
		continueAnalysis(
			request: MediaConversationRequest,
		): Promise<MediaConversationTurnResult>;
	};
}

export interface MarkdownConversionOptions {
	readonly mimeType?: string;
	readonly sourcePath?: string;
	readonly artifactDirectory?: string;
	readonly artifactDirectoryRoot?: string;
	readonly services?: MarkdownConversionServices;
	readonly maxArchiveEntries?: number;
	readonly maxArchiveDepth?: number;
	readonly archiveDepth?: number;
}

export interface AttachmentDetection {
	readonly extension: string;
	readonly mimeType?: string;
	readonly detectedMimeType?: string;
	readonly detectedExtension?: string;
	readonly isTextLike: boolean;
}

export type AttachmentConversionKind = MarkdownConversionKind;
export type AttachmentArtifact = MarkdownArtifact;
export type AttachmentCapabilityError = MarkdownCapabilityError;
export type AttachmentConversionResult = MarkdownConversionResult;
export type AttachmentVisionAnalysisRequest = ImageAnalysisRequest;
export type AttachmentVisionAnalysisResult = ImageAnalysisResult;
export type AttachmentTranscriptionRequest = AudioTranscriptionRequest;
export type AttachmentTranscriptionResult = AudioTranscriptionResult;
export type AttachmentConversionServices = MarkdownConversionServices;
export type AttachmentConversionOptions = MarkdownConversionOptions;
