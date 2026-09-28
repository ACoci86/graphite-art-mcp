/**
 * Exercises the WebSocket endpoint against a fake bridge (a plain `ws` client standing in for the Graphite tab):
 * token auth, protocol negotiation, request/response correlation, timeouts and disconnects.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { GraphiteClient } from "../src/graphite/client.js";
import { GraphiteError } from "../src/graphite/errors.js";

const TOKEN = "test-token-0123456789";
let client: GraphiteClient;
let port: number;

type FakeBridge = WebSocket & { closed: Promise<number> };

function openFakeBridge(hello: Record<string, unknown> = {}, origin?: string): Promise<FakeBridge> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { headers: { origin } } : {}) as FakeBridge;
		// Register the close listener up front so a rejection that happens during the 30 ms grace period is not missed
		socket.closed = new Promise((resolveClose) => socket.once("close", (code) => resolveClose(code)));
		socket.once("open", () => {
			socket.send(JSON.stringify({ type: "hello", token: TOKEN, protocol_version: 1, bridge_version: "test", graphite_commit: "abc", ...hello }));
			// Give the server a tick to process the hello before the test proceeds
			setTimeout(() => resolve(socket), 30);
		});
		socket.once("error", reject);
	});
}

function waitClose(socket: FakeBridge): Promise<number> {
	return socket.closed;
}

beforeEach(async () => {
	client = new GraphiteClient({ host: "127.0.0.1", port: 0, token: TOKEN, allowedOrigins: [], requestTimeoutMs: 300, log: () => undefined });
	await client.listen();
	port = client.port;
});

afterEach(async () => {
	await client.close();
});

describe("GraphiteClient", () => {
	it("falls back to a free port when the configured one is taken", async () => {
		const logs: string[] = [];
		const second = new GraphiteClient({ host: "127.0.0.1", port: client.port, token: TOKEN, allowedOrigins: [], requestTimeoutMs: 300, log: (m) => logs.push(m) });
		await second.listen();
		expect(second.port).not.toBe(client.port);
		expect(second.port).toBeGreaterThan(0);
		expect(logs.some((m) => m.includes("already in use"))).toBe(true);
		await second.close();
	});

	it("reports not connected before a bridge attaches", async () => {
		expect(client.connected).toBe(false);
		await expect(client.request("new_document", { name: "x" })).rejects.toMatchObject({ code: "GRAPHITE_NOT_CONNECTED" });
	});

	it("rejects a wrong token with close code 4003", async () => {
		const socket = await openFakeBridge({ token: "wrong" });
		expect(await waitClose(socket)).toBe(4003);
		expect(client.connected).toBe(false);
	});

	it("rejects a protocol version mismatch with 4004", async () => {
		const socket = await openFakeBridge({ protocol_version: 99 });
		expect(await waitClose(socket)).toBe(4004);
	});

	it("rejects non-local browser origins before the handshake", async () => {
		await expect(openFakeBridge({}, "https://evil.example")).rejects.toBeDefined();
	});

	it("accepts localhost origins", async () => {
		const socket = await openFakeBridge({}, "http://localhost:8080");
		expect(client.connected).toBe(true);
		expect(client.info?.graphite_commit).toBe("abc");
		socket.close();
	});

	it("correlates responses by id and resolves typed results", async () => {
		const socket = await openFakeBridge();
		socket.on("message", (data) => {
			const request = JSON.parse(data.toString());
			expect(request.command).toBe("new_document");
			expect(request.params).toEqual({ name: "Logo" });
			socket.send(JSON.stringify({ id: request.id, ok: true, result: { document_id: "123", name: "Logo" } }));
		});
		const result = await client.request("new_document", { name: "Logo" });
		expect(result).toEqual({ document_id: "123", name: "Logo" });
		socket.close();
	});

	it("surfaces bridge errors as GraphiteError with the bridge's code", async () => {
		const socket = await openFakeBridge();
		socket.on("message", (data) => {
			const request = JSON.parse(data.toString());
			socket.send(JSON.stringify({ id: request.id, ok: false, error: { code: "INVALID_SVG", message: "nope" } }));
		});
		const error = await client.request("insert_svg", { svg: "x", x: 0, y: 0, center: false, layer_id: "1" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GraphiteError);
		expect((error as GraphiteError).code).toBe("INVALID_SVG");
		socket.close();
	});

	it("times out when the bridge never answers", async () => {
		const socket = await openFakeBridge();
		await expect(client.request("get_capabilities", {})).rejects.toMatchObject({ code: "BRIDGE_TIMEOUT" });
		socket.close();
	});

	it("fails in-flight requests when the bridge disconnects", async () => {
		const socket = await openFakeBridge();
		const pending = client.request("get_capabilities", {});
		socket.close();
		await expect(pending).rejects.toMatchObject({ code: "GRAPHITE_NOT_CONNECTED" });
	});

	it("refuses commands outside the whitelist without touching the socket", async () => {
		const socket = await openFakeBridge();
		await expect(client.request("execute_raw_message" as never, {} as never)).rejects.toMatchObject({ code: "UNKNOWN_COMMAND" });
		socket.close();
	});

	it("lets a newer tab replace the previous bridge", async () => {
		const first = await openFakeBridge();
		const closed = waitClose(first);
		const second = await openFakeBridge();
		expect(await closed).toBe(4000);
		expect(client.connected).toBe(true);
		second.close();
	});
});
