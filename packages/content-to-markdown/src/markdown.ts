import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

export function buildMarkdownDocument(sourceLabel: string, body: string, notes: readonly string[] = []): string {
	const sections = [`# ${sourceLabel}`];
	const normalizedBody = normalizeText(body);
	sections.push(normalizedBody || '_No content extracted._');

	if (notes.length > 0) {
		sections.push('## Conversion Notes');
		for (const note of notes) {
			sections.push(`- ${note}`);
		}
	}

	return sections.join('\n\n').trimEnd();
}

export function convertHtmlToMarkdown(html: string): string {
	const service = createTurndownService();
	const markdown = service.turndown(preprocessHtmlForMarkdown(html));
	return normalizeText(markdown);
}

export function normalizePdfText(input: string): string {
	return normalizeText(
		input
			.replace(/[ \t]+\n/g, '\n')
			.replace(/\n{3,}/g, '\n\n'),
	);
}

export function normalizeText(input: string): string {
	return input
		.replace(/\r\n/g, '\n')
		.replace(/\u0000/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function buildMarkdownTable(rows: string[][]): string {
	const nonEmptyRows = rows.filter((row) => row.some((cell) => cell.trim().length > 0));
	if (nonEmptyRows.length === 0) {
		return '';
	}
	const columnCount = nonEmptyRows.reduce((max, row) => Math.max(max, row.length), 0);
	const normalizedRows = nonEmptyRows.map((row) => {
		const cells = [...row];
		while (cells.length < columnCount) {
			cells.push('');
		}
		return cells.map((cell) => escapeMarkdownTableCell(cell));
	});

	const [header, ...bodyRows] = normalizedRows;
	const lines = [
		`| ${header.join(' | ')} |`,
		`| ${header.map(() => '---').join(' | ')} |`,
	];
	for (const row of bodyRows) {
		lines.push(`| ${row.join(' | ')} |`);
	}
	return lines.join('\n');
}

export function summarizeImageSource(src: string): string {
	const trimmed = src.trim();
	if (!trimmed) {
		return '';
	}
	if (!trimmed.startsWith('data:')) {
		return trimmed;
	}
	const separatorIndex = trimmed.indexOf(',');
	if (separatorIndex === -1) {
		return `${trimmed.slice(0, 64)}...`;
	}
	return `${trimmed.slice(0, separatorIndex)}...`;
}

export function escapeMarkdownTableCell(value: string): string {
	return value.replace(/\|/g, '\\|').replace(/\n/g, '<br/>');
}

function createTurndownService(): TurndownService {
	const service = new TurndownService({
		bulletListMarker: '-',
		codeBlockStyle: 'fenced',
		emDelimiter: '*',
		headingStyle: 'atx',
	});
	service.use(gfm);

	service.addRule('checkboxes', {
		filter: ['input'],
		replacement: (_content, node) => {
			const element = node as { getAttribute?: (name: string) => string | null };
			if (element.getAttribute?.('type') !== 'checkbox') {
				return '';
			}
			return element.getAttribute('checked') !== null ? '[x] ' : '[ ] ';
		},
	});

	service.addRule('safeLinks', {
		filter: ['a'],
		replacement: (content, node) => {
			const element = node as { getAttribute?: (name: string) => string | null };
			const href = element.getAttribute?.('href')?.trim() ?? '';
			if (!href || href.toLowerCase().startsWith('javascript:')) {
				return content;
			}
			return `[${content || href}](${href})`;
		},
	});

	service.addRule('safeImages', {
		filter: ['img'],
		replacement: (_content, node) => {
			const element = node as { getAttribute?: (name: string) => string | null };
			const alt = (element.getAttribute?.('alt') ?? '').replace(/\s+/g, ' ').trim();
			const src = summarizeImageSource(element.getAttribute?.('src') ?? '');
			if (!src) {
				return alt;
			}
			return `![${alt}](${src})`;
		},
	});

	return service;
}

function preprocessHtmlForMarkdown(html: string): string {
	return promoteFirstTableRowToHeader(
		html
			.replace(/<head\b[\s\S]*?<\/head>/gi, '')
			.replace(/<colgroup\b[\s\S]*?<\/colgroup>/gi, ''),
	);
}

function promoteFirstTableRowToHeader(html: string): string {
	return html.replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => {
		const flattenedTable = tableHtml
			.replace(/<p\b[^>]*>/gi, '')
			.replace(/<\/p>/gi, '')
			.replace(/>\s+</g, '><');

		if (/<th\b/i.test(flattenedTable)) {
			return flattenedTable;
		}

		return flattenedTable.replace(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/i, (_rowMatch, attributes, rowContent) => {
			const headerContent = rowContent
				.replace(/<td\b/gi, '<th')
				.replace(/<\/td>/gi, '</th>');
			return `<tr${attributes}>${headerContent}</tr>`;
		});
	});
}
