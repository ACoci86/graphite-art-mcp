# Using graphite-art-mcp with ChatGPT and other MCP clients

The connector contains nothing Claude-specific: it is a plain MCP server speaking stdio, with tool input/output
schemas in JSON Schema. Any client that can launch a local stdio MCP server works the same way.

## Local stdio clients (Cursor, Windsurf, Cline, Zed, Codex CLI, …)

Use the client's MCP configuration with the same shape as in `docs/claude.md`:

```json
{
  "mcpServers": {
    "graphite": {
      "command": "node",
      "args": ["/absolute/path/to/graphite-art-mcp/dist/index.js"],
      "env": { "GRAPHITE_MCP_TOKEN": "<your token>" }
    }
  }
}
```

Then open the patched Graphite tab with `?automation=<your token>` once, as described in the README.

## ChatGPT

At the time of writing, ChatGPT's connector support for MCP is limited to *remote* servers reachable over HTTPS
(Streamable HTTP), and availability depends on plan and admin settings. Check OpenAI's current documentation for
"custom connectors" / "MCP" before relying on it.

This connector currently exposes only the stdio transport. To use it from a remote-only client you would need to:

1. run it behind an MCP stdio→HTTP proxy (several open-source ones exist), and
2. expose that proxy over HTTPS (e.g. a tunnelling tool), protected by the proxy's authentication.

Be careful: the connector controls a local editor and writes files to disk. Anything that makes it reachable from
the internet must be authenticated. Adding a first-party Streamable HTTP transport with OAuth is a possible future
addition and would be a small change in `src/index.ts` (the tool layer is transport-independent).

## Any other MCP host

The full tool list, with schemas, is discoverable through the standard `tools/list` request. You can explore it without
an AI client at all:

```bash
npm run inspect      # opens the MCP Inspector against dist/index.js
```
