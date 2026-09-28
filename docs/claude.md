# Using graphite-art-mcp with Claude

The connector is a standard stdio MCP server, so any Claude surface that supports MCP can use it. Configuration
formats change over time; the authoritative references are:

- Claude Desktop: <https://modelcontextprotocol.io/quickstart/user>
- Claude Code: <https://docs.claude.com/en/docs/claude-code/mcp>

## Quick setup (recommended)

### Claude Desktop: install the extension

Download the `.mcpb` file from the latest GitHub release and open it. Claude Desktop installs it and shows a settings
panel; the defaults work. Skip the rest of this section unless you prefer the config file.

### Claude Desktop: config file

Edit the config file (Settings → Developer → Edit Config), e.g.
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS or
`%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "graphite": {
      "command": "npx",
      "args": ["-y", "graphite-art-mcp"],
      "env": { "GRAPHITE_MCP_EXPORT_DIR": "/Users/you/Pictures/graphite-exports" }
    }
  }
}
```

Restart Claude Desktop. The tools icon should list the `graphite_*` tools.

### Claude Code

```bash
claude mcp add graphite -e GRAPHITE_MCP_EXPORT_DIR=$HOME/graphite-exports -- npx -y graphite-art-mcp
```

Check with `claude mcp list` / `/mcp` inside a session.

### What happens on first use

The connector downloads a pre-built Graphite once into your user cache, serves it at `http://127.0.0.1:47833`, and
opens it in your browser with the session token already in the URL. The tab remembers the token, so on later starts it
simply reconnects. No Rust, no Graphite checkout, no token copying. Set `GRAPHITE_MCP_OPEN_BROWSER=0` if you prefer to
open the tab yourself (`graphite_get_capabilities` reports the URL as `web_url`).

## Developer setup (your own Graphite build)

Build the connector (`npm install && npm run build`), register `node /absolute/path/to/dist/index.js` instead of
`npx`, add `"GRAPHITE_MCP_SERVE": "0"` and a fixed `GRAPHITE_MCP_TOKEN` to the `env` block, then run the patched
Graphite checkout with `cargo run` and open it once with `?automation=<your token>` appended. See the README for the
full steps.

## 5. Try it

Ask Claude:

> Check whether Graphite is connected.

(It calls `graphite_get_capabilities`.) Then:

> Create a new Graphite document called "Fox logo", insert a minimalist orange fox head made of a few polygons, centred at (400, 400), and export it as SVG.

You should see the layers appear live in Graphite and get back the export path.

## Tips for good results

- Ask Claude to look up references and preview the SVG locally before inserting; Graphite round trips are slow and the
  connector cannot show the canvas.
- For anything beyond a few dozen elements, have Claude write the SVG to a file and pass `svg_path`.
- Text is converted to paths automatically; for a particular typeface, set `GRAPHITE_MCP_FONT_DIR`.
- If an insert reports `BRIDGE_TIMEOUT`, `graphite_get_document` tells you whether the layer landed; the connector already
  waits a grace period and reports `confirmed_late: true` when it does.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `GRAPHITE_NOT_CONNECTED` | Is the Graphite tab open? Does its console show the bridge connected? Same token on both sides? Same port (`GRAPHITE_MCP_PORT` vs. `?automationEndpoint=`)? |
| Console: `connector rejected this tab (4003 bad token)` | Token mismatch. Reopen the tab with `?automation=<token>` using the value from the MCP config. |
| Console: `(4004 protocol version mismatch)` | Connector and patch are from different versions of this repo. Rebuild both. |
| `INVALID_SVG` | The markup is not well-formed XML, has no `<svg>` root, or contains `<script>`. Add `xmlns="http://www.w3.org/2000/svg"`, a `viewBox`, and close all tags. |
| `BRIDGE_TIMEOUT` on `graphite_insert_svg` | Graphite had not reported the layer when the wait (10 s + 40 ms per element, then a 30 s grace) ran out. **Do not retry blindly:** call `graphite_get_document` and look for the `layer_id` in the error's `details`; the layer usually appears. Split very large files or raise `GRAPHITE_MCP_INSERT_MS_PER_ELEMENT`. |
| `BRIDGE_TIMEOUT` on `graphite_export` | Rendering exceeded `GRAPHITE_MCP_EXPORT_TIMEOUT_MS`; the first raster render of a large document is the slow one. Retry, or raise the limit. A late result is discarded, never downloaded by the tab. |
| `EXPORT_FAILED` … no layers | The document is empty; insert something first. |
| Text looks wrong or uses the wrong typeface | The connector outlines `<text>` with bundled Liberation fonts. Put the wanted `.ttf`/`.otf` files in `GRAPHITE_MCP_FONT_DIR`; they are matched by family name. |
| `EXPORT_PATH_NOT_ALLOWED` | Paths must be inside `GRAPHITE_MCP_EXPORT_DIR` or `GRAPHITE_MCP_EXPORT_ROOTS`. |
| The tab says `4003 bad token` after an update | The cached token in the connector's cache directory differs from the one the tab remembered. Open the `web_url` from `graphite_get_capabilities` once; it carries the current token. |
| "Graphite web app unavailable" in the logs | The release bundle could not be downloaded (offline, or `REPOSITORY` in `src/version.ts` not set yet). Use the developer setup, or `GRAPHITE_MCP_WEB_DIR` with your own `frontend/dist`. |

Diagnostics from the connector go to stderr; Claude Desktop shows them under Settings → Developer → logs.
