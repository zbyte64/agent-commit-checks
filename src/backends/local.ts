/**
 * Local backend: a small decision model behind an OpenAI-compatible server on this machine.
 *
 * The default server is llama.cpp's `llama-server`, which acc starts on first use if
 * `[backends.local] server` is set and nothing answers at `url`. The server keeps running for later
 * calls. Any server with `/v1/chat/completions` and `json_schema` response formats also works (e.g.
 * Ollama at http://127.0.0.1:11434 with `server = ""`).
 *
 * The answer schema is enforced by the server's grammar-constrained decoding, so even a tiny model
 * returns well-formed JSON. It also goes in the prompt so the model knows what each field means.
 *
 * A small model's self-reported `confidence` is noise (it writes 1.0 almost every time), so this
 * backend measures it instead. It reads the token probabilities at each answer's decision tokens and
 * attaches `answer_probs`: the model's probability for each answer it considered.
 * `checks.validateEntry` turns that into the probability of the same verdict.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Table } from "../config.ts";
import { logDir } from "../log.ts";
import { run, which } from "../proc.ts";
import { jsonObject, withSchema } from "../prompt.ts";
import { pyRepr, splitlines } from "../text.ts";
import { type Backend, BackendError } from "./base.ts";

// Picked by benchmarking on a laptop (Ryzen 9 7940HS, Radeon 780M); see bench/README.md.
export const RECOMMENDED_MODELS: Record<string, string> = { cpu: "Qwen/Qwen3-0.6B-GGUF:Q8_0", gpu: "Qwen/Qwen3-4B-GGUF:Q8_0" };
export const RECOMMENDED_MODEL = RECOMMENDED_MODELS.cpu;
// `cpu` turns GPU devices off: with -ngl 0 alone, a GPU build still offloads large prompt matmuls.
export const DEVICE_ARGS: Record<string, string[]> = { cpu: ["--device", "none"], gpu: ["--n-gpu-layers", "999"] };
export const DEVICES = Object.keys(DEVICE_ARGS);
export const DEFAULT_URL = "http://127.0.0.1:8763";
// Room for a 12000-character diff, the prompt and a long answer in each of two slots.
export const DEFAULT_SERVER_ARGS = ["--ctx-size", "16384", "--parallel", "2"];
export const MAX_TOKENS = 2048;
// Alternatives read at each answer token. The probabilities are taken before the schema constraint,
// so many alternatives are not valid answers and are dropped.
export const TOP_LOGPROBS = 20;

// One server start at a time in this process, like Python's module lock.
let startQueue: Promise<void> = Promise.resolve();

async function withStartLock<T>(fn: () => Promise<T>): Promise<T> {
	const previous = startQueue;
	const { promise, resolve } = Promise.withResolvers<void>();
	startQueue = promise;
	await previous;
	try {
		return await fn();
	} finally {
		resolve();
	}
}

export class LocalBackend implements Backend {
	name = "local";
	url: string;
	device: string;
	model: string;
	server: string;
	serverArgs: string[];
	startupSeconds: number;

	constructor(settings: Table) {
		this.url = String(settings.url ?? DEFAULT_URL).replace(/\/+$/, "");
		this.device = settings.device ?? "cpu";
		if (!DEVICES.includes(this.device)) {
			throw new BackendError(`backends.local.device must be one of ${DEVICES.join(", ")}, not ${pyRepr(this.device)}`);
		}
		this.model = settings.model ?? RECOMMENDED_MODELS[this.device];
		this.server = settings.server ?? "";
		this.serverArgs = settings.server_args ?? DEFAULT_SERVER_ARGS;
		this.startupSeconds = Number(settings.startup_seconds ?? 300);
	}

	// ── server ───────────────────────────────────────────────────────────────

	/** The model ids at `/v1/models`, or null until the server answers (llama-server returns 503 while loading). */
	async servedModels(timeoutSeconds = 2): Promise<string[] | null> {
		let data: unknown;
		try {
			const r = await fetch(`${this.url}/v1/models`, { signal: AbortSignal.timeout(timeoutSeconds * 1000) });
			if (!r.ok) return null;
			const body = await r.text();
			data = JSON.parse(body || "{}");
		} catch {
			return null;
		}
		const models = typeof data === "object" && data !== null ? (data as Table).data : null;
		if (!Array.isArray(models)) return [];
		return models.filter((m) => typeof m === "object" && m !== null && !Array.isArray(m)).map((m) => m.id ?? "");
	}

	async ready(timeoutSeconds = 2): Promise<boolean> {
		return (await this.servedModels(timeoutSeconds)) !== null;
	}

	/** A server left running with another model (e.g. after switching presets) would answer every check with it, so refuse instead. */
	async checkModel(): Promise<void> {
		const served = await this.servedModels();
		if (served?.length && !served.includes(this.model)) {
			throw new BackendError(
				`the server at ${this.url} serves ${served.join(", ")}, not ${this.model}; ` +
					`stop it (pkill -f 'llama-server.*--port ${this.port}') ` +
					"and acc will start the configured model",
			);
		}
	}

	/** The port acc starts the server on: the url's, or 80 when it names none. */
	get port(): string {
		return new URL(this.url).port || "80";
	}

	serverArgv(): string[] {
		const parts = new URL(this.url);
		return [
			this.server,
			"-hf",
			this.model,
			"--alias",
			this.model,
			"--host",
			parts.hostname || "127.0.0.1",
			"--port",
			this.port,
			...DEVICE_ARGS[this.device],
			...this.serverArgs,
		];
	}

	/** Start the server if it is configured and not answering, then wait until it is ready. */
	async ensureServer(): Promise<void> {
		if (await this.ready()) return this.checkModel();
		if (!this.server) {
			throw new BackendError(
				`no model server answers at ${this.url}; start one, or set ` +
					"[backends.local] server so acc starts llama-server itself",
			);
		}
		await withStartLock(async () => {
			if (await this.ready()) return this.checkModel();
			const path = isAbsolute(this.server) ? this.server : which(this.server);
			if (!path) {
				throw new BackendError(
					`local model server not found at ${pyRepr(this.server)}; install llama.cpp ` +
						"or set [backends.local] server to llama-server's absolute path",
				);
			}
			const out = serverLog();
			mkdirSync(dirname(out), { recursive: true });
			const fd = openSync(out, "a");
			// A new session, so the server outlives this hook and serves later pushes.
			const proc = spawn(path, this.serverArgv().slice(1), { stdio: ["ignore", fd, fd], detached: true });
			closeSync(fd);
			let exitCode: number | null | undefined;
			let spawnFailed = false;
			proc.on("exit", (code) => {
				exitCode = code;
			});
			proc.on("error", () => {
				spawnFailed = true;
				exitCode = null;
			});
			proc.unref();
			const deadline = performance.now() + this.startupSeconds * 1000;
			while (performance.now() < deadline) {
				if (await this.ready()) return;
				if (exitCode !== undefined && !(await this.ready())) {
					throw new BackendError(`llama-server exited ${spawnFailed ? "before starting" : exitCode} while starting; see ${out}`);
				}
				await sleep(500);
			}
			throw new BackendError(
				`llama-server did not become ready in ${this.startupSeconds.toFixed(0)}s ` +
					`(the first start downloads the model); see ${out}`,
				true,
			);
		});
	}

	// ── calls ────────────────────────────────────────────────────────────────

	request(system: string, prompt: string, stdin: string, schema: Table): Table {
		// The data goes before the instructions, so a small model reads the question last.
		const user = stdin ? `${stdin}\n${withSchema(prompt, schema)}` : withSchema(prompt, schema);
		return {
			model: this.model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			temperature: 0,
			max_tokens: MAX_TOKENS,
			logprobs: true,
			top_logprobs: TOP_LOGPROBS,
			response_format: { type: "json_schema", json_schema: { name: "checks", strict: true, schema } },
			// Thinking is off so the model answers like a decision model (Qwen3 templates read this).
			chat_template_kwargs: { enable_thinking: false },
		};
	}

	async ask(system: string, prompt: string, stdin: string, schema: Table, timeoutSeconds: number): Promise<Table> {
		await this.ensureServer();
		return parseOutput(await this.post(this.request(system, prompt, stdin, schema), timeoutSeconds), schema);
	}

	/** POST a chat completion request; returns the raw response body. */
	async post(request: Table, timeoutSeconds: number): Promise<string> {
		let r: Response;
		let raw: string;
		try {
			r = await fetch(`${this.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(timeoutSeconds * 1000),
			});
			raw = await r.text();
		} catch (e) {
			const err = e as Error & { cause?: Error };
			if (err.name === "TimeoutError") throw new BackendError(`local model timed out after ${timeoutSeconds.toFixed(0)}s`);
			throw new BackendError(`local model server at ${this.url} failed: ${err.cause?.message ?? err.message}`);
		}
		if (!r.ok) {
			const detail = splitlines(raw.trim());
			throw new BackendError(
				`local model server returned ${r.status}: ${detail.length ? detail[0] : r.statusText}`,
				r.status === 408 || r.status === 429 || r.status >= 500,
			);
		}
		return raw;
	}
}

/** The GPUs a llama-server build can use, from `llama-server --list-devices`. */
export async function listDevices(server: string): Promise<string[]> {
	let out: string;
	try {
		out = (await run(server, ["--list-devices"], { timeoutMs: 30_000 })).stdout;
	} catch {
		return [];
	}
	return [...out.matchAll(/^\s+\w+\d+: (.+?)(?: \(\d+ MiB.*)?$/gm)].map((m) => m[1]);
}

export function serverLog(): string {
	return join(dirname(logDir()), "llama-server.log");
}

export function parseOutput(raw: string, schema: Table | null = null): Table {
	let choice: Table;
	let text: string;
	try {
		choice = JSON.parse(raw).choices[0];
		text = choice.message.content || "";
	} catch {
		throw new BackendError("local model server returned no chat completion", true);
	}
	const data = jsonObject(text);
	if (data === null) {
		const why = choice.finish_reason === "length" ? "was cut off" : "is not a JSON object";
		throw new BackendError(`local model answer ${why}`, true);
	}
	if (typeof data.checks !== "object" || data.checks === null || Array.isArray(data.checks)) {
		throw new BackendError("local model answer has no `checks` object", true);
	}
	const tokens = (choice.logprobs || {}).content;
	if (schema && Array.isArray(tokens) && tokens.length) addAnswerProbs(data, tokens, schema);
	return data;
}

// ── confidence from token probabilities ──────────────────────────────────────

export interface TokenLogprob {
	token: string;
	logprob: number;
	top_logprobs?: { token: string; logprob: number }[];
}

type AnswerValue = string | number;

/** Python's `round(x, n)` close enough for probabilities: half away from zero at n decimals. */
function round(x: number, n: number): number {
	const f = 10 ** n;
	return Math.round(x * f) / f;
}

/**
 * The answer value a partial answer text stands for, and whether it is final.
 *
 * null means the text is not a valid answer, or still matches several. A number that has not ended
 * stands for the middle of the range it covers ("0.8" -> 0.85).
 */
function resolve(text: string, answerSchema: Table): [AnswerValue, boolean] | null {
	if ("enum" in answerSchema) {
		const core = text.split('"', 1)[0].toLowerCase();
		const closed = text.includes('"');
		const hits = (answerSchema.enum as string[]).filter((v) => (closed ? v.toLowerCase() === core : v.toLowerCase().startsWith(core)));
		return core && hits.length === 1 ? [hits[0], true] : null;
	}
	const m = /^-?\d+(?:\.\d*)?/.exec(text);
	if (!m) return null;
	const core = m[0];
	const closed = core.length < text.length;
	if (answerSchema.type === "integer") return [Number.parseInt(core, 10), closed];
	const lo: number = answerSchema.minimum ?? 0;
	const hi: number = answerSchema.maximum ?? 1;
	let value: number;
	if (closed) {
		value = Number.parseFloat(core);
	} else if (core.includes(".") && !core.endsWith(".")) {
		value = Number.parseFloat(core) + 0.5 * 10 ** -(core.length - core.indexOf(".") - 1);
	} else if (Number.parseFloat(core.replace(/\.+$/, "")) >= hi) {
		value = hi;
	} else {
		return null;
	}
	return [round(Math.min(Math.max(value, lo), hi), 6), closed];
}

/** `{answer value: probability}` along the chosen tokens, from the answer's first character at `pos`. */
function alternatives(tokens: TokenLogprob[], starts: number[], pos: number, answerSchema: Table): Map<AnswerValue, number> {
	let i = 0;
	starts.forEach((s, k) => {
		if (s <= pos) i = k;
	});
	const cut = pos - starts[i];
	let prefix = "";
	let pathP = 1;
	const probs = new Map<AnswerValue, number>();
	for (let k = i; k < tokens.length; k++) {
		const tok = tokens[k];
		const c = k === i ? cut : 0;
		for (const alt of tok.top_logprobs ?? []) {
			if (alt.token === tok.token) continue;
			const hit = resolve(prefix + alt.token.slice(c), answerSchema);
			if (hit !== null) probs.set(hit[0], (probs.get(hit[0]) ?? 0) + pathP * Math.exp(alt.logprob));
		}
		prefix += tok.token.slice(c);
		pathP *= Math.exp(tok.logprob);
		const hit = resolve(prefix, answerSchema);
		if (hit !== null && hit[1]) {
			probs.set(hit[0], (probs.get(hit[0]) ?? 0) + pathP);
			return probs;
		}
	}
	return new Map();
}

/** Attach `answer_probs` (`[[value, probability], ...]`, summing to 1) to each answer. */
export function addAnswerProbs(data: Table, tokens: TokenLogprob[], schema: Table): void {
	let text = "";
	const starts: number[] = [];
	for (const tok of tokens) {
		starts.push(text.length);
		text += tok.token;
	}
	const specs: Table = schema.properties.checks.properties ?? {};
	let pos = 0;
	for (const [key, entry] of Object.entries(data.checks as Table)) {
		const spec = specs[key]?.properties?.answer;
		const at = text.indexOf(JSON.stringify(key), pos);
		let m: RegExpExecArray | null = null;
		if (spec && at >= 0) {
			const re = /"answer"\s*:\s*"?/g;
			re.lastIndex = at;
			m = re.exec(text);
		}
		if (!m || typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const end = m.index + m[0].length;
		pos = end;
		const probs = alternatives(tokens, starts, end, spec);
		let total = 0;
		for (const p of probs.values()) total += p;
		if (total > 0 && probs.has(entry.answer)) {
			entry.answer_probs = [...probs]
				.filter(([v, p]) => p / total >= 0.001 || v === entry.answer)
				.map(([v, p]) => [v, round(p / total, 4)]);
		}
	}
}
