# Configuration

All settings are environment variables. None are required.

| Variable | Default | Description |
| --- | --- | --- |
| `GRAPHITE_MCP_EXPORT_DIR` | `~/graphite-mcp-exports` | Destination for exports when no path is given. |
| `GRAPHITE_MCP_EXPORT_ROOTS` | (empty) | Additional directories exports may be written to, separated by `:` (`;` on Windows). |
| `GRAPHITE_MCP_OPEN_BROWSER` | `1` | Open the served Graphite in the default browser when no tab connects within 3 seconds of start. |
| `GRAPHITE_MCP_FONT_DIR` | (bundled fonts only) | Directories with `.ttf` or `.otf` files used when converting text to paths, separated by `:` (`;` on Windows). |
| `GRAPHITE_MCP_TOKEN` | generated once, then cached | Session token the Graphite tab must present. If unset, a token is generated on the first run and saved in the cache directory. |
| `GRAPHITE_MCP_PORT` | `47832` | WebSocket port the Graphite tab connects to. |
| `GRAPHITE_MCP_HOST` | `127.0.0.1` | Bind address. Binding to other interfaces exposes the editor to the network. |
| `GRAPHITE_MCP_ALLOWED_ORIGINS` | any localhost origin | Comma-separated browser origins allowed to connect. |
| `GRAPHITE_MCP_SERVE` | `1` | Serve the pre-built Graphite web app locally. Set to `0` when running Graphite yourself. |
| `GRAPHITE_MCP_WEB_PORT` | `47833` | Port of the local web server. |
| `GRAPHITE_MCP_WEB_DIR` | (download) | Serve this `frontend/dist` directory instead of downloading the release bundle. |
| `GRAPHITE_MCP_BUNDLE_URL` | GitHub release asset for this version | Download location of the pre-built app. |
| `GRAPHITE_MCP_BUNDLE_SHA256` | (not verified) | Hex SHA-256 the download must match; published next to each release asset. |
| `GRAPHITE_MCP_CACHE_DIR` | `~/.cache/graphite-art-mcp` (varies by OS) | Location of downloaded bundles and the generated token. |
| `GRAPHITE_MCP_REQUEST_TIMEOUT_MS` | `15000` | Timeout for simple commands and the minimum wait for `insert_svg`. |
| `GRAPHITE_MCP_EXPORT_TIMEOUT_MS` | `60000` | Export timeout. The first raster render of a large document is the slowest. |
| `GRAPHITE_MCP_INSERT_MS_PER_ELEMENT` | `40` | Additional wait per SVG element on insert; Graphite creates one layer per element. |
| `GRAPHITE_MCP_INSERT_GRACE_MS` | `30000` | After an insert wait expires, how long the connector keeps polling for the layer before reporting failure. |

## Errors

Every failure is returned as an MCP `isError` result whose text is JSON: `{ "code": "...", "message": "...", "details"?: ... }`.
The codes are `GRAPHITE_NOT_CONNECTED`, `GRAPHITE_CRASHED`, `NO_ACTIVE_DOCUMENT`, `DOCUMENT_NOT_FOUND`,
`LAYER_NOT_FOUND`, `LAYER_NOT_CREATED`, `INVALID_SVG`, `INVALID_COLOR`, `INVALID_TRANSFORM`, `INVALID_PARAMS`,
`EXPORT_FAILED`, `EXPORT_PATH_NOT_ALLOWED`, `UNSUPPORTED_FORMAT`, `UNKNOWN_COMMAND`, `BRIDGE_TIMEOUT`,
`GRAPHITE_VERSION_UNSUPPORTED` and `UNEXPECTED`.

`BRIDGE_TIMEOUT` from `graphite_insert_svg` means Graphite had not confirmed the new layer within the allowed time; it
does not mean the insert failed. The layer usually appears shortly afterwards. The connector already waits a grace
period and reports `confirmed_late: true` when it shows up. If it still times out, call `graphite_get_document` and
look for the `layer_id` given in the error before inserting again; repeating the insert without checking creates a
duplicate.

## Resources

Exported files are also available as MCP resources named `graphite-export://<file>`, so a client can list and read
them without a filesystem path.

## Diagnostics

`npx graphite-art-mcp doctor` checks the Node version, both ports, the token, the web app download, the export
directory and the fonts, and prints what to fix.
