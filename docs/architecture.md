# Architecture

```
┌──────────────────────────┐   MCP (stdio, JSON-RPC)   ┌──────────────────────────────────────┐
│ AI client                │ ◄───────────────────────► │ graphite-art-mcp  (Node process)      │
│ Claude Desktop / Code, … │                           │  src/index.ts     stdio transport      │
└──────────────────────────┘                           │  src/server.ts    McpServer + tools    │
                                                       │  src/tools/*      13 typed tools       │
                                                       │  src/graphite/client.ts  WS endpoint   │
                                                       └───────────────▲──────────────────────┘
                                                          ws://127.0.0.1:47832  (JSON, token)
                                                                       │ tab connects out
┌──────────────────────────────────────────────────────────────────────┴──────────────────────┐
│ Browser tab running Graphite                                                                │
│  frontend/src/automation-bridge.ts   auth, whitelist, waits for confirming FrontendMessages │
│        │ editor.automationInsertSvg(id, svg, x, y, center, parent?, name?)  (wasm-bindgen)  │
│        ▼                                                                                    │
│  frontend/wrapper/src/editor_commands.rs   fn automation_* (args) -> Message                │
│        ▼  dispatch()                                                                        │
│  editor crate: Dispatcher → PortfolioMessage / DocumentMessage / GraphOperationMessage       │
│        ▼                                                                                    │
│  FrontendMessage stream  ──► App.svelte callback ──► bridge.intercept() ──► SubscriptionsRouter │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

The connector also hosts the patched Graphite web app itself (`src/web/`): `bundle.ts` downloads the release asset
`graphite-web.tar.gz` for the connector's version into the user cache, `static-server.ts` serves it on
`http://127.0.0.1:47833`, and `browser.ts` opens it with the session token in the URL when no tab connects at start-up.
Developers can disable this (`GRAPHITE_MCP_SERVE=0`) and run Graphite's own dev server instead.

## Design rules

1. **Data-driving, never GUI-driving.** The bridge only calls wrapper functions that produce editor messages. No DOM
   selectors, no synthetic clicks.
2. **Closed whitelist on both ends.** `COMMAND_NAMES` in `src/graphite/protocol.ts` and `COMMANDS` in
   `automation-bridge.ts` must match. There is no generic "dispatch this message" command.
3. **Ids are strings on the wire.** Graphite's `NodeId`/`DocumentId` are `u64`; JS gets them as `bigint`; the protocol
   and MCP results carry decimal strings so nothing is ever rounded.
4. **Caller-allocated layer ids.** Wrapper commands cannot return values (`fn … -> Message`), so the connector
   generates the 64-bit `layer_id` and passes it in; the bridge confirms creation by watching
   `UpdateDocumentLayerStructure`.
5. **Observed document ids.** `NewDocumentWithName` allocates its own id, so the bridge awaits the next
   `UpdateActiveDocument`.
6. **Exports are intercepted, not downloaded.** Graphite hands file bytes to the frontend via `TriggerSaveFile`; while
   an automation export is pending the bridge swallows that message and returns the bytes over the socket. The connector
   writes the file inside approved roots only.
7. **Structured errors everywhere.** Both layers use the same stable code list (`src/graphite/errors.ts`).
8. **Inert by default.** Without a token in the URL/localStorage the bridge does nothing, so a patched Graphite build
   behaves exactly like stock.

## Sequence: `graphite_insert_svg`

1. MCP tool validates input (zod), prechecks the SVG, generates `layer_id`.
2. `GraphiteClient.request("insert_svg", …)` → JSON frame with a UUID `id` → tab.
3. Bridge: validates params, `DOMParser` check, verifies `parent_id` exists, verifies a document is active.
4. Bridge registers a waiter for `UpdateDocumentLayerStructure` containing `layer_id`, then calls
   `editor.automationInsertSvg(...)`.
5. Wrapper builds `Batched[AddTransaction, NewSvg{…}, SetDisplayName?, SelectedNodesSet, ActivateTool(Select)]`
   and dispatches synchronously. `NewSvg` parses with usvg, creates the group + child layers, applies the transform.
6. Frontend messages flow through `intercept` → waiter resolves → bridge replies `{ ok: true, result: { layer_id } }`.
7. Tool returns text + `structuredContent`.

Failure paths: usvg rejection → no layer appears → waiter times out → `INVALID_SVG`. Editor locked → message
buffered until next animation frame → still within the 10 s wait.

## Sequence: `graphite_export`

1. Tool resolves and authorises the output path, derives `name` (base name without extension).
2. Bridge sets `pendingExport`, calls `editor.automationExport(name, FileType, scale)` →
   `PortfolioMessage::SubmitDocumentExport { bounds: AllArtwork, … }`.
3. Executor renders asynchronously. For SVG: `TriggerSaveFile { name, content }` → intercepted → resolved.
   For raster: `TriggerExportImage` passes through to Graphite's own rasterizer, which calls `saveRasterizedExport`,
   producing a `TriggerSaveFile` with the encoded image → intercepted → resolved.
4. Bridge returns base64; connector writes the file and returns the absolute path.

## Versioning

`protocol_version` is negotiated in the `hello` frame; a mismatch closes the socket with code 4004. The bridge reports
`graphite_commit` from `editor::application::GRAPHITE_GIT_COMMIT_HASH` (exposed via `graphiteCommitHash()`), and
`graphite_get_capabilities` surfaces it so incompatibilities can be diagnosed from the AI side.

See `docs/upstreaming.md` for the plan to move the bridge into Graphite itself.
