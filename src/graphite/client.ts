/**
 * `GraphiteClient` owns the localhost WebSocket endpoint the Graphite tab connects to and turns commands into
 * request/response round trips.
 *
 * Direction: the MCP server *listens*; the browser tab *connects*. A web page cannot accept incoming sockets,
 * so this is the only workable direction on the web build. The first frame from the tab must be a `hello`
 * carrying the session token; otherwise the socket is closed.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { GraphiteError, isErrorCode } from "./errors.js";
import {
	COMMAND_NAMES,
	PROTOCOL_VERSION,
	decodeFromBridge,
	encodeRequest,
	isBridgeHello,
	type AutomationCommand,
	type BridgeHello,
	type BridgeResponse,
	type CommandResult,
} from "./protocol.js";

export interface GraphiteClientOptions {
	host: string;
	port: number;
	token: string;
	/** Origins allowed to connect. Any origin matching one of these prefixes is accepted; empty = allow all *localhost* origins. */
	allowedOrigins: string[];
	requestTimeoutMs: number;
	log: (message: string) => void;
}

interface Pending {
	resolve: (result: CommandResult) => void;
	reject: (error: GraphiteError) => void;
	timer: NodeJS.Timeout;
	command: string;
}

export interface BridgeInfo {
	bridge_version: string;
	graphite_commit: string | null;
	protocol_version: number;
	connected_at: string;
}

export class GraphiteClient {
	private readonly options: GraphiteClientOptions;
	private server: WebSocketServer | null = null;
	private boundPort: number | null = null;
	private socket: WebSocket | null = null;
	private bridgeInfo: BridgeInfo | null = null;
	private readonly pending = new Map<string, Pending>();

	constructor(options: GraphiteClientOptions) {
		this.options = options;
	}

	/** Starts listening. Resolves once the port is bound. */
	listen(): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = new WebSocketServer({ host: this.options.host, port: this.options.port, verifyClient: (info: { req: IncomingMessage }) => this.verifyClient(info.req) });
			server.on("listening", () => {
				this.server = server;
				const address = server.address();
				this.boundPort = typeof address === "object" && address ? address.port : this.options.port;
				this.options.log(`listening on ws://${this.options.host}:${this.boundPort}`);
				resolve();
			});
			server.on("error", (error) => reject(error));
			server.on("connection", (socket, request) => this.onConnection(socket, request));
		});
	}

	async close(): Promise<void> {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new GraphiteError("GRAPHITE_NOT_CONNECTED", `Connector shutting down while ${pending.command} (${id}) was in flight`));
		}
		this.pending.clear();
		this.socket?.close();
		this.socket = null;
		await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
		this.server = null;
		this.boundPort = null;
	}

	/** The port actually bound (differs from the configured one only when it was 0, meaning "any free port"). */
	get port(): number {
		return this.boundPort ?? this.options.port;
	}

	get connected(): boolean {
		return this.socket !== null && this.socket.readyState === WebSocket.OPEN && this.bridgeInfo !== null;
	}

	get info(): BridgeInfo | null {
		return this.bridgeInfo;
	}

	/** Sends a command to the bridge and awaits its typed result. `timeoutMs` overrides the default per-command budget. */
	async request<C extends AutomationCommand>(command: C["command"], params: C["params"], timeoutMs?: number): Promise<CommandResult> {
		if (!(COMMAND_NAMES as readonly string[]).includes(command)) {
			throw new GraphiteError("UNKNOWN_COMMAND", `"${command}" is not a whitelisted automation command`);
		}
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN || !this.bridgeInfo) {
			throw new GraphiteError(
				"GRAPHITE_NOT_CONNECTED",
				`No Graphite editor tab is connected to ws://${this.options.host}:${this.options.port}. Open Graphite with the automation bridge enabled and the matching token.`,
			);
		}

		const id = randomUUID();
		const budgetMs = timeoutMs ?? this.options.requestTimeoutMs;
		return new Promise<CommandResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new GraphiteError("BRIDGE_TIMEOUT", `Graphite did not answer "${command}" within ${budgetMs} ms`));
			}, budgetMs);
			this.pending.set(id, { resolve, reject, timer, command });
			socket.send(encodeRequest({ id, command, params: params as Record<string, unknown> }), (error) => {
				if (!error) return;
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new GraphiteError("GRAPHITE_NOT_CONNECTED", `Failed to send "${command}" to Graphite: ${error.message}`));
			});
		});
	}

	// --- internals -------------------------------------------------------------------------------------------------

	private verifyClient(request: IncomingMessage): boolean {
		const origin = request.headers.origin;
		// Non-browser clients (tests, scripts) send no Origin header. They still need the token in `hello`.
		if (!origin) return true;
		if (this.options.allowedOrigins.length > 0) {
			const ok = this.options.allowedOrigins.some((allowed) => origin === allowed || origin.startsWith(allowed));
			if (!ok) this.options.log(`rejected connection from origin ${origin}`);
			return ok;
		}
		let hostname: string;
		try {
			hostname = new URL(origin).hostname;
		} catch {
			return false;
		}
		const ok = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
		if (!ok) this.options.log(`rejected connection from non-local origin ${origin}`);
		return ok;
	}

	private onConnection(socket: WebSocket, request: IncomingMessage): void {
		let authenticated = false;
		const authTimer = setTimeout(() => {
			if (!authenticated) {
				this.options.log("closing socket that never sent hello");
				socket.close(4001, "hello timeout");
			}
		}, 5_000);

		socket.on("message", (data) => {
			let frame;
			try {
				frame = decodeFromBridge(data.toString());
			} catch (error) {
				this.options.log(String(error));
				return;
			}

			if (isBridgeHello(frame)) {
				clearTimeout(authTimer);
				if (!this.acceptHello(socket, frame)) return;
				authenticated = true;
				this.options.log(`bridge connected from ${request.headers.origin ?? "no-origin"} (graphite ${frame.graphite_commit ?? "unknown"})`);
				return;
			}
			if (!authenticated) {
				socket.close(4003, "not authenticated");
				return;
			}
			this.onResponse(frame);
		});

		socket.on("close", () => {
			clearTimeout(authTimer);
			if (this.socket === socket) {
				this.socket = null;
				this.bridgeInfo = null;
				this.options.log("bridge disconnected");
				for (const [id, pending] of this.pending) {
					clearTimeout(pending.timer);
					pending.reject(new GraphiteError("GRAPHITE_NOT_CONNECTED", `Graphite disconnected while "${pending.command}" (${id}) was in flight`));
				}
				this.pending.clear();
			}
		});

		socket.on("error", (error) => this.options.log(`socket error: ${error.message}`));
	}

	private acceptHello(socket: WebSocket, hello: BridgeHello): boolean {
		if (hello.token !== this.options.token) {
			this.options.log("rejected bridge with wrong token");
			socket.close(4003, "bad token");
			return false;
		}
		if (hello.protocol_version !== PROTOCOL_VERSION) {
			this.options.log(`rejected bridge speaking protocol v${hello.protocol_version}; this connector speaks v${PROTOCOL_VERSION}`);
			socket.close(4004, "protocol version mismatch");
			return false;
		}
		// A newly connected tab replaces any previous one (e.g. after a page reload)
		if (this.socket && this.socket !== socket) this.socket.close(4000, "replaced by a newer bridge connection");
		this.socket = socket;
		this.bridgeInfo = {
			bridge_version: hello.bridge_version,
			graphite_commit: hello.graphite_commit,
			protocol_version: hello.protocol_version,
			connected_at: new Date().toISOString(),
		};
		return true;
	}

	private onResponse(response: BridgeResponse): void {
		const pending = this.pending.get(response.id);
		if (!pending) {
			this.options.log(`response for unknown request ${response.id}`);
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(response.id);
		if (response.ok) pending.resolve(response.result);
		else pending.reject(new GraphiteError(isErrorCode(response.error.code) ? response.error.code : "UNEXPECTED", response.error.message, response.error.details));
	}
}
