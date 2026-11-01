/**
 * Claude Code backend: one `claude -p` call per batch, using the user's existing login.
 *
 * Never pass `--bare`: it skips OAuth and keychain credentials.
 */
import type { Table } from "../config.ts";
import { run, SpawnError } from "../proc.ts";
import { schemaJson } from "../prompt.ts";
import { splitlines } from "../text.ts";
import { type Backend, BackendError } from "./base.ts";

// Structured output needs at least two turns: the model calls the StructuredOutput tool, then the
// run ends. A call that fails schema validation costs another turn, so leave headroom;
// StructuredOutput is the only tool, so the run stays bounded.
export const MAX_TURNS = "4";
// No hooks in the spawned run, so this gate cannot recurse. Thinking is always off: the backend
// imitates a decision model, which returns a typed answer directly. The setting alone is not
// enough, because hooks inherit the agent's environment and a MAX_THINKING_TOKENS there turns
// thinking back on.
export const SETTINGS = '{"disableAllHooks": true, "alwaysThinkingEnabled": false}';
export const ENV_OVERRIDES = { MAX_THINKING_TOKENS: "0" };

export class ClaudeBackend implements Backend {
	name = "claude";
	command: string;
	model: string;

	constructor(settings: Table) {
		this.command = settings.command ?? "claude";
		this.model = settings.model ?? "haiku";
	}

	argv(system: string, prompt: string, schema: Table): string[] {
		return [
			this.command,
			"-p",
			"--model",
			this.model,
			"--max-turns",
			MAX_TURNS,
			"--tools",
			"",
			"--strict-mcp-config",
			"--mcp-config",
			'{"mcpServers":{}}',
			"--setting-sources",
			"",
			"--settings",
			SETTINGS,
			"--no-session-persistence",
			"--system-prompt",
			system,
			"--output-format",
			"json",
			"--json-schema",
			schemaJson(schema),
			prompt,
		];
	}

	async ask(system: string, prompt: string, stdin: string, schema: Table, timeoutSeconds: number): Promise<Table> {
		const [cmd, ...args] = this.argv(system, prompt, schema);
		let proc;
		try {
			proc = await run(cmd, args, {
				input: stdin,
				timeoutMs: timeoutSeconds * 1000,
				env: { ...process.env, ...ENV_OVERRIDES },
			});
		} catch (e) {
			if (e instanceof SpawnError) throw new BackendError(`claude CLI not found at '${this.command}'`);
			throw e;
		}
		if (proc.timedOut) throw new BackendError(`claude -p timed out after ${timeoutSeconds.toFixed(0)}s`);
		return parseOutput(proc.stdout, proc.stderr, proc.code ?? -9);
	}
}

/** `--output-format json` prints one result object, or an event array in verbose mode. */
function resultEvent(data: unknown): Table | null {
	if (isTable(data)) return data;
	if (Array.isArray(data)) {
		for (const event of [...data].reverse()) if (isTable(event) && event.type === "result") return event;
	}
	return null;
}

function structuredToolInput(data: unknown): Table | null {
	if (!Array.isArray(data)) return null;
	for (const event of [...data].reverse()) {
		if (!isTable(event) || event.type !== "assistant") continue;
		for (const block of event.message?.content ?? []) {
			if (block?.type === "tool_use" && block?.name === "StructuredOutput") return block.input ?? null;
		}
	}
	return null;
}

function isTable(v: unknown): v is Table {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseOutput(stdout: string, stderr = "", returncode = 0): Table {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		const detail = splitlines((stderr || stdout).trim());
		throw new BackendError(
			`claude -p exited ${returncode} without JSON output: ${detail.length ? detail[detail.length - 1] : "no output"}`,
		);
	}
	const result = resultEvent(data);
	if (result === null) throw new BackendError("claude -p output has no result event", true);
	let structured = result.structured_output ?? null;
	// Fallback: the StructuredOutput tool call may exist even if the run ended early.
	if (structured === null) structured = structuredToolInput(data);
	if (structured === null) {
		if (result.is_error) {
			const msg = result.result || (result.errors ?? []).join(", ") || (result.subtype ?? "");
			const retryable = ["error_max_turns", "error_max_structured_output_retries"].includes(result.subtype);
			throw new BackendError(`claude -p failed: ${msg}`, retryable);
		}
		throw new BackendError("claude -p returned no structured_output", true);
	}
	if (!isTable(structured) || !isTable(structured.checks)) {
		throw new BackendError("claude -p structured_output has no `checks` object", true);
	}
	return structured;
}
