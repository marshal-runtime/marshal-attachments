import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	convertContentToMarkdown,
	type MarkdownConversionServices,
} from '../src/content-to-markdown/index.js';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecFileMock = (
	command: string,
	args: readonly string[],
	callback: ExecFileCallback,
) => void;
type InitializeSafeDirectory =
	typeof import('@marshal/agent-runtime-provider-kit')['initializeSafeDirectory'];
type RandomUuid = typeof import('node:crypto')['randomUUID'];

const mocks = vi.hoisted(() => ({
	execFile: vi.fn<ExecFileMock>(),
	initializeSafeDirectory: vi.fn<InitializeSafeDirectory>(),
	parsePdf: vi.fn<() => Promise<{ text: string }>>(),
	randomUUID: vi.fn<RandomUuid>(),
	realInitializeSafeDirectory: undefined as InitializeSafeDirectory | undefined,
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('node:crypto', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:crypto')>();
	return { ...actual, randomUUID: mocks.randomUUID };
});
vi.mock('@marshal/agent-runtime-provider-kit', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@marshal/agent-runtime-provider-kit')>();
	mocks.realInitializeSafeDirectory = actual.initializeSafeDirectory;
	return { ...actual, initializeSafeDirectory: mocks.initializeSafeDirectory };
});
vi.mock('../src/content-to-markdown/pdfParseDefault.js', () => ({
	parsePdfWithDefaultRenderer: mocks.parsePdf,
}));

const cleanup: string[] = [];
let rendererTarget = 0;
let rendererArrivals = 0;
let rendererGate = Promise.resolve();
let releaseRenderers: (() => void) | undefined;

beforeEach(() => {
	const realInitializeSafeDirectory = mocks.realInitializeSafeDirectory;
	if (!realInitializeSafeDirectory) {
		throw new Error('The real safe-directory initializer was not loaded.');
	}
	mocks.execFile.mockReset();
	mocks.initializeSafeDirectory.mockReset();
	mocks.initializeSafeDirectory.mockImplementation(realInitializeSafeDirectory);
	mocks.parsePdf.mockReset();
	mocks.parsePdf.mockResolvedValue({ text: '' });
	mocks.randomUUID.mockReset();
	let uuidSequence = 0;
	mocks.randomUUID.mockImplementation(() => testUuid(++uuidSequence));
	rendererTarget = 0;
	rendererArrivals = 0;
	rendererGate = Promise.resolve();
	releaseRenderers = undefined;
	installProcessMocks();
});

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((directory) =>
		fs.rm(directory, { recursive: true, force: true })));
});

describe('conversion artifact isolation', () => {
	it('excludes stale PDF pages across sequential conversions', async () => {
		const artifactRoot = await createTempDirectory();
		const services = documentImageServices();

		const first = await convertContentToMarkdown(
			'scan.pdf',
			Buffer.from('first-two-pages'),
			{ mimeType: 'application/pdf', artifactDirectory: artifactRoot, services },
		);
		const second = await convertContentToMarkdown(
			'scan.pdf',
			Buffer.from('second-one-page'),
			{ mimeType: 'application/pdf', artifactDirectory: artifactRoot, services },
		);

		expect(first.artifacts).toHaveLength(2);
		expect(second.artifacts).toHaveLength(1);
		expect(second.markdown).toContain('second-one-page:page-1');
		expect(second.markdown).not.toContain('first-two-pages:page-2');
		expect(conversionRoot(first.artifacts[0]!.path))
			.not.toBe(conversionRoot(second.artifacts[0]!.path));
		await expect(fs.readFile(first.artifacts[1]!.path, 'utf8'))
			.resolves.toBe('first-two-pages:page-2');
	});

	it('isolates concurrent PDF rendering for the same logical filename', async () => {
		const artifactRoot = await createTempDirectory();
		const services = documentImageServices();
		blockRenderersUntil(2);

		const [first, second] = await Promise.all([
			convertContentToMarkdown(
				'scan.pdf',
				Buffer.from('concurrent-first-two-pages'),
				{ mimeType: 'application/pdf', artifactDirectory: artifactRoot, services },
			),
			convertContentToMarkdown(
				'scan.pdf',
				Buffer.from('concurrent-second-one-page'),
				{ mimeType: 'application/pdf', artifactDirectory: artifactRoot, services },
			),
		]);

		expect(first.artifacts).toHaveLength(2);
		expect(second.artifacts).toHaveLength(1);
		expect(first.markdown).toContain('concurrent-first-two-pages:page-2');
		expect(first.markdown).not.toContain('concurrent-second-one-page');
		expect(second.markdown).toContain('concurrent-second-one-page:page-1');
		expect(second.markdown).not.toContain('concurrent-first-two-pages');
		expect(conversionRoot(first.artifacts[0]!.path))
			.not.toBe(conversionRoot(second.artifacts[0]!.path));
	});

	it('keeps sequential materialized sources in separate persistent directories', async () => {
		const artifactRoot = await createTempDirectory();
		const services = transcriptionServices();

		const first = await convertContentToMarkdown(
			'clip.mp3',
			Buffer.from('first audio'),
			{ mimeType: 'audio/mpeg', artifactDirectory: artifactRoot, services },
		);
		const second = await convertContentToMarkdown(
			'clip.mp3',
			Buffer.from('second audio'),
			{ mimeType: 'audio/mpeg', artifactDirectory: artifactRoot, services },
		);
		const firstPath = first.artifacts[0]!.path;
		const secondPath = second.artifacts[0]!.path;

		expect(firstPath).not.toBe(secondPath);
		expect(first.markdown).toContain('first audio');
		expect(second.markdown).toContain('second audio');
		await expect(fs.readFile(firstPath, 'utf8')).resolves.toBe('first audio');
		await expect(fs.readFile(secondPath, 'utf8')).resolves.toBe('second audio');
	});

	it('isolates concurrent materialization before host services read files', async () => {
		const artifactRoot = await createTempDirectory();
		const requests: string[] = [];
		let release!: () => void;
		const bothMaterialized = new Promise<void>((resolve) => {
			release = resolve;
		});
		const services: MarkdownConversionServices = {
			audioTranscription: {
				async transcribeAudio(request) {
					requests.push(request.filePath);
					if (requests.length === 2) release();
					await bothMaterialized;
					const text = await fs.readFile(request.filePath, 'utf8');
					return { markdown: text, text, providerId: 'test-transcriber' };
				},
			},
		};

		const [first, second] = await Promise.all([
			convertContentToMarkdown(
				'clip.mp3',
				Buffer.from('concurrent first audio'),
				{ mimeType: 'audio/mpeg', artifactDirectory: artifactRoot, services },
			),
			convertContentToMarkdown(
				'clip.mp3',
				Buffer.from('concurrent second audio'),
				{ mimeType: 'audio/mpeg', artifactDirectory: artifactRoot, services },
			),
		]);

		expect(new Set(requests)).toHaveLength(2);
		expect(first.markdown).toContain('concurrent first audio');
		expect(first.markdown).not.toContain('concurrent second audio');
		expect(second.markdown).toContain('concurrent second audio');
		expect(second.markdown).not.toContain('concurrent first audio');
	});

	it('removes a failed invocation scope without deleting successful artifacts', async () => {
		const artifactRoot = await createTempDirectory();
		const successful = await convertContentToMarkdown(
			'clip.mp3',
			Buffer.from('persistent successful audio'),
			{
				mimeType: 'audio/mpeg',
				artifactDirectory: artifactRoot,
				services: transcriptionServices(),
			},
		);
		const successfulPath = successful.artifacts[0]!.path;

		await expect(convertContentToMarkdown(
			'clip.mp3',
			Buffer.from('failed audio'),
			{
				mimeType: 'audio/mpeg',
				artifactDirectory: artifactRoot,
				services: {
					audioTranscription: {
						async transcribeAudio() {
							throw new Error('transcription failed');
						},
					},
				},
			},
		)).rejects.toThrow('transcription failed');

		expect(await fs.readdir(artifactRoot)).toEqual([
			path.basename(conversionRoot(successfulPath)),
		]);
		await expect(fs.readFile(successfulPath, 'utf8'))
			.resolves.toBe('persistent successful audio');
	});

	it('rejects direct artifact roots containing a symlink or junction component', async (testContext) => {
		const parent = await createTempDirectory();
		const outside = await createTempDirectory();
		const linked = path.join(parent, 'linked');
		try {
			await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM') {
				testContext.skip();
				return;
			}
			throw error;
		}

		try {
			await expect(convertContentToMarkdown(
				'notes.txt',
				Buffer.from('linked direct output'),
				{
					mimeType: 'text/plain',
					artifactDirectory: path.join(linked, 'artifacts'),
				},
			)).rejects.toThrow(/symbolic link|junction/i);
			expect(await fs.readdir(outside)).toEqual([]);
		} finally {
			await fs.unlink(linked).catch(() => undefined);
		}
	});

	it('rejects a direct artifact root swapped to a junction during allocation', async (testContext) => {
		const parent = await createTempDirectory();
		const outside = await createTempDirectory();
		const artifactRoot = path.join(parent, 'artifacts');
		const originalRoot = path.join(parent, 'original-artifacts');
		const linkProbe = path.join(parent, 'link-probe');
		await fs.mkdir(artifactRoot);
		try {
			await fs.symlink(outside, linkProbe, process.platform === 'win32' ? 'junction' : 'dir');
			await fs.unlink(linkProbe);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM') {
				testContext.skip();
				return;
			}
			throw error;
		}

		const realInitializeSafeDirectory = mocks.realInitializeSafeDirectory!;
		let calls = 0;
		mocks.initializeSafeDirectory.mockImplementation(async (...args) => {
			const canonical = await realInitializeSafeDirectory(...args);
			calls += 1;
			if (calls === 1) {
				await fs.rename(artifactRoot, originalRoot);
				await fs.symlink(
					outside,
					artifactRoot,
					process.platform === 'win32' ? 'junction' : 'dir',
				);
			}
			return canonical;
		});

		try {
			await expect(convertContentToMarkdown(
				'notes.txt',
				Buffer.from('allocation race'),
				{
					mimeType: 'text/plain',
					artifactDirectory: artifactRoot,
					artifactDirectoryRoot: parent,
				},
			)).rejects.toThrow(/symbolic link|junction/i);
			expect((await fs.readdir(outside)).some((entry) => entry.startsWith('conversion-')))
				.toBe(true);
		} finally {
			await fs.unlink(artifactRoot).catch(() => undefined);
		}
	});

	it.each([
		{
			label: 'plain text',
			filePath: 'notes.txt',
			content: Buffer.from('no artifact content'),
			mimeType: 'text/plain',
			expectedKind: 'text',
		},
		{
			label: 'typed unsupported image',
			filePath: 'scan.png',
			content: Buffer.from([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
				0x00, 0x00, 0x00, 0x00,
			]),
			mimeType: 'image/png',
			expectedKind: 'unsupported',
		},
	])('does not leave an empty successful scope for $label', async ({
		filePath,
		content,
		mimeType,
		expectedKind,
	}) => {
		const parent = await createTempDirectory();
		const artifactRoot = path.join(parent, 'artifacts');
		const converted = await convertContentToMarkdown(filePath, content, {
			mimeType,
			artifactDirectory: artifactRoot,
			artifactDirectoryRoot: parent,
		});

		expect(converted.kind).toBe(expectedKind);
		expect(converted.artifacts).toEqual([]);
		expect(await fs.readdir(artifactRoot)).toEqual([]);
	});

	it('removes partial output from a failed PDF renderer before fallback succeeds', async () => {
		const artifactRoot = await createTempDirectory();
		mocks.execFile.mockImplementation((command, args, callback) => {
			const output = args.at(-1);
			if (!output) {
				callback(new Error('Missing renderer output path.'), '', '');
				return;
			}
			if (command === 'pdftoppm') {
				void fs.writeFile(`${output}-1.png`, 'partial-first-renderer').then(
					() => callback(new Error('pdftoppm failed after partial output'), '', ''),
					(error: unknown) => callback(asError(error), '', ''),
				);
				return;
			}
			if (command === 'magick') {
				void fs.writeFile(
					path.join(path.dirname(output), 'page-000.png'),
					'fallback-only-page',
				).then(
					() => callback(null, '', ''),
					(error: unknown) => callback(asError(error), '', ''),
				);
				return;
			}
			callback(new Error(`Unexpected renderer: ${command}`), '', '');
		});

		const converted = await convertContentToMarkdown(
			'scan.pdf',
			Buffer.from('fallback-pdf'),
			{
				mimeType: 'application/pdf',
				artifactDirectory: artifactRoot,
				services: documentImageServices(),
			},
		);
		const artifactPath = converted.artifacts[0]!.path;
		const renderRoot = path.dirname(path.dirname(artifactPath));

		expect(converted.artifacts).toHaveLength(1);
		expect(converted.markdown).toContain('fallback-only-page');
		expect(converted.markdown).not.toContain('partial-first-renderer');
		expect(await fs.readdir(renderRoot)).toEqual([
			path.basename(path.dirname(artifactPath)),
		]);
	});

	it('retries exclusive artifact writes after a deterministic UUID collision', async () => {
		const artifactRoot = await createTempDirectory();
		const collision = testUuid(101);
		const retry = testUuid(102);
		mocks.randomUUID
			.mockReset()
			.mockReturnValueOnce(collision)
			.mockReturnValueOnce(retry)
			.mockImplementation(() => testUuid(103));
		const realInitializeSafeDirectory = mocks.realInitializeSafeDirectory!;
		let initializeCalls = 0;
		mocks.initializeSafeDirectory.mockImplementation(async (...args) => {
			const canonical = await realInitializeSafeDirectory(...args);
			initializeCalls += 1;
			if (initializeCalls === 2) {
				const assets = path.join(canonical, 'assets');
				await fs.mkdir(assets);
				await fs.writeFile(
					path.join(assets, `pptx-image-1-${collision}.png`),
					'preexisting artifact',
				);
			}
			return canonical;
		});
		const presentation = await createPresentationWithImages([
			Buffer.from('converted image'),
		]);

		const converted = await convertContentToMarkdown(
			'slides.pptx',
			presentation,
			{
				mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
				artifactDirectory: artifactRoot,
			},
		);

		expect(converted.artifacts).toHaveLength(1);
		await expect(fs.readFile(converted.artifacts[0]!.path, 'utf8'))
			.resolves.toBe('converted image');
		expect(path.basename(converted.artifacts[0]!.path)).toContain(retry);
		await expect(fs.readFile(
			path.join(
				conversionRoot(converted.artifacts[0]!.path),
				'assets',
				`pptx-image-1-${collision}.png`,
			),
			'utf8',
		)).resolves.toBe('preexisting artifact');
	});
});

function installProcessMocks(): void {
	mocks.execFile.mockImplementation((command, args, callback) => {
		if (command !== 'pdftoppm') {
			callback(Object.assign(new Error(`${command} is unavailable`), { code: 'ENOENT' }), '', '');
			return;
		}
		const sourcePath = args.at(-2);
		const outputPrefix = args.at(-1);
		if (!sourcePath || !outputPrefix) {
			callback(new Error('Unexpected pdftoppm arguments.'), '', '');
			return;
		}
		void renderFakePdf(sourcePath, outputPrefix).then(
			() => callback(null, '', ''),
			(error: unknown) => callback(asError(error), '', ''),
		);
	});
}

async function renderFakePdf(sourcePath: string, outputPrefix: string): Promise<void> {
	await waitForRendererPeers();
	const source = await fs.readFile(sourcePath, 'utf8');
	const pageCount = source.includes('two-pages') ? 2 : 1;
	for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
		await fs.writeFile(`${outputPrefix}-${pageNumber}.png`, `${source}:page-${pageNumber}`);
	}
}

function blockRenderersUntil(target: number): void {
	rendererTarget = target;
	rendererGate = new Promise<void>((resolve) => {
		releaseRenderers = resolve;
	});
}

async function waitForRendererPeers(): Promise<void> {
	if (rendererTarget === 0) return;
	rendererArrivals += 1;
	if (rendererArrivals === rendererTarget) releaseRenderers?.();
	await rendererGate;
}

function documentImageServices(): MarkdownConversionServices {
	return {
		documentImages: {
			async analyzeImage(request) {
				return {
					markdown: request.data?.toString('utf8') ?? '',
					providerId: 'test-document-images',
				};
			},
		},
	};
}

function transcriptionServices(): MarkdownConversionServices {
	return {
		audioTranscription: {
			async transcribeAudio(request) {
				const text = await fs.readFile(request.filePath, 'utf8');
				return { markdown: text, text, providerId: 'test-transcriber' };
			},
		},
	};
}

function conversionRoot(artifactPath: string): string {
	return path.dirname(path.dirname(artifactPath));
}

async function createTempDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-markdown-artifacts-'));
	cleanup.push(directory);
	return directory;
}

async function createPresentationWithImages(images: readonly Buffer[]): Promise<Buffer> {
	const zip = new JSZip();
	const pictures = images.map((_, index) => `
		<p:pic>
			<p:nvPicPr><p:cNvPr id="${index + 1}" name="Image ${index + 1}"/></p:nvPicPr>
			<p:blipFill><a:blip r:embed="rId${index + 1}"/></p:blipFill>
		</p:pic>`).join('');
	zip.file('ppt/slides/slide1.xml', `
		<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
			xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
			xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
			<p:cSld><p:spTree>${pictures}</p:spTree></p:cSld>
		</p:sld>`);
	zip.file('ppt/slides/_rels/slide1.xml.rels', `
		<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
			${images.map((_, index) => `
				<Relationship Id="rId${index + 1}"
					Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
					Target="../media/image${index + 1}.png"/>`).join('')}
		</Relationships>`);
	for (const [index, image] of images.entries()) {
		zip.file(`ppt/media/image${index + 1}.png`, image);
	}
	return zip.generateAsync({ type: 'nodebuffer' });
}

function testUuid(value: number): `${string}-${string}-${string}-${string}-${string}` {
	return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
