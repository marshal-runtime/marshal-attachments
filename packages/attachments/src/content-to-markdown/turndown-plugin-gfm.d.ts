declare module 'turndown-plugin-gfm' {
	import type TurndownService from 'turndown';

	export function gfm(service: TurndownService): void;

	const plugin: {
		gfm: typeof gfm;
	};

	export default plugin;
}
