# Development

## How it works

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

- The browser tab opens the connection to the connector, since a web page cannot accept incoming sockets. The first
  frame must carry the session token or the socket is closed. Only localhost origins are accepted.
- Both sides implement a fixed list of commands. There is intentionally no tool for sending arbitrary editor messages.
- Every command becomes a regular editor message rather than simulated input, so undo, selection and the Layers
  panel behave exactly as they would for manual edits.
- Exports do not trigger browser downloads. The bridge captures the bytes Graphite produces and the connector writes
  the file, restricted to approved directories.
- The connector serves a pre-built copy of Graphite (`src/web/`): it downloads the release asset
  `graphite-web.tar.gz` for its own version into the user cache, serves it on `127.0.0.1:47833`, and opens it with the
  session token in the URL when no tab connects at start-up.

See [architecture.md](architecture.md) for the design rules and [graphite-internals.md](graphite-internals.md) for
the Graphite messages involved.

## Supported Graphite version

Upstream `master` at commit `ae321b3409113b238f1482a5ad71cbfff6929602` (27 September 2026) with the patch in
[`../graphite-patch/`](../graphite-patch/README.md). Graphite changes frequently. Section 10 of
[graphite-internals.md](graphite-internals.md) lists what to verify when building against a newer commit, and
[upstreaming.md](upstreaming.md) describes the plan to move the bridge into Graphite itself.

## Building the connector

```bash
git clone https://github.com/ACoci86/graphite-art-mcp.git
cd graphite-art-mcp
npm install
npm run build
```

Register the built server in Claude Code with `claude mcp add graphite -- node /absolute/path/to/dist/index.js`, or
with the equivalent entry in another client's configuration.

## Running Graphite from a local checkout

Use this when working on the bridge patch.

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
`GRAPHITE_MCP_WEB_DIR=/path/to/Graphite/frontend/dist`; the connector then serves that build instead of the release
bundle.

When the bridge source changes, keep the three copies identical: `graphite-patch/frontend/src/automation-bridge.ts`
(used by the tests), the Graphite checkout, and the patch file regenerated from `git diff HEAD` in the checkout.

## Tests

```bash
npm run typecheck
npm test              # protocol, socket client, MCP tools in memory, the bridge under jsdom, the web server, the bundle installer, text outlining
```

The unit tests do not require a Graphite build. The end-to-end test does:

```bash
npm run e2e -- --web-dir /path/to/Graphite/frontend/dist
```

It starts the built connector serving that bundle, opens it in headless Chromium, and drives every tool through a real
MCP client. WebGPU is disabled in that browser so Graphite uses its CPU renderer, which behaves the same on every
machine; set `GRAPHITE_E2E_CHROMIUM_ARGS` to test a GPU path.

## Claude Desktop extension

`npm run extension` builds the `.mcpb` bundle into `build/`. It stages the compiled connector with its production
dependencies and the bundled fonts, and generates the manifest from `package.json` and the server's own tool list, so
the manifest cannot drift from the code.

## Releasing

1. Set `CONNECTOR_VERSION` in `src/version.ts` and `version` in `package.json` to the same value.
2. Push a tag `vX.Y.Z`.

The Release workflow checks out Graphite at the pinned commit, applies the patch, builds the web app, builds the
extension, runs the end-to-end test against the freshly built app, attaches `graphite-web.tar.gz`, its SHA-256 and the
`.mcpb` to the GitHub release, and publishes the package to npm using the `NPM_TOKEN` repository secret.

To move to a newer Graphite commit, update `GRAPHITE_COMMIT` in `.github/workflows/release.yml`, re-apply and re-test
the patch, update the commit listed above, and publish a release.

For a manual end-to-end check with a connected Graphite, ask the client:

> Create a new Graphite document named "MCP Test". Insert a centered blue five-point star. Export it as SVG.

The document should appear, the star should be present as editable layers, and the export should be written to the
export directory.

## Known limitations

- Undo of a delete restores the layer but Graphite logs "Could not get nested network_metadata" errors in the browser
  console while doing so; they are harmless.
- Documents have no artboard unless the SVG workflow adds one.
- Style changes cover solid fills and strokes only; gradients and blend modes are not exposed yet.
- Transforms are applied in the parent's coordinate space; the connector does not know a layer's bounding box, so
  rotation and scaling need an explicit `origin` to pivot around a point other than the parent's origin.
- One connected tab at a time. A reloaded tab replaces the previous connection.
