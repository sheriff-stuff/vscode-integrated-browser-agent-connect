// SPIKE integration test: can the @vscode/test-electron harness launch this
// extension and drive the VS Code integrated browser (/navigate + /eval)?
const assert = require('assert');
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_ID = 'sheriff-stuff.integrated-browser-agent-connect';
const INSTANCES_DIR = path.join(os.homedir(), '.integrated-browser-agent-connect', 'instances');

function log(...args) {
	console.log('[SPIKE]', ...args);
}

async function sleep(ms) {
	return new Promise(r => setTimeout(r, ms));
}

// Find the bound HTTP port: prefer the instance JSON files, else probe 3788+.
async function discoverPort() {
	// 1. instance files
	try {
		const files = fs.readdirSync(INSTANCES_DIR).filter(f => f.endsWith('.json'));
		for (const f of files) {
			try {
				const data = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, f), 'utf-8'));
				if (data.port && data.pid === process.pid) {
					log('Found instance file for our pid with port', data.port);
					return data.port;
				}
			} catch { /* ignore */ }
		}
		// fallback: any instance file
		for (const f of files) {
			try {
				const data = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, f), 'utf-8'));
				if (data.port) {
					log('Found instance file (any pid) with port', data.port);
					return data.port;
				}
			} catch { /* ignore */ }
		}
	} catch { /* dir may not exist */ }

	// 2. probe ports
	for (let p = 3788; p < 3808; p++) {
		try {
			const res = await fetch(`http://127.0.0.1:${p}/status`);
			if (res.ok) {
				const body = await res.json();
				if (body && body.ok) {
					log('Probed live /status on port', p);
					return p;
				}
			}
		} catch { /* not listening */ }
	}
	return null;
}

async function post(port, route, body) {
	const res = await fetch(`http://127.0.0.1:${port}${route}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return res.json();
}

async function get(port, route) {
	const res = await fetch(`http://127.0.0.1:${port}${route}`);
	return res.json();
}

describe('integrated-browser-agent-connect spike', function () {
	this.timeout(180000);
	let port = null;

	it('activates the extension and starts the HTTP server (/status)', async () => {
		const ext = vscode.extensions.getExtension(EXT_ID);
		assert.ok(ext, `extension ${EXT_ID} not found`);
		await ext.activate();
		log('Extension activated');

		// Poll for the HTTP server / instance file (autoStart on activation).
		for (let i = 0; i < 60 && port === null; i++) {
			port = await discoverPort();
			if (port === null) await sleep(500);
		}
		assert.ok(port, 'could not discover HTTP port (server never came up)');
		log('Using port', port);

		const status = await get(port, '/status');
		log('/status =>', JSON.stringify(status));
		assert.strictEqual(status.ok, true, '/status did not return ok:true');
	});

	it('drives the integrated browser: /navigate + /eval', async () => {
		assert.ok(port, 'no port from previous test');

		// Use a data: URL so the test does not depend on network access.
		const dataUrl = 'data:text/html,<!doctype html><html><head><title>SpikeTitle</title></head><body><h1>hello-spike</h1></body></html>';
		log('POST /navigate', dataUrl.slice(0, 40), '...');
		const nav = await post(port, '/navigate', { url: dataUrl });
		log('/navigate =>', JSON.stringify(nav));
		assert.strictEqual(nav.ok, true, `/navigate failed: ${JSON.stringify(nav)}`);

		// Wait for document to finish loading.
		let ready = null;
		for (let i = 0; i < 40; i++) {
			const r = await post(port, '/eval', { expression: 'document.readyState' });
			if (r.ok) {
				ready = r.data;
				log(`readyState[${i}] =>`, ready);
				if (ready === 'complete' || ready === 'interactive') break;
			} else {
				log(`eval readyState[${i}] error =>`, JSON.stringify(r));
			}
			await sleep(250);
		}

		const titleRes = await post(port, '/eval', { expression: 'document.title' });
		log('/eval document.title =>', JSON.stringify(titleRes));
		const h1Res = await post(port, '/eval', { expression: 'document.querySelector("h1")?.textContent' });
		log('/eval h1 text =>', JSON.stringify(h1Res));
		const mathRes = await post(port, '/eval', { expression: '6 * 7' });
		log('/eval 6*7 =>', JSON.stringify(mathRes));

		assert.strictEqual(mathRes.ok, true, `/eval(6*7) failed: ${JSON.stringify(mathRes)}`);
		assert.strictEqual(mathRes.data, 42, 'eval math did not return 42');

		assert.strictEqual(titleRes.ok, true, `/eval(title) failed: ${JSON.stringify(titleRes)}`);
		// VS Code's integrated browser may prefix the title with a tab badge
		// like "(1) ", so assert containment rather than equality.
		assert.ok(
			typeof titleRes.data === 'string' && titleRes.data.includes('SpikeTitle'),
			`unexpected title: ${JSON.stringify(titleRes.data)}`,
		);

		assert.strictEqual(h1Res.ok, true, `/eval(h1) failed: ${JSON.stringify(h1Res)}`);
		assert.strictEqual(h1Res.data, 'hello-spike', `unexpected h1: ${JSON.stringify(h1Res.data)}`);

		log('SUCCESS: navigate + eval returned correct values from the integrated browser');
	});

	it('captures a screenshot PNG — the core "see the change" capability', async () => {
		assert.ok(port, 'no port from previous test');
		const res = await get(port, '/screenshot');
		assert.strictEqual(res.ok, true, `/screenshot failed: ${JSON.stringify(res).slice(0, 200)}`);
		// base64-encoded PNG starts with the signature "iVBORw0KGgo".
		assert.ok(
			typeof res.data === 'string' && res.data.startsWith('iVBORw0KGgo'),
			'screenshot did not return a PNG',
		);
		log('screenshot OK, base64 length:', res.data.length);
	});

	it('emulate applies viewport width (verify without mobile on a bare page)', async () => {
		assert.ok(port, 'no port from previous test');
		// Non-responsive page; with no emulation innerWidth tracks the pane.
		const dataUrl = 'data:text/html,<!doctype html><html><body>w</body></html>';
		await post(port, '/navigate', { url: dataUrl });
		await sleep(300);
		const before = await post(port, '/eval', { expression: 'window.innerWidth' });
		const em = await post(port, '/emulate', { width: 390, height: 844 });
		await sleep(150);
		const after = await post(port, '/eval', { expression: 'window.innerWidth' });
		const path = em.data && em.data.path;
		log(`emulate innerWidth before=${before.data} after=${after.data} path=${path}`);
		await post(port, '/emulate', { reset: true });
		assert.strictEqual(after.data, 390, `emulate width not applied (got ${after.data}, path=${path})`);
	});

	it('removed endpoints are gone (404)', async () => {
		assert.ok(port, 'no port from previous test');
		for (const route of ['/markdown', '/screenshot-slice', '/downloads']) {
			const r = await fetch(`http://127.0.0.1:${port}${route}`);
			log(`GET ${route} =>`, r.status);
			assert.strictEqual(r.status, 404, `${route} should be removed (got ${r.status})`);
		}
		const ds = await fetch(`http://127.0.0.1:${port}/download/set`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
		});
		log('POST /download/set =>', ds.status);
		assert.strictEqual(ds.status, 404, `/download/set should be removed (got ${ds.status})`);
	});
});
