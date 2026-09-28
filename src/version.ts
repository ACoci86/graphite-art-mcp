export const CONNECTOR_VERSION = "0.2.0";

/**
 * GitHub repository that publishes this connector, as `owner/name`. Release builds of the patched Graphite web app are
 * downloaded from this repository's GitHub Releases (asset `graphite-web.tar.gz` under tag `v<CONNECTOR_VERSION>`).
 * Change it when you fork or rename the project; `GRAPHITE_MCP_BUNDLE_URL` overrides the whole URL at runtime.
 */
export const REPOSITORY = "ACoci86/graphite-art-mcp";
export const BUNDLE_ASSET = "graphite-web.tar.gz";
export const DEFAULT_BUNDLE_URL = `https://github.com/${REPOSITORY}/releases/download/v${CONNECTOR_VERSION}/${BUNDLE_ASSET}`;
