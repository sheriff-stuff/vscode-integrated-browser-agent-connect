import http from 'node:http';

// A tiny stand-in for the extension's HTTP bridge. It records every request the
// MCP tool handlers make (method, path, query, parsed body) and replies with a
// canned `{ ok: true, data }` envelope shaped per route. A route can be forced
// to return `{ ok: false, error }` via setError() to exercise the error path.

export interface RecordedRequest {
	method: string;
	path: string;
	query: Record<string, string>;
	body: unknown;
}

export interface MockBridge {
	/** Bound port on 127.0.0.1 (OS-assigned). */
	port: number;
	/** Every request received, in arrival order. */
	requests: RecordedRequest[];
	/** Force a pathname to reply with `{ ok:false, error }`. */
	setError(pathname: string, error: string): void;
	/** Stop forcing an error on a pathname. */
	clearError(pathname: string): void;
	/** Most recently recorded request (throws if none). */
	last(): RecordedRequest;
	/** Close the server. */
	stop(): Promise<void>;
}

// 1x1 transparent PNG — what the real /screenshot returns as base64 (no data: prefix).
export const SCREENSHOT_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Per-route canned `data`. /screenshot must be the raw base64 string so the
// handler can wrap it in an MCP image block; everything else can be any JSON.
function dataFor(pathname: string): unknown {
	if (pathname === '/screenshot') return SCREENSHOT_BASE64;
	return { route: pathname, ok: true };
}

export async function startMockBridge(): Promise<MockBridge> {
	const requests: RecordedRequest[] = [];
	const errors = new Map<string, string>();

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c as Buffer));
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			let body: unknown;
			if (raw) {
				try {
					body = JSON.parse(raw);
				} catch {
					body = raw;
				}
			}
			requests.push({
				method: req.method ?? '',
				path: url.pathname,
				query: Object.fromEntries(url.searchParams),
				body,
			});

			res.setHeader('Content-Type', 'application/json');
			const errMsg = errors.get(url.pathname);
			if (errMsg !== undefined) {
				res.end(JSON.stringify({ ok: false, error: errMsg }));
				return;
			}
			res.end(JSON.stringify({ ok: true, data: dataFor(url.pathname) }));
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const addr = server.address();
	const port = typeof addr === 'object' && addr ? addr.port : 0;

	return {
		port,
		requests,
		setError(pathname, error) {
			errors.set(pathname, error);
		},
		clearError(pathname) {
			errors.delete(pathname);
		},
		last() {
			const r = requests[requests.length - 1];
			if (!r) throw new Error('mock bridge recorded no requests');
			return r;
		},
		stop() {
			return new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
