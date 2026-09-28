# graphite-art-mcp

Lets Claude draw in the [Graphite](https://graphite.art) vector editor.

You describe the artwork in a chat. Claude creates it in Graphite as ordinary layers that you can keep editing by hand,
and it can look at the result, adjust colours and positions, undo, and export SVG or PNG files.

> Not affiliated with the Graphite project. Graphite is MIT / Apache-2.0 licensed; this connector is MIT licensed. It
> is unrelated to the Graphite code review tool at graphite.com.

## Install

**Claude Desktop (Mac or Windows)**

Download `graphite-art-mcp-<version>.mcpb` from the
[latest release](https://github.com/ACoci86/graphite-art-mcp/releases/latest) and open it. Claude Desktop installs it.
That is all.

**Claude Code (Mac, Windows, Linux)**

```bash
claude mcp add graphite -- npx -y graphite-art-mcp
```

Requires Node.js 20 or newer.

**Other MCP clients**

Add this to the client's MCP configuration:

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

## First use

Start a chat and ask Claude to check whether Graphite is connected. The first time, the connector downloads a copy of
Graphite (a few megabytes, once), starts it locally, and opens it in your browser. The page connects on its own and
stays connected after restarts.

Then ask for artwork, for example: "Draw a poster with a large red arrow made of small cursors, then show me a preview."

Exported files are saved in `graphite-mcp-exports` in your home folder.

If nothing connects, run `npx graphite-art-mcp doctor`. It checks the common causes and says what to fix.

## What Claude can do

| Tool | Purpose |
| --- | --- |
| `graphite_new_document` | Create a new document. |
| `graphite_insert_svg` | Add artwork as editable layers. Text is converted to outlines automatically. |
| `graphite_preview` | See the current canvas as an image. |
| `graphite_get_document` | List the layers and open documents. |
| `graphite_set_style` | Change fill, stroke or opacity of a layer. |
| `graphite_transform_layer` | Move, scale or rotate a layer. |
| `graphite_rename_layer`, `graphite_delete_layer` | Rename or remove a layer. |
| `graphite_undo`, `graphite_redo` | Step through the history. |
| `graphite_select_document` | Switch between open documents. |
| `graphite_export` | Save the document as SVG, PNG or other image formats. |
| `graphite_get_capabilities` | Report the connection state. |

## Good to know

- Large drawings take time: Graphite creates one layer per shape, at roughly 40 ms each. For big artwork Claude
  should save the SVG to a file and pass its path instead of sending the markup inline.
- Text is rendered with the bundled Liberation fonts (Sans, Serif, Mono). For a specific typeface, point the
  `GRAPHITE_MCP_FONT_DIR` setting at a folder with `.ttf` or `.otf` files.
- Claude works best when it looks at the preview after each change rather than redrawing from scratch.

## Settings

Everything works without configuration. The most useful settings, as environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GRAPHITE_MCP_EXPORT_DIR` | `~/graphite-mcp-exports` | Where exports are saved. |
| `GRAPHITE_MCP_OPEN_BROWSER` | `1` | Set `0` to open the Graphite tab yourself. |
| `GRAPHITE_MCP_FONT_DIR` | bundled fonts | Extra fonts for text. |

The full list, including ports and timeouts, is in [docs/configuration.md](docs/configuration.md).

## Limitations

- Works with Claude Desktop, Claude Code and other local MCP clients. It does not work with the chat at claude.ai in a
  browser; that would require a hosted version.
- Text becomes outlined paths, not editable text layers.
- Fills and strokes are solid colours; gradients and blend modes are not exposed yet.
- The bundled Graphite is pinned to one upstream commit and updated with each release.

## For developers

Architecture, building Graphite yourself, tests, releasing and the bridge patch are described in
[docs/development.md](docs/development.md).

## License

MIT, see [LICENSE](LICENSE). Graphite itself is MIT / Apache-2.0 and is not redistributed in this repository; the
patch under `graphite-patch/` is offered under the same dual license so that it can be upstreamed.
