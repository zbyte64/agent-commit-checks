/** Reading the JSONL event stream of `omp -p --mode json` and `pi -p --mode json`. */
import type { Table } from "../config.ts";
import { jsonObject } from "../prompt.ts";
import { splitlines } from "../text.ts";
import { BackendError } from "./base.ts";

// Provider errors worth one more attempt; auth, billing and bad-request errors are not.
const RETRYABLE_STATUS = new Set([408, 409, 429]);

/** `--mode json` prints one JSON event per line. */
export function events(stdout: string): Table[] {
	const out: Table[] = [];
	for (const raw of splitlines(stdout)) {
		const line = raw.trim();
		if (!line.startsWith("{")) continue;
		try {
			const event = JSON.parse(line);
			if (typeof event === "object" && event !== null && !Array.isArray(event)) out.push(event);
		} catch {
			// Not an event line.
		}
	}
	return out;
}

function finalAssistant(evts: Table[]): Table | null {
	for (const event of [...evts].reverse()) {
		if (event.type !== "message_end") continue;
		const message = event.message;
		if (typeof message === "object" && message !== null && message.role === "assistant") return message;
	}
	return null;
}

export function isRetryableStatus(status: unknown): boolean {
	return typeof status === "number" && Number.isInteger(status) && (RETRYABLE_STATUS.has(status) || status >= 500);
}

export interface AgentOutputOptions {
	/** How the call is named in messages, e.g. "omp -p". */
	cli: string;
	/** Error when there are no events at all (the CLI failed before starting the run). */
	noEvents(firstLine: string): BackendError;
	/** The one-line error text of a failed assistant message, and whether a retry may help. */
	failure(message: Table): { text: string; retryable: boolean };
}

/** The `{"checks": ...}` answer of the final assistant message, or a BackendError. */
export function parseAgentOutput(stdout: string, stderr: string, opts: AgentOutputOptions): Table {
	const evts = events(stdout);
	if (!evts.length) {
		const detail = splitlines((stderr || stdout).trim()).filter((line) => line.trim());
		throw opts.noEvents(detail.length ? detail[0] : "no output");
	}
	const message = finalAssistant(evts);
	if (message === null) throw new BackendError(`${opts.cli} output has no assistant message`, true);
	const stop = message.stopReason;
	if (stop === "error") {
		const { text, retryable } = opts.failure(message);
		throw new BackendError(`${opts.cli} failed (${message.provider ?? "?"}/${message.model ?? "?"}): ${text}`, retryable);
	}
	if (stop === "aborted") throw new BackendError(`${opts.cli} was aborted before answering`);
	const content: unknown[] = Array.isArray(message.content) ? message.content : [];
	const text = content
		.filter((b): b is Table => typeof b === "object" && b !== null && (b as Table).type === "text")
		.map((b) => b.text ?? "")
		.join("");
	const data = jsonObject(text);
	if (data === null) {
		const why = stop === "length" ? "was cut off" : "is not a JSON object";
		throw new BackendError(`${opts.cli} answer ${why}`, true);
	}
	if (typeof data.checks !== "object" || data.checks === null || Array.isArray(data.checks)) {
		throw new BackendError(`${opts.cli} answer has no \`checks\` object`, true);
	}
	return data;
}
