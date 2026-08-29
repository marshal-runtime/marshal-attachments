import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
	},
	test: {
		include: ['__tests__/**/*.spec.ts'],
		globals: false,
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
