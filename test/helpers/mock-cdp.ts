// Fake CDPManager + CDPTab used to drive BridgeServer without a real browser.
//
// The real types live in src/cdp.ts / src/cdp-tab.ts but http-server.ts imports
// them with `import type` only, so at runtime BridgeServer just calls methods on
// whatever object it's handed. These duck-typed mocks supply exactly the fields
// and methods http-server.ts touches: state, transport, activeTabId, tabCount,
// pageSessionId, children, events, console, network, getTab, list, openTab,
// closeTab, activate, consoleForTab, networkForTab, clearNetwork — plus a tab
// with an async send(method, params).

export interface ConsoleEntry {
	type: string;
	text: string;
	timestamp: number;
	target?: string;
	tabId?: string;
}

export interface NetworkEntry {
	requestId: string;
	method: string;
	url: string;
	status?: number;
	timestamp: number;
	tabId?: string;
}

/** A canned CDP response, or a function computing one from the params. */
type Responder = unknown | ((params: Record<string, unknown>) => unknown);

export interface MockTab {
	tabId: string;
	url: string;
	title: string;
	/** Returned by Runtime.evaluate for `document.documentElement.outerHTML`. */
	dom: string;
	/** Returned by Runtime.evaluate for `window.location.href`. */
	locationHref: string;
	/** Returned by Runtime.evaluate for `window.innerWidth` (the /emulate probe). */
	innerWidth: number;
	/** Returned by Runtime.evaluate for an arbitrary /eval expression. */
	evalValue: unknown;
	/** Returned by Accessibility.getFullAXTree as `{ nodes }`. */
	axNodes: unknown[];
	/** Per-method overrides; takes precedence over the built-in defaults. */
	responses: Record<string, Responder>;
	/** Every (method, params) the server sent, in order — for assertions. */
	calls: Array<{ method: string; params?: Record<string, unknown> }>;
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

function evalResponse(tab: MockTab, expression: string): unknown {
	// Mirror the JS the route handlers wrap: click/type return their status
	// object inside result.value; dom/url/innerWidth return scalars.
	if (expression.includes('el.click()')) {
		return { result: { value: { clicked: true } } };
	}
	if (expression.includes('el.focus()')) {
		return { result: { value: { focused: true } } };
	}
	if (expression === 'window.innerWidth') {
		return { result: { value: tab.innerWidth } };
	}
	if (expression === 'document.documentElement.outerHTML') {
		return { result: { value: tab.dom } };
	}
	if (expression === 'window.location.href') {
		return { result: { value: tab.locationHref } };
	}
	if (expression.includes('scrollBy')) {
		return { result: { value: null } };
	}
	// Generic /eval path.
	return { result: { value: tab.evalValue } };
}

function defaultResponse(tab: MockTab, method: string, params: Record<string, unknown>): unknown {
	switch (method) {
		case 'Page.navigate':
			return { frameId: 'f1' };
		case 'Input.insertText':
			return {};
		case 'Page.captureScreenshot':
			return { data: 'BASE64' };
		case 'Emulation.setDeviceMetricsOverride':
		case 'Emulation.setTouchEmulationEnabled':
		case 'Emulation.setUserAgentOverride':
		case 'Emulation.clearDeviceMetricsOverride':
		case 'Page.setDeviceMetricsOverride':
			return {};
		case 'Accessibility.getFullAXTree':
			return { nodes: tab.axNodes };
		case 'Runtime.evaluate':
			return evalResponse(tab, String(params.expression ?? ''));
		default:
			return {};
	}
}

export function createMockTab(overrides: Partial<MockTab> = {}): MockTab {
	const tab: MockTab = {
		tabId: 'tab-main',
		url: 'http://localhost/',
		title: 'Test Page',
		dom: '<html><head><title>Test Page</title></head><body>hi</body></html>',
		locationHref: 'http://localhost/page',
		innerWidth: 1280,
		evalValue: null,
		axNodes: [{ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Test Page' } }],
		responses: {},
		calls: [],
		async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
			tab.calls.push({ method, params });
			const override = tab.responses[method];
			if (override !== undefined) {
				return typeof override === 'function'
					? (override as (p: Record<string, unknown>) => unknown)(params ?? {})
					: override;
			}
			return defaultResponse(tab, method, params ?? {});
		},
		...overrides,
	};
	return tab;
}

export interface TabInfo {
	tabId: string;
	number: number | null;
	url: string;
	title: string;
	active: boolean;
	state: string;
	transport: string | null;
}

export interface MockCDP {
	state: string;
	transport: string | null;
	activeTabId: string | null;
	tabCount: number;
	pageSessionId: string | null;
	children: unknown[];
	events: Record<string, number>;
	console: ConsoleEntry[];
	network: NetworkEntry[];
	/** Per-tab console buffers, keyed by tabId (consumed by /console?tabId=). */
	consoleByTab: Record<string, ConsoleEntry[]>;
	/** Per-tab network buffers, keyed by tabId (consumed by /network?tabId=). */
	networkByTab: Record<string, NetworkEntry[]>;
	/** Recorded clearNetwork calls (undefined == "all"). */
	clearNetworkCalls: Array<string | undefined>;
	/** Recorded openTab calls, in order. */
	openTabCalls: Array<{ url: string; makeActive: boolean }>;
	/** Recorded closeTab calls (tabIds), in order. */
	closeTabCalls: string[];
	/** Recorded activate calls (tabIds), in order. */
	activateCalls: string[];
	tabs: Record<string, MockTab>;
	_list: TabInfo[];
	getTab(tabId?: string): MockTab | undefined;
	list(): TabInfo[];
	openTab(url: string, makeActive?: boolean): Promise<MockTab>;
	closeTab(tabId: string): Promise<void>;
	activate(tabId: string): void;
	consoleForTab(tabId: string): ConsoleEntry[];
	networkForTab(tabId: string): NetworkEntry[];
	clearNetwork(tabId?: string): void;
}

export interface MockLog {
	lines: string[];
	appendLine(msg: string): void;
}

export function createMockLog(): MockLog {
	return {
		lines: [],
		appendLine(msg: string) {
			this.lines.push(msg);
		},
	};
}

export interface MockCDPOptions {
	state?: string;
	transport?: string | null;
	activeTabId?: string | null;
	tabCount?: number;
	pageSessionId?: string | null;
	children?: unknown[];
	events?: Record<string, number>;
	console?: ConsoleEntry[];
	network?: NetworkEntry[];
	consoleByTab?: Record<string, ConsoleEntry[]>;
	networkByTab?: Record<string, NetworkEntry[]>;
	list?: TabInfo[];
	/** Overrides applied to the single default tab. */
	tab?: Partial<MockTab>;
}

/**
 * Build a mock CDPManager with one connected tab by default. The tab is
 * returned alongside so tests can mutate `tab.responses` / `tab.innerWidth`
 * etc. before issuing a request.
 */
export function createMockCDP(opts: MockCDPOptions = {}): { cdp: MockCDP; tab: MockTab; log: MockLog } {
	const tab = createMockTab(opts.tab);
	const log = createMockLog();

	const cdp: MockCDP = {
		state: opts.state ?? 'connected',
		transport: opts.transport ?? 'browserTab',
		activeTabId: opts.activeTabId ?? tab.tabId,
		tabCount: opts.tabCount ?? 1,
		pageSessionId: opts.pageSessionId ?? 'page-session-1',
		children: opts.children ?? [],
		events: opts.events ?? { 'Runtime.consoleAPICalled': 3 },
		console: opts.console ?? [],
		network: opts.network ?? [],
		consoleByTab: opts.consoleByTab ?? {},
		networkByTab: opts.networkByTab ?? {},
		clearNetworkCalls: [],
		openTabCalls: [],
		closeTabCalls: [],
		activateCalls: [],
		tabs: { [tab.tabId]: tab },
		_list: opts.list ?? [
			{
				tabId: tab.tabId,
				number: 1,
				url: tab.url,
				title: tab.title,
				active: true,
				state: 'connected',
				transport: 'browserTab',
			},
		],
		getTab(tabId?: string): MockTab | undefined {
			if (tabId) return cdp.tabs[tabId];
			if (cdp.activeTabId) return cdp.tabs[cdp.activeTabId];
			const keys = Object.keys(cdp.tabs);
			return keys.length === 1 ? cdp.tabs[keys[0]] : undefined;
		},
		list(): TabInfo[] {
			return cdp._list;
		},
		async openTab(url: string, makeActive = true): Promise<MockTab> {
			cdp.openTabCalls.push({ url, makeActive });
			const newTab = createMockTab({ tabId: 'tab-new', url });
			cdp.tabs[newTab.tabId] = newTab;
			cdp.tabCount = Object.keys(cdp.tabs).length;
			if (makeActive) cdp.activeTabId = newTab.tabId;
			return newTab;
		},
		async closeTab(tabId: string): Promise<void> {
			cdp.closeTabCalls.push(tabId);
			delete cdp.tabs[tabId];
			cdp.tabCount = Object.keys(cdp.tabs).length;
		},
		activate(tabId: string): void {
			cdp.activateCalls.push(tabId);
			if (!cdp.tabs[tabId]) throw new Error(`No tab: ${tabId}`);
			cdp.activeTabId = tabId;
		},
		consoleForTab(tabId: string): ConsoleEntry[] {
			return cdp.consoleByTab[tabId] ?? [];
		},
		networkForTab(tabId: string): NetworkEntry[] {
			return cdp.networkByTab[tabId] ?? [];
		},
		clearNetwork(tabId?: string): void {
			cdp.clearNetworkCalls.push(tabId);
		},
	};

	return { cdp, tab, log };
}
