/**
 * Stable error codes shared by the MCP server and the bridge. The MCP tool layer turns these into
 * `isError` results whose text is a JSON envelope `{ code, message, details? }`, so the model can branch on `code`.
 */

export const ERROR_CODES = [
	"GRAPHITE_NOT_CONNECTED",
	"GRAPHITE_CRASHED",
	"NO_ACTIVE_DOCUMENT",
	"DOCUMENT_NOT_FOUND",
	"LAYER_NOT_FOUND",
	"LAYER_NOT_CREATED",
	"INVALID_SVG",
	"INVALID_COLOR",
	"INVALID_TRANSFORM",
	"INVALID_PARAMS",
	"EXPORT_FAILED",
	"EXPORT_PATH_NOT_ALLOWED",
	"UNSUPPORTED_FORMAT",
	"UNKNOWN_COMMAND",
	"BRIDGE_TIMEOUT",
	"BRIDGE_AUTH_FAILED",
	"GRAPHITE_VERSION_UNSUPPORTED",
	"UNEXPECTED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class GraphiteError extends Error {
	readonly code: ErrorCode;
	readonly details: unknown;

	constructor(code: ErrorCode, message: string, details?: unknown) {
		super(message);
		this.name = "GraphiteError";
		this.code = code;
		this.details = details;
	}

	toJSON(): { code: ErrorCode; message: string; details?: unknown } {
		return this.details === undefined ? { code: this.code, message: this.message } : { code: this.code, message: this.message, details: this.details };
	}
}

export function isErrorCode(value: unknown): value is ErrorCode {
	return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/** Wraps anything thrown into a `GraphiteError`, keeping known codes and mapping the rest to `UNEXPECTED`. */
export function toGraphiteError(error: unknown): GraphiteError {
	if (error instanceof GraphiteError) return error;
	if (typeof error === "object" && error !== null) {
		const { code, message, details } = error as { code?: unknown; message?: unknown; details?: unknown };
		if (isErrorCode(code) && typeof message === "string") return new GraphiteError(code, message, details);
	}
	const message = error instanceof Error ? error.message : String(error);
	return new GraphiteError("UNEXPECTED", message);
}
