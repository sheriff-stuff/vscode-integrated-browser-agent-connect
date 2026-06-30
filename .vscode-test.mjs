import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'test/**/*.test.js',
	version: 'stable',
	mocha: {
		ui: 'bdd',
		timeout: 180000,
	},
});
