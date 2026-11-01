/**
 * pi backend: one `pi -p` call per batch, using pi's own login (https://pi.dev).
 *
 * Like `omp -p`, `pi -p` has no structured-output flag, so the prompt carries the answer schema and
 * the runner validates each entry. pi has no model roles: `backends.pi.model` names the model
 * (`provider/id`, or an id pi can resolve to one authenticated provider).
 */
import type { Table } from "../config.ts";
import { run, SpawnError } from "../proc.ts";
import { withSchema } from "../prompt.ts";
import { splitlines } from "../text.ts";
import { isRetryableStatus, parseAgentOutput } from "./agentjson.ts";
import { type Backend, BackendError } from "./base.ts";

// A lean, single-answer call: no tools, no saved session, no project inputs, no MCP servers and no
// startup network calls. `--no-extensions` also keeps the acc extension (and any other tool_call
// handler) out of the spawned run, so the gate cannot recurse.
export const LEAN_FLAGS = [
	"--no-session",
	"--no-tools",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
	"--no-mcp",
	"--offline",
];
// Thinking is off so the model answers like a decision model.
export const THINKING = "off";

export class PiBackend implements Backend {
	name = "pi";
	command: string;
	model: string;
	/** Run in the project, like the agent itself. */
	cwd: string | null;

	constructor(settings: Table, cwd: string | null = null) {
		this.command = settings.command ?? "pi";
		this.model = settings.model ?? "anthropic/claude-haiku-4-5";
		this.cwd = cwd;
	}

	argv(system: string, prompt: string, schema: Table): string[] {
		return [
			this.command,
			"-p",
			"--model",
			this.model,
			...LEAN_FLAGS,
			"--thinking",
			THINKING,
			"--system-prompt",
			system,
			"--mode",
			"json",
			withSchema(prompt, schema),
		];
	}

	async ask(system: string, prompt: string, stdin: string, schema: Table, timeoutSeconds: number): Promise<Table> {
		const [cmd, ...args] = this.argv(system, prompt, schema);
		let proc;
		try {
			proc = await run(cmd, args, { input: stdin, timeoutMs: timeoutSeconds * 1000, cwd: this.cwd ?? undefined });
		} catch (e) {
			if (e instanceof SpawnError) throw new BackendError(`pi CLI not found at '${this.command}'`);
			throw e;
		}
		if (proc.timedOut) throw new BackendError(`pi -p timed out after ${timeoutSeconds.toFixed(0)}s`);
		return parseOutput(proc.stdout, proc.stderr, proc.code ?? -9);
	}
}

/**
 * Provider errors often arrive as JSON (sometimes JSON inside a JSON string). Unwrap `error.message`
 * down to the first plain-text line, and find an HTTP status if the provider gave one.
 */
export function providerError(raw: string): { text: string; status: number | null } {
	let text = raw.trim();
	let status: number | null = null;
	for (let depth = 0; depth < 4; depth++) {
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			break;
		}
		const err = (data as Table)?.error ?? data;
		if (typeof err !== "object" || err === null) break;
		const code = err.code ?? err.status;
		if (typeof code === "number") status = code;
		if (typeof err.message !== "string") break;
		text = err.message.trim();
	}
	const leading = /^(\d{3})\b/.exec(text);
	if (status === null && leading) status = Number(leading[1]);
	return { text: splitlines(text)[0] ?? "", status };
}

export function parseOutput(stdout: string, stderr = "", returncode = 0): Table {
	return parseAgentOutput(stdout, stderr, {
		cli: "pi -p",
		noEvents: (first) => new BackendError(`pi -p exited ${returncode} without JSON events: ${first}`),
		failure: (message) => {
			const { text, status } = providerError(String(message.errorMessage || "unknown error"));
			return { text, retryable: isRetryableStatus(message.errorStatus ?? status) };
		},
	});
}
