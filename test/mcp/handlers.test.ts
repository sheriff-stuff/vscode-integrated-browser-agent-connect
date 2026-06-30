import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMockBridge, SCREENSHOT_BASE64, type MockBridge } from './mock-bridge.ts';

// Repo root = two levels up from this file (test/mcp/).
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// Drives the BUILT MCP server (dist/mcp-server.mjs) through a real MCP client,
// pointed at the mock bridge via BROWSER_BRIDGE_PORT. Asserts that each tool
// handler builds the expected HTTP method/path/query/body and shapes its result.

type ToolResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	isError?: boolean;
};

const textOf = (r: ToolResult) => {
	assert.equal(r.content[0]?.type, 'text', 'expected a text content block');
	return r.content[0].text ?? '';
};

test('MCP tool handlers drive the bridge correctly', { timeout: 60_000 }, async (t) => {
	const mock: MockBridge = await startMockBridge();

	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['dist/mcp-server.mjs'],
		cwd: repoRoot,
		env: { ...process.env, BROWSER_BRIDGE_PORT: String(mock.port) },
	});
	const client = new Client({ name: 'mcp-handlers-test', version: '0.0.0' });

	const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
		(await client.callTool({ name, arguments: args })) as unknown as ToolResult;

	try {
		await client.connect(transport);

		await t.test('browser_navigate -> POST /navigate', async () => {
			const r = await call('browser_navigate', { url: 'https://example.com', tabId: 't1' });
			const req = mock.last();
			assert.equal(req.method, 'POST');
			assert.equal(req.path, '/navigate');
			assert.deepEqual(req.body, { url: 'https://example.com', tabId: 't1' });
			textOf(r);
		});

		await t.test('browser_eval -> POST /eval', async () => {
			const r = await call('browser_eval', { expression: 'document.title', tabId: 't1' });
			const req = mock.last();
			assert.equal(req.method, 'POST');
			assert.equal(req.path, '/eval');
			assert.deepEqual(req.body, { expression: 'document.title', tabId: 't1' });
			textOf(r);
		});

		await t.test('browser_click -> POST /click', async () => {
			const r = await call('browser_click', { selector: '#go' });
			const req = mock.last();
			assert.equal(req.method, 'POST');
			assert.equal(req.path, '/click');
			assert.equal((req.body as { selector: string }).selector, '#go');
			textOf(r);
		});

		await t.test('browser_type -> POST /type', async () => {
			const r = await call('browser_type', { selector: 'input', text: 'hello' });
			const req = mock.last();
			assert.equal(req.method, 'POST');
			assert.equal(req.path, '/type');
			assert.equal((req.body as { selector: string }).selector, 'input');
			assert.equal((req.body as { text: string }).text, 'hello');
			textOf(r);
		});

		await t.test('browser_scroll -> POST /scroll', async () => {
			const r = await call('browser_scroll', { deltaX: 10, deltaY: 20, selector: '#pane' });
			const req = mock.last();
			assert.equal(req.method, 'POST');
			assert.equal(req.path, '/scroll');
			assert.equal((req.body as { deltaX: number }).deltaX, 10);
			assert.equal((req.body as { deltaY: number }).deltaY, 20);
			assert.equal((req.body as { selector: string }).selector, '#pane');
			textOf(r);
		});

		await t.test('browser_screenshot -> GET /screenshot (image block + query)', async () => {
			const r = await call('browser_screenshot', { fullPage: true, waitMs: 500, tabId: 't' });
			const req = mock.last();
			assert.equal(req.method, 'GET');
			assert.equal(req.path, '/screenshot');
			assert.deepEqual(req.query, { fullPage: 'true', waitMs: '500', tabId: 't' });
			assert.equal(r.content[0]?.type, 'image');
			assert.equal(r.content[0]?.mimeType, 'image/png');
			assert.equal(r.content[0]?.data, SCREENSHOT_BASE64);
		});

		await t.test('browser_emulate -> POST /emulate', async () => {
			const r = await call('browser_emulate', { width: 390, height: 844, mobile: true });
			const req = mock.last();
			assert.equal(req.method, 'POST');
			assert.equal(req.path, '/emulate');
			assert.equal((req.body as { width: number }).width, 390);
			assert.equal((req.body as { height: number }).height, 844);
			assert.equal((req.body as { mobile: boolean }).mobile, true);
			textOf(r);
		});

		await t.test('browser_snapshot -> GET /snapshot (tabId in query)', async () => {
			const r = await call('browser_snapshot', { tabId: 't9' });
			const req = mock.last();
			assert.equal(req.method, 'GET');
			assert.equal(req.path, '/snapshot');
			assert.deepEqual(req.query, { tabId: 't9' });
			textOf(r);
		});

		await t.test('browser_dom -> GET /dom', async () => {
			const r = await call('browser_dom', {});
			const req = mock.last();
			assert.equal(req.method, 'GET');
			assert.equal(req.path, '/dom');
			textOf(r);
		});

		await t.test('browser_console -> GET /console (limit + tabId query)', async () => {
			const r = await call('browser_console', { limit: 25, tabId: 't3' });
			const req = mock.last();
			assert.equal(req.method, 'GET');
			assert.equal(req.path, '/console');
			assert.equal(req.query.limit, '25');
			assert.equal(req.query.tabId, 't3');
			textOf(r);
		});

		await t.test('browser_network -> GET /network (limit + filter + tabId query)', async () => {
			const r = await call('browser_network', { limit: 10, filter: 'api', tabId: 't4' });
			const req = mock.last();
			assert.equal(req.method, 'GET');
			assert.equal(req.path, '/network');
			assert.equal(req.query.limit, '10');
			assert.equal(req.query.filter, 'api');
			assert.equal(req.query.tabId, 't4');
			textOf(r);
		});

		await t.test('browser_network_clear -> POST /network/clear', async () => {
			const r = await call('browser_network_clear', { tabId: 't4' });
			const req = mock.last();
			assert.equal(req.method, 'POST');
			assert.equal(req.path, '/network/clear');
			assert.equal(req.query.tabId, 't4');
			textOf(r);
		});

		await t.test('browser_url -> GET /url', async () => {
			const r = await call('browser_url', { tabId: 't5' });
			const req = mock.last();
			assert.equal(req.method, 'GET');
			assert.equal(req.path, '/url');
			assert.equal(req.query.tabId, 't5');
			textOf(r);
		});

		await t.test('browser_status -> GET /status', async () => {
			const r = await call('browser_status', {});
			const req = mock.last();
			assert.equal(req.method, 'GET');
			assert.equal(req.path, '/status');
			textOf(r);
		});

		await t.test('browser_tab_open -> POST /tab/open', async () => {
			const r = await call('browser_tab_open', { url: 'https://a.test', makeActive: false });
			const req = mock.last();
			assert.equal(req.method, 'POST');
			assert.equal(req.path, '/tab/open');
			assert.equal((req.body as { url: string }).url, 'https://a.test');
			assert.equal((req.body as { makeActive: boolean }).makeActive, false);
			textOf(r);
		});

		await t.test('browser_tab_close -> POST /tab/close/:id (id in path)', async () => {
			const r = await call('browser_tab_close', { tabId: 't' });
			const req = mock.last();
			assert.equal(req.method, 'POST');
			assert.equal(req.path, '/tab/close/t');
			textOf(r);
		});

		await t.test('browser_tab_list -> GET /tabs', async () => {
			const r = await call('browser_tab_list', {});
			const req = mock.last();
			assert.equal(req.method, 'GET');
			assert.equal(req.path, '/tabs');
			textOf(r);
		});

		await t.test('browser_tab_activate -> POST /tab/activate/:id (id in path)', async () => {
			const r = await call('browser_tab_activate', { tabId: 't' });
			const req = mock.last();
			assert.equal(req.method, 'POST');
			assert.equal(req.path, '/tab/activate/t');
			textOf(r);
		});

		await t.test('error path -> isError + "Error: boom" text', async () => {
			mock.setError('/status', 'boom');
			try {
				const r = await call('browser_status', {});
				assert.equal(r.isError, true);
				assert.equal(textOf(r), 'Error: boom');
			} finally {
				mock.clearError('/status');
			}
		});
	} finally {
		await client.close().catch(() => {});
		await transport.close().catch(() => {});
		await mock.stop().catch(() => {});
	}
});
