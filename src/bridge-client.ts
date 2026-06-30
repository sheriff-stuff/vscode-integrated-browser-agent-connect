import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Pure helpers shared by the MCP server (and exercised directly by unit tests).
// Kept free of build-time injected globals (`__PKG_VERSION__`) and of any
// top-level side effects so the module is safe to `import` from a test runner.

export const INSTANCES_DIR = path.join(os.homedir(), '.integrated-browser-agent-connect', 'instances');

export interface Instance {
	port: number;
	workspace: string;
	pid: number;
	startedAt: string;
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export interface DiscoverOptions {
	/** Directory to scan for instance files. Defaults to INSTANCES_DIR. */
	dir?: string;
	/** Working directory used for workspace matching. Defaults to process.cwd(). */
	cwd?: string;
	/** Liveness probe. Defaults to isProcessAlive — override in tests. */
	isAlive?: (pid: number) => boolean;
}

export function discoverInstance(opts: DiscoverOptions = {}): Instance | null {
	const dir = opts.dir ?? INSTANCES_DIR;
	const cwd = opts.cwd ?? process.cwd();
	const alive = opts.isAlive ?? isProcessAlive;
	try {
		const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
		const instances: Instance[] = [];
		for (const file of files) {
			try {
				const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
				// Skip instances with dead processes
				if (!alive(data.pid)) continue;
				instances.push(data);
			} catch {
				// Skip corrupt files
			}
		}

		// Best match: cwd is inside a registered workspace
		// Sort by workspace length descending so deeper paths match first
		instances.sort((a, b) => b.workspace.length - a.workspace.length);
		for (const inst of instances) {
			if (!inst.workspace) continue;
			// Ensure match is on a path boundary (exact match or followed by separator)
			if (cwd === inst.workspace || cwd.startsWith(inst.workspace + path.sep)) {
				return inst;
			}
		}

		// Fallback: return the most recently started instance
		instances.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
		if (instances.length > 0) {
			return instances[0];
		}
	} catch {
		// instances dir doesn't exist yet
	}
	return null;
}

export function discoverPort(opts?: DiscoverOptions): number | null {
	return discoverInstance(opts)?.port ?? null;
}

export function getBridgeUrl(): string {
	// Env var override takes priority (for testing / manual config).
	if (process.env.BROWSER_BRIDGE_PORT) {
		return `http://127.0.0.1:${process.env.BROWSER_BRIDGE_PORT}`;
	}
	// Re-discover on every call. Caching was unsafe: VS Code windows shift
	// ports on reload (port 3788 may have been pottagold at startup but become
	// integrated-browser-agent-connect after a reload), so a cached port can silently
	// route calls to the wrong workspace's bridge. Filesystem-reading the
	// instances dir each time costs ~1ms, well worth the correctness.
	const port = discoverPort();
	if (port) return `http://127.0.0.1:${port}`;
	// Last resort default — the lowest port the extension tries to bind.
	return 'http://127.0.0.1:3788';
}

export async function bridgeFetch(urlPath: string, options?: RequestInit): Promise<{ ok: boolean; data?: unknown; error?: string }> {
	try {
		const base = getBridgeUrl();
		const res = await fetch(`${base}${urlPath}`, options);
		return await res.json() as { ok: boolean; data?: unknown; error?: string };
	} catch {
		// Each call re-discovers the port, so a second retry doesn't buy us
		// anything beyond a clearer error message.
		return { ok: false, error: 'Integrated Browser Agent Connect is not reachable. Make sure VS Code is running with the extension active.' };
	}
}

export async function bridgePost(urlPath: string, body: Record<string, unknown>) {
	return bridgeFetch(urlPath, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

export function toMcpResult(result: { ok: boolean; data?: unknown; error?: string }) {
	if (!result.ok) {
		return {
			content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
			isError: true,
		};
	}
	const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
	return { content: [{ type: 'text' as const, text }] };
}
