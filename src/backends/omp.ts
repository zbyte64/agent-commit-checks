/**
 * oh-my-pi backend: one `omp -p` call per batch, using omp's own login and model roles.
 *
 * `omp -p` has no structured-output flag, so the prompt carries the answer schema and the runner
 * validates each entry (retrying missing or invalid ones alone).
 */
import { fileURLToPath } from "node:url";
import type { Table } from "../config.ts";
import { run, SpawnError } from "../proc.ts";
import { withSchema } from "../prompt.ts";
import { splitlines } from "../text.ts";
import { parseAgentOutput, isRetryableStatus } from "./agentjson.ts";
import { type Backend, BackendError } from "./base.ts";

// A lean, single-answer call: no tools, no saved session, and no project inputs that would bloat
// the prompt. `--no-extensions` also keeps the acc extension (and any other tool_call handler) out
// of the spawned run, so the gate cannot recurse.
export const LEAN_FLAGS = [
	"--no-session",
	"--no-tools",
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-context-files",
	"--no-lsp",
	"--no-title",
];
// Turns omp's memory backend off for the call, so no diff is stored or recalled across calls.
export const OVERLAY = fileURLToPath(new URL("./omp_overlay.yml", import.meta.url));
// Thinking is off so the model answers like a decision model.
export const THINKING = "off";

export class OmpBackend implements Backend {
	name = "omp";
	command: string;
	model: string;
	/** Run in the project so an `.omp/config.yml` overlay (e.g. a per-project decision role) applies. */
	cwd: string | null;

	constructor(settings: Table, cwd: string | null = null) {
		this.command = settings.command ?? "omp";
		this.model = settings.model ?? "@decision";
		this.cwd = cwd;
	}

	argv(system: string, prompt: string, schema: Table): string[] {
		return [
			this.command,
			"-p",
			"--model",
			this.model,
			...LEAN_FLAGS,
			"--config",
			OVERLAY,
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
			if (e instanceof SpawnError) throw new BackendError(`omp CLI not found at '${this.command}'`);
			throw e;
		}
		if (proc.timedOut) throw new BackendError(`omp -p timed out after ${timeoutSeconds.toFixed(0)}s`);
		return parseOutput(proc.stdout, proc.stderr, proc.code ?? -9, this.model);
	}
}

function noEventsError(first: string, returncode: number, model: string): BackendError {
	let msg = `omp -p exited ${returncode} without JSON events: ${first}`;
	if (model.startsWith("@") && first.includes("not found")) {
		const role = model.slice(1);
		msg +=
			`. Define the role in ~/.omp/agent/config.yml (modelRoles: {${role}: <provider/model>}) ` +
			"or set backends.omp.model in .acc/config.toml";
	}
	return new BackendError(msg);
}

export function parseOutput(stdout: string, stderr = "", returncode = 0, model = ""): Table {
	return parseAgentOutput(stdout, stderr, {
		cli: "omp -p",
		noEvents: (first) => noEventsError(first, returncode, model),
		failure: (message) => ({
			text: splitlines(String(message.errorMessage || "unknown error").trim())[0] ?? "",
			retryable: isRetryableStatus(message.errorStatus),
		}),
	});
}
