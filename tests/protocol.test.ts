import { describe, expect, it } from "vitest";
import { GraphiteError, toGraphiteError } from "../src/graphite/errors.js";
import { COMMAND_NAMES, FILE_TYPE_BY_FORMAT, EXPORT_FORMATS, decodeFromBridge, encodeRequest, isBridgeHello, isBridgeResponse } from "../src/graphite/protocol.js";

describe("protocol encoding", () => {
	it("encodes a request with id, command and params", () => {
		const raw = encodeRequest({ id: "req-1", command: "insert_svg", params: { svg: "<svg/>", x: 1, y: 2, center: false, layer_id: "42" } });
		expect(JSON.parse(raw)).toEqual({ id: "req-1", command: "insert_svg", params: { svg: "<svg/>", x: 1, y: 2, center: false, layer_id: "42" } });
	});

	it("decodes a hello frame", () => {
		const frame = decodeFromBridge(JSON.stringify({ type: "hello", token: "t", protocol_version: 1, bridge_version: "0.1.0", graphite_commit: null }));
		expect(isBridgeHello(frame)).toBe(true);
	});

	it("decodes ok and error responses", () => {
		const ok = decodeFromBridge(JSON.stringify({ id: "a", ok: true, result: { document_id: "1", name: "x" } }));
		expect(isBridgeResponse(ok) && ok.ok).toBe(true);
		const err = decodeFromBridge(JSON.stringify({ id: "b", ok: false, error: { code: "INVALID_SVG", message: "bad" } }));
		expect(isBridgeResponse(err) && !err.ok && err.error.code).toBe("INVALID_SVG");
	});

	it("rejects garbage and half-formed frames", () => {
		expect(() => decodeFromBridge("not json")).toThrow(/invalid JSON/);
		expect(() => decodeFromBridge(JSON.stringify({ id: "x" }))).toThrow(/neither/);
		expect(() => decodeFromBridge(JSON.stringify({ id: "x", ok: false, error: { message: "no code" } }))).toThrow(/neither/);
	});

	it("keeps the command whitelist and format map in sync", () => {
		expect(COMMAND_NAMES).toEqual([
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
		]);
		for (const format of EXPORT_FORMATS) expect(FILE_TYPE_BY_FORMAT[format]).toMatch(/^[A-Z][a-z]+$/);
	});
});

describe("error mapping", () => {
	it("preserves known codes coming from the bridge", () => {
		const error = toGraphiteError({ code: "LAYER_NOT_FOUND", message: "Layer 8451 was not found" });
		expect(error).toBeInstanceOf(GraphiteError);
		expect(error.code).toBe("LAYER_NOT_FOUND");
		expect(error.toJSON()).toEqual({ code: "LAYER_NOT_FOUND", message: "Layer 8451 was not found" });
	});

	it("maps unknown throwables to UNEXPECTED", () => {
		expect(toGraphiteError(new TypeError("boom")).code).toBe("UNEXPECTED");
		expect(toGraphiteError({ code: "NOT_A_REAL_CODE", message: "x" }).code).toBe("UNEXPECTED");
		expect(toGraphiteError("string").message).toBe("string");
	});
});
