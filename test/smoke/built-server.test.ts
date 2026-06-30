import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Repo root = two levels up from this file (test/smoke/).
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// The 18 tools the built server must expose. Asserting set equality catches
// both missing tools and unexpected extras.
const EXPECTED_TOOLS = [
	'browser_navigate',
	'browser_eval',
	'browser_click',
	'browser_type',
	'browser_scroll',
	'browser_screenshot',
	'browser_emulate',
	'browser_snapshot',
	'browser_dom',
	'browser_console',
	'browser_network',
	'browser_network_clear',
	'browser_url',
	'browser_status',
	'browser_tab_open',
	'browser_tab_close',
	'browser_tab_list',
	'browser_tab_activate',
].sort();

test('built MCP server initializes and lists the 18 expected tools', { timeout: 60_000 }, async () => {
	// Spawn the BUILT server via node directly (do NOT rely on the shebang).
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['dist/mcp-server.mjs'],
		cwd: repoRoot,
	});

	const client = new Client({ name: 'smoke-test-client', version: '0.0.0' });

	try {
		// connect() performs the MCP initialize handshake; throws on failure.
		await client.connect(transport);

		// Server identity reported during initialize.
		const serverInfo = client.getServerVersion();
		assert.ok(serverInfo, 'server did not report version info');
		assert.equal(serverInfo?.name, 'integrated-browser-agent-connect');

		// listTools needs no live bridge (no tool is actually called).
		const { tools } = await client.listTools();
		const names = tools.map(t => t.name).sort();

		assert.deepEqual(
			names,
			EXPECTED_TOOLS,
			`tool set mismatch.\n  expected: ${EXPECTED_TOOLS.join(', ')}\n  actual:   ${names.join(', ')}`,
		);
	} finally {
		// Close client + transport so the spawned child is killed and the run exits.
		await client.close().catch(() => {});
		await transport.close().catch(() => {});
	}
});
