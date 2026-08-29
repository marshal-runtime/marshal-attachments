import * as path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import type { AttachmentDetection } from './types.js';

const TEXT_EXTENSIONS = new Set([
	'.txt',
	'.md',
	'.markdown',
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.json',
	'.jsonc',
	'.yaml',
	'.yml',
	'.toml',
	'.ini',
	'.cfg',
	'.conf',
	'.env',
	'.csv',
	'.sql',
	'.sh',
	'.ps1',
	'.bat',
	'.cmd',
	'.py',
	'.go',
	'.rs',
	'.rb',
	'.java',
	'.kt',
	'.swift',
	'.php',
	'.c',
	'.cc',
	'.cpp',
	'.h',
	'.hpp',
	'.cs',
	'.html',
	'.htm',
	'.css',
	'.scss',
	'.xml',
	'.svg',
	'.rst',
	'.log',
	'.properties',
	'.gradle',
	'.gitignore',
	'.gitattributes',
]);

const TEXT_LIKE_MIME_PREFIXES = [
	'text/',
];

const TEXT_LIKE_MIME_EXACT = new Set([
	'application/json',
	'application/ld+json',
	'application/xml',
	'application/x-sh',
	'application/x-ndjson',
	'application/javascript',
	'application/typescript',
	'application/x-yaml',
	'application/yaml',
	'image/svg+xml',
]);

export function isTextLikeAttachment(filePath: string, mimeType?: string, content?: Buffer): boolean {
	const extension = path.extname(filePath).toLowerCase();
	if (TEXT_EXTENSIONS.has(extension)) {
		return true;
	}

	const normalizedMime = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
	if (normalizedMime) {
		if (TEXT_LIKE_MIME_PREFIXES.some((prefix) => normalizedMime.startsWith(prefix))) {
			return true;
		}
		if (TEXT_LIKE_MIME_EXACT.has(normalizedMime)) {
			return true;
		}
	}

	if (!content || content.length === 0) {
		return false;
	}

	return isLikelyUtf8Text(content);
}

export async function detectAttachment(
	filePath: string,
	content: Buffer,
	mimeType?: string,
): Promise<AttachmentDetection> {
	const extension = path.extname(filePath).toLowerCase();
	const detected = await fileTypeFromBuffer(content).catch(() => undefined);
	const normalizedMime = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
	const detectedMimeType = detected?.mime?.toLowerCase();
	const detectedExtension = detected?.ext ? `.${detected.ext.toLowerCase()}` : undefined;

	return {
		extension,
		mimeType: normalizedMime,
		detectedMimeType,
		detectedExtension,
		isTextLike: isTextLikeAttachment(
			filePath,
			normalizedMime ?? detectedMimeType,
			content,
		),
	};
}

function isLikelyUtf8Text(content: Buffer): boolean {
	if (content.includes(0)) {
		return false;
	}

	const sample = content.subarray(0, Math.min(content.length, 4096));
	let suspiciousByteCount = 0;
	for (const byte of sample) {
		if (byte === 9 || byte === 10 || byte === 13) {
			continue;
		}
		if (byte >= 32) {
			continue;
		}
		suspiciousByteCount += 1;
	}

	return suspiciousByteCount / Math.max(sample.length, 1) < 0.02;
}
