# Verifying Changes — how to build, run, and test this extension

How to prove a change actually works at runtime, and how to avoid the caching traps
that make you test stale code. Written for someone who has never built a VS Code
extension before.

---

## TL;DR (read this; skip the rest unless you need detail)

- **Two ways to run it:** (1) **F5** opens an isolated "Extension Development Host"
  window running your source — the fast dev loop. (2) **Package a `.vsix` and install
  it** — what a real user gets; use this for final sign-off.
- **The dev loop:** `npm install` once, press **F5**, a second VS Code window opens with
  the extension live. Edit code → the watch task rebuilds → run **Developer: Reload
  Window** in that second window to load the new code.
- **Compiling proves almost nothing.** This extension leans on moving Chromium/VS Code
  APIs; a change can compile and still be a runtime no-op. You must exercise it live.
- **Test in layers, matching the architecture:** (1) `npm run check-types`, (2) hit the
  **HTTP server directly with curl** (isolates the browser engine, no Claude Code restart
  needed), (3) full **Claude Code restart** then drive the **MCP tools** end to end.
- **The #1 caching trap:** Claude Code captures the MCP child process **once at session
  start**. Reloading VS Code or reinstalling the extension does **not** refresh it. After
  changing MCP code you must **fully restart Claude Code** (`/exit` + relaunch), not just
  reload.
- **Other stale-state sources:** the copied MCP bundle at `~/.integrated-browser-agent-connect/`,
  leftover instance files in `~/.integrated-browser-agent-connect/instances/`, a port that crept up
  to 3789/3790, and a browser tab holding old page state. Clean-room checklist is in §5.
- **Proposed-API (multi-tab) path:** F5 enables it automatically; an installed `.vsix`
  needs VS Code launched with `--enable-proposed-api=sheriff-stuff.integrated-browser-agent-connect`.
  Confirm which path you're on via `GET /status` → `transport`.

Recommended loop is at the bottom (§6).

---

## 1. One-time setup

```bash
npm install
```

That installs dependencies. You don't need `vsce` globally — the repo uses `npx vsce`.

## 2. The fast dev loop (F5 / Extension Development Host)

This is how you iterate. You do **not** package or install anything.

1. Open this repo in VS Code.
2. Press **F5** (or Run → Start Debugging). Per `.vscode/launch.json`, this first runs the
   default build task (`watch`, which starts `tsc` + `esbuild` in watch mode), then opens a
   **second VS Code window** — the *Extension Development Host* — with your extension loaded
   straight from source (`--extensionDevelopmentPath=${workspaceFolder}`).
3. That second window is where you test. The extension auto-starts (`onStartupFinished`),
   binds the HTTP server, and lazy-launches the browser on the first request.
4. **After editing code:** the watch task rebuilds automatically, but the running window
   keeps the *old* code until you refresh it. In the Extension Development Host window run
   **Developer: Reload Window** (Command Palette). That reactivates the extension with the
   new build.

**F5 vs. installing a VSIX:** F5 runs an unpackaged dev build in an isolated window —
breakpoints work, reload is instant, and it doesn't touch your normal VS Code. A `.vsix`
is the packaged, distributable form you install into a real VS Code to test the actual
user experience. Use F5 for development; use a VSIX for final verification.

> Watch-task caveat: `watch:tsc` only type-checks the **extension** project
> (`tsconfig.json`). The **MCP server** has its own `tsconfig.mcp.json` that watch does
> **not** cover, and esbuild bundles without type-checking. So MCP type errors only show
> up when you run `npm run check-types` (which checks both). Run it before trusting an MCP
> change.

## 3. The real-install loop (packaged VSIX)

Closest to what a user gets. Use this to sign off before publishing or relying on it at work.

```bash
npx vsce package                        # runs the production build via vscode:prepublish
code --install-extension integrated-browser-agent-connect-<ver>.vsix --force
```

> On vsce 3.x, `package` needs `--allow-proposed-apis browser` (the extension declares the
> `browser` proposal). vsce 2.x neither needs nor accepts the flag.

- `--force` matters: without it, installing the **same version number** may be skipped, so
  you'd keep running the old code — a classic "why didn't my change take" trap. `--force`
  overwrites.
- Then **Developer: Reload Window** (or restart VS Code) so the new install activates.
- To remove it again: uninstall from the Extensions view, or
  `code --uninstall-extension sheriff-stuff.integrated-browser-agent-connect`.

## 4. Verifying in layers (do these in order)

Each layer isolates one part of the chain you mapped in the architecture review.

**Layer 1 — types/compile (necessary, not sufficient):**
```bash
npm run check-types     # tsc for BOTH the extension and the MCP server
```
This catches type breakage. It tells you **nothing** about runtime — the underlying
Chromium/VS Code APIs can change shape and a clean compile can still be a no-op.

**Layer 2 — HTTP server directly with curl (isolates the browser engine):**

This is the fastest real test and it **needs no Claude Code restart** — you're bypassing
the MCP layer entirely and talking to the engine. First find the actual port (it starts at
3788 but increments if taken):
```bash
cat ~/.integrated-browser-agent-connect/instances/*.json     # shows port + workspace + pid
curl http://127.0.0.1:3788/status                  # bridge health + transport
curl -X POST http://127.0.0.1:3788/navigate \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'
curl -X POST http://127.0.0.1:3788/eval \
  -H 'Content-Type: application/json' -d '{"expression":"document.title"}'
```
If the feature works over curl, the engine + HTTP layer are correct. Any remaining problem
is in the MCP layer.

**Layer 3 — MCP tools end to end (the full chain):**

Only this layer needs the Claude Code restart (see §5). After restarting Claude Code, ask
it to use a tool by name, e.g. *"use browser_navigate to open https://example.com"*, then
*"use browser_eval to return document.title"*. Confirm the result matches what curl gave.

## 5. Caching traps — making sure you're not testing stale code

This extension persists state in several places. Each is a way to accidentally run old code.

1. **Claude Code's MCP child process is frozen at session start.** Claude Code spawns
   `node ~/.integrated-browser-agent-connect/mcp-server.mjs` once when the session begins and holds
   that process for the whole session. Reloading the VS Code window or reinstalling the
   extension does **not** replace it. **Fix:** fully restart Claude Code (`/exit` then
   relaunch) after any MCP-server change. (This is why Layer 2 / curl is so useful — it
   skips this entirely.)

2. **The copied MCP bundle.** On activation the extension copies `dist/mcp-server.mjs` to
   the stable path `~/.integrated-browser-agent-connect/mcp-server.mjs` (that copy is what Claude Code
   runs). So the order is: build → **reload the extension window** (so it re-copies) → then
   restart Claude Code (so it picks up the fresh copy). Skip the reload and you restart
   Claude Code onto a stale bundle.

3. **Stale instance files.** `~/.integrated-browser-agent-connect/instances/*.json` map workspace →
   port. Dead ones are cleaned on the next window startup, but during rapid testing they can
   point the MCP at the wrong window. `cat` them to see what's registered; delete manually if
   in doubt.

4. **Port drift.** If a previous instance didn't release 3788, the new one binds 3789, 3790,
   … Always read the real port from `/status` or the instance file rather than assuming 3788.

5. **Browser page state.** The browser launches lazily and keeps its page, cookies, and any
   sticky `browser_emulate` override. For a clean test, close the browser tab (this
   disconnects CDP) or navigate to `about:blank` first.

6. **`~/.claude.json`.** The extension writes its MCP entry here on activation. Harmless, but
   relevant if you later split HTTP from MCP — that's the file the auto-config touches.

## 6. Recommended verification loop

For a typical change (e.g. removing a feature during the strip-down):

1. **Build:** let the F5 watch task rebuild, or run `npm run package`.
2. **Type-check both projects:** `npm run check-types`.
3. **Reload** the Extension Development Host window (**Developer: Reload Window**).
4. **Layer 2 first — curl** the affected endpoint(s) plus a sanity check that
   `/navigate` + `/eval` still work. Most regressions surface here, fast, with no restart.
5. **Layer 3 — restart Claude Code** and drive the matching MCP tool only if the change
   touched the MCP layer or you want full end-to-end confidence.
6. **Final sign-off (optional but recommended for work use):** package a `.vsix`, install
   with `--force`, reload, and repeat the smoke test on the real install.
7. **Commit** the verified change before starting the next cut — small reversible steps.

For removing a whole feature, the strongest check is the **negative** one: confirm the
endpoint/tool is gone (curl returns 404 / the MCP tool no longer lists) **and** that
`/navigate` + `/eval` still work — i.e. you removed only what you meant to.
