import defaultPdfJsModule from 'pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js';

export interface PdfParserPageData {
	readonly pageNumber: number;
	getTextContent(options?: {
		readonly normalizeWhitespace?: boolean;
		readonly disableCombineTextItems?: boolean;
	}): Promise<{ items: Array<PdfParserRawTextItem> }>;
	getViewport(options: { readonly scale: number }): { width: number };
}

interface PdfParserRawTextItem {
	readonly str?: string;
	readonly transform?: number[];
}

interface PdfParseDefaultOptions {
	readonly pagerender?: (pageData: PdfParserPageData) => Promise<string> | string;
	readonly max?: number;
}

interface PdfParseDefaultResult {
	readonly numpages: number;
	readonly numrender: number;
	readonly info: Record<string, unknown> | null;
	readonly metadata: unknown;
	readonly text: string;
	readonly version: string;
}

interface PdfJsDocument {
	readonly numPages: number;
	getMetadata(): Promise<{ info?: Record<string, unknown>; metadata?: unknown } | null>;
	getPage(pageNumber: number): Promise<PdfParserPageData>;
	destroy(): unknown;
}

interface PdfJsApi {
	readonly version: string;
	disableWorker?: boolean;
	getDocument(dataBuffer: Buffer): Promise<PdfJsDocument>;
}

const DEFAULT_PDF_JS = defaultPdfJsModule as PdfJsApi;

export async function parsePdfWithDefaultRenderer(
	dataBuffer: Buffer,
	options: PdfParseDefaultOptions = {},
): Promise<PdfParseDefaultResult> {
	const pagerender = typeof options.pagerender === 'function' ? options.pagerender : renderPageText;
	const max = typeof options.max === 'number' ? options.max : 0;

	DEFAULT_PDF_JS.disableWorker = true;
	const document = await DEFAULT_PDF_JS.getDocument(dataBuffer);
	try {
		const metadata = await document.getMetadata().catch(() => null);
		const pageCount = document.numPages;
		const renderCount = max <= 0 ? pageCount : Math.min(max, pageCount);
		let text = '';

		for (let pageNumber = 1; pageNumber <= renderCount; pageNumber += 1) {
			const pageText = await document
				.getPage(pageNumber)
				.then((pageData) => pagerender(pageData))
				.catch(() => '');
			text = `${text}\n\n${pageText}`;
		}

		return {
			numpages: pageCount,
			numrender: renderCount,
			info: metadata?.info ?? null,
			metadata: metadata?.metadata ?? null,
			text,
			version: DEFAULT_PDF_JS.version,
		};
	} finally {
		await Promise.resolve(document.destroy());
	}
}

async function renderPageText(pageData: PdfParserPageData): Promise<string> {
	const textContent = await pageData.getTextContent({
		normalizeWhitespace: false,
		disableCombineTextItems: false,
	});
	let lastY: number | undefined;
	let text = '';
	for (const item of textContent.items) {
		const itemText = item.str ?? '';
		const currentY = item.transform?.[5];
		if (lastY === undefined || currentY === lastY) {
			text += itemText;
		} else {
			text += `\n${itemText}`;
		}
		lastY = currentY;
	}
	return text;
}
