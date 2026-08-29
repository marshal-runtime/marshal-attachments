import { execFile as execFileCallback } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { initializeSafeDirectory } from '@marshal/agent-runtime-provider-kit';
import JSZip from 'jszip';
import * as exifr from 'exifr';
import mammoth from 'mammoth';
import { parseBuffer as parseMediaBuffer } from 'music-metadata';
import * as XLSX from 'xlsx';
import { preProcessDocxMath } from './docxMath.js';
import { detectAttachment, isTextLikeAttachment } from './detection.js';
import {
	buildMarkdownDocument,
	buildMarkdownTable,
	convertHtmlToMarkdown,
	normalizePdfText,
	normalizeText,
} from './markdown.js';
import { parsePdfWithDefaultRenderer } from './pdfParseDefault.js';
import type {
	ContentAnalysisHandle,
	MarkdownCapabilityError,
	MarkdownProviderCapability,
	MarkdownConversionServices,
	AttachmentArtifact,
	AttachmentConversionKind,
	AttachmentConversionOptions,
	AttachmentConversionResult,
	AttachmentDetection,
	ImageMetadataSummary,
} from './types.js';
import { descendantsByLocalName, getAttribute, parseXml, textContentOf } from './xml.js';

const execFile = promisify(execFileCallback);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLS_MIME = 'application/vnd.ms-excel';
const EPUB_MIME = 'application/epub+zip';

const ARCHIVE_MIME_TYPES = new Set([
	'application/zip',
	'application/x-zip-compressed',
]);

const HTML_MIME_TYPES = new Set([
	'text/html',
	'application/xhtml+xml',
]);

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.webm']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
const PARTIAL_NUMBERING_PATTERN = /^\.\d+$/;
const MAX_ARTIFACT_FILENAME_ATTEMPTS = 16;

interface ResolvedAttachmentConversionOptions extends AttachmentConversionOptions {
	readonly maxArchiveEntries: number;
	readonly maxArchiveDepth: number;
	readonly archiveDepth: number;
}

interface AttachmentConversionInput {
	readonly filePath: string;
	readonly content: Buffer;
	readonly sourceLabel: string;
	readonly detection: AttachmentDetection;
	readonly options: ResolvedAttachmentConversionOptions;
	readonly registry: AttachmentConverterRegistry;
}

interface AttachmentConverter {
	readonly id: string;
	readonly priority: number;
	accepts(input: AttachmentConversionInput): boolean;
	convert(input: AttachmentConversionInput): Promise<AttachmentConversionResult>;
}

class AttachmentConverterRegistry {
	private readonly converters: AttachmentConverter[] = [];

	register(converter: AttachmentConverter): void {
		this.converters.push(converter);
		this.converters.sort((left, right) => left.priority - right.priority);
	}

	async convert(input: Omit<AttachmentConversionInput, 'registry'>): Promise<AttachmentConversionResult> {
		const fullInput: AttachmentConversionInput = {
			...input,
			registry: this,
		};

		for (const converter of this.converters) {
			if (!converter.accepts(fullInput)) {
				continue;
			}
			return converter.convert(fullInput);
		}

		return buildUnsupportedConversion(fullInput);
	}
}

interface PdfPageData {
	readonly pageNumber: number;
	getTextContent(options?: {
		readonly normalizeWhitespace?: boolean;
		readonly disableCombineTextItems?: boolean;
	}): Promise<{ items: Array<PdfRawTextItem> }>;
	getViewport(options: { readonly scale: number }): { width: number };
}

interface PdfRawTextItem {
	readonly str?: string;
	readonly transform?: number[];
	readonly width?: number;
	readonly height?: number;
}

interface PdfTextItem {
	readonly text: string;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

interface PdfRenderedPage {
	readonly pageNumber: number;
	readonly markdown: string;
	readonly hasTables: boolean;
}

interface PdfRowInfo {
	readonly text: string;
	readonly words: readonly PdfTextItem[];
	readonly cells: string[];
	readonly isParagraph: boolean;
	readonly hasPartialNumbering: boolean;
	readonly isTableRow: boolean;
	readonly xGroups: number[];
}

interface ZipRelationship {
	readonly id: string;
	readonly type: string;
	readonly target: string;
}

let defaultRegistry: AttachmentConverterRegistry | null = null;

export type {
	ContentAnalysisHandle,
	ImageAnalysisRequest,
	ImageAnalysisResult,
	MarkdownArtifact,
	MarkdownCapabilityError,
	MarkdownCapabilityErrorCode,
	MarkdownConversionResult,
	MarkdownConversionServices,
	MarkdownConversionKind,
	MarkdownConversionOptions,
	MarkdownProviderCapability,
	MediaAnalysisRequest,
	MediaAnalysisResult,
	MediaConversationRequest,
	MediaConversationTurnResult,
	AttachmentArtifact,
	AttachmentConversionServices,
	AttachmentConversionKind,
	AttachmentConversionOptions,
	AttachmentConversionResult,
	AttachmentTranscriptionRequest,
	AttachmentTranscriptionResult,
	AttachmentVisionAnalysisRequest,
	AttachmentVisionAnalysisResult,
	ImageMetadataSummary,
} from './types.js';

export { isTextLikeAttachment };

export async function convertContentToMarkdown(
	filePath: string,
	content: Buffer,
	mimeTypeOrOptions?: string | AttachmentConversionOptions,
	maybeOptions?: AttachmentConversionOptions,
): Promise<AttachmentConversionResult> {
	const options = resolveOptions(mimeTypeOrOptions, maybeOptions);
	const artifactDirectory = await createInvocationArtifactDirectory(
		options.artifactDirectory,
		options.artifactDirectoryRoot,
	);
	let converted: AttachmentConversionResult;
	try {
		const detection = await detectAttachment(filePath, content, options.mimeType);
		converted = await getDefaultRegistry().convert({
			filePath,
			content,
			sourceLabel: path.basename(filePath),
			detection,
			options: {
				...options,
				artifactDirectory,
			},
		});
	} catch (error) {
		try {
			await fs.rm(artifactDirectory, { recursive: true, force: true });
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				'Attachment conversion failed and its invocation artifact directory could not be removed.',
			);
		}
		throw error;
	}
	await removeEmptyInvocationArtifactDirectory(artifactDirectory);
	return converted;
}

export const convertAttachmentToMarkdown = convertContentToMarkdown;

export async function extractImageMetadataSummary(content: Buffer): Promise<ImageMetadataSummary | null> {
	try {
		const metadata = await exifr.parse(content, {
			tiff: true,
			exif: true,
			gps: true,
			xmp: false,
			icc: false,
			iptc: false,
		}) as Record<string, unknown> | null;

		if (!metadata) {
			return null;
		}

		const capturedAtValue = metadata.DateTimeOriginal ?? metadata.CreateDate ?? metadata.ModifyDate;
		const capturedAt = capturedAtValue instanceof Date
			? capturedAtValue.toISOString()
			: typeof capturedAtValue === 'string'
				? capturedAtValue
				: undefined;

		return compactImageMetadata({
			width: numberOrUndefined(metadata.ExifImageWidth) ?? numberOrUndefined(metadata.ImageWidth),
			height: numberOrUndefined(metadata.ExifImageHeight) ?? numberOrUndefined(metadata.ImageHeight),
			description: stringOrUndefined(metadata.ImageDescription),
			cameraModel: stringOrUndefined(metadata.Model),
			lensModel: stringOrUndefined(metadata.LensModel),
			capturedAt,
			latitude: numberOrUndefined(metadata.latitude) ?? numberOrUndefined(metadata.GPSLatitude),
			longitude: numberOrUndefined(metadata.longitude) ?? numberOrUndefined(metadata.GPSLongitude),
		});
	} catch {
		return null;
	}
}

export const __internal = {
	renderPdfPageItems,
};

function getDefaultRegistry(): AttachmentConverterRegistry {
	if (defaultRegistry) {
		return defaultRegistry;
	}

	const registry = new AttachmentConverterRegistry();
	registry.register(createDocxConverter());
	registry.register(createSpreadsheetConverter());
	registry.register(createPresentationConverter());
	registry.register(createPdfConverter());
	registry.register(createEpubConverter());
	registry.register(createArchiveConverter());
	registry.register(createMediaConverter('video'));
	registry.register(createMediaConverter('audio'));
	registry.register(createHtmlConverter());
	registry.register(createTextConverter());
	registry.register(createUnsupportedConverter());
	defaultRegistry = registry;
	return registry;
}

function resolveOptions(
	mimeTypeOrOptions?: string | AttachmentConversionOptions,
	maybeOptions?: AttachmentConversionOptions,
): ResolvedAttachmentConversionOptions {
	const baseOptions = typeof mimeTypeOrOptions === 'string'
		? { ...maybeOptions, mimeType: mimeTypeOrOptions }
		: mimeTypeOrOptions ?? {};

	return {
		...baseOptions,
		maxArchiveEntries: baseOptions.maxArchiveEntries ?? 50,
		maxArchiveDepth: baseOptions.maxArchiveDepth ?? 3,
		archiveDepth: baseOptions.archiveDepth ?? 0,
	};
}

async function createInvocationArtifactDirectory(
	configuredRoot: string | undefined,
	containmentRoot: string | undefined,
): Promise<string> {
	const root = await initializeSafeDirectory(
		configuredRoot ?? path.join(os.tmpdir(), 'marshal-content-to-markdown'),
		'artifactDirectory',
		containmentRoot,
	);
	const allocated = await fs.mkdtemp(path.join(root, 'conversion-'));
	return initializeSafeDirectory(
		allocated,
		'artifact invocation directory',
		root,
	);
}

async function removeEmptyInvocationArtifactDirectory(directory: string): Promise<void> {
	await removeDirectoryTreeIfEmpty(directory);
}

async function removeDirectoryTreeIfEmpty(directory: string): Promise<boolean> {
	let entries;
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
		if (!await removeDirectoryTreeIfEmpty(path.join(directory, entry.name))) return false;
	}
	try {
		await fs.rmdir(directory);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') return true;
		if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
		throw error;
	}
}

function createTextConverter(): AttachmentConverter {
	return {
		id: 'text',
		priority: 90,
		accepts: (input) => input.detection.isTextLike,
		async convert(input) {
			return buildConversionResult(input, {
				kind: 'text',
				sourceLabel: input.sourceLabel,
				markdown: normalizeText(input.content.toString('utf-8')),
				notes: [],
				detectedMimeType: input.detection.detectedMimeType ?? input.detection.mimeType,
				artifacts: [],
			});
		},
	};
}

function createHtmlConverter(): AttachmentConverter {
	return {
		id: 'html',
		priority: 80,
		accepts: (input) => {
			const mimeType = input.detection.mimeType ?? input.detection.detectedMimeType;
			return HTML_MIME_TYPES.has(mimeType ?? '')
				|| input.detection.extension === '.html'
				|| input.detection.extension === '.htm';
		},
		async convert(input) {
			const body = convertHtmlToMarkdown(input.content.toString('utf-8'));
			return buildConversionResult(input, {
				kind: 'html',
				sourceLabel: input.sourceLabel,
				markdown: buildMarkdownDocument(input.sourceLabel, body),
				notes: [],
				detectedMimeType: input.detection.detectedMimeType ?? input.detection.mimeType,
				artifacts: [],
			});
		},
	};
}

function createDocxConverter(): AttachmentConverter {
	return {
		id: 'docx',
		priority: 10,
		accepts: (input) =>
			input.detection.extension === '.docx'
			|| input.detection.mimeType === DOCX_MIME
			|| input.detection.detectedMimeType === DOCX_MIME,
		async convert(input) {
			const processedContent = await preProcessDocxMath(input.content);
			const artifacts: AttachmentArtifact[] = [];
			const embeddedImageSections: string[] = [];
			let imageIndex = 0;

			const result = await mammoth.convertToHtml(
				{ buffer: processedContent },
				{
					convertImage: mammoth.images.imgElement(async (image) => {
						imageIndex += 1;
						const buffer = await image.readAsBuffer();
						const mimeType = image.contentType || 'application/octet-stream';
						const artifact = await persistArtifactBuffer(
							input.options.artifactDirectory,
							`docx-image-${imageIndex}`,
							buffer,
							mimeType,
						);
						if (artifact) {
							artifacts.push(artifact);
						}

						const altText = (image as { altText?: string }).altText?.trim() || `Embedded DOCX image ${imageIndex}`;
						const analysis = await analyzeEmbeddedImage({
							sourceLabel: input.sourceLabel,
							label: altText,
							mimeType,
							buffer,
							filePath: artifact?.path,
							services: input.options.services,
						});
						if (artifact || analysis) {
							embeddedImageSections.push(buildEmbeddedImageSection({
								index: imageIndex,
								label: altText,
								path: artifact?.path,
								mimeType,
								analysis,
							}));
						}

						return artifact
							? { src: artifact.path, alt: altText }
							: {
								src: `data:${mimeType};base64,${buffer.toString('base64')}`,
								alt: altText,
							};
					}),
				},
			);

			const notes = result.messages.map((message) => `${message.type}: ${message.message}`);
			const bodySections = [convertHtmlToMarkdown(result.value)];
			if (embeddedImageSections.length > 0) {
				bodySections.push('## Embedded Images', ...embeddedImageSections);
			}

			return buildConversionResult(input, {
				kind: 'docx',
				sourceLabel: input.sourceLabel,
				markdown: buildMarkdownDocument(input.sourceLabel, bodySections.join('\n\n'), notes),
				notes,
				detectedMimeType: input.detection.detectedMimeType ?? input.detection.mimeType,
				artifacts,
			});
		},
	};
}

function createSpreadsheetConverter(): AttachmentConverter {
	return {
		id: 'spreadsheet',
		priority: 20,
		accepts: (input) =>
			input.detection.extension === '.xlsx'
			|| input.detection.extension === '.xls'
			|| input.detection.mimeType === XLSX_MIME
			|| input.detection.mimeType === XLS_MIME
			|| input.detection.detectedMimeType === XLSX_MIME
			|| input.detection.detectedMimeType === XLS_MIME,
		async convert(input) {
			const workbook = XLSX.read(input.content, { type: 'buffer' });
			const sections: string[] = [];
			for (const [index, sheetName] of workbook.SheetNames.entries()) {
				const sheet = workbook.Sheets[sheetName];
				if (!sheet) {
					continue;
				}
				const html = XLSX.utils.sheet_to_html(sheet, {
					id: `sheet-${index + 1}`,
					editable: false,
				});
				const markdown = convertHtmlToMarkdown(`<h2>Sheet: ${escapeHtml(sheetName)}</h2>${html}`);
				if (markdown) {
					sections.push(markdown);
				}
			}

			return buildConversionResult(input, {
				kind: 'spreadsheet',
				sourceLabel: input.sourceLabel,
				markdown: buildMarkdownDocument(
					input.sourceLabel,
					sections.join('\n\n'),
					sections.length === 0 ? ['No sheet content extracted.'] : [],
				),
				notes: sections.length === 0 ? ['No sheet content extracted.'] : [],
				detectedMimeType: input.detection.detectedMimeType ?? input.detection.mimeType,
				artifacts: [],
			});
		},
	};
}

function createPresentationConverter(): AttachmentConverter {
	return {
		id: 'presentation',
		priority: 30,
		accepts: (input) =>
			input.detection.extension === '.pptx'
			|| input.detection.mimeType === PPTX_MIME
			|| input.detection.detectedMimeType === PPTX_MIME,
		async convert(input) {
			const zip = await JSZip.loadAsync(input.content);
			const slideEntries = Object.keys(zip.files)
				.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
				.sort((left, right) => naturalCompare(left, right));

			const sections: string[] = [];
			const artifacts: AttachmentArtifact[] = [];
			for (const slideEntry of slideEntries) {
				const slideXml = await zip.file(slideEntry)?.async('string');
				if (!slideXml) {
					continue;
				}
				const slideNumber = Number(/slide(\d+)\.xml$/.exec(slideEntry)?.[1] ?? '0');
				const relationships = await loadZipRelationships(zip, slideEntry);
				const notesXml = await loadNotesSlideXml(zip, slideEntry, relationships);
				const slideMarkdown = await renderSlideMarkdown({
					slideNumber,
					slideXml,
					notesXml,
					relationships,
					zip,
					options: input.options,
					sourceLabel: input.sourceLabel,
				});
				artifacts.push(...slideMarkdown.artifacts);
				sections.push(slideMarkdown.markdown);
			}

			return buildConversionResult(input, {
				kind: 'presentation',
				sourceLabel: input.sourceLabel,
				markdown: buildMarkdownDocument(
					input.sourceLabel,
					sections.join('\n\n'),
					[
						'Presentation conversion preserves slide titles, body text, tables, notes, chart summaries, and embedded image references where possible.',
						'Exact slide layout and animation timing are intentionally not preserved.',
					],
				),
				notes: [
					'presentation-layout-partial',
				],
				detectedMimeType: input.detection.detectedMimeType ?? input.detection.mimeType,
				artifacts,
			});
		},
	};
}

function createPdfConverter(): AttachmentConverter {
	return {
		id: 'pdf',
		priority: 40,
		accepts: (input) =>
			input.detection.extension === '.pdf'
			|| input.detection.mimeType === 'application/pdf'
			|| input.detection.detectedMimeType === 'application/pdf',
		async convert(input) {
			const renderedPages: PdfRenderedPage[] = [];
			let parseResult: { text: string } | null = null;
			const notes: string[] = [];
			try {
				parseResult = await parsePdfWithDefaultRenderer(input.content, {
					pagerender: async (pageData: PdfPageData) => {
						const textContent = await pageData.getTextContent({
							normalizeWhitespace: false,
							disableCombineTextItems: false,
						});
						const viewport = pageData.getViewport({ scale: 1 });
						const items: PdfTextItem[] = textContent.items
							.map((item) => normalizePdfTextItem(item))
							.filter((item): item is PdfTextItem => item !== null);
						const rendered = renderPdfPageItems(items, viewport.width, pageData.pageNumber);
						renderedPages.push(rendered);
						return rendered.markdown;
					},
				});
			} catch (error) {
				notes.push(`pdf-parse-failed: ${stringifyError(error)}`);
			}

			let body = renderedPages
				.sort((left, right) => left.pageNumber - right.pageNumber)
				.map((page) => page.markdown)
				.filter((pageMarkdown) => pageMarkdown.trim().length > 0)
				.join('\n\n');

			const artifacts: AttachmentArtifact[] = [];
			const capabilityErrors: MarkdownCapabilityError[] = [];
			if (!body.trim()) {
				body = normalizePdfText(parseResult?.text ?? '');
			}

			const sparseText = body.replace(/\s+/g, ' ').trim().length < 48;
			if (sparseText) {
				const ocrFallback = await renderPdfWithVisionFallback(input);
				if (ocrFallback) {
					body = ocrFallback.markdown;
					notes.push('vision-ocr-fallback');
					artifacts.push(...ocrFallback.artifacts);
				} else if (!resolveDocumentImageService(input.options.services)) {
					capabilityErrors.push(createCapabilityError(
						'pdf-ocr',
						'PROVIDER_MISSING',
						'No document image analysis provider was supplied, so OCR fallback for sparse PDFs is unavailable.',
					));
				} else {
					capabilityErrors.push(createCapabilityError(
						'pdf-ocr',
						'PROVIDER_UNAVAILABLE',
						'The configured document image analysis provider did not produce OCR output for this PDF.',
					));
				}
			}

			if (renderedPages.some((page) => page.hasTables)) {
				notes.push('pdf-table-heuristics-applied');
			}
			if (!notes.includes('vision-ocr-fallback')) {
				notes.push('pdf-text-and-layout-heuristics');
			}
			if (!body.trim()) {
				body = '_No PDF text could be extracted._';
			}

			return buildConversionResult(input, {
				kind: 'pdf',
				sourceLabel: input.sourceLabel,
				markdown: buildMarkdownDocument(input.sourceLabel, mergePartialNumberingLines(body), notes),
				notes,
				detectedMimeType: input.detection.detectedMimeType ?? input.detection.mimeType,
				artifacts,
				capabilityErrors,
			});
		},
	};
}

function createArchiveConverter(): AttachmentConverter {
	return {
		id: 'archive',
		priority: 50,
		accepts: (input) =>
			input.detection.extension === '.zip'
			|| ARCHIVE_MIME_TYPES.has(input.detection.mimeType ?? '')
			|| ARCHIVE_MIME_TYPES.has(input.detection.detectedMimeType ?? ''),
		async convert(input) {
			if (input.options.archiveDepth >= input.options.maxArchiveDepth) {
				return buildConversionResult(input, {
					kind: 'archive',
					sourceLabel: input.sourceLabel,
					markdown: buildMarkdownDocument(
						input.sourceLabel,
						'_Archive recursion limit reached._',
						['archive-depth-limit-reached'],
					),
					notes: ['archive-depth-limit-reached'],
					detectedMimeType: input.detection.detectedMimeType ?? input.detection.mimeType,
					artifacts: [],
				});
			}

			const zip = await JSZip.loadAsync(input.content);
			const sections: string[] = [];
			const artifacts: AttachmentArtifact[] = [];
			const entries = Object.values(zip.files)
				.filter((entry) => !entry.dir && !entry.name.startsWith('__MACOSX/'))
				.slice(0, input.options.maxArchiveEntries);

			for (const entry of entries) {
				try {
					const buffer = await entry.async('nodebuffer');
					const nestedArtifactDirectory = input.options.artifactDirectory
						? path.join(input.options.artifactDirectory, 'archive', sanitizePathSegment(entry.name))
						: undefined;
					const converted = await convertAttachmentToMarkdown(
						entry.name,
						buffer,
						{
							...input.options,
							mimeType: undefined,
							artifactDirectory: nestedArtifactDirectory,
							archiveDepth: input.options.archiveDepth + 1,
						},
					);
					artifacts.push(...converted.artifacts);
					sections.push(`## File: ${entry.name}\n\n${converted.markdown}`);
				} catch (error) {
					sections.push(`## File: ${entry.name}\n\n_Failed to convert archive entry: ${stringifyError(error)}_`);
				}
			}

			const notes = entries.length >= input.options.maxArchiveEntries
				? [`Archive truncated after ${input.options.maxArchiveEntries} entries.`]
				: [];

			return buildConversionResult(input, {
				kind: 'archive',
				sourceLabel: input.sourceLabel,
				markdown: buildMarkdownDocument(input.sourceLabel, sections.join('\n\n'), notes),
				notes,
				detectedMimeType: input.detection.detectedMimeType ?? input.detection.mimeType,
				artifacts,
			});
		},
	};
}

function createEpubConverter(): AttachmentConverter {
	return {
		id: 'epub',
		priority: 45,
		accepts: (input) =>
			input.detection.extension === '.epub'
			|| input.detection.mimeType === EPUB_MIME
			|| input.detection.detectedMimeType === EPUB_MIME,
		async convert(input) {
			const zip = await JSZip.loadAsync(input.content);
			const containerXml = await zip.file('META-INF/container.xml')?.async('string');
			if (!containerXml) {
				return buildUnsupportedConversion(input, 'Invalid EPUB container.');
			}

			const containerDoc = parseXml(containerXml);
			const rootfile = descendantsByLocalName(containerDoc, 'rootfile')[0];
			const packagePath = getAttribute(rootfile, 'full-path');
			if (!packagePath) {
				return buildUnsupportedConversion(input, 'Could not resolve EPUB package document.');
			}

			const packageXml = await zip.file(packagePath)?.async('string');
			if (!packageXml) {
				return buildUnsupportedConversion(input, 'Could not read EPUB package document.');
			}

			const packageDoc = parseXml(packageXml);
			const manifestById = new Map<string, { href: string; mediaType?: string }>();
			for (const item of descendantsByLocalName(packageDoc, 'item')) {
				const id = getAttribute(item, 'id');
				const href = getAttribute(item, 'href');
				if (!id || !href) {
					continue;
				}
				manifestById.set(id, {
					href,
					mediaType: getAttribute(item, 'media-type'),
				});
			}

			const baseDir = path.posix.dirname(packagePath);
			const sections: string[] = [];
			for (const itemRef of descendantsByLocalName(packageDoc, 'itemref')) {
				const idref = getAttribute(itemRef, 'idref');
				const manifestEntry = idref ? manifestById.get(idref) : undefined;
				if (!manifestEntry) {
					continue;
				}
				if (!manifestEntry.mediaType?.includes('html') && !manifestEntry.href.endsWith('.xhtml') && !manifestEntry.href.endsWith('.html')) {
					continue;
				}

				const chapterPath = path.posix.normalize(path.posix.join(baseDir, manifestEntry.href));
				const html = await zip.file(chapterPath)?.async('string');
				if (!html) {
					continue;
				}
				const chapterLabel = path.posix.basename(chapterPath);
				const markdown = convertHtmlToMarkdown(html);
				sections.push(`## ${chapterLabel}\n\n${markdown}`);
			}

			return buildConversionResult(input, {
				kind: 'epub',
				sourceLabel: input.sourceLabel,
				markdown: buildMarkdownDocument(input.sourceLabel, sections.join('\n\n'), sections.length === 0 ? ['No EPUB chapter content extracted.'] : []),
				notes: sections.length === 0 ? ['No EPUB chapter content extracted.'] : [],
				detectedMimeType: input.detection.detectedMimeType ?? input.detection.mimeType,
				artifacts: [],
			});
		},
	};
}

function createMediaConverter(kind: 'audio' | 'video'): AttachmentConverter {
	return {
		id: kind,
		priority: kind === 'video' ? 60 : 61,
		accepts: (input) => {
			const mimeType = input.detection.mimeType ?? input.detection.detectedMimeType;
			const extension = input.detection.extension || input.detection.detectedExtension || '';
			return kind === 'video'
				? mimeType?.startsWith('video/') === true || VIDEO_EXTENSIONS.has(extension)
				: mimeType?.startsWith('audio/') === true || AUDIO_EXTENSIONS.has(extension);
		},
		async convert(input) {
			const filePath = await ensureMaterializedSourcePath(input);
			const metadata = await probeMediaMetadata(filePath, input.content);
			const metadataLines = formatMediaMetadataLines(metadata);
			const capabilityErrors: MarkdownCapabilityError[] = [];
			const analysisHandles: ContentAnalysisHandle[] = [];
			const transcription = kind === 'audio' && filePath && input.options.services?.audioTranscription
				? await input.options.services.audioTranscription.transcribeAudio({
					sourceLabel: input.sourceLabel,
					filePath,
					mimeType: input.detection.mimeType ?? input.detection.detectedMimeType,
				})
				: null;
			const mediaAnalysisService = kind === 'video'
				? input.options.services?.videoAnalysis
				: input.options.services?.audioAnalysis;
			const mediaAnalysis = filePath && mediaAnalysisService
				? await mediaAnalysisService.analyzeMedia({
					sourceLabel: input.sourceLabel,
					filePath,
					mimeType: input.detection.mimeType ?? input.detection.detectedMimeType ?? `application/${kind}`,
					modality: kind,
					prompt: kind === 'video'
						? 'Analyze this video in markdown. Preserve notable scenes, speaker turns, slide text, on-screen text, tables, charts, and timeline-relevant events. Include concise timestamps when helpful.'
						: 'Analyze this audio in markdown. Summarize the speakers, important events, structure, and any notable acoustic observations that would help with follow-up questions.',
				})
				: null;
			if (mediaAnalysis?.handle) {
				analysisHandles.push(mediaAnalysis.handle);
			}

			const sections = [
				metadataLines.length > 0
					? metadataLines.join('\n')
					: '_No structured media metadata extracted._',
			];
			if (filePath) {
				sections.push(`## Source File\n\n- path: ${filePath}`);
			}
			if (transcription) {
				sections.push(`## Transcript\n\n${transcription.markdown}`);
			}
			if (mediaAnalysis?.markdown?.trim()) {
				sections.push(`## Analysis\n\n${mediaAnalysis.markdown}`);
			}

			const notes: string[] = [];
			if (kind === 'audio' && !input.options.services?.audioTranscription) {
				capabilityErrors.push(createCapabilityError(
					'audio-transcription',
					'PROVIDER_MISSING',
					'No audio transcription provider was supplied for this conversion.',
				));
			} else if (kind === 'audio' && !transcription) {
				capabilityErrors.push(createCapabilityError(
					'audio-transcription',
					'PROVIDER_UNAVAILABLE',
					'The configured audio transcription provider did not produce a transcript for this file.',
				));
			}
			if (kind === 'video' && !input.options.services?.videoAnalysis) {
				capabilityErrors.push(createCapabilityError(
					'video-analysis',
					'PROVIDER_MISSING',
					'No video analysis provider was supplied for this conversion.',
				));
			} else if (kind === 'video' && !mediaAnalysis) {
				capabilityErrors.push(createCapabilityError(
					'video-analysis',
					'PROVIDER_UNAVAILABLE',
					'The configured video analysis provider did not produce an analysis for this file.',
				));
			}
			if (kind === 'audio' && input.options.services?.audioAnalysis && !mediaAnalysis) {
				capabilityErrors.push(createCapabilityError(
					'audio-analysis',
					'PROVIDER_UNAVAILABLE',
					'The configured audio analysis provider did not produce an analysis handle for this file.',
				));
			}
			if (!transcription && !mediaAnalysis) {
				notes.push('No model-backed media analysis was produced for this media file.');
			}

			return buildConversionResult(input, {
				kind,
				sourceLabel: input.sourceLabel,
				markdown: buildMarkdownDocument(input.sourceLabel, sections.join('\n\n'), notes),
				notes,
				detectedMimeType: input.detection.detectedMimeType ?? input.detection.mimeType,
				artifacts: filePath
					? [{ kind, path: filePath, label: `${kind} source file`, mimeType: input.detection.mimeType ?? input.detection.detectedMimeType }]
					: [],
				metadata: metadata ?? undefined,
				capabilityErrors,
				analysisHandles,
			});
		},
	};
}

function createUnsupportedConverter(): AttachmentConverter {
	return {
		id: 'unsupported',
		priority: 999,
		accepts: () => true,
		async convert(input) {
			return buildUnsupportedConversion(input);
		},
	};
}

async function renderSlideMarkdown(args: {
	readonly slideNumber: number;
	readonly slideXml: string;
	readonly notesXml?: string;
	readonly relationships: Map<string, ZipRelationship>;
	readonly zip: JSZip;
	readonly options: ResolvedAttachmentConversionOptions;
	readonly sourceLabel: string;
}): Promise<{ markdown: string; artifacts: AttachmentArtifact[] }> {
	const doc = parseXml(args.slideXml);
	const title = extractSlideTitle(doc);
	const paragraphs = extractSlideParagraphs(doc, title);
	const tables = extractSlideTables(doc);
	const charts = await extractSlideCharts(doc, args.relationships, args.zip);
	const images = await extractSlideImages({
		doc,
		relationships: args.relationships,
		zip: args.zip,
		options: args.options,
		sourceLabel: args.sourceLabel,
	});
	const notes = args.notesXml ? extractNotesParagraphs(parseXml(args.notesXml)) : [];

	const sections = [
		`<!-- Slide number: ${args.slideNumber} -->`,
		title ? `## Slide ${args.slideNumber}: ${title}` : `## Slide ${args.slideNumber}`,
	];

	if (paragraphs.length === 0 && tables.length === 0 && charts.length === 0 && images.sections.length === 0 && notes.length === 0) {
		sections.push('_No text extracted from slide_');
		return {
			markdown: sections.join('\n\n'),
			artifacts: images.artifacts,
		};
	}

	for (const paragraph of paragraphs) {
		sections.push(paragraph);
	}
	for (const table of tables) {
		sections.push(table);
	}
	for (const chart of charts) {
		sections.push(chart);
	}
	if (images.sections.length > 0) {
		sections.push('### Images', ...images.sections);
	}
	if (notes.length > 0) {
		sections.push('### Notes');
		for (const note of notes) {
			sections.push(note);
		}
	}

	return {
		markdown: sections.join('\n\n'),
		artifacts: images.artifacts,
	};
}

function extractSlideTitle(document: Document): string | undefined {
	for (const shape of descendantsByLocalName(document, 'sp')) {
		const placeholder = descendantsByLocalName(shape, 'ph')[0];
		const placeholderType = getAttribute(placeholder, 'type');
		if (placeholderType !== 'title' && placeholderType !== 'ctrTitle') {
			continue;
		}
		const title = extractParagraphsFromNode(shape)
			.find((paragraph) => paragraph.trim().length > 0);
		if (title) {
			return title.replace(/^[-*]\s+/, '');
		}
	}
	return undefined;
}

function extractSlideParagraphs(document: Document, title?: string): string[] {
	const paragraphs: string[] = [];
	for (const shape of descendantsByLocalName(document, 'sp')) {
		const placeholder = descendantsByLocalName(shape, 'ph')[0];
		const placeholderType = getAttribute(placeholder, 'type');
		if (placeholderType === 'title' || placeholderType === 'ctrTitle') {
			continue;
		}
		for (const paragraph of extractParagraphsFromNode(shape)) {
			const cleaned = paragraph.trim();
			if (!cleaned || cleaned === title) {
				continue;
			}
			paragraphs.push(cleaned);
		}
	}
	return paragraphs;
}

function extractParagraphsFromNode(node: Node): string[] {
	return descendantsByLocalName(node, 'p')
		.map((paragraph) => extractParagraphText(paragraph))
		.filter((paragraph) => paragraph.length > 0);
}

function extractParagraphText(paragraphNode: Element): string {
	const text = descendantsByLocalName(paragraphNode, 't')
		.map((node) => decodeXmlText(node.textContent ?? ''))
		.join('')
		.trim();

	if (!text) {
		return '';
	}

	const hasBullet = descendantsByLocalName(paragraphNode, 'buChar').length > 0
		|| descendantsByLocalName(paragraphNode, 'buAutoNum').length > 0;
	return hasBullet ? `- ${text}` : text;
}

function extractSlideTables(document: Document): string[] {
	return descendantsByLocalName(document, 'tbl')
		.map((table) => {
			const rows = descendantsByLocalName(table, 'tr').map((row) =>
				descendantsByLocalName(row, 'tc').map((cell) =>
					descendantsByLocalName(cell, 't')
						.map((textNode) => decodeXmlText(textNode.textContent ?? ''))
						.join('')
						.trim(),
				),
			);
			return buildMarkdownTable(rows);
		})
		.filter((table) => table.length > 0);
}

async function extractSlideCharts(
	document: Document,
	relationships: Map<string, ZipRelationship>,
	zip: JSZip,
): Promise<string[]> {
	const charts: string[] = [];
	for (const chartNode of descendantsByLocalName(document, 'chart')) {
		const relationshipId = getAttribute(chartNode, 'id');
		const target = relationshipId ? relationships.get(relationshipId)?.target : undefined;
		if (!target) {
			continue;
		}
		const normalizedTarget = resolveZipTarget('ppt/slides', target);
		const chartXml = await zip.file(normalizedTarget)?.async('string');
		if (!chartXml) {
			continue;
		}
		const chartMarkdown = renderChartMarkdown(chartXml);
		if (chartMarkdown) {
			charts.push(chartMarkdown);
		}
	}
	return charts;
}

function renderChartMarkdown(chartXml: string): string {
	const document = parseXml(chartXml);
	const title = descendantsByLocalName(document, 'title')
		.flatMap((node) => descendantsByLocalName(node, 't'))
		.map((node) => textContentOf(node))
		.filter(Boolean)
		.join(' ')
		.trim();
	const series = descendantsByLocalName(document, 'ser').map((seriesNode, seriesIndex) => {
		const name = descendantsByLocalName(seriesNode, 'tx')
			.flatMap((node) => descendantsByLocalName(node, 'v'))
			.map((node) => textContentOf(node))
			.find(Boolean)
			?? `Series ${seriesIndex + 1}`;
		const categories = descendantsByLocalName(seriesNode, 'cat')
			.flatMap((node) => descendantsByLocalName(node, 'pt'))
			.map((node) => descendantsByLocalName(node, 'v').map((valueNode) => textContentOf(valueNode)).join(''))
			.filter(Boolean);
		const values = descendantsByLocalName(seriesNode, 'val')
			.flatMap((node) => descendantsByLocalName(node, 'pt'))
			.map((node) => descendantsByLocalName(node, 'v').map((valueNode) => textContentOf(valueNode)).join(''))
			.filter(Boolean);
		return { name, categories, values };
	});

	if (series.length === 0) {
		return '';
	}

	const categorySet = new Set<string>();
	for (const entry of series) {
		for (const category of entry.categories) {
			categorySet.add(category);
		}
	}
	const categories = Array.from(categorySet);
	if (categories.length === 0) {
		const bulletLines = series.map((entry) => `- ${entry.name}: ${entry.values.join(', ')}`);
		return [`### Chart${title ? `: ${title}` : ''}`, ...bulletLines].join('\n');
	}

	const rows: string[][] = [
		['Category', ...series.map((entry) => entry.name)],
	];
	for (const category of categories) {
		const row = [category];
		for (const entry of series) {
			const index = entry.categories.indexOf(category);
			row.push(index >= 0 ? entry.values[index] ?? '' : '');
		}
		rows.push(row);
	}

	return [`### Chart${title ? `: ${title}` : ''}`, buildMarkdownTable(rows)].join('\n\n');
}

async function extractSlideImages(args: {
	readonly doc: Document;
	readonly relationships: Map<string, ZipRelationship>;
	readonly zip: JSZip;
	readonly options: ResolvedAttachmentConversionOptions;
	readonly sourceLabel: string;
}): Promise<{ sections: string[]; artifacts: AttachmentArtifact[] }> {
	const sections: string[] = [];
	const artifacts: AttachmentArtifact[] = [];
	let imageIndex = 0;

	for (const picture of descendantsByLocalName(args.doc, 'pic')) {
		const blip = descendantsByLocalName(picture, 'blip')[0];
		const relationshipId = getAttribute(blip, 'embed');
		const target = relationshipId ? args.relationships.get(relationshipId)?.target : undefined;
		if (!target) {
			continue;
		}
		const normalizedTarget = resolveZipTarget('ppt/slides', target);
		const buffer = await args.zip.file(normalizedTarget)?.async('nodebuffer');
		if (!buffer) {
			continue;
		}

		imageIndex += 1;
		const nameNode = descendantsByLocalName(picture, 'cNvPr')[0];
		const label = getAttribute(nameNode, 'descr')
			|| getAttribute(nameNode, 'name')
			|| `Embedded slide image ${imageIndex}`;
		const mimeType = mimeTypeFromExtension(path.extname(normalizedTarget).toLowerCase());
		const artifact = await persistArtifactBuffer(
			args.options.artifactDirectory,
			`pptx-image-${imageIndex}${path.extname(normalizedTarget)}`,
			buffer,
			mimeType ?? 'application/octet-stream',
		);
		if (artifact) {
			artifacts.push(artifact);
		}
		const analysis = await analyzeEmbeddedImage({
			sourceLabel: args.sourceLabel,
			label,
			mimeType: mimeType ?? 'application/octet-stream',
			buffer,
			filePath: artifact?.path,
			services: args.options.services,
		});
		sections.push(buildEmbeddedImageSection({
			index: imageIndex,
			label,
			path: artifact?.path,
			mimeType,
			analysis,
		}));
	}

	return { sections, artifacts };
}

function extractNotesParagraphs(document: Document): string[] {
	return descendantsByLocalName(document, 'p')
		.map((paragraph) => extractParagraphText(paragraph))
		.filter((paragraph) => paragraph.trim().length > 0);
}

export function renderPdfPageItems(items: PdfTextItem[], pageWidth: number, pageNumber = 1): PdfRenderedPage {
	const rowInfo = buildPdfRows(items, pageWidth);
	const tableRegions = findPdfTableRegions(rowInfo);
	const contentLines: string[] = [`## Page ${pageNumber}`];
	let rowIndex = 0;
	while (rowIndex < rowInfo.length) {
		const tableRegion = tableRegions.find(([start]) => start === rowIndex);
		if (tableRegion) {
			const [start, end] = tableRegion;
			const rows = rowInfo.slice(start, end).map((row) => row.cells);
			contentLines.push(buildMarkdownTable(rows));
			rowIndex = end;
			continue;
		}

		const insideTable = tableRegions.some(([start, end]) => rowIndex > start && rowIndex < end);
		if (!insideTable && rowInfo[rowIndex]) {
			contentLines.push(rowInfo[rowIndex]!.text);
		}
		rowIndex += 1;
	}

	if (rowInfo.length === 0) {
		contentLines.push('_No text extracted from page._');
	}

	return {
		pageNumber,
		markdown: dedupeSequentialLines(contentLines).join('\n\n'),
		hasTables: tableRegions.length > 0,
	};
}

async function renderPdfWithVisionFallback(
	input: AttachmentConversionInput,
): Promise<{ markdown: string; artifacts: AttachmentArtifact[] } | null> {
	const documentImageService = resolveDocumentImageService(input.options.services);
	if (!documentImageService) {
		return null;
	}
	const sourcePath = await ensureMaterializedSourcePath(input, '.pdf');
	if (!sourcePath) {
		return null;
	}

	const renderDir = input.options.artifactDirectory
		? path.join(input.options.artifactDirectory, 'pdf-pages')
		: path.join(os.tmpdir(), 'marshal-chat-attachments', crypto.createHash('sha1').update(sourcePath).digest('hex'));
	await fs.mkdir(renderDir, { recursive: true });
	const pageImages = await renderPdfPagesToImages(sourcePath, renderDir);
	if (pageImages.length === 0) {
		return null;
	}

	const sections: string[] = [];
	const artifacts: AttachmentArtifact[] = [];
	let pageIndex = 0;
	for (const imagePath of pageImages) {
		pageIndex += 1;
		const buffer = await fs.readFile(imagePath);
		const analysis = await documentImageService.analyzeImage({
			sourceLabel: input.sourceLabel,
			mimeType: 'image/png',
			filePath: imagePath,
			data: buffer,
			mode: 'ocr',
			prompt: 'Extract text from this PDF page into markdown. Preserve headings, lists, table-like structure, and form fields when visible.',
		});
		artifacts.push({
			kind: 'page-image',
			path: imagePath,
			label: `Rendered PDF page ${pageIndex}`,
			mimeType: 'image/png',
		});
		sections.push(`## Page ${pageIndex}\n\n${analysis?.markdown?.trim() || '_No OCR text extracted from page._'}`);
	}

	return {
		markdown: sections.join('\n\n'),
		artifacts,
	};
}

async function renderPdfPagesToImages(sourcePath: string, outputDir: string): Promise<string[]> {
	const attempts = [
		async (attemptDirectory: string) => {
			await execFile('pdftoppm', [
				'-png',
				'-r',
				'200',
				sourcePath,
				path.join(attemptDirectory, 'page'),
			]);
		},
		async (attemptDirectory: string) => {
			await execFile('magick', [
				'-density',
				'200',
				sourcePath,
				path.join(attemptDirectory, 'page-%03d.png'),
			]);
		},
	];

	for (const [index, attempt] of attempts.entries()) {
		const attemptDirectory = await fs.mkdtemp(
			path.join(outputDir, `renderer-${index + 1}-`),
		);
		let rendererError: unknown;
		try {
			await attempt(attemptDirectory);
			const files = await fs.readdir(attemptDirectory);
			const images = files
				.filter((file) => file.toLowerCase().endsWith('.png'))
				.sort(naturalCompare)
				.map((file) => path.join(attemptDirectory, file));
			if (images.length > 0) {
				return images;
			}
		} catch (error) {
			rendererError = error;
		}
		await removePdfRendererAttempt(attemptDirectory, rendererError);
		// Try the next renderer.
	}

	return [];
}

async function removePdfRendererAttempt(
	directory: string,
	rendererError?: unknown,
): Promise<void> {
	try {
		await fs.rm(directory, { recursive: true, force: true });
	} catch (cleanupError) {
		if (rendererError !== undefined) {
			throw new AggregateError(
				[rendererError, cleanupError],
				'PDF renderer failed and its attempt output could not be removed.',
			);
		}
		throw cleanupError;
	}
}

function normalizePdfTextItem(item: PdfRawTextItem): PdfTextItem | null {
	const text = (item.str ?? '').replace(/\s+/g, ' ').trim();
	if (!text) {
		return null;
	}
	const transform = item.transform ?? [];
	return {
		text,
		x: Number(transform[4] ?? 0),
		y: Number(transform[5] ?? 0),
		width: Number(item.width ?? 0),
		height: Number(item.height ?? 0),
	};
}

function buildPdfRows(items: PdfTextItem[], pageWidth: number): PdfRowInfo[] {
	const groupedRows = new Map<number, PdfTextItem[]>();
	for (const item of items) {
		const rowKey = Math.round(item.y / 3) * 3;
		const row = groupedRows.get(rowKey) ?? [];
		row.push(item);
		groupedRows.set(rowKey, row);
	}

	const rows = Array.from(groupedRows.entries())
		.sort((left, right) => right[0] - left[0])
		.map(([, rowItems]) => rowItems.sort((left, right) => left.x - right.x))
		.map((rowItems) => {
			const text = rowItems.map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim();
			const xGroups = clusterPositions(rowItems.map((item) => item.x), 28);
			const lineWidth = rowItems.length > 0
				? (rowItems[rowItems.length - 1]!.x + rowItems[rowItems.length - 1]!.width) - rowItems[0]!.x
				: 0;
			return {
				text,
				words: rowItems,
				cells: [],
				isParagraph: lineWidth > pageWidth * 0.55 && text.length > 60,
				hasPartialNumbering: PARTIAL_NUMBERING_PATTERN.test(rowItems[0]?.text ?? ''),
				isTableRow: false,
				xGroups,
			} satisfies PdfRowInfo;
		})
		.filter((row) => row.text.length > 0);

	const tableColumnStarts = inferPdfTableColumns(rows, pageWidth);
	if (tableColumnStarts.length === 0) {
		return rows;
	}

	return rows.map((row) => {
		if (row.isParagraph || row.hasPartialNumbering) {
			return row;
		}
		const alignedColumns = new Set<number>();
		for (const word of row.words) {
			for (const [columnIndex, columnStart] of tableColumnStarts.entries()) {
				if (Math.abs(word.x - columnStart) < 32) {
					alignedColumns.add(columnIndex);
					break;
				}
			}
		}
		const isTableRow = alignedColumns.size >= 2;
		return {
			...row,
			isTableRow,
			cells: isTableRow ? assignPdfCells(row.words, tableColumnStarts) : [],
		};
	});
}

function inferPdfTableColumns(rows: readonly PdfRowInfo[], pageWidth: number): number[] {
	const allPositions: number[] = [];
	for (const row of rows) {
		if (row.isParagraph || row.hasPartialNumbering || row.xGroups.length < 2) {
			continue;
		}
		allPositions.push(...row.xGroups);
	}
	if (allPositions.length === 0) {
		return [];
	}

	const sorted = [...allPositions].sort((left, right) => left - right);
	const gaps: number[] = [];
	for (let index = 0; index < sorted.length - 1; index += 1) {
		const gap = sorted[index + 1]! - sorted[index]!;
		if (gap > 5) {
			gaps.push(gap);
		}
	}
	const adaptiveTolerance = gaps.length >= 3
		? Math.max(25, Math.min(50, gaps.sort((left, right) => left - right)[Math.floor(gaps.length * 0.7)] ?? 35))
		: 35;
	const columns = clusterPositions(sorted, adaptiveTolerance);
	if (columns.length < 2) {
		return [];
	}

	const contentWidth = columns[columns.length - 1]! - columns[0]!;
	if (contentWidth <= 0) {
		return [];
	}
	const avgColumnWidth = contentWidth / columns.length;
	if (avgColumnWidth < 30) {
		return [];
	}
	const columnsPerInch = columns.length / (contentWidth / 72);
	if (columnsPerInch > 10) {
		return [];
	}
	const adaptiveMaxColumns = Math.max(15, Math.floor(20 * (pageWidth / 612)));
	return columns.length > adaptiveMaxColumns ? [] : columns;
}

function clusterPositions(positions: readonly number[], tolerance: number): number[] {
	const sorted = [...positions].sort((left, right) => left - right);
	const clusters: number[] = [];
	for (const value of sorted) {
		if (clusters.length === 0 || value - clusters[clusters.length - 1]! > tolerance) {
			clusters.push(value);
		}
	}
	return clusters;
}

function assignPdfCells(words: readonly PdfTextItem[], columnStarts: readonly number[]): string[] {
	const cells = Array.from({ length: columnStarts.length }, () => '');
	for (const word of words) {
		let targetIndex = columnStarts.length - 1;
		for (let index = 0; index < columnStarts.length - 1; index += 1) {
			const boundary = columnStarts[index + 1]!;
			if (word.x < boundary - 16) {
				targetIndex = index;
				break;
			}
		}
		cells[targetIndex] = cells[targetIndex]
			? `${cells[targetIndex]} ${word.text}`
			: word.text;
	}
	return cells.map((cell) => cell.trim());
}

function findPdfTableRegions(rows: readonly PdfRowInfo[]): Array<[number, number]> {
	const regions: Array<[number, number]> = [];
	let index = 0;
	while (index < rows.length) {
		if (!rows[index]?.isTableRow) {
			index += 1;
			continue;
		}
		const start = index;
		while (index < rows.length && rows[index]?.isTableRow) {
			index += 1;
		}
		regions.push([start, index]);
	}
	const totalTableRows = regions.reduce((sum, [start, end]) => sum + (end - start), 0);
	if (rows.length > 0 && totalTableRows / rows.length < 0.2) {
		return [];
	}
	return regions;
}

async function loadNotesSlideXml(
	zip: JSZip,
	slideEntry: string,
	relationships: Map<string, ZipRelationship>,
): Promise<string | undefined> {
	const notesRelationship = Array.from(relationships.values()).find((relationship) => relationship.type.includes('/notesSlide'));
	if (!notesRelationship) {
		return undefined;
	}
	const target = resolveZipTarget(path.posix.dirname(slideEntry), notesRelationship.target);
	return zip.file(target)?.async('string');
}

async function loadZipRelationships(zip: JSZip, sourceEntry: string): Promise<Map<string, ZipRelationship>> {
	const relEntry = `${path.posix.dirname(sourceEntry)}/_rels/${path.posix.basename(sourceEntry)}.rels`;
	const relXml = await zip.file(relEntry)?.async('string');
	const relationships = new Map<string, ZipRelationship>();
	if (!relXml) {
		return relationships;
	}
	const document = parseXml(relXml);
	for (const relationship of descendantsByLocalName(document, 'Relationship')) {
		const id = getAttribute(relationship, 'Id');
		const type = getAttribute(relationship, 'Type');
		const target = getAttribute(relationship, 'Target');
		if (!id || !type || !target) {
			continue;
		}
		relationships.set(id, { id, type, target });
	}
	return relationships;
}

function resolveZipTarget(baseDir: string, target: string): string {
	const normalizedTarget = target.replace(/\\/g, '/');
	if (normalizedTarget.startsWith('/')) {
		return normalizedTarget.slice(1);
	}
	return path.posix.normalize(path.posix.join(baseDir, normalizedTarget));
}

async function analyzeEmbeddedImage(args: {
	readonly sourceLabel: string;
	readonly label: string;
	readonly mimeType: string;
	readonly buffer: Buffer;
	readonly filePath?: string;
	readonly services?: ResolvedAttachmentConversionOptions['services'];
}): Promise<string | undefined> {
	const imageService = resolveDocumentImageService(args.services);
	if (!imageService) {
		return undefined;
	}
	const result = await imageService.analyzeImage({
		sourceLabel: args.sourceLabel,
		mimeType: args.mimeType,
		filePath: args.filePath,
		data: args.buffer,
		mode: 'ocr+caption',
		prompt: 'Extract any visible text from this embedded document image into markdown. After the text, add a short note describing diagrams, charts, or visuals that matter for understanding the document.',
	});
	return result?.markdown?.trim() || undefined;
}

function buildEmbeddedImageSection(args: {
	readonly index: number;
	readonly label: string;
	readonly path?: string;
	readonly mimeType?: string;
	readonly analysis?: string;
}): string {
	const lines = [`### Image ${args.index}: ${args.label}`];
	if (args.path) {
		lines.push(`- path: ${args.path}`);
	}
	if (args.mimeType) {
		lines.push(`- mime_type: ${args.mimeType}`);
	}
	if (args.analysis) {
		lines.push('');
		lines.push(args.analysis);
	}
	return lines.join('\n');
}

async function persistArtifactBuffer(
	artifactDirectory: string | undefined,
	label: string,
	buffer: Buffer,
	mimeType: string,
): Promise<AttachmentArtifact | undefined> {
	if (!artifactDirectory) {
		return undefined;
	}
	const assetsDirectory = path.join(artifactDirectory, 'assets');
	await fs.mkdir(assetsDirectory, { recursive: true });
	const extension = extensionForMimeType(mimeType) || path.extname(label) || '.bin';
	const safeBaseName = sanitizePathSegment(path.basename(label, path.extname(label)));
	const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`;
	const filePath = await writeUniqueArtifactBuffer(
		assetsDirectory,
		safeBaseName || 'artifact',
		normalizedExtension,
		buffer,
	);
	return {
		kind: 'image',
		path: filePath,
		label,
		mimeType,
	};
}

async function writeUniqueArtifactBuffer(
	directory: string,
	baseName: string,
	extension: string,
	buffer: Buffer,
): Promise<string> {
	for (let attempt = 0; attempt < MAX_ARTIFACT_FILENAME_ATTEMPTS; attempt += 1) {
		const filePath = path.join(
			directory,
			`${baseName}-${crypto.randomUUID()}${extension}`,
		);
		try {
			await fs.writeFile(filePath, buffer, { flag: 'wx' });
			return filePath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
	}
	throw new Error(
		`Could not allocate a unique artifact filename after ${MAX_ARTIFACT_FILENAME_ATTEMPTS} attempts.`,
	);
}

async function ensureMaterializedSourcePath(
	input: AttachmentConversionInput,
	fallbackExtension?: string,
): Promise<string | undefined> {
	if (input.options.sourcePath) {
		return input.options.sourcePath;
	}

	const baseDir = input.options.artifactDirectory
		? path.join(input.options.artifactDirectory, 'source')
		: path.join(os.tmpdir(), 'marshal-chat-attachments', crypto.createHash('sha1').update(input.filePath).digest('hex'));
	await fs.mkdir(baseDir, { recursive: true });
	const extension = input.detection.extension || input.detection.detectedExtension || fallbackExtension || '';
	const targetPath = path.join(baseDir, `${sanitizePathSegment(path.basename(input.filePath, path.extname(input.filePath))) || 'attachment'}${extension}`);
	await fs.writeFile(targetPath, input.content);
	return targetPath;
}

async function probeMediaMetadata(
	filePath: string | undefined,
	content: Buffer,
): Promise<Record<string, unknown> | null> {
	const ffprobeMetadata = filePath ? await probeMediaWithFfprobe(filePath) : null;
	if (ffprobeMetadata) {
		return ffprobeMetadata;
	}

	try {
		const parsed = await parseMediaBuffer(content);
		return {
			format: parsed.format.container,
			durationSeconds: parsed.format.duration,
			bitrate: parsed.format.bitrate,
			codec: parsed.format.codec,
			numberOfChannels: parsed.format.numberOfChannels,
			sampleRate: parsed.format.sampleRate,
			trackInfo: parsed.common.track,
			title: parsed.common.title,
			artist: parsed.common.artist,
			album: parsed.common.album,
		};
	} catch {
		return null;
	}
}

async function probeMediaWithFfprobe(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const { stdout } = await execFile('ffprobe', [
			'-v',
			'error',
			'-show_entries',
			'format=duration,bit_rate,size,format_name:stream=index,codec_name,codec_type,width,height,channels,sample_rate',
			'-of',
			'json',
			filePath,
		]);
		return JSON.parse(stdout) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function formatMediaMetadataLines(metadata: Record<string, unknown> | null): string[] {
	if (!metadata) {
		return [];
	}
	const lines: string[] = [];
	const format = metadata.format as Record<string, unknown> | undefined;
	if (format) {
		if (typeof format.format_name === 'string') {
			lines.push(`- format: ${format.format_name}`);
		}
		if (format.duration !== undefined) {
			lines.push(`- duration_seconds: ${format.duration}`);
		}
		if (format.bit_rate !== undefined) {
			lines.push(`- bitrate: ${format.bit_rate}`);
		}
		if (format.size !== undefined) {
			lines.push(`- size_bytes: ${format.size}`);
		}
	}
	const streams = Array.isArray(metadata.streams) ? metadata.streams as Array<Record<string, unknown>> : [];
	for (const stream of streams) {
		const parts = [
			typeof stream.codec_type === 'string' ? `type=${stream.codec_type}` : undefined,
			typeof stream.codec_name === 'string' ? `codec=${stream.codec_name}` : undefined,
			stream.width !== undefined && stream.height !== undefined ? `size=${stream.width}x${stream.height}` : undefined,
			stream.channels !== undefined ? `channels=${stream.channels}` : undefined,
			stream.sample_rate !== undefined ? `sample_rate=${stream.sample_rate}` : undefined,
		].filter((value): value is string => Boolean(value));
		if (parts.length > 0) {
			lines.push(`- stream: ${parts.join(', ')}`);
		}
	}
	for (const [key, value] of Object.entries(metadata)) {
		if (key === 'format' || key === 'streams') {
			continue;
		}
		if (value !== undefined && value !== null && value !== '') {
			lines.push(`- ${key}: ${String(value)}`);
		}
	}
	return lines;
}

function buildUnsupportedConversion(input: AttachmentConversionInput, extraNote?: string): AttachmentConversionResult {
	const notes = extraNote ? [extraNote, 'unsupported'] : ['unsupported'];
	return buildConversionResult(input, {
		kind: 'unsupported',
		sourceLabel: input.sourceLabel,
		markdown: [
			`# Unsupported attachment: ${input.sourceLabel}`,
			'',
			`- MIME type: ${input.detection.mimeType ?? input.detection.detectedMimeType ?? 'unknown'}`,
			`- Extension: ${input.detection.extension || input.detection.detectedExtension || '(none)'}`,
			'',
			extraNote ?? 'No inline content was extracted for this file type.',
		].join('\n'),
		notes,
		detectedMimeType: input.detection.detectedMimeType ?? input.detection.mimeType,
		artifacts: [],
	});
}

function buildConversionResult(
	input: AttachmentConversionInput,
	result: Omit<AttachmentConversionResult, 'capabilityErrors' | 'analysisHandles'> & {
		readonly capabilityErrors?: readonly MarkdownCapabilityError[];
		readonly analysisHandles?: readonly ContentAnalysisHandle[];
	},
): AttachmentConversionResult {
	return {
		...result,
		capabilityErrors: result.capabilityErrors ?? [],
		analysisHandles: result.analysisHandles ?? [],
	};
}

function createCapabilityError(
	capability: MarkdownProviderCapability,
	code: MarkdownCapabilityError['code'],
	message: string,
	providerId?: string,
): MarkdownCapabilityError {
	return { capability, code, message, providerId };
}

function resolveDocumentImageService(
	services: MarkdownConversionServices | undefined,
): MarkdownConversionServices['documentImages'] | MarkdownConversionServices['images'] | undefined {
	return services?.documentImages ?? services?.images;
}

function mergePartialNumberingLines(markdown: string): string {
	const lines = markdown.split('\n');
	const merged: string[] = [];
	let index = 0;
	while (index < lines.length) {
		const currentLine = lines[index]!.trim();
		if (PARTIAL_NUMBERING_PATTERN.test(currentLine)) {
			let lookahead = index + 1;
			while (lookahead < lines.length && lines[lookahead]!.trim().length === 0) {
				lookahead += 1;
			}
			if (lookahead < lines.length) {
				merged.push(`${currentLine} ${lines[lookahead]!.trim()}`);
				index = lookahead + 1;
				continue;
			}
		}
		merged.push(lines[index]!);
		index += 1;
	}
	return merged.join('\n');
}

function dedupeSequentialLines(lines: readonly string[]): string[] {
	const deduped: string[] = [];
	for (const line of lines) {
		if (deduped[deduped.length - 1] === line) {
			continue;
		}
		deduped.push(line);
	}
	return deduped;
}

function compactImageMetadata(summary: ImageMetadataSummary): ImageMetadataSummary | null {
	const hasValues = Object.values(summary).some((value) => value !== undefined);
	return hasValues ? summary : null;
}

function naturalCompare(left: string, right: string): number {
	return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function decodeXmlText(value: string): string {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#10;/g, '\n')
		.replace(/&#13;/g, '\n');
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function sanitizePathSegment(value: string): string {
	return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '-');
}

function mimeTypeFromExtension(extension: string): string | undefined {
	switch (extension.toLowerCase()) {
		case '.png':
			return 'image/png';
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg';
		case '.gif':
			return 'image/gif';
		case '.webp':
			return 'image/webp';
		case '.bmp':
			return 'image/bmp';
		default:
			return undefined;
	}
}

function extensionForMimeType(mimeType: string): string | undefined {
	switch (mimeType.toLowerCase()) {
		case 'image/png':
			return '.png';
		case 'image/jpeg':
			return '.jpg';
		case 'image/gif':
			return '.gif';
		case 'image/webp':
			return '.webp';
		case 'application/pdf':
			return '.pdf';
		default:
			return undefined;
	}
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringifyError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
