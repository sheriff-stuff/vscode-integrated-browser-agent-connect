import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
	discoverInstance,
	discoverPort,
	getBridgeUrl,
	toMcpResult,
	type Instance,
} from '../../src/bridge-client.ts';

// Liveness stub: every pid is alive unless explicitly excluded.
const allAlive = (_pid: number) => true;

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibac-'));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function writeInstance(name: string, inst: Partial<Instance>): void {
	fs.writeFileSync(path.join(dir, name), JSON.stringify(inst), 'utf-8');
}

// ---------- discoverInstance ----------

test('discoverInstance returns null when directory does not exist', () => {
	const missing = path.join(dir, 'does-not-exist-subdir');
	const result = discoverInstance({ dir: missing, cwd: dir, isAlive: allAlive });
	assert.equal(result, null);
});

test('discoverInstance matches workspace containing cwd', () => {
	const ws = path.join(dir, 'workspace');
	const cwd = path.join(ws, 'src', 'app');
	writeInstance('a.json', { port: 4001, workspace: ws, pid: 100, startedAt: '2026-01-01T00:00:00Z' });
	const result = discoverInstance({ dir, cwd, isAlive: allAlive });
	assert.ok(result);
	assert.equal(result!.port, 4001);
});

test('discoverInstance matches exact workspace == cwd', () => {
	const ws = path.join(dir, 'workspace');
	writeInstance('a.json', { port: 4002, workspace: ws, pid: 100, startedAt: '2026-01-01T00:00:00Z' });
	const result = discoverInstance({ dir, cwd: ws, isAlive: allAlive });
	assert.ok(result);
	assert.equal(result!.port, 4002);
});

test('discoverInstance: deepest nested workspace wins', () => {
	const outer = path.join(dir, 'repo');
	const inner = path.join(outer, 'packages', 'web');
	const cwd = path.join(inner, 'src');
	writeInstance('outer.json', { port: 5001, workspace: outer, pid: 100, startedAt: '2026-01-02T00:00:00Z' });
	writeInstance('inner.json', { port: 5002, workspace: inner, pid: 101, startedAt: '2026-01-01T00:00:00Z' });
	const result = discoverInstance({ dir, cwd, isAlive: allAlive });
	assert.ok(result);
	assert.equal(result!.port, 5002, 'deeper workspace should win regardless of startedAt');
});

test('discoverInstance: path boundary prefix is not treated as a match', () => {
	const ws = path.join(dir, 'bar');
	const cwd = path.join(dir, 'barbaz');
	// "bar" workspace is older; "other" workspace is newer and unrelated.
	writeInstance('bar.json', { port: 7001, workspace: ws, pid: 100, startedAt: '2026-01-01T00:00:00Z' });
	writeInstance('other.json', { port: 7002, workspace: path.join(dir, 'zzz'), pid: 101, startedAt: '2026-06-01T00:00:00Z' });
	const result = discoverInstance({ dir, cwd, isAlive: allAlive });
	// If "bar" had matched "barbaz" it would be returned. Instead the fallback
	// (most recent startedAt) returns "other".
	assert.ok(result);
	assert.equal(result!.port, 7002, 'prefix bar must not match barbaz; fallback to most recent');
});

test('discoverInstance: dead PIDs are skipped', () => {
	const ws = path.join(dir, 'workspace');
	writeInstance('dead.json', { port: 8001, workspace: ws, pid: 999, startedAt: '2026-06-01T00:00:00Z' });
	writeInstance('live.json', { port: 8002, workspace: ws, pid: 1, startedAt: '2026-01-01T00:00:00Z' });
	const isAlive = (pid: number) => pid !== 999;
	const result = discoverInstance({ dir, cwd: ws, isAlive });
	assert.ok(result);
	assert.equal(result!.port, 8002, 'dead pid 999 must be excluded, live instance returned');
});

test('discoverInstance: fallback to most recent startedAt when no workspace matches', () => {
	const cwd = path.join(dir, 'unrelated');
	writeInstance('old.json', { port: 9001, workspace: path.join(dir, 'a'), pid: 100, startedAt: '2026-01-01T00:00:00Z' });
	writeInstance('new.json', { port: 9002, workspace: path.join(dir, 'b'), pid: 101, startedAt: '2026-12-31T00:00:00Z' });
	writeInstance('mid.json', { port: 9003, workspace: path.join(dir, 'c'), pid: 102, startedAt: '2026-06-15T00:00:00Z' });
	const result = discoverInstance({ dir, cwd, isAlive: allAlive });
	assert.ok(result);
	assert.equal(result!.port, 9002, 'most recent startedAt should win the fallback');
});

test('discoverInstance: corrupt JSON files are skipped', () => {
	const ws = path.join(dir, 'workspace');
	fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json', 'utf-8');
	writeInstance('good.json', { port: 10001, workspace: ws, pid: 100, startedAt: '2026-01-01T00:00:00Z' });
	const result = discoverInstance({ dir, cwd: ws, isAlive: allAlive });
	assert.ok(result);
	assert.equal(result!.port, 10001);
});

test('discoverInstance: non-.json files are ignored', () => {
	const ws = path.join(dir, 'workspace');
	fs.writeFileSync(path.join(dir, 'ignore.txt'), JSON.stringify({ port: 11001, workspace: ws, pid: 100, startedAt: '2026-12-31T00:00:00Z' }), 'utf-8');
	writeInstance('real.json', { port: 11002, workspace: ws, pid: 100, startedAt: '2026-01-01T00:00:00Z' });
	const result = discoverInstance({ dir, cwd: ws, isAlive: allAlive });
	assert.ok(result);
	assert.equal(result!.port, 11002, 'only the .json instance should be considered');
});

test('discoverInstance: returns null when dir is empty', () => {
	const result = discoverInstance({ dir, cwd: dir, isAlive: allAlive });
	assert.equal(result, null);
});

// ---------- discoverPort ----------

test('discoverPort returns the discovered instance port', () => {
	const ws = path.join(dir, 'workspace');
	writeInstance('a.json', { port: 12001, workspace: ws, pid: 100, startedAt: '2026-01-01T00:00:00Z' });
	const port = discoverPort({ dir, cwd: ws, isAlive: allAlive });
	assert.equal(port, 12001);
});

test('discoverPort returns null when no instance found', () => {
	const port = discoverPort({ dir, cwd: dir, isAlive: allAlive });
	assert.equal(port, null);
});

// ---------- getBridgeUrl ----------

test('getBridgeUrl honours BROWSER_BRIDGE_PORT env var', () => {
	const saved = process.env.BROWSER_BRIDGE_PORT;
	try {
		process.env.BROWSER_BRIDGE_PORT = '54321';
		assert.equal(getBridgeUrl(), 'http://127.0.0.1:54321');
	} finally {
		if (saved === undefined) {
			delete process.env.BROWSER_BRIDGE_PORT;
		} else {
			process.env.BROWSER_BRIDGE_PORT = saved;
		}
	}
});

// ---------- toMcpResult ----------

test('toMcpResult: error result', () => {
	const out = toMcpResult({ ok: false, error: 'boom' });
	assert.deepEqual(out, {
		content: [{ type: 'text', text: 'Error: boom' }],
		isError: true,
	});
});

test('toMcpResult: string data passes through verbatim', () => {
	const out = toMcpResult({ ok: true, data: 'hello' });
	assert.equal(out.content[0].text, 'hello');
	assert.ok(!('isError' in out));
});

test('toMcpResult: object data is pretty-printed JSON', () => {
	const data = { a: 1 };
	const out = toMcpResult({ ok: true, data });
	assert.equal(out.content[0].text, JSON.stringify(data, null, 2));
	assert.ok(!('isError' in out));
});
