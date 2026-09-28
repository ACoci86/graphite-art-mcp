# graphite-art-mcp

An unofficial MCP connector for the [Graphite](https://graphite.art) graphics editor.

It allows Claude Desktop, Claude Code, and other [Model Context Protocol](https://modelcontextprotocol.io/) clients
to create artwork inside a running Graphite editor. The AI client writes SVG, the connector passes it to Graphite,
and Graphite converts it into standard vector layers that remain fully editable. Every command is delivered as a
regular editor message rather than simulated input, so undo, selection and the Layers panel behave exactly as they
would for manual edits.

> This project is not affiliated with or endorsed by the Graphite project or the Graphite Foundation. Graphite is an
> independent open source project (MIT / Apache-2.0). This connector is MIT licensed. It is unrelated to the Graphite
> code review tool at graphite.com and to the `graphite-mcp` package on PyPI.

## Installation

The only prerequisite is Node.js 20 or newer.

Claude Desktop (Settings, Developer, Edit Config):

```json
{
  "mcpServers": {
    "graphite": {
      "command": "npx",
      "args": ["-y", "graphite-art-mcp"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add graphite -- npx -y graphite-art-mcp
```

On first use, the connector downloads a pre-built copy of Graphite into the user cache directory (a one-time download
of a few megabytes), serves it at `http://127.0.0.1:47833`, and opens it in the default browser. The page connects
automatically. The session token is included in the URL and stored by the browser tab, so subsequent restarts
reconnect without any manual steps.

To open the tab manually instead, set `GRAPHITE_MCP_OPEN_BROWSER=0`. The `graphite_get_capabilities` tool reports the
URL as `web_url`.

If something does not connect, run `npx graphite-art-mcp doctor`. It checks the Node version, both ports, the token,
the web app download, the export directory and the fonts, and prints what to fix.

Exported files are written to `~/graphite-mcp-exports` unless `GRAPHITE_MCP_EXPORT_DIR` is set. All settings are
listed under Configuration.

The pre-built copy is Graphite at the commit listed below, with the bridge patch from `graphite-patch/` applied. It is
compiled from the upstream sources by this repository's Release workflow. The download can be verified with
`GRAPHITE_MCP_BUNDLE_SHA256`; the hash is published alongside each release asset.

## Tools

Version 0.2.0 provides thirteen tools for creating and editing layers, inspecting the document, and exporting.

| Tool | Description |
| --- | --- |
| `graphite_get_capabilities` | Reports whether a Graphite tab is connected, the Graphite commit, the available commands, and the URL of the served web app. |
| `graphite_new_document` | Creates a new document and makes it the active tab. Returns `document_id`. |
| `graphite_insert_svg` | Inserts SVG, either inline or from a file via `svg_path`, as an editable group layer. Text is converted to paths first. Returns `layer_id`. |
| `graphite_export` | Renders the active document to SVG, PNG, JPG, WebP, TIFF, BMP, TGA or ICO and writes the file to disk. |
| `graphite_get_document` | Returns the active document's layers (id, name, kind, visibility, parent) and the open documents. Use it to confirm an insert before retrying. |
| `graphite_preview` | Renders the active document to a small PNG and returns it as an image, so the AI client can check the result without writing a file. |
| `graphite_set_style` | Sets the fill colour, stroke colour and width, or opacity of an existing layer. |
| `graphite_transform_layer` | Moves, scales or rotates an existing layer, or applies a raw affine matrix, in its parent's coordinate space. |
| `graphite_rename_layer` | Renames a layer in the Layers panel. |
| `graphite_delete_layer` | Deletes a layer and its contents. |
| `graphite_undo`, `graphite_redo` | Step through the document's history. |
| `graphite_select_document` | Makes another open document active; `graphite_get_document` lists them. |

Supported Graphite version: upstream `master` at commit `ae321b3409113b238f1482a5ad71cbfff6929602` (27 September
2026) with the patch in [`graphite-patch/`](graphite-patch/README.md). Graphite changes frequently. Section 10 of
[`docs/graphite-internals.md`](docs/graphite-internals.md) lists what to verify when building against a newer commit.

## Architecture

```
Claude / any MCP client
        |  MCP over stdio
        v
graphite-art-mcp  (Node, this repository)    listens on ws://127.0.0.1:47832
        ^  JSON request/response, session token
        |
Graphite tab  ->  frontend/src/automation-bridge.ts  (connects to the socket)
        |  automationInsertSvg(...) and related wrapper calls, via wasm-bindgen
        v
frontend/wrapper/src/editor_commands.rs  ->  standard editor messages
        v
Graphite editor (Rust/WASM)  ->  GraphOperationMessage::NewSvg, PortfolioMessage::SubmitDocumentExport, ...
```

Design decisions:

- The browser tab opens the connection to the connector, since a web page cannot accept incoming sockets. The first
  frame must carry the session token or the socket is closed. Only localhost origins are accepted.
- Both sides implement a fixed list of commands. There is intentionally no tool for sending arbitrary editor messages.
- Exports do not trigger browser downloads. The bridge captures the bytes Graphite produces and the connector writes
  the file, restricted to approved directories.

## Developer setup

This section applies only when working on the bridge patch or running Graphite from a local checkout.

```bash
git clone https://github.com/ACoci86/graphite-art-mcp.git
cd graphite-art-mcp
npm install
npm run build
```

Patch and run Graphite:

```bash
git clone https://github.com/GraphiteEditor/Graphite.git
cd Graphite
git checkout ae321b3409113b238f1482a5ad71cbfff6929602   # tested commit; newer commits may also work
git apply /path/to/graphite-art-mcp/graphite-patch/automation-bridge.patch
cargo run           # builds the wasm wrapper and starts the development server
```

If the patch does not apply cleanly to a newer Graphite, `graphite-patch/README.md` describes the four affected files
so the changes can be applied manually.

Configure the connector to use the local Graphite instead of serving its own copy, and set a fixed token:

```json
{
  "mcpServers": {
    "graphite": {
      "command": "node",
      "args": ["/absolute/path/to/graphite-art-mcp/dist/index.js"],
      "env": { "GRAPHITE_MCP_SERVE": "0", "GRAPHITE_MCP_TOKEN": "choose-a-long-random-string" }
    }
  }
}
```

Open the URL printed by Graphite (usually `http://localhost:8080`) once with the token appended:

```
http://localhost:8080/?automation=choose-a-long-random-string
```

The bridge stores the token in `localStorage`, removes it from the URL, and connects. The browser console shows
`[automation-bridge] connected to ws://127.0.0.1:47832`.

Alternatively, build the web app with `cargo run build web` and set
`GRAPHITE_MCP_WEB_DIR=/path/to/Graphite/frontend/dist`. The connector then serves that build instead of the release
bundle.

## Configuration

All settings are environment variables.

| Variable | Default | Description |
| --- | --- | --- |
| `GRAPHITE_MCP_TOKEN` | generated once, then cached | Session token the tab must present. If unset, a token is generated on the first run and saved in the cache directory so it remains stable across restarts. |
| `GRAPHITE_MCP_PORT` | `47832` | WebSocket port. |
| `GRAPHITE_MCP_HOST` | `127.0.0.1` | Bind address. Binding to other interfaces exposes the editor to the network. |
| `GRAPHITE_MCP_EXPORT_DIR` | `~/graphite-mcp-exports` | Destination for exports when no path is given. |
| `GRAPHITE_MCP_EXPORT_ROOTS` | (empty) | Additional directories exports may be written to, separated by `:` (`;` on Windows). |
| `GRAPHITE_MCP_ALLOWED_ORIGINS` | any localhost origin | Comma-separated browser origins allowed to connect. |
| `GRAPHITE_MCP_REQUEST_TIMEOUT_MS` | `15000` | Timeout for simple commands and the minimum wait for `insert_svg`. |
| `GRAPHITE_MCP_EXPORT_TIMEOUT_MS` | `60000` | Export timeout. The first raster render of a large document is the slowest. |
| `GRAPHITE_MCP_INSERT_MS_PER_ELEMENT` | `40` | Additional wait per SVG element on insert. Graphite creates one layer per element, so a 500-element file is allowed about 30 seconds. |
| `GRAPHITE_MCP_INSERT_GRACE_MS` | `30000` | After an insert wait expires, how long the connector keeps polling `get_document` for the layer before reporting failure. |
| `GRAPHITE_MCP_SERVE` | `1` | Serve the pre-built Graphite web app locally. Set to `0` for the developer setup. |
| `GRAPHITE_MCP_WEB_PORT` | `47833` | Port of the local web server. |
| `GRAPHITE_MCP_WEB_DIR` | (download) | Serve this `frontend/dist` directory instead of downloading the release bundle. |
| `GRAPHITE_MCP_BUNDLE_URL` | GitHub release asset for this version | Download location of the pre-built app. |
| `GRAPHITE_MCP_BUNDLE_SHA256` | (not verified) | Hex SHA-256 the download must match. |
| `GRAPHITE_MCP_CACHE_DIR` | `~/.cache/graphite-art-mcp` (varies by OS) | Location of bundles and the generated token. |
| `GRAPHITE_MCP_OPEN_BROWSER` | `1` | Open the served app in the default browser when no tab connects within 3 seconds of start. |
| `GRAPHITE_MCP_FONT_DIR` | (bundled fonts only) | Directories with `.ttf` or `.otf` files used when outlining text, separated by `:` (`;` on Windows). |

## Errors

Every failure is returned as an MCP `isError` result whose text is JSON: `{ "code": "...", "message": "...", "details"?: ... }`.
The codes are `GRAPHITE_NOT_CONNECTED`, `GRAPHITE_CRASHED`, `NO_ACTIVE_DOCUMENT`, `LAYER_NOT_FOUND`,
`LAYER_NOT_CREATED`, `INVALID_SVG`, `INVALID_PARAMS`, `EXPORT_FAILED`, `EXPORT_PATH_NOT_ALLOWED`, `UNSUPPORTED_FORMAT`,
`UNKNOWN_COMMAND`, `BRIDGE_TIMEOUT`, `GRAPHITE_VERSION_UNSUPPORTED` and `UNEXPECTED`.

Exported files are also available as MCP resources named `graphite-export://<file>`, so a client can list and read
them without a filesystem path.

`BRIDGE_TIMEOUT` from `graphite_insert_svg` deserves attention. It means Graphite had not confirmed the new layer
within the allowed time; it does not mean the insert failed. The layer usually appears shortly afterwards. Call
`graphite_get_document` and look for the `layer_id` given in the error before inserting again. Repeating the insert
without checking creates a duplicate.

## Working with large or detailed artwork

- Graphite's SVG importer cannot render `<text>` in the web build, so the connector converts text to outlined paths
  before inserting. It ships Liberation Sans, Serif and Mono (regular and bold, SIL Open Font License) and maps common
  names such as Arial, Helvetica, Times and Courier onto them; italic is synthesised with a skew. For a specific
  typeface, place `.ttf` or `.otf` files in the directory named by `GRAPHITE_MCP_FONT_DIR`. Supported: `x`, `y`,
  `dx`, `dy`, `tspan`, `font-size` (px, pt, em), `font-family`, `font-weight`, `font-style`, `letter-spacing` and
  `text-anchor`, as attributes or in `style`. Pass `outline_text: false` to insert the raw text instead.
- Each SVG element becomes a layer, at roughly 30 to 40 ms per element, so large drawings take time to insert. Save
  them to a file and pass `svg_path` rather than sending large markup inline on every call.
- `<defs>`, `<use>`, `<symbol>` and gradients are handled by Graphite's importer and need no preparation.
- Preview the SVG locally before inserting it. Rendering with Inkscape, rsvg or a browser costs nothing, whereas each
  Graphite round trip takes seconds. After inserting, `graphite_preview` returns the rendered canvas as an image so the
  result can be checked directly.
- Three-dimensional objects such as boxes and trays look correct only when built as real 3D geometry, projected once,
  and drawn back to front. Shapes positioned by eye rarely look right. Consulting a few reference images first
  reduces the number of iterations considerably.

## Development

```bash
npm run typecheck
npm test              # protocol, socket client, MCP tools in memory, the bridge under jsdom, the web server and the bundle installer
npm run inspect       # MCP Inspector against the built server
```

The unit tests do not require a Graphite build. The end-to-end test does:

```bash
npm run e2e -- --web-dir /path/to/Graphite/frontend/dist
```

It starts the built connector serving that bundle, opens it in headless Chromium, and drives every tool through a real
MCP client. The Release workflow runs it against the bundle it just built before publishing.

## Releasing

1. Set `CONNECTOR_VERSION` in `src/version.ts` and `version` in `package.json` to the same value.
2. Push a tag `vX.Y.Z`.

The Release workflow checks out Graphite at the pinned commit, applies the patch, builds the web app, attaches
`graphite-web.tar.gz` and its SHA-256 to the GitHub release, and publishes the package to npm when an `NPM_TOKEN`
repository secret is configured. The connector downloads the asset matching its own version on first run.

To move to a newer Graphite commit, update `GRAPHITE_COMMIT` in `.github/workflows/release.yml`, re-apply and re-test
the patch, and publish a release.

For a manual end-to-end check with a connected Graphite, ask the client:

> Create a new Graphite document named "MCP Test". Insert a centered blue five-point star. Export it as SVG.

The document should appear, the star should be present as editable layers, and the export should be written to the
export directory.

## Known limitations

- Undo of a delete restores the layer but Graphite logs "Could not get nested network_metadata" errors in the browser
  console while doing so; they are harmless.
- Documents have no artboard unless the SVG workflow adds one. `graphite_add_artboard` is planned.
- Text becomes outlined paths, not editable text layers. Native text layers are planned.
- Export always renders all artwork, not a selection or a single artboard.
- One connected tab at a time. A reloaded tab replaces the previous connection.
- Style changes cover solid fills and strokes only; gradients and blend modes are not exposed yet.
- Transforms are applied in the parent's coordinate space; the connector does not know a layer's bounding box, so
  rotation and scaling need an explicit `origin` to pivot around a point other than the parent's origin.

## License

MIT, see [LICENSE](LICENSE). Graphite itself is MIT / Apache-2.0 and is not redistributed in this repository. The
patch under `graphite-patch/` is offered under the same dual license so that it can be upstreamed.
