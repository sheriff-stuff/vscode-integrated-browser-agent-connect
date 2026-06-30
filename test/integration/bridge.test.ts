import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import { BridgeServer } from '../../src/http-server.ts';
import type { CDPManager } from '../../src/cdp.ts';
import {
	createMockCDP,
	type MockCDP,
	type MockTab,
	type MockLog,
	type MockCDPOptions,
	type ConsoleEntry,
	type NetworkEntry,
} from '../helpers/mock-cdp.ts';

interface Ctx {
	base: string;
	cdp: MockCDP;
	tab: MockTab;
	log: MockLog;
	server: BridgeServer;
}

/**
 * Start a real BridgeServer on a random free port (port 0), run the test body
 * against it over HTTP, then always stop the server so the process exits.
 */
async function withServer(opts: MockCDPOptions, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
	const { cdp, tab, log } = createMockCDP(opts);
	const server = new BridgeServer(cdp as unknown as CDPManager, log as unknown as vscode.OutputChannel);
	await server.start(0);
	const port = server.port;
	assert.ok(typeof port === 'number' && port > 0, 'server.port should be a real chosen port');
	const base = `http://127.0.0.1:${port}`;
	try {
		await fn({ base, cdp, tab, log, server });
	} finally {
		await server.stop();
	}
}

interface ApiResult {
	ok: boolean;
	data?: unknown;
	error?: string;
}

async function get(base: string, path: string): Promise<ApiResult> {
	const res = await fetch(base + path);
	return res.json() as Promise<ApiResult>;
}

async function post(base: string, path: string, body?: unknown): Promise<ApiResult> {
	const res = await fetch(base + path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body ?? {}),
	});
	return res.json() as Promise<ApiResult>;
}

// ---------- /status ----------

test('/status reports connected state and mock counts', async () => {
	await withServer({ console: [{ type: 'log', text: 'a', timestamp: 1 }], tabCount: 2 }, async ({ base }) => {
		const r = await get(base, '/status');
		assert.equal(r.ok, true);
		const data = r.data as Record<string, unknown>;
		assert.equal(data.cdp, 'connected');
		assert.equal(data.server, true);
		assert.equal(data.transport, 'browserTab');
		assert.equal(data.tabCount, 2);
		assert.equal(data.consoleBufferSize, 1);
		assert.equal(data.pageSessionId, 'page-session-1');
	});
});

// ---------- /tabs ----------

test('/tabs returns cdp.list() output', async () => {
	await withServer({}, async ({ base, cdp }) => {
		const r = await get(base, '/tabs');
		assert.equal(r.ok, true);
		assert.deepEqual(r.data, cdp.list());
	});
});

// ---------- /navigate ----------

test('/navigate missing url -> error', async () => {
	await withServer({}, async ({ base }) => {
		const r = await post(base, '/navigate', {});
		assert.deepEqual(r, { ok: false, error: 'Missing url' });
	});
});

test('/navigate valid -> returns Page.navigate result', async () => {
	await withServer({}, async ({ base }) => {
		const r = await post(base, '/navigate', { url: 'http://example.com' });
		assert.equal(r.ok, true);
		assert.deepEqual(r.data, { frameId: 'f1' });
	});
});

// ---------- /eval ----------

test('/eval missing expression -> error', async () => {
	await withServer({}, async ({ base }) => {
		const r = await post(base, '/eval', {});
		assert.deepEqual(r, { ok: false, error: 'Missing expression' });
	});
});

test('/eval exceptionDetails -> ok:false with description', async () => {
	await withServer({}, async ({ base, tab }) => {
		tab.responses['Runtime.evaluate'] = {
			result: { description: 'ReferenceError: boom is not defined' },
			exceptionDetails: { exceptionId: 1 },
		};
		const r = await post(base, '/eval', { expression: 'boom' });
		assert.equal(r.ok, false);
		assert.equal(r.error, 'ReferenceError: boom is not defined');
	});
});

test('/eval success -> data equals evaluated value', async () => {
	await withServer({}, async ({ base, tab }) => {
		tab.evalValue = 42;
		const r = await post(base, '/eval', { expression: '40 + 2' });
		assert.equal(r.ok, true);
		assert.equal(r.data, 42);
	});
});

// ---------- /click ----------

test('/click element-not-found -> ok:false with error', async () => {
	await withServer({}, async ({ base, tab }) => {
		tab.responses['Runtime.evaluate'] = { result: { value: { error: 'Element not found: #x' } } };
		const r = await post(base, '/click', { selector: '#x' });
		assert.equal(r.ok, false);
		assert.equal(r.error, 'Element not found: #x');
	});
});

test('/click success -> data.clicked true', async () => {
	await withServer({}, async ({ base }) => {
		const r = await post(base, '/click', { selector: '#btn' });
		assert.equal(r.ok, true);
		assert.deepEqual(r.data, { clicked: true });
	});
});

// ---------- /type ----------

test('/type missing selector/text -> error', async () => {
	await withServer({}, async ({ base }) => {
		const r = await post(base, '/type', { selector: '#in' });
		assert.deepEqual(r, { ok: false, error: 'Missing selector or text' });
	});
});

test('/type success -> data.typed equals text length', async () => {
	await withServer({}, async ({ base, tab }) => {
		const r = await post(base, '/type', { selector: '#in', text: 'hello' });
		assert.equal(r.ok, true);
		assert.deepEqual(r.data, { typed: 5 });
		// Sanity: the actual text was forwarded via Input.insertText.
		const insert = tab.calls.find(c => c.method === 'Input.insertText');
		assert.deepEqual(insert?.params, { text: 'hello' });
	});
});

// ---------- /scroll ----------

test('/scroll window scroll -> ok', async () => {
	await withServer({}, async ({ base }) => {
		const r = await post(base, '/scroll', { deltaX: 0, deltaY: 200 });
		assert.equal(r.ok, true);
		assert.deepEqual(r.data, { scrolled: true });
	});
});

test('/scroll selector scroll -> ok', async () => {
	await withServer({}, async ({ base, tab }) => {
		const r = await post(base, '/scroll', { selector: '#pane', deltaY: 50 });
		assert.equal(r.ok, true);
		assert.deepEqual(r.data, { scrolled: true });
		const evalCall = tab.calls.find(c => c.method === 'Runtime.evaluate');
		assert.ok(String(evalCall?.params?.expression).includes('#pane'));
	});
});

// ---------- /emulate ----------

test('/emulate reset -> ok with data.reset', async () => {
	await withServer({}, async ({ base }) => {
		const r = await post(base, '/emulate', { reset: true });
		assert.equal(r.ok, true);
		assert.deepEqual(r.data, { reset: true });
	});
});

test('/emulate missing width/height -> error', async () => {
	await withServer({}, async ({ base }) => {
		const r = await post(base, '/emulate', { width: 800 });
		assert.equal(r.ok, false);
		assert.match(r.error ?? '', /Missing width and height/);
	});
});

test('/emulate success (probe matches) -> path emulation', async () => {
	await withServer({}, async ({ base, tab }) => {
		tab.innerWidth = 1280; // probe equals requested width -> Emulation path sticks
		const r = await post(base, '/emulate', { width: 1280, height: 800 });
		assert.equal(r.ok, true);
		const data = r.data as Record<string, unknown>;
		assert.equal(data.path, 'emulation');
		assert.equal(data.width, 1280);
		assert.equal(data.height, 800);
	});
});

test('/emulate fallback (probe mismatches) -> path page', async () => {
	await withServer({}, async ({ base, tab }) => {
		tab.innerWidth = 980; // probe != requested width -> falls back to Page path
		const r = await post(base, '/emulate', { width: 1280, height: 800 });
		assert.equal(r.ok, true);
		const data = r.data as Record<string, unknown>;
		assert.equal(data.path, 'page');
		assert.ok(tab.calls.some(c => c.method === 'Page.setDeviceMetricsOverride'));
	});
});

// ---------- /snapshot, /dom, /url ----------

test('/snapshot returns the AX nodes array', async () => {
	await withServer({}, async ({ base, tab }) => {
		const r = await get(base, '/snapshot');
		assert.equal(r.ok, true);
		assert.deepEqual(r.data, tab.axNodes);
	});
});

test('/dom returns the evaluated outerHTML', async () => {
	await withServer({}, async ({ base, tab }) => {
		tab.dom = '<html><body>snapshot</body></html>';
		const r = await get(base, '/dom');
		assert.equal(r.ok, true);
		assert.equal(r.data, '<html><body>snapshot</body></html>');
	});
});

test('/url returns the location string', async () => {
	await withServer({}, async ({ base, tab }) => {
		tab.locationHref = 'http://localhost:3000/dashboard';
		const r = await get(base, '/url');
		assert.equal(r.ok, true);
		assert.equal(r.data, 'http://localhost:3000/dashboard');
	});
});

// ---------- /console ----------

test('/console respects ?limit=', async () => {
	const entries: ConsoleEntry[] = Array.from({ length: 5 }, (_, i) => ({
		type: 'log',
		text: `m${i}`,
		timestamp: i,
	}));
	await withServer({ console: entries }, async ({ base }) => {
		const r = await get(base, '/console?limit=2');
		assert.equal(r.ok, true);
		const data = r.data as ConsoleEntry[];
		assert.equal(data.length, 2);
		assert.deepEqual(data.map(e => e.text), ['m3', 'm4']);
	});
});

test('/console respects ?tabId= (uses consoleForTab)', async () => {
	const tabEntries: ConsoleEntry[] = [{ type: 'error', text: 'tabonly', timestamp: 1, tabId: 'tab-main' }];
	await withServer({ consoleByTab: { 'tab-main': tabEntries } }, async ({ base }) => {
		const r = await get(base, '/console?tabId=tab-main');
		assert.equal(r.ok, true);
		assert.deepEqual(r.data, tabEntries);
	});
});

// ---------- /network ----------

test('/network respects ?limit=', async () => {
	const entries: NetworkEntry[] = Array.from({ length: 4 }, (_, i) => ({
		requestId: `r${i}`,
		method: 'GET',
		url: `http://x/${i}`,
		timestamp: i,
	}));
	await withServer({ network: entries }, async ({ base }) => {
		const r = await get(base, '/network?limit=1');
		const data = r.data as NetworkEntry[];
		assert.equal(data.length, 1);
		assert.equal(data[0].requestId, 'r3');
	});
});

test('/network respects ?filter= (substring on url)', async () => {
	const entries: NetworkEntry[] = [
		{ requestId: 'a', method: 'GET', url: 'http://x/api/users', timestamp: 1 },
		{ requestId: 'b', method: 'GET', url: 'http://x/static/app.js', timestamp: 2 },
		{ requestId: 'c', method: 'GET', url: 'http://x/api/orders', timestamp: 3 },
	];
	await withServer({ network: entries }, async ({ base }) => {
		const r = await get(base, '/network?filter=api');
		const data = r.data as NetworkEntry[];
		assert.deepEqual(data.map(e => e.requestId), ['a', 'c']);
	});
});

test('/network respects ?tabId= (uses networkForTab)', async () => {
	const tabEntries: NetworkEntry[] = [{ requestId: 'z', method: 'POST', url: 'http://x/z', timestamp: 1, tabId: 'tab-main' }];
	await withServer({ networkByTab: { 'tab-main': tabEntries } }, async ({ base }) => {
		const r = await get(base, '/network?tabId=tab-main');
		assert.deepEqual(r.data, tabEntries);
	});
});

// ---------- /network/clear ----------

test('/network/clear without tabId -> cleared:all', async () => {
	await withServer({}, async ({ base, cdp }) => {
		const r = await post(base, '/network/clear', {});
		assert.deepEqual(r.data, { cleared: 'all' });
		assert.deepEqual(cdp.clearNetworkCalls, [undefined]);
	});
});

test('/network/clear with ?tabId= -> cleared:<tabId>', async () => {
	await withServer({}, async ({ base, cdp }) => {
		const r = await post(base, '/network/clear?tabId=tab-main', {});
		assert.deepEqual(r.data, { cleared: 'tab-main' });
		assert.deepEqual(cdp.clearNetworkCalls, ['tab-main']);
	});
});

// ---------- /screenshot ----------

test('/screenshot default -> base64 with captureBeyondViewport:false', async () => {
	await withServer({}, async ({ base, tab }) => {
		const r = await get(base, '/screenshot');
		assert.equal(r.ok, true);
		assert.equal(r.data, 'BASE64');
		const cap = tab.calls.find(c => c.method === 'Page.captureScreenshot');
		assert.ok(cap, 'Page.captureScreenshot should have been called');
		assert.equal(cap?.params?.format, 'png');
		assert.equal(cap?.params?.captureBeyondViewport, false);
	});
});

test('/screenshot ?fullPage=true -> captureBeyondViewport:true', async () => {
	await withServer({}, async ({ base, tab }) => {
		const r = await get(base, '/screenshot?fullPage=true');
		assert.equal(r.ok, true);
		assert.equal(r.data, 'BASE64');
		const cap = tab.calls.find(c => c.method === 'Page.captureScreenshot');
		assert.equal(cap?.params?.captureBeyondViewport, true);
	});
});

test('/screenshot ?waitMs=50 -> still returns ok', async () => {
	await withServer({}, async ({ base, tab }) => {
		const r = await get(base, '/screenshot?waitMs=50');
		assert.equal(r.ok, true);
		assert.equal(r.data, 'BASE64');
		assert.ok(tab.calls.some(c => c.method === 'Page.captureScreenshot'));
	});
});

// ---------- /tab/open ----------

test('/tab/open missing url -> error', async () => {
	await withServer({}, async ({ base }) => {
		const r = await post(base, '/tab/open', {});
		assert.deepEqual(r, { ok: false, error: 'Missing url' });
	});
});

test('/tab/open valid -> returns openTab result, defaults makeActive true', async () => {
	await withServer({}, async ({ base, cdp }) => {
		const r = await post(base, '/tab/open', { url: 'http://example.com' });
		assert.equal(r.ok, true);
		const data = r.data as Record<string, unknown>;
		assert.equal(data.tabId, 'tab-new');
		assert.equal(data.url, 'http://example.com');
		assert.equal(data.title, 'Test Page');
		assert.deepEqual(cdp.openTabCalls, [{ url: 'http://example.com', makeActive: true }]);
	});
});

test('/tab/open makeActive:false -> passed through', async () => {
	await withServer({}, async ({ base, cdp }) => {
		const r = await post(base, '/tab/open', { url: 'http://example.com', makeActive: false });
		assert.equal(r.ok, true);
		assert.deepEqual(cdp.openTabCalls, [{ url: 'http://example.com', makeActive: false }]);
	});
});

// ---------- /tab/close/:tabId ----------

test('/tab/close/:tabId success -> closed:<id> and closeTab called', async () => {
	await withServer({}, async ({ base, cdp }) => {
		const r = await post(base, '/tab/close/tab-main', {});
		assert.equal(r.ok, true);
		assert.deepEqual(r.data, { closed: 'tab-main' });
		assert.deepEqual(cdp.closeTabCalls, ['tab-main']);
	});
});

test('/tab/close/:tabId closeTab throws -> ok:false with error', async () => {
	await withServer({}, async ({ base, cdp }) => {
		cdp.closeTab = async () => { throw new Error('no such tab'); };
		const r = await post(base, '/tab/close/ghost', {});
		assert.equal(r.ok, false);
		assert.equal(r.error, 'no such tab');
	});
});

// ---------- /tab/activate/:tabId ----------

test('/tab/activate/:tabId success -> active:<id> and activate called', async () => {
	await withServer({}, async ({ base, cdp }) => {
		const r = await post(base, '/tab/activate/tab-main', {});
		assert.equal(r.ok, true);
		assert.deepEqual(r.data, { active: 'tab-main' });
		assert.deepEqual(cdp.activateCalls, ['tab-main']);
	});
});

test('/tab/activate/:tabId activate throws -> ok:false with error', async () => {
	await withServer({}, async ({ base, cdp }) => {
		cdp.activate = () => { throw new Error('No tab: ghost'); };
		const r = await post(base, '/tab/activate/ghost', {});
		assert.equal(r.ok, false);
		assert.equal(r.error, 'No tab: ghost');
	});
});

// ---------- tab resolution ----------

test('unknown tabId -> No tab with id <id>', async () => {
	await withServer({}, async ({ base }) => {
		const r = await post(base, '/eval', { expression: '1', tabId: 'ghost' });
		assert.equal(r.ok, false);
		assert.equal(r.error, 'No tab with id ghost');
	});
});

// ---------- requireAnyTab guard ----------

test('CDP not connected -> guarded endpoint errors', async () => {
	// tabCount > 0 so the lazy-launch branch is skipped (no ensureBrowser set),
	// then the state guard short-circuits with the connection error.
	await withServer({ state: 'disconnected', tabCount: 1 }, async ({ base }) => {
		const r = await post(base, '/eval', { expression: '1' });
		assert.deepEqual(r, { ok: false, error: 'CDP not connected' });
	});
});
