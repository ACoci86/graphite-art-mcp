/**
 * Wire protocol between the MCP server (Node) and the automation bridge running inside the Graphite editor tab.
 *
 * Transport: WebSocket on 127.0.0.1. The MCP server is the WebSocket *server*; the browser tab connects to it,
 * because a browser page can open outbound sockets but cannot listen. The first frame the bridge sends is a
 * `hello` carrying the session token; everything after that is request/response keyed by `id`.
 *
 * All ids that are `u64` inside Graphite (NodeId, DocumentId) travel as decimal strings, never JS numbers.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Commands the MCP server may ask the bridge to perform. Deliberately a closed whitelist. */
export type AutomationCommand =
	| { command: "get_capabilities"; params: Record<string, never> }
	| { command: "new_document"; params: { name: string } }
	| {
			command: "insert_svg";
			/**
			 * `layer_id` is allocated by the MCP server (the wrapper cannot return values) and echoed back on success.
			 * `timeout_ms` bounds how long the bridge waits for Graphite to report the layer; omitted, the bridge scales it with the element count.
			 */
			params: { svg: string; x: number; y: number; center: boolean; layer_id: string; parent_id?: string; name?: string; timeout_ms?: number };
	  }
	| { command: "export"; params: { format: ExportFormat; scale_factor: number; name: string; timeout_ms?: number } }
	| { command: "get_document"; params: Record<string, never> }
	| { command: "select_document"; params: { document_id: string } }
	| { command: "set_fill"; params: { layer_id: string; color: string | null } }
	| { command: "set_stroke"; params: { layer_id: string; color: string | null; weight: number } }
	| { command: "set_opacity"; params: { layer_id: string; opacity: number } }
	| { command: "set_transform"; params: { layer_id: string; matrix: [number, number, number, number, number, number]; replace: boolean } }
	| { command: "delete_layer"; params: { layer_id: string } }
	| { command: "rename_layer"; params: { layer_id: string; name: string } }
	| { command: "undo"; params: Record<string, never> }
	| { command: "redo"; params: Record<string, never> };

export type CommandName = AutomationCommand["command"];

export const COMMAND_NAMES: readonly CommandName[] = [
	"get_capabilities",
	"new_document",
	"insert_svg",
	"export",
	"get_document",
	"select_document",
	"set_fill",
	"set_stroke",
	"set_opacity",
	"set_transform",
	"delete_layer",
	"rename_layer",
	"undo",
	"redo",
];

export const EXPORT_FORMATS = ["svg", "png", "jpg", "webp", "tiff", "bmp", "tga", "ico"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Maps our lowercase format names onto Graphite's `FileType` enum variant names. */
export const FILE_TYPE_BY_FORMAT: Record<ExportFormat, string> = {
	svg: "Svg",
	png: "Png",
	jpg: "Jpg",
	webp: "Webp",
	tiff: "Tiff",
	bmp: "Bmp",
	tga: "Tga",
	ico: "Ico",
};

export interface Capabilities {
	protocol_version: number;
	bridge_version: string;
	graphite_commit: string | null;
	commands: CommandName[];
}

export interface NewDocumentResult {
	document_id: string;
	name: string;
}

export interface InsertSvgResult {
	layer_id: string;
	document_id: string | null;
}

export interface ExportResult {
	file_name: string;
	format: ExportFormat;
	/** Base64-encoded file bytes. */
	content_base64: string;
	byte_length: number;
}

/** Snapshot of the active document as the bridge observes it from Graphite's frontend messages. */
export interface LayerInfo {
	id: string;
	name: string | null;
	kind: string | null;
	visible: boolean;
	parent_id: string | null;
}

export interface GetDocumentResult {
	document_id: string;
	name: string | null;
	layer_count: number;
	/** Every layer id in the active document (decimal strings), nested groups included. */
	layer_ids: string[];
	/** Per-layer details when the bridge is new enough to report them. */
	layers?: LayerInfo[];
	open_documents?: Array<{ document_id: string; name: string }>;
}

export interface LayerResult {
	layer_id: string;
	deleted?: boolean;
	name?: string;
}

export interface SelectDocumentResult {
	document_id: string;
	name: string | null;
}

export type CommandResult = Capabilities | NewDocumentResult | InsertSvgResult | ExportResult | GetDocumentResult | LayerResult | SelectDocumentResult | { ok: true };

export interface BridgeHello {
	type: "hello";
	token: string;
	protocol_version: number;
	bridge_version: string;
	graphite_commit: string | null;
}

export interface BridgeRequest {
	id: string;
	command: CommandName;
	params: Record<string, unknown>;
}

export interface BridgeErrorBody {
	code: string;
	message: string;
	details?: unknown;
}

export type BridgeResponse =
	| { id: string; ok: true; result: CommandResult }
	| { id: string; ok: false; error: BridgeErrorBody };

export type BridgeToServer = BridgeHello | BridgeResponse;

export function isBridgeHello(value: unknown): value is BridgeHello {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "hello" && typeof (value as { token?: unknown }).token === "string";
}

export function isBridgeResponse(value: unknown): value is BridgeResponse {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || typeof v.ok !== "boolean") return false;
	if (v.ok === true) return "result" in v;
	const error = v.error as Record<string, unknown> | undefined;
	return typeof error === "object" && error !== null && typeof error.code === "string" && typeof error.message === "string";
}

export function encodeRequest(request: BridgeRequest): string {
	return JSON.stringify(request);
}

export function decodeFromBridge(raw: string): BridgeToServer {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Bridge sent invalid JSON: ${String(error)}`);
	}
	if (isBridgeHello(parsed) || isBridgeResponse(parsed)) return parsed;
	throw new Error("Bridge sent a frame that is neither a hello nor a response");
}
