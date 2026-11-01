/**
 * `acc mcp`: a stdio MCP server exposing the check tools (src/tools.ts), for Claude Code.
 *
 * MCP over stdio is newline-delimited JSON-RPC 2.0. This server implements the part a tools-only
 * server needs: initialize, ping, tools/list and tools/call.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Table } from "./config.ts";
import { callTool, INSTRUCTIONS, TOOLS, type ToolEnv, ToolError } from "./tools.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

interface Request {
	jsonrpc: "2.0";
	id?: string | number | null;
	method?: string;
	params?: Table;
}

/** The JSON-RPC response for one message, or null for notifications. */
export async function handle(msg: Request, env: ToolEnv): Promise<Table | null> {
	const respond = (result: Table): Table => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
	const fail = (code: number, message: string): Table => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
	const isRequest = msg.id !== undefined && msg.id !== null;
	if (typeof msg.method !== "string") return isRequest ? fail(-32600, "invalid request") : null;
	if (!isRequest) return null; // notifications (initialized, cancelled, ...) need no answer

	switch (msg.method) {
		case "initialize": {
			const asked = msg.params?.protocolVersion;
			return respond({
				protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "acc", version: VERSION },
				instructions: INSTRUCTIONS,
			});
		}
		case "ping":
			return respond({});
		case "tools/list":
			return respond({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
		case "tools/call": {
			const name = msg.params?.name;
			if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool: ${name}`);
			try {
				const { text, data } = await callTool(name, msg.params?.arguments ?? {}, env);
				return respond({ content: [{ type: "text", text }], structuredContent: data, isError: false });
			} catch (e) {
				const text = e instanceof ToolError ? e.message : `Error executing tool ${name}: ${(e as Error).message}`;
				return respond({ content: [{ type: "text", text }], isError: true });
			}
		}
		default:
			return fail(-32601, `method not found: ${msg.method}`);
	}
}

/** Serve until stdin closes. Requests run concurrently; each answer is written when it is ready. */
export async function serve(env: ToolEnv, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
	const pending = new Set<Promise<void>>();
	const write = (msg: Table): void => {
		output.write(`${JSON.stringify(msg)}\n`);
	};
	for await (const line of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) {
		if (!line.trim()) continue;
		let msg: Request;
		try {
			msg = JSON.parse(line);
		} catch {
			write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
			continue;
		}
		const task = handle(msg, env).then((reply) => {
			if (reply) write(reply);
		});
		pending.add(task);
		task.finally(() => pending.delete(task));
	}
	await Promise.all(pending);
}
