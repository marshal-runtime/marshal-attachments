import JSZip from 'jszip';
import { childElements, descendantsByLocalName, firstChildByLocalName, getAttribute, localNameOf, parseXml, serializeXml } from './xml.js';

const DOCX_XML_PATHS = [
	'word/document.xml',
	'word/footnotes.xml',
	'word/endnotes.xml',
] as const;

export async function preProcessDocxMath(content: Buffer): Promise<Buffer> {
	const zip = await JSZip.loadAsync(content);
	for (const filePath of DOCX_XML_PATHS) {
		const file = zip.file(filePath);
		if (!file) {
			continue;
		}
		try {
			const xml = await file.async('string');
			const processedXml = convertOmathInXml(xml);
			zip.file(filePath, processedXml);
		} catch {
			// Keep original XML when conversion fails.
		}
	}
	return await zip.generateAsync({ type: 'nodebuffer' });
}

function convertOmathInXml(xml: string): string {
	const document = parseXml(xml);
	const blockMathNodes = descendantsByLocalName(document, 'oMathPara');
	for (const node of blockMathNodes) {
		const latex = renderMathBlock(node);
		replaceWithTextRun(node, `$$${latex}$$`);
	}

	const inlineMathNodes = descendantsByLocalName(document, 'oMath');
	for (const node of inlineMathNodes) {
		if (localNameOf(node.parentNode) === 'oMathPara') {
			continue;
		}
		const latex = renderMathNode(node);
		replaceWithTextRun(node, `$${latex}$`);
	}

	return serializeXml(document);
}

function replaceWithTextRun(node: Element, latex: string): void {
	const document = node.ownerDocument;
	if (!document) {
		return;
	}
	const run = document.createElement('w:r');
	const text = document.createElement('w:t');
	text.appendChild(document.createTextNode(latex));
	run.appendChild(text);
	node.parentNode?.replaceChild(run, node);
}

function renderMathBlock(node: Element): string {
	return descendantsByLocalName(node, 'oMath')
		.map((entry) => renderMathNode(entry))
		.filter((value) => value.length > 0)
		.join('\n\n');
}

function renderMathNode(node: Element | null | undefined): string {
	if (!node) {
		return '';
	}
	const parts = childElements(node).map((child) => renderMathElement(child)).filter(Boolean);
	return normalizeLatex(parts.join(' '));
}

function renderMathElement(node: Element | null | undefined): string {
	if (!node) {
		return '';
	}
	const name = localNameOf(node);
	switch (name) {
		case 'r':
			return descendantsByLocalName(node, 't')
				.map((entry) => escapeLatex(entry.textContent ?? ''))
				.join('');
		case 't':
			return escapeLatex(node.textContent ?? '');
		case 'oMath':
		case 'e':
			return renderMathNode(node);
		case 'f':
			return renderFraction(node);
		case 'sSup':
			return renderSuperscript(node);
		case 'sSub':
			return renderSubscript(node);
		case 'sSubSup':
			return renderSubSuperscript(node);
		case 'rad':
			return renderRadical(node);
		case 'nary':
			return renderNary(node);
		case 'd':
			return renderDelimited(node);
		case 'm':
			return renderMatrix(node);
		case 'func':
			return renderFunction(node);
		case 'acc':
			return renderAccent(node);
		case 'limLow':
			return renderLimit(node, '_');
		case 'limUpp':
			return renderLimit(node, '^');
		case 'box':
		case 'bar':
		case 'borderBox':
		case 'groupChr':
		case 'phant':
			return renderMathNode(firstChildByLocalName(node, 'e') ?? node);
		default:
			return childElements(node).map((child) => renderMathElement(child)).join(' ');
	}
}

function renderFraction(node: Element): string {
	const numerator = renderMathNode(firstChildByLocalName(node, 'num'));
	const denominator = renderMathNode(firstChildByLocalName(node, 'den'));
	return `\\frac{${numerator}}{${denominator}}`;
}

function renderSuperscript(node: Element): string {
	const base = renderMathNode(firstChildByLocalName(node, 'e'));
	const exponent = renderMathNode(firstChildByLocalName(node, 'sup'));
	return `${wrapMath(base)}^{${exponent}}`;
}

function renderSubscript(node: Element): string {
	const base = renderMathNode(firstChildByLocalName(node, 'e'));
	const subscript = renderMathNode(firstChildByLocalName(node, 'sub'));
	return `${wrapMath(base)}_{${subscript}}`;
}

function renderSubSuperscript(node: Element): string {
	const base = renderMathNode(firstChildByLocalName(node, 'e'));
	const subscript = renderMathNode(firstChildByLocalName(node, 'sub'));
	const superscript = renderMathNode(firstChildByLocalName(node, 'sup'));
	return `${wrapMath(base)}_{${subscript}}^{${superscript}}`;
}

function renderRadical(node: Element): string {
	const degree = renderMathNode(firstChildByLocalName(node, 'deg'));
	const body = renderMathNode(firstChildByLocalName(node, 'e'));
	return degree
		? `\\sqrt[${degree}]{${body}}`
		: `\\sqrt{${body}}`;
}

function renderNary(node: Element): string {
	const symbol = mapNarySymbol(getAttribute(firstChildByLocalName(node, 'chr'), 'val'));
	const body = renderMathNode(firstChildByLocalName(node, 'e'));
	const subscript = renderMathNode(firstChildByLocalName(node, 'sub'));
	const superscript = renderMathNode(firstChildByLocalName(node, 'sup'));
	return `${symbol}${subscript ? `_{${subscript}}` : ''}${superscript ? `^{${superscript}}` : ''} ${body}`.trim();
}

function renderDelimited(node: Element): string {
	const properties = firstChildByLocalName(node, 'dPr');
	const begin = mapDelimiter(getAttribute(firstChildByLocalName(properties, 'begChr'), 'val') ?? '(');
	const end = mapDelimiter(getAttribute(firstChildByLocalName(properties, 'endChr'), 'val') ?? ')');
	const body = childElements(node)
		.filter((child) => localNameOf(child) !== 'dPr')
		.map((child) => renderMathElement(child))
		.join(', ');
	return `\\left${begin} ${body} \\right${end}`;
}

function renderMatrix(node: Element): string {
	const rows = childElements(node)
		.filter((child) => localNameOf(child) === 'mr')
		.map((row) => childElements(row)
			.filter((cell) => localNameOf(cell) === 'e')
			.map((cell) => renderMathNode(cell))
			.join(' & '))
		.filter((row) => row.length > 0);
	return rows.length > 0
		? `\\begin{bmatrix}${rows.join(' \\\\ ')}\\end{bmatrix}`
		: '';
}

function renderFunction(node: Element): string {
	const name = renderMathNode(firstChildByLocalName(node, 'fName'));
	const argument = renderMathNode(firstChildByLocalName(node, 'e'));
	return `${name}${argument ? `(${argument})` : ''}`;
}

function renderAccent(node: Element): string {
	const base = renderMathNode(firstChildByLocalName(node, 'e'));
	const accent = getAttribute(firstChildByLocalName(firstChildByLocalName(node, 'accPr'), 'chr'), 'val');
	switch (accent) {
		case '¯':
			return `\\overline{${base}}`;
		case '˘':
			return `\\breve{${base}}`;
		case '̂':
		case '^':
			return `\\hat{${base}}`;
		case '̃':
		case '~':
			return `\\tilde{${base}}`;
		default:
			return base;
	}
}

function renderLimit(node: Element, operator: '_' | '^'): string {
	const base = renderMathNode(firstChildByLocalName(node, 'e'));
	const limit = renderMathNode(firstChildByLocalName(node, 'lim'));
	return `${wrapMath(base)}${operator}{${limit}}`;
}

function wrapMath(value: string): string {
	return /^[A-Za-z0-9]+$/.test(value) ? value : `(${value})`;
}

function mapNarySymbol(value: string | undefined): string {
	switch (value) {
		case '∑':
			return '\\sum';
		case '∏':
			return '\\prod';
		case '∫':
			return '\\int';
		case '⋃':
			return '\\bigcup';
		case '⋂':
			return '\\bigcap';
		default:
			return escapeLatex(value ?? '');
	}
}

function mapDelimiter(value: string): string {
	switch (value) {
		case '{':
		case '}':
			return `\\${value}`;
		default:
			return value;
	}
}

function escapeLatex(value: string): string {
	return value
		.replace(/\\/g, '\\textbackslash{}')
		.replace(/([{}_#$%&])/g, '\\$1');
}

function normalizeLatex(value: string): string {
	return value
		.replace(/\s+/g, ' ')
		.replace(/\s+([,.;:])/g, '$1')
		.trim();
}
