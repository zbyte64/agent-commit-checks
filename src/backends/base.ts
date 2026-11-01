/** The backend contract shared by every model backend. */
import type { Table } from "../config.ts";
import type { Entry } from "../prompt.ts";

export class BackendError extends Error {
	readonly retryable: boolean;
	constructor(message: string, retryable = false) {
		super(message);
		this.name = "BackendError";
		this.retryable = retryable;
	}
}

/** Turns (system, prompt, stdin, schema) into `{"checks": {...}}`. */
export interface Backend {
	name: string;
	model: string;
	ask(system: string, prompt: string, stdin: string, schema: Table, timeoutSeconds: number): Promise<Table>;
	/**
	 * Classifier backends (judge, tiny) answer from token probabilities instead of a written answer:
	 * the runner hands them the entries themselves rather than a prompt.
	 */
	decide?(entries: Entry[], stdin: string, timeoutSeconds: number): Promise<Table>;
}
