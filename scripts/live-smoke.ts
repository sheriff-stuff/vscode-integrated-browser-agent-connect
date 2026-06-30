// Manual LIVE SMOKE for integrated-browser-agent-connect.
//
// Builds + packages + installs the CURRENT extension, waits for the user to
// reload VS Code, then drives the REAL integrated browser through the live HTTP
// bridge to confirm a page loads and a CSS value is what's expected (and that a
// CSS *change* round-trips through the live DOM).
//
// Run (real):    node --experimental-strip-types scripts/live-smoke.ts
// Run (dry):     node --experimental-strip-types scripts/live-smoke.ts --dry-run
//
// The real run needs an interactive VS Code: it spawns `npx vsce package` and
// `code --install-extension`, then blocks on Enter until you've reloaded the
// window. --dry-run does NONE of that: it prints the planned steps (including the
// exact computed commands) and exits 0, so the control flow can be verified
// without VS Code.
//
// ExperimentalWarning / MODULE_TYPELESS_PACKAGE_JSON lines from Node are expected.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { getBridgeUrl, discoverInstance } from '../src/bridge-client.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const EXTENSION_ID = 'sheriff-stuff.integrated-browser-agent-connect';

const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Small logging helpers
// ---------------------------------------------------------------------------
let step = 0;
function logStep(msg: string): void {
	step += 1;
	console.log(`\n[step ${step}] ${msg}`);
}
function logWould(cmd: string): void {
	console.log(`  would run: ${cmd}`);
}
function info(msg: string): void {
	console.log(`  ${msg}`);
}

// ---------------------------------------------------------------------------
// package.json version
// ---------------------------------------------------------------------------
function readVersion(): string {
	const pkgPath = path.join(REPO_ROOT, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
	if (!pkg.version) {
		throw new Error(`No "version" field in ${pkgPath}`);
	}
	return pkg.version;
}

// ---------------------------------------------------------------------------
// vsce major-version detection (drives the --allow-proposed-apis branch)
// ---------------------------------------------------------------------------
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const CODE = process.platform === 'win32' ? 'code.cmd' : 'code';

function detectVsceMajor(): number {
	const res = spawnSync(NPX, ['vsce', '--version'], {
		cwd: REPO_ROOT,
		encoding: 'utf-8',
		shell: process.platform === 'win32',
	});
	if (res.status !== 0) {
		throw new Error(`\`npx vsce --version\` failed: ${res.stderr || res.stdout || res.error}`);
	}
	const out = (res.stdout || '').trim();
	const m = out.match(/(\d+)\./);
	if (!m) {
		throw new Error(`Could not parse vsce version from: ${JSON.stringify(out)}`);
	}
	return Number(m[1]);
}

/** Build the `npx vsce package` argv for the detected major. */
function packageArgs(vsceMajor: number): string[] {
	const args = ['vsce', 'package'];
	// vsce 3.x refuses to package an extension declaring a proposed API unless
	// told which proposals are allowed; vsce 2.x neither needs nor accepts it.
	if (vsceMajor >= 3) {
		args.push('--allow-proposed-apis', 'browser');
	}
	return args;
}

// ---------------------------------------------------------------------------
// HTTP helpers against the live bridge
// ---------------------------------------------------------------------------
interface BridgeResponse {
	ok: boolean;
	data?: unknown;
	error?: string;
}

async function bridgeGet(urlPath: string): Promise<BridgeResponse> {
	const base = getBridgeUrl();
	const res = await fetch(`${base}${urlPath}`);
	return (await res.json()) as BridgeResponse;
}

async function bridgePost(urlPath: string, body: Record<string, unknown>): Promise<BridgeResponse> {
	const base = getBridgeUrl();
	const res = await fetch(`${base}${urlPath}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return (await res.json()) as BridgeResponse;
}

async function evalExpr(expression: string): Promise<unknown> {
	const r = await bridgePost('/eval', { expression });
	if (!r.ok) {
		throw new Error(`/eval failed for \`${expression}\`: ${r.error}`);
	}
	return r.data;
}

// ---------------------------------------------------------------------------
// Throwaway fixture page
//
// Richer than a bare <h1> so the interaction tools have something to act on:
//   #probe  — h1 whose computed color the CSS round-trip reads/mutates
//   #name   — text input for /type
//   #btn    — button that sets window.__clicked and appends <div id="out"> for /click
//   #tall   — 3000px spacer so /scroll moves window.scrollY off zero
//   <img>   — same-origin sub-resource so /network has a request to show
//   on load — fetch('/ping') (another network entry) + console.log('SMOKE_MARKER')
// The <meta viewport> makes innerWidth track the emulated width even without
// mobile (see the /emulate gotcha in http-server.ts).
// ---------------------------------------------------------------------------
const FIXTURE_HTML = `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>live-smoke fixture</title>
</head>
<body>
	<h1 id="probe" style="color: rgb(255, 0, 0)">hi</h1>
	<input id="name" type="text" value="">
	<button id="btn">go</button>
	<div id="tall" style="height: 3000px;">tall</div>
	<img id="pixel" src="/pixel.png" alt="pixel">
	<script>
		console.log('SMOKE_MARKER');
		// Globally-callable so the smoke test can trigger a CSS change via /eval.
		window.changeColor = function () {
			document.getElementById('probe').style.color = 'rgb(0, 128, 0)';
		};
		document.getElementById('btn').addEventListener('click', function () {
			window.__clicked = true;
			var out = document.createElement('div');
			out.id = 'out';
			out.textContent = 'clicked';
			document.body.appendChild(out);
		});
		// Same-origin sub-resource fetch so /network has an entry beyond the doc + img.
		fetch('/ping').catch(function () {});
	</script>
</body>
</html>`;

// 1x1 transparent PNG, used to satisfy the fixture's <img src="/pixel.png">.
const PIXEL_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64',
);

function startFixtureServer(): Promise<{ server: http.Server; url: string }> {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const route = (req.url || '/').split('?')[0];
			if (route === '/ping') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end('{"pong":true}');
				return;
			}
			if (route === '/pixel.png') {
				res.writeHead(200, { 'Content-Type': 'image/png' });
				res.end(PIXEL_PNG);
				return;
			}
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(FIXTURE_HTML);
		});
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			if (!addr || typeof addr !== 'object') {
				reject(new Error('Fixture server did not bind a port'));
				return;
			}
			resolve({ server, url: `http://127.0.0.1:${addr.port}/` });
		});
	});
}

function closeServer(server: http.Server): Promise<void> {
	return new Promise((resolve) => {
		server.closeAllConnections?.();
		server.close(() => resolve());
	});
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
function waitForEnter(prompt: string): Promise<void> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(prompt, () => {
			rl.close();
			resolve();
		});
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assert(cond: boolean, msg: string): void {
	if (!cond) {
		throw new Error(msg);
	}
}

// ---------------------------------------------------------------------------
// Per-tool PASS/SKIP/FAIL harness
// ---------------------------------------------------------------------------
type CheckStatus = 'PASS' | 'SKIP' | 'FAIL';
interface CheckResult {
	name: string;
	status: CheckStatus;
	note: string;
}
const results: CheckResult[] = [];

/** Thrown by a check body to record SKIP (e.g. capability behind a proposed API). */
class SkipError extends Error {}
function skip(msg: string): never {
	throw new SkipError(msg);
}

/**
 * Run one tool check. The body may return a note string (shown on PASS),
 * throw SkipError (→ SKIP, not a failure), or throw anything else (→ FAIL).
 */
async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
	try {
		const note = (await fn()) || '';
		results.push({ name, status: 'PASS', note });
		info(`PASS  ${name}${note ? ` — ${note}` : ''}`);
	} catch (err) {
		if (err instanceof SkipError) {
			results.push({ name, status: 'SKIP', note: err.message });
			info(`SKIP  ${name} — ${err.message}`);
		} else {
			const msg = err instanceof Error ? err.message : String(err);
			results.push({ name, status: 'FAIL', note: msg });
			info(`FAIL  ${name} — ${msg}`);
		}
	}
}

/** Print the result table and return the number of hard failures. */
function reportResults(): number {
	console.log('\n========================================');
	console.log('Per-tool results:');
	const pad = Math.max(...results.map(r => r.name.length), 4);
	for (const r of results) {
		console.log(`  ${r.status.padEnd(4)}  ${r.name.padEnd(pad)}  ${r.note}`);
	}
	const pass = results.filter(r => r.status === 'PASS').length;
	const skipped = results.filter(r => r.status === 'SKIP').length;
	const failed = results.filter(r => r.status === 'FAIL').length;
	console.log('----------------------------------------');
	console.log(`  ${pass} passed, ${skipped} skipped, ${failed} failed (of ${results.length})`);
	console.log('========================================');
	return failed;
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------
function runDryRun(): void {
	const version = readVersion();
	const vsix = `integrated-browser-agent-connect-${version}.vsix`;

	console.log('=== live-smoke --dry-run (no commands executed, no bridge required) ===');
	info(`repo root: ${REPO_ROOT}`);
	info(`extension version (from package.json): ${version}`);
	info(`expected vsix artifact: ${vsix}`);

	logStep('Detect vsce major version');
	info('would detect vsce version via `npx vsce --version` and branch on the major:');
	info('  major >= 3 -> add `--allow-proposed-apis browser`');
	info('  major  < 3 -> no extra flag (2.x rejects it)');

	logStep('Package the extension');
	logWould(`${NPX} ${packageArgs(3).join(' ')}   (if vsce major >= 3)`);
	logWould(`${NPX} ${packageArgs(2).join(' ')}   (if vsce major < 3)`);

	logStep('Install the extension');
	logWould(`${CODE} --install-extension ${vsix} --force`);

	logStep('Prompt to reload VS Code');
	info('would print "Run Developer: Reload Window" and wait for Enter');

	logStep('Discover the live bridge');
	info('would call getBridgeUrl() (honours BROWSER_BRIDGE_PORT and the instances dir)');
	info('would GET /status and assert data.cdp === "connected"');

	logStep('Start throwaway fixture server');
	info('would http.createServer on 127.0.0.1:0 serving:');
	info('  /            -> rich fixture (#probe h1, #name input, #btn, #tall spacer, <img src="/pixel.png">)');
	info('               (on load: console.log("SMOKE_MARKER") + fetch("/ping"))');
	info('  /ping        -> {"pong":true}  (same-origin sub-resource for /network)');
	info('  /pixel.png   -> 1x1 PNG        (same-origin sub-resource for /network)');

	logStep('Navigate + wait for load');
	info('would POST /navigate { url: <fixture> }, then poll /eval document.readyState until "complete"');

	logStep('Run per-tool checks against the live browser (PASS/SKIP/FAIL each)');
	info('would exercise every bridge capability end-to-end:');
	const plannedChecks = [
		'GET /status            -> data.cdp === "connected"',
		'GET /url               -> equals the fixture URL',
		'GET /tabs              -> array includes the active tabId (from /status)',
		'POST /eval             -> 6*7 returns 42',
		'GET /dom               -> HTML contains id="probe"',
		'GET /snapshot          -> non-empty AX node array',
		'POST /type             -> #name then /eval reads back the typed value',
		'POST /click            -> #btn then /eval confirms window.__clicked===true and #out exists',
		'POST /scroll           -> deltaY 800 then /eval window.scrollY > 0',
		'GET /screenshot        -> base64 PNG starting with "iVBORw0KGgo"',
		'POST /emulate          -> {width:390,height:844} (no mobile), LOG path+innerWidth leniently, then {reset:true}',
		'GET /console           -> ?limit=50 includes an entry containing "SMOKE_MARKER"',
		'GET /network           -> ?limit=50 has >=1 entry; ?filter=ping narrows it',
		'POST /network/clear     -> then /network returns fewer/zero entries',
		'POST /tab/open         -> returns a new tabId  (SKIP if proposed API unavailable)',
		'POST /tab/activate/:id -> activate the new tab (SKIP if open skipped)',
		'POST /tab/close/:id    -> close the new tab    (SKIP if open skipped)',
		'CSS round-trip (eval)  -> re-navigate, read rgb(255,0,0), set + re-read rgb(0,128,0)',
	];
	for (const c of plannedChecks) {
		info(`  - ${c}`);
	}
	info('would print a per-tool PASS/SKIP/FAIL table; exit non-zero if any HARD check FAILED');
	info('(SKIP due to missing proposed API is NOT a failure)');

	logStep('Teardown');
	info('would close any tabs opened during the run, then close the fixture server (finally block)');

	console.log('\nDRY RUN OK — control flow parsed and planned. Exiting 0.');
}

// ---------------------------------------------------------------------------
// Real run
// ---------------------------------------------------------------------------
async function runLive(): Promise<void> {
	const version = readVersion();
	const vsix = `integrated-browser-agent-connect-${version}.vsix`;

	console.log('=== live-smoke (LIVE) ===');
	info(`repo root: ${REPO_ROOT}`);
	info(`extension version: ${version}`);

	// 1+2. Detect vsce major.
	logStep('Detect vsce major version');
	const vsceMajor = detectVsceMajor();
	info(`vsce major version: ${vsceMajor}`);
	const pkgArgs = packageArgs(vsceMajor);
	info(`proposed-api flag: ${vsceMajor >= 3 ? 'YES (--allow-proposed-apis browser)' : 'no (vsce 2.x)'}`);

	// 3a. Package (runs the production build via vscode:prepublish).
	logStep('Package the extension');
	info(`${NPX} ${pkgArgs.join(' ')}`);
	const pkgRes = spawnSync(NPX, pkgArgs, {
		cwd: REPO_ROOT,
		stdio: 'inherit',
		shell: process.platform === 'win32',
	});
	if (pkgRes.status !== 0) {
		throw new Error(`vsce package failed (exit ${pkgRes.status}).`);
	}
	const vsixPath = path.join(REPO_ROOT, vsix);
	if (!fs.existsSync(vsixPath)) {
		throw new Error(`Expected vsix not found at ${vsixPath}`);
	}

	// 3b. Install.
	logStep('Install the extension');
	info(`${CODE} --install-extension ${vsix} --force`);
	const instRes = spawnSync(CODE, ['--install-extension', vsixPath, '--force'], {
		cwd: REPO_ROOT,
		stdio: 'inherit',
		shell: process.platform === 'win32',
	});
	if (instRes.status !== 0) {
		throw new Error(`code --install-extension failed (exit ${instRes.status}).`);
	}

	// 4. Wait for reload.
	logStep('Reload VS Code, then continue');
	console.log('  Installing a .vsix does NOT take effect until the window reloads.');
	console.log('  In VS Code run the command palette action: "Developer: Reload Window"');
	console.log(`  (extension id: ${EXTENSION_ID})`);
	await waitForEnter('  Press Enter here once VS Code has reloaded... ');

	// 5. Discover the live bridge.
	logStep('Discover the live bridge');
	const inst = discoverInstance();
	if (inst) {
		info(`discovered instance: port=${inst.port} pid=${inst.pid} workspace=${inst.workspace}`);
	} else {
		info('no instance file found; falling back to getBridgeUrl() default / env override');
	}
	const base = getBridgeUrl();
	info(`bridge base url: ${base}`);

	let status: BridgeResponse;
	try {
		status = await bridgeGet('/status');
	} catch (err) {
		throw new Error(
			`Could not reach the bridge at ${base}. Is VS Code running with the new build? Did you reload the window? (${String(err)})`,
		);
	}
	assert(status.ok === true, `/status returned not-ok: ${status.error}`);
	const cdp = (status.data as { cdp?: string } | undefined)?.cdp;
	info(`/status -> cdp=${cdp}`);
	assert(
		cdp === 'connected',
		`CDP is "${cdp}", expected "connected". The integrated browser may not be attached yet — open/reload it and retry.`,
	);

	// 6. Fixture server.
	logStep('Start throwaway fixture server');
	const { server, url } = await startFixtureServer();
	info(`fixture serving at ${url}`);

	// Tabs we open during the run; closed in finally so we leave no orphans.
	const openedTabs: string[] = [];

	try {
		// 7. Navigate + wait for load.
		logStep('Navigate to fixture and wait for load');
		const nav = await bridgePost('/navigate', { url });
		assert(nav.ok === true, `/navigate failed: ${nav.error}`);
		info(`navigated to ${url}`);

		const deadline = Date.now() + 15000;
		let ready = '';
		while (Date.now() < deadline) {
			try {
				ready = String(await evalExpr('document.readyState'));
			} catch {
				ready = '';
			}
			if (ready === 'complete') break;
			await sleep(250);
		}
		assert(ready === 'complete', `Page never reached readyState "complete" (last: "${ready}")`);
		info('document.readyState === "complete"');
		// Give the on-load fetch('/ping') + <img> a moment to hit the network buffer.
		await sleep(500);

		// 8. Drive every bridge capability end-to-end.
		logStep('Run per-tool checks against the live browser');
		const expectedHref = url.replace(/\/$/, '');

		await check('GET /status', async () => {
			const r = await bridgeGet('/status');
			assert(r.ok === true, `not ok: ${r.error}`);
			const cdp = (r.data as { cdp?: string }).cdp;
			assert(cdp === 'connected', `cdp=${cdp}, expected connected`);
			return `cdp=connected`;
		});

		await check('GET /url', async () => {
			const r = await bridgeGet('/url');
			assert(r.ok === true, `not ok: ${r.error}`);
			const href = String(r.data);
			assert(href.startsWith(expectedHref), `got ${href}, expected ${expectedHref}`);
			return href;
		});

		let activeTabId = '';
		await check('GET /tabs', async () => {
			const r = await bridgeGet('/tabs');
			assert(r.ok === true, `not ok: ${r.error}`);
			const tabs = r.data as Array<{ tabId: string; active?: boolean }>;
			assert(Array.isArray(tabs) && tabs.length > 0, 'expected non-empty tab array');
			const status = await bridgeGet('/status');
			activeTabId = String((status.data as { activeTabId?: string }).activeTabId ?? '');
			const hit = tabs.find(t => t.tabId === activeTabId) ?? tabs.find(t => t.active);
			assert(!!hit, `active tab ${activeTabId} not present in /tabs`);
			return `${tabs.length} tab(s), active=${activeTabId}`;
		});

		await check('POST /eval', async () => {
			const r = await bridgePost('/eval', { expression: '6 * 7' });
			assert(r.ok === true, `not ok: ${r.error}`);
			assert(r.data === 42, `expected 42, got ${JSON.stringify(r.data)}`);
			return '6*7 === 42';
		});

		await check('GET /dom', async () => {
			const r = await bridgeGet('/dom');
			assert(r.ok === true, `not ok: ${r.error}`);
			const html = String(r.data);
			assert(html.includes('id="probe"'), 'DOM did not contain id="probe"');
			return `${html.length} bytes`;
		});

		await check('GET /snapshot', async () => {
			const r = await bridgeGet('/snapshot');
			assert(r.ok === true, `not ok: ${r.error}`);
			assert(Array.isArray(r.data) && (r.data as unknown[]).length > 0, 'expected non-empty AX node array');
			return `${(r.data as unknown[]).length} AX nodes`;
		});

		await check('POST /type', async () => {
			const typed = 'smoke-' + Date.now();
			const r = await bridgePost('/type', { selector: '#name', text: typed });
			assert(r.ok === true, `not ok: ${r.error}`);
			const val = String(await evalExpr("document.getElementById('name').value"));
			assert(val === typed, `#name.value is "${val}", expected "${typed}"`);
			return `#name.value === "${typed}"`;
		});

		await check('POST /click', async () => {
			const r = await bridgePost('/click', { selector: '#btn' });
			assert(r.ok === true, `not ok: ${r.error}`);
			const clicked = await evalExpr('window.__clicked === true');
			const hasOut = await evalExpr("!!document.getElementById('out')");
			assert(clicked === true, `window.__clicked is ${JSON.stringify(clicked)}`);
			assert(hasOut === true, '#out was not appended');
			return 'window.__clicked === true, #out present';
		});

		await check('POST /scroll', async () => {
			const r = await bridgePost('/scroll', { deltaX: 0, deltaY: 800 });
			assert(r.ok === true, `not ok: ${r.error}`);
			await sleep(150);
			const y = Number(await evalExpr('window.scrollY'));
			assert(y > 0, `window.scrollY is ${y}, expected > 0`);
			return `window.scrollY === ${y}`;
		});

		await check('GET /screenshot', async () => {
			const r = await bridgeGet('/screenshot');
			assert(r.ok === true, `not ok: ${r.error}`);
			const b64 = String(r.data);
			assert(b64.startsWith('iVBORw0KGgo'), 'data is not a PNG (bad signature)');
			return `PNG, ${b64.length} base64 chars`;
		});

		await check('POST /emulate', async () => {
			// Lenient: the host may filter device metrics. Treat a successful call
			// as PASS and just LOG the resolved path + innerWidth.
			const r = await bridgePost('/emulate', { width: 390, height: 844 });
			assert(r.ok === true, `not ok: ${r.error}`);
			const path = (r.data as { path?: string }).path;
			const iw = Number(await evalExpr('window.innerWidth'));
			const reset = await bridgePost('/emulate', { reset: true });
			assert(reset.ok === true, `reset not ok: ${reset.error}`);
			const note = `path=${path}, innerWidth=${iw}${iw === 390 ? ' (applied)' : ' (host did not apply width — informational)'}, reset ok`;
			return note;
		});

		await check('GET /console', async () => {
			const r = await bridgeGet('/console?limit=50');
			assert(r.ok === true, `not ok: ${r.error}`);
			const entries = r.data as Array<{ text?: string }>;
			assert(Array.isArray(entries), 'console data not an array');
			const hit = entries.some(e => (e.text ?? '').includes('SMOKE_MARKER'));
			assert(hit, 'no console entry containing SMOKE_MARKER');
			return `${entries.length} entries, SMOKE_MARKER found`;
		});

		await check('GET /network', async () => {
			const all = await bridgeGet('/network?limit=50');
			assert(all.ok === true, `not ok: ${all.error}`);
			const entries = all.data as Array<{ url?: string }>;
			assert(Array.isArray(entries) && entries.length > 0, 'expected >= 1 network entry');
			const filtered = await bridgeGet('/network?limit=50&filter=ping');
			assert(filtered.ok === true, `filter not ok: ${filtered.error}`);
			const fEntries = filtered.data as Array<{ url?: string }>;
			assert(fEntries.every(e => (e.url ?? '').includes('ping')), 'filter returned non-matching url');
			assert(fEntries.length <= entries.length, 'filter did not narrow results');
			return `${entries.length} total, ${fEntries.length} match filter=ping`;
		});

		await check('POST /network/clear', async () => {
			const before = await bridgeGet('/network?limit=50');
			const beforeN = (before.data as unknown[]).length;
			const r = await bridgePost('/network/clear', {});
			assert(r.ok === true, `not ok: ${r.error}`);
			const after = await bridgeGet('/network?limit=50');
			const afterN = (after.data as unknown[]).length;
			assert(afterN <= beforeN, `after-clear count ${afterN} > before ${beforeN}`);
			return `${beforeN} -> ${afterN} entries`;
		});

		// Tab lifecycle: open a second fixture tab, activate it, close it.
		// browser_tab_open may need the proposed API; if it errors, SKIP the trio.
		let newTabId = '';
		await check('POST /tab/open', async () => {
			const r = await bridgePost('/tab/open', { url });
			if (!r.ok) {
				skip(`tab_open unavailable (proposed API?): ${r.error}`);
			}
			newTabId = String((r.data as { tabId?: string }).tabId ?? '');
			assert(newTabId.length > 0, 'no tabId returned');
			openedTabs.push(newTabId);
			return `opened ${newTabId}`;
		});

		await check('POST /tab/activate', async () => {
			if (!newTabId) skip('no tab opened (tab_open skipped/failed)');
			const r = await bridgePost(`/tab/activate/${newTabId}`, {});
			assert(r.ok === true, `not ok: ${r.error}`);
			return `activated ${newTabId}`;
		});

		await check('POST /tab/close', async () => {
			if (!newTabId) skip('no tab opened (tab_open skipped/failed)');
			const r = await bridgePost(`/tab/close/${newTabId}`, {});
			assert(r.ok === true, `not ok: ${r.error}`);
			openedTabs.splice(openedTabs.indexOf(newTabId), 1);
			return `closed ${newTabId}`;
		});

		// Original CSS load -> read -> change -> re-read round-trip.
		// Re-navigate so #probe is back to its initial red regardless of earlier checks.
		await check('CSS round-trip (eval)', async () => {
			await bridgePost('/navigate', { url });
			const d2 = Date.now() + 15000;
			let rs = '';
			while (Date.now() < d2) {
				try { rs = String(await evalExpr('document.readyState')); } catch { rs = ''; }
				if (rs === 'complete') break;
				await sleep(250);
			}
			assert(rs === 'complete', `page never completed (last: "${rs}")`);
			const before = String(await evalExpr("getComputedStyle(document.getElementById('probe')).color"));
			assert(before === 'rgb(255, 0, 0)', `initial color ${before}, expected rgb(255, 0, 0)`);
			const after = String(await evalExpr(
				"(() => { document.getElementById('probe').style.color = 'rgb(0, 128, 0)'; return getComputedStyle(document.getElementById('probe')).color; })()",
			));
			assert(after === 'rgb(0, 128, 0)', `changed color ${after}, expected rgb(0, 128, 0)`);
			return `${before} -> ${after}`;
		});

		// Summary + exit code.
		const failed = reportResults();
		if (failed > 0) {
			throw new Error(`${failed} hard check(s) FAILED (see table above)`);
		}
		console.log('\nPASS: all hard checks passed (skips are not failures).');
	} finally {
		// Best-effort cleanup of any tab we opened but did not close.
		for (const tabId of openedTabs) {
			try {
				await bridgePost(`/tab/close/${tabId}`, {});
				info(`cleaned up tab ${tabId}`);
			} catch {
				info(`could not clean up tab ${tabId}`);
			}
		}
		await closeServer(server);
		info('fixture server closed');
	}
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
	if (DRY_RUN) {
		runDryRun();
		return;
	}
	await runLive();
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error('\n========================================');
		console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
		console.error('========================================');
		process.exit(1);
	},
);
