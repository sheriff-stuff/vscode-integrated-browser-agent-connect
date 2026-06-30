# TODO

## Deferred: cut multi-tab support

**Status:** deferred — not doing it now. Multi-tab stays in.

### Why this came up
While verifying the tools after the strip-down, `browser_emulate` *appeared* broken on
this machine: setting `{width:390, height:844, mobile:true}` left `window.innerWidth` at
`980`, not `390`. The machine runs the proposed-`browser`-API / `browserTab` (multi-tab)
transport, so the first guess was "emulate's viewport sizing doesn't work on the multi-tab
transport — cut multi-tab to force the single-tab path where it works."

### Why that was wrong (the actual reason it "broke")
It wasn't broken. The test was bad:
- The test page was **non-responsive** (no `<meta name="viewport">`).
- With `mobile:true`, Chromium renders a non-responsive page at the **980px mobile default
  layout width** and scales it down — that's exactly how a real mobile browser shows a
  non-responsive site. So `innerWidth = 980` was **correct behaviour**, not a dropped
  override.
- Re-tested without `mobile` (`{width:1280, height:800}`) on the same multi-tab transport:
  `innerWidth = 1280`, `innerHeight = 800`, `path: "emulation"`. The width override works.

**Conclusion:** emulate works on the multi-tab/`browserTab` transport. There is **no
functional reason to cut multi-tab.** It was kept on purpose; you don't have to use it
(omit `tabId` → everything targets the active tab, just like single-tab).

### If you ever do want to cut it (for a smaller codebase only)
Removing multi-tab means deleting the proposed-API path and dropping to the single-tab
debug-session (`editor-browser` / `requestCDPProxy` / websocket) transport. Touch points:

- `src/cdp.ts` — `openTab`, `adoptBrowserTab`, `untrackBrowserTab`, `syncActive`,
  `pendingAdoptions`, `ownerId`, `allocateNumber`, `numberToPrefix`, `displayNumber` usage.
- `src/cdp-tab.ts` — `connectToBrowserTab` + the BrowserCDPSession plumbing, and the
  title-prefix machinery (`buildTitleScript`, `setTitlePrefix`, `removeTitlePrefix`,
  `titleScriptId`, `currentTitlePrefix`).
- `src/extension.ts` — `hasProposedBrowserApi`, `launchBrowserViaProposedApi`, the
  proposed-API branch in `launchBrowser`, and the `onDidOpenBrowserTab` /
  `onDidCloseBrowserTab` / `onDidChangeActiveBrowserTab` listeners + startup adopt loop.
- `src/http-server.ts` — `/tab/open`, `/tab/close`, `/tab/activate` (decide whether to keep
  `/tabs` for the single synthetic tab).
- `src/mcp-server.ts` — `browser_tab_open`, `browser_tab_close`, `browser_tab_activate`
  (decide whether to keep `browser_tab_list`).
- `package.json` — `enabledApiProposals: ["browser"]` and the `publish:marketplace`
  `--allow-proposed-apis browser` flag.
- `src/typings/vscode.proposed.browser.d.ts` — delete.
- README / CLAUDE.md — drop the multi-tab + proposed-API sections.

**Tradeoff if cut:** you lose multi-tab *and* the `browserTab` transport's better
worker/iframe console + network capture (the websocket fallback only captures the main
page session). Verify after with `npm test`, then reinstall the VSIX and restart Claude
Code (the MCP child is captured at session start).
