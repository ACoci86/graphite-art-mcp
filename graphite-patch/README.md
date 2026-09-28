# Graphite automation-bridge patch

The connector needs a small addition to Graphite: **4 files, +776 lines, no new dependencies, no changes to
`/editor`**. Stock behaviour is unchanged unless the tab is opened with an automation token.

Tested against upstream commit `ae321b3409113b238f1482a5ad71cbfff6929602` (2026‑09‑27).

## Apply

```bash
cd /path/to/Graphite
git checkout ae321b3409113b238f1482a5ad71cbfff6929602   # optional but recommended for a first run
git apply /path/to/graphite-art-mcp/graphite-patch/automation-bridge.patch
cargo run                                                # Graphite's normal dev server
```

If `git apply` reports conflicts on a newer Graphite, apply the pieces by hand; the full post-patch files are in
`frontend/` next to this README for reference.

## What it touches

### `frontend/wrapper/src/editor_commands.rs`

Eleven new command functions appended inside the existing `#[editor_commands] mod editor_commands` block, plus
`use` lines for `ExportBounds`, `TransformIn`, `ToolType`, `Stroke` and `glam::{DAffine2, DVec2}`.

| Rust fn | Generated JS | Editor message it produces |
| --- | --- | --- |
| `automation_new_document(name)` | `automationNewDocument(name)` | `PortfolioMessage::NewDocumentWithName` |
| `automation_insert_svg(id, svg, x, y, center, parent_id?, name?)` | `automationInsertSvg(id: bigint, svg, x, y, center, parentId?: bigint, name?)` | `Batched[DocumentMessage::AddTransaction, GraphOperationMessage::NewSvg, NodeGraphMessage::SetDisplayName?, NodeGraphMessage::SelectedNodesSet, ToolMessage::ActivateTool(Select)]` — the same sequence `DocumentMessage::InsertSvg` uses |
| `automation_export(name, file_type, scale_factor)` | `automationExport(name, fileType, scaleFactor)` | `PortfolioMessage::SubmitDocumentExport { bounds: AllArtwork, … }` |
| `automation_set_fill(id, color?)` | `automationSetFill(id, color?)` | `Batched[AddTransaction, GraphOperationMessage::FillColorSet]` |
| `automation_set_stroke(id, color?, weight)` | `automationSetStroke(id, color?, weight)` | `Batched[AddTransaction, GraphOperationMessage::StrokeSet { stroke: Stroke::new(weight) }]` |
| `automation_set_opacity(id, opacity)` | `automationSetOpacity(id, opacity)` | `Batched[AddTransaction, GraphOperationMessage::OpacitySet]` |
| `automation_set_transform(id, a, b, c, d, e, f, replace)` | `automationSetTransform(...)` | `Batched[AddTransaction, GraphOperationMessage::TransformChange or TransformSet { transform_in: Local }]` |
| `automation_delete_layer(id)` | `automationDeleteLayer(id)` | `DocumentMessage::DeleteNode` |
| `automation_rename_layer(id, name)` | `automationRenameLayer(id, name)` | `NodeGraphMessage::SetDisplayName` |
| `automation_undo()` / `automation_redo()` | `automationUndo()` / `automationRedo()` | `DocumentMessage::Undo` / `Redo` |

Switching documents reuses the existing `selectDocument(documentId)` command.

Because the macro also compiles these bodies into the desktop `EditorCommand` enum, the same commands work on the
native build without extra work (the bridge itself is web-only for now).

### `frontend/wrapper/src/editor_wrapper.rs` (+7)

`graphiteCommitHash(): string` getter returning `editor::application::GRAPHITE_GIT_COMMIT_HASH`, so the bridge
can report which Graphite commit it is running for compatibility diagnostics.

### `frontend/src/automation-bridge.ts` (new)

The bridge. Reads the token from `?automation=` (then stores it in `localStorage.graphiteAutomationToken` and
scrubs the URL) or from localStorage; if absent it is completely inert. Otherwise it connects to
`ws://127.0.0.1:47832` (override with `?automationEndpoint=ws://127.0.0.1:PORT`, local hosts only), authenticates,
and services the whitelisted commands (`get_capabilities`, `new_document`, `insert_svg`, `export`, `get_document`,
`select_document`, `set_fill`, `set_stroke`, `set_opacity`, `set_transform`, `delete_layer`, `rename_layer`, `undo`,
`redo`). It also caches `UpdateDocumentLayerDetails` so `get_document` can report layer names, kinds and visibility. It observes
`UpdateActiveDocument`, `UpdateOpenDocumentsList` and `UpdateDocumentLayerStructure` to learn ids and confirm results,
and captures `TriggerSaveFile` while an export it started is pending (or, if that export's wait already expired, once
more so the late file is dropped rather than downloaded).

Waits: `insert_svg` waits 10 s plus 40 ms per SVG element (Graphite builds one layer per element), capped at 120 s, or
whatever `timeout_ms` the connector passes; expiry is reported as `BRIDGE_TIMEOUT` with the layer id in `details`, never
as `INVALID_SVG` (well-formedness is checked up front with `DOMParser`). `export` refuses an empty document immediately
and reports a slow render as `BRIDGE_TIMEOUT` with the layer count.

### `frontend/src/App.svelte` (+7)

Creates the bridge, taps the `EditorWrapper.create` callback (`if (bridge.intercept(type, data)) return;`),
attaches the editor handle after creation, and destroys the bridge on unmount.

## Upstreaming

The wrapper additions are written to be upstreamable as-is: they are ordinary `editor_commands`, follow the file's
existing conventions, and compose only public editor messages. The bridge could become an opt-in feature in
Graphite proper; until then it lives here as a patch.

## Verifying the patch without the connector

Open the patched Graphite, then in the browser console:

```js
localStorage.graphiteAutomationToken = "test"; location.reload();
```

With no connector running, the console will show reconnect attempts every 2 s and nothing else — proving the bridge
is loaded and harmless. Start the connector with `GRAPHITE_MCP_TOKEN=test` and the next attempt connects.
