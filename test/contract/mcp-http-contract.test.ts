import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeServer } from '../../src/http-server.ts';

// Canonical tool -> HTTP endpoint table. Verified against src/mcp-server.ts.
// Drift guard: every MCP tool must hit a route the bridge actually serves.
const TABLE: Array<{ tool: string; method: 'GET' | 'POST'; path: string }> = [
	{ tool: 'browser_navigate', method: 'POST', path: '/navigate' },
	{ tool: 'browser_eval', method: 'POST', path: '/eval' },
	{ tool: 'browser_click', method: 'POST', path: '/click' },
	{ tool: 'browser_type', method: 'POST', path: '/type' },
	{ tool: 'browser_scroll', method: 'POST', path: '/scroll' },
	{ tool: 'browser_screenshot', method: 'GET', path: '/screenshot' },
	{ tool: 'browser_emulate', method: 'POST', path: '/emulate' },
	{ tool: 'browser_snapshot', method: 'GET', path: '/snapshot' },
	{ tool: 'browser_dom', method: 'GET', path: '/dom' },
	{ tool: 'browser_console', method: 'GET', path: '/console' },
	{ tool: 'browser_network', method: 'GET', path: '/network' },
	{ tool: 'browser_network_clear', method: 'POST', path: '/network/clear' },
	{ tool: 'browser_url', method: 'GET', path: '/url' },
	{ tool: 'browser_status', method: 'GET', path: '/status' },
	{ tool: 'browser_tab_open', method: 'POST', path: '/tab/open' },
	{ tool: 'browser_tab_close', method: 'POST', path: '/tab/close/:tabId' },
	{ tool: 'browser_tab_list', method: 'GET', path: '/tabs' },
	{ tool: 'browser_tab_activate', method: 'POST', path: '/tab/activate/:tabId' },
];

// Minimal inline mock of CDPManager — owned by this test, kept tiny. Only needs
// enough surface to let every route run without throwing.
function makeMockCdp() {
	const tab = {
		tabId: 't',
		url: '',
		title: '',
		// All CDP commands resolve to a benign shape covering every route's
		// destructuring: { result: { value } }, { nodes }, { data }.
		async send(_method: string, _params?: unknown) {
			return { result: { value: '' }, nodes: [], data: '' };
		},
	};
	return {
		state: 'connected',
		transport: 'mock',
		activeTabId: 't',
		pageSessionId: 'sess',
		tabCount: 1,
		children: [],
		events: {},
		console: [] as unknown[],
		network: [] as unknown[],
		getTab(_tabId?: string) { return tab; },
		list() { return []; },
		consoleForTab(_tabId: string) { return []; },
		networkForTab(_tabId: string) { return []; },
		clearNetwork(_tabId?: string) { /* no-op */ },
		async openTab(_url: string, _makeActive?: boolean) { return { tabId: 't', url: '', title: '' }; },
		async closeTab(_tabId: string) { /* no-op */ },
		activate(_tabId: string) { /* no-op */ },
	};
}

const noopLog = { appendLine(_msg: string) { /* no-op */ } };

test('every MCP tool maps to a served bridge route (no 404)', { timeout: 30_000 }, async (t) => {
	// Table integrity.
	assert.equal(TABLE.length, 18, 'table must have exactly 18 entries');
	const tools = TABLE.map(r => r.tool);
	assert.equal(new Set(tools).size, 18, 'tool names must be unique');

	// Start the real BridgeServer on an ephemeral port (0).
	const cdp = makeMockCdp();
	const server = new BridgeServer(cdp as never, noopLog as never);
	// start(0) binds an OS-assigned ephemeral port; read the actual port from the
	// getter (the return value echoes the literal preferred port, here 0).
	await server.start(0);
	const port = server.port;
	assert.ok(port && port > 0, 'server did not bind an ephemeral port');
	const base = `http://127.0.0.1:${port}`;

	t.after(async () => { await server.stop(); });

	for (const row of TABLE) {
		const reqPath = row.path.replace(':tabId', 't');
		const init: RequestInit = { method: row.method };
		if (row.method === 'POST') {
			init.headers = { 'Content-Type': 'application/json' };
			init.body = '{}';
		}
		const res = await fetch(`${base}${reqPath}`, init);

		// A served route never 404s and always returns { ok: boolean } JSON.
		// An unregistered route yields an Express 404.
		assert.notEqual(res.status, 404, `${row.tool} -> ${row.method} ${reqPath} returned 404 (route not served)`);
		const body = await res.json() as { ok?: unknown };
		assert.equal(typeof body.ok, 'boolean', `${row.tool} -> ${row.method} ${reqPath} body has no boolean ok field`);
	}
});
