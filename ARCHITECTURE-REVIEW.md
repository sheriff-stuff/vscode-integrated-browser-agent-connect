# Architecture Review — integrated-browser-agent-connect

A review of what this extension does, how the HTTP and MCP halves relate, and what
can be stripped to get a bare-bones version for work use.

---

## TL;DR (read this; skip the rest unless you need detail)

- **What it is:** a bridge that lets Claude Code (and curl/scripts) drive the browser
  *already open inside VS Code* — with your real session, cookies, and localhost dev server.
- **Three layers:** `Extension (CDP engine) → HTTP server (all the logic, localhost:3788) → MCP server (a thin client)`. Claude talks to the MCP; the MCP talks HTTP; the HTTP server talks CDP to the browser.
- **HTTP vs MCP are already cleanly separated.** The MCP server is a separate process with **zero browser logic** — every tool just forwards to an HTTP endpoint. The only "link" between them is one localhost port discovered through one JSON file. Splitting them is *deleting glue*, not surgery.
- **Dependency direction is one-way:** MCP needs HTTP; HTTP needs nothing from MCP. The HTTP API works alone (curl it). The MCP is useless without it.
- **`/eval`** runs arbitrary caller-supplied JS in the page. It's the workhorse read tool **and** the main security surface. Removing it keeps navigation/click/type working (those build their own fixed JS); you only lose the flexible read path.
- **Core to keep:** the CDP engine, navigate, eval (optional), a page-read endpoint, screenshot, status/url, port discovery, Claude auto-config.
- **Strippable:** multi-tab + title-prefix scripts (biggest cut), downloads, emulate, screenshot-slice, markdown, console/network buffering, the "open in browser" menus, the `chrome` browser-type option.
- **Security note for work:** localhost-only, **no auth**, `/eval` runs arbitrary JS as your logged-in session. Fine on a personal box; a conscious decision on a work machine.

See **Recommendations** at the bottom for what I'd actually do.

---

## 1. What this extension is

VS Code 1.112+ ships a built-in integrated browser (Chromium, full DevTools) behind the
`editor-browser` debug type. Microsoft wired browser tools into it but locked them to
GitHub Copilot. This extension bridges that same browser — the one open in your editor,
with your cookies and your localhost routing — to **any** agent that speaks HTTP or MCP.

Every other solution (Browser MCP, Playwright MCP, chrome-devtools-mcp) drives an
*external* Chrome. This one drives the browser *inside VS Code*.

## 2. The three layers

```
Claude Code  ──stdio──▶  MCP server  ──HTTP──▶  HTTP server  ──CDP──▶  Browser
                      (dist/mcp-server.mjs)   (inside extension)   (editor-browser)
                       separate Node process   localhost:3788       in VS Code
```

1. **Extension host** — `extension.ts` + `cdp.ts` + `cdp-tab.ts`. Owns the live Chrome
   DevTools Protocol (CDP) connection to the integrated browser. This is the engine.
   Built to `dist/extension.js` (CommonJS).
2. **HTTP server** — `http-server.ts`. Runs *inside* the extension, listens on
   `127.0.0.1:3788`, exposes every capability as a REST endpoint. **All the real
   browser logic lives here.**
3. **MCP server** — `mcp-server.ts`. A *standalone* Node process built separately to
   `dist/mcp-server.mjs` (ESM). Contains **zero browser logic**. Every tool is a
   one-line forward: `browser_navigate` → `POST /navigate`.

The two outputs are built independently (`esbuild.js`): the extension as CommonJS
excluding `vscode`, the MCP server as a self-contained ESM stdio binary.

## 3. The HTTP ↔ MCP link, traced end to end

One real call — `browser_navigate` to example.com — travelling the whole chain. This
*is* the integrity of the links:

1. **Claude Code** calls MCP tool `browser_navigate({url})` over stdio.
2. **MCP server** (`mcp-server.ts:148`) handler is just
   `toMcpResult(await bridgePost('/navigate', { url, tabId }))`. No browser work — it
   only needs to know which port to POST to.
3. **Port discovery** (`mcp-server.ts:30`): reads `~/.integrated-browser-agent-connect/instances/*.json`,
   finds the entry whose `workspace` matches its working directory, pulls out `port`.
   That file was written by the extension at startup (`extension.ts:341`).
   **This file is the entire contract between the two halves.**
4. **HTTP POST** `localhost:3788/navigate` with `{url}`.
5. **HTTP server** (`http-server.ts:129`) resolves the target tab, calls
   `tab.send('Page.navigate', {url})`.
6. **CDP engine** (`cdp-tab.ts:887`) puts it on the WebSocket to the browser. Page loads.
7. Response walks back: CDP result → HTTP `{ok:true, data}` → MCP wraps as tool output → Claude.

**What this means:**

- **The seam is HTTP + one JSON file.** No shared code, no shared memory, no imports
  between the MCP process and the extension. As decoupled as two cooperating programs get.
- **The direction is one-way.** MCP needs HTTP. HTTP needs nothing from MCP. The HTTP
  server runs fine with the MCP server never started — curl works identically:
  `curl -X POST localhost:3788/navigate -d '{"url":"..."}'`.
- **Separating them is mostly deleting glue.** To split: remove the three convenience
  steps in `extension.ts` (`syncMcpServer`, `configureClaude`, optionally
  `registerInstance`), ship the MCP `.mjs` on its own, and have it find the port via the
  `BROWSER_BRIDGE_PORT` env var (already supported, `mcp-server.ts:74`) or a config value
  instead of the instances file. The browser engine is never touched.

So keeping them together vs. separating is a **packaging choice, not an architectural
risk**. Together = one install, auto-wired, zero config (today). Separate = you control
exactly what each piece does and where it points, at the cost of wiring the port yourself.

## 4. What `/eval` actually is

`/eval` (`http-server.ts:146`; MCP tool `browser_eval` at `mcp-server.ts:159`) takes a
string of JavaScript, runs it **inside the page** via CDP `Runtime.evaluate`, returns the
value. e.g. agent sends `document.querySelector('h1').textContent`, gets the heading back.

It matters two ways:

- **It's the workhorse.** Cheapest, fastest way for an agent to read anything — a field
  value, whether a button exists, computed state — without dumping the whole DOM or taking
  a screenshot. The MCP instructions explicitly tell Claude to prefer it
  (`mcp-server.ts:127`). Other endpoints (`/click`, `/type`, `/scroll`, `/url`, `/dom`,
  `/markdown`) are themselves built on `Runtime.evaluate` internally — but `/eval` is the
  one that runs **caller-supplied** code.
- **It's the security surface.** The page runs with your real VS Code session — your
  cookies, your logged-in localhost server. Arbitrary JS there can read or act as you on
  whatever's loaded. Any local process that can reach `localhost:3788` can drive it with
  no authentication.

Removing `/eval` removes only the *arbitrary-code* entrypoint; `/click`, `/type`, etc.
keep working because they build their own fixed JS. You lose the flexible read path, not
navigation or interaction.

## 5. Core vs. strippable

**Core (connect + navigate + read — the stated need):**

- The CDP engine (`cdp.ts`, `cdp-tab.ts`) and activation/launch flow
- HTTP `/navigate`, `/eval`, `/status`, `/url`, one page-reading endpoint (`/dom`,
  `/snapshot`, or `/markdown`), and `/screenshot`
- Matching MCP tools + port discovery + `configureClaude`

**Strippable, roughly by size/independence:**

| Feature | Where | Notes |
|---|---|---|
| **Multi-tab** (proposed-API path, `openBrowserTab`, tab numbering, owner IDs) | large chunk of `cdp.ts` + `extension.ts` | Biggest single simplification. Falls back to a simpler single-tab debug-session path. **But** multi-tab is also the *better* transport (worker/iframe events flow more reliably). Real trade-off. |
| **Title-prefix scripts** (`buildTitleScript`, `setTitlePrefix`) | ~150 lines in `cdp-tab.ts` | Purely cosmetic "(N)" in tab titles. Only useful with multi-tab. |
| **Downloads** (`/download/set`, `/downloads`, buffers) | ~120 lines across files | Niche. |
| **Emulate** (`/emulate` device metrics) | ~60 lines | Mobile/responsive testing only. |
| **Screenshot slice** (`/screenshot-slice`) | ~60 lines | For very tall pages only. |
| **Markdown extraction** (`/markdown`) | ~90 lines | Nice-to-have; `/dom` covers the need more crudely. |
| **Console + network buffering** | child-session/auto-attach logic in `cdp-tab.ts` | Useful for debugging; drop if you only navigate. |
| **`openInBrowser` command + context menus** | `extension.ts` + `package.json` menus | Convenience for humans, not agents. |
| **`browserType: chrome` option** | small | Drop if you only ever use the integrated browser. |

## 6. Security posture (flagged for work use)

Documented in CLAUDE.md and confirmed in code:

- HTTP server binds to `127.0.0.1` only — never network-exposed.
- **No authentication** — same as the reference `cdp-bridge`. Any local process can call it.
- `/eval` runs arbitrary JS in whatever page is open, under your real session.

Fine for a personal dev box. On a corporate machine it deserves a deliberate decision:
keep as-is, or restrict/remove `/eval`.

---

## Recommendations

1. **Don't split HTTP from MCP unless you have a concrete reason.** They're already
   process-isolated and one-way coupled, so keeping them together costs you nothing in
   cleanliness and saves you from wiring the port by hand. Split only if you want to run
   the HTTP core somewhere the MCP shouldn't be auto-configured (e.g. a shared/work
   machine where you don't want `~/.claude.json` auto-edited).

2. **Strip features, not the architecture.** The three-layer shape is sound. The wins are
   in deleting optional endpoints, not in restructuring. Best value-to-risk order:
   downloads → emulate → screenshot-slice → markdown → the "open in browser" menus →
   the `chrome` browser-type option. Each is self-contained and low-risk to remove.

3. **Treat multi-tab as a single, separate decision.** It's the biggest cut but also the
   biggest trade-off: removing it shrinks `cdp.ts`/`cdp-tab.ts` a lot (including the
   ~150-line title-prefix machinery) but drops to the single-tab path with weaker
   worker/iframe event capture. Decide this on its own, after the easy strips.

4. **Keep `/eval` if this is your personal box; reconsider it for work.** It's what makes
   the agent fast and capable. If the work machine's threat model cares that any local
   process can run JS as your session, remove `/eval` (and keep `/click`/`/type` — they
   don't depend on it) or put a shared-secret header in front of the HTTP server.

5. **Suggested bare-bones target:** keep the CDP engine + single page-read path +
   `navigate`/`eval`/`screenshot`/`url`/`status`, the MCP wrappers for those, port
   discovery, and Claude auto-config. Drop everything in the strippable table. That's a
   meaningfully smaller surface that still does "connect to the browser and navigate it."

6. **Do it incrementally and verify after each cut** — remove one feature, rebuild
   (`npm run package`), confirm navigate + read still work, commit. Small reversible steps
   beat one big strip.
