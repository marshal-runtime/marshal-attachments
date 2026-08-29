import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	resolve: {
		alias: {
			'@marshal/attachments/content-to-markdown': fileURLToPath(
				new URL('../attachments/src/content-to-markdown/index.ts', import.meta.url),
			),
		},
	},
	test: {
		include: ['__tests__/**/*.spec.ts'],
		globals: false,
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
