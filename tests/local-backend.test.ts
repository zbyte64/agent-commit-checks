/** The local backend against a stand-in OpenAI-compatible server, and its config switch. */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { BackendError } from "../src/backends/base.ts";
import { LocalBackend, parseOutput } from "../src/backends/local.ts";
import * as checks from "../src/checks.ts";
import { useTmp } from "./helpers.ts";

const tmp = useTmp();
const SCHEMA = { type: "object", properties: { checks: { type: "object" } }, required: ["checks"] };

function completion(content: string, finish = "stop"): string {
	return JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: finish }] });
}

/** Answers /v1/models and /v1/chat/completions with canned replies; records request bodies. */
class Server {
	replies: [number, string][] = [];
	requests: any[] = [];
	models = '{"data": []}';
	readonly server: ReturnType<typeof Bun.serve>;

	constructor() {
		this.server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (req) => {
				if (req.method === "GET") return new Response(this.models, { headers: { "Content-Type": "application/json" } });
				this.requests.push(await req.json());
				const [code, body] = this.replies.shift() as [number, string];
				return new Response(body, { status: code, headers: { "Content-Type": "application/json" } });
			},
		});
	}

	get url(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}
}

const servers: Server[] = [];
function server(): Server {
	const s = new Server();
	servers.push(s);
	return s;
}
afterEach(() => {
	for (const s of servers.splice(0)) s.server.stop(true);
});

async function freePort(): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	const srv = createServer();
	srv.listen(0, "127.0.0.1", () => {
		const port = (srv.address() as { port: number }).port;
		srv.close(() => resolve(port));
	});
	return promise;
}

async function backendError(p: Promise<unknown>): Promise<BackendError> {
	try {
		await p;
	} catch (e) {
		if (e instanceof BackendError) return e;
		throw e;
	}
	throw new Error("expected a BackendError");
}

test("answer and request shape", async () => {
	const s = server();
	s.replies.push([200, completion('{"checks": {"a": {"answer": 0.1}}}')]);
	const out = await new LocalBackend({ url: s.url, model: "m" }).ask("sys", "QUESTION", "DATA", SCHEMA, 5);
	expect(out).toEqual({ checks: { a: { answer: 0.1 } } });
	const req = s.requests[0];
	expect(req.model).toBe("m");
	expect(req.temperature).toBe(0);
	expect(req.response_format.json_schema.schema).toEqual(SCHEMA);
	expect(req.chat_template_kwargs).toEqual({ enable_thinking: false });
	const user: string = req.messages[1].content;
	expect(user.indexOf("DATA")).toBeLessThan(user.indexOf("QUESTION"));
	expect(user.indexOf("QUESTION")).toBeLessThan(user.indexOf("JSON Schema"));
});

test.each([
	[503, true],
	[429, true],
	[400, false],
])("HTTP %p retryable=%p", async (code, retryable) => {
	const s = server();
	s.replies.push([code, '{"error": "nope"}']);
	const e = await backendError(new LocalBackend({ url: s.url }).ask("s", "p", "", SCHEMA, 5));
	expect(e.message).toContain(`returned ${code}`);
	expect(e.retryable).toBe(retryable);
});

test.each([
	[completion('{"checks": {"a": ', "length"), "cut off"],
	[completion("yes"), "not a JSON object"],
	[completion('{"result": {}}'), "no `checks` object"],
	['{"error": "x"}', "no chat completion"],
])("invalid answer %# is retryable", async (raw, match) => {
	const e = await backendError(Promise.resolve().then(() => parseOutput(raw)));
	expect(e.message).toContain(match);
	expect(e.retryable).toBe(true);
});

test("no server and no autostart", async () => {
	const backend = new LocalBackend({ url: `http://127.0.0.1:${await freePort()}`, server: "" });
	await expect(backend.ask("s", "p", "", SCHEMA, 5)).rejects.toThrow("no model server answers");
});

test("starts the server when it is down", async () => {
	// A stand-in llama-server: serves on --port, answers every request with one fixed answer.
	const script = join(tmp(), "llama-server");
	const argvFile = join(tmp(), "argv.json");
	writeFileSync(
		script,
		`#!${process.execPath}\n` +
			`const args = process.argv.slice(2);\n` +
			`require("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));\n` +
			`const body = ${JSON.stringify(completion('{"checks": {}}'))};\n` +
			`Bun.serve({ hostname: "127.0.0.1", port: Number(args[args.indexOf("--port") + 1]), fetch: () => new Response(body) });\n`,
	);
	chmodSync(script, 0o755);
	const port = await freePort();
	const backend = new LocalBackend({
		url: `http://127.0.0.1:${port}`,
		model: "org/repo:Q8_0",
		server: script,
		server_args: ["--ctx-size", "4096"],
	});
	try {
		expect(await backend.ask("s", "p", "", SCHEMA, 5)).toEqual({ checks: {} });
		expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual([
			"-hf",
			"org/repo:Q8_0",
			"--alias",
			"org/repo:Q8_0",
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"--device",
			"none",
			"--ctx-size",
			"4096",
		]);
	} finally {
		try {
			execFileSync("pkill", ["-f", script]);
		} catch {
			// already gone
		}
	}
});

test("unknown device", () => {
	expect(() => new LocalBackend({ device: "tpu" })).toThrow("device must be one of cpu, gpu");
});

test("refuses a server with another model", async () => {
	const s = server();
	s.models = '{"data": [{"id": "other/model"}]}';
	await expect(new LocalBackend({ url: s.url, model: "mine/model" }).ask("s", "p", "", SCHEMA, 5)).rejects.toThrow(
		"serves other/model, not mine/model",
	);
});

// ── confidence from token probabilities ──────────────────────────────────────

function tok(text: string, p = 1.0, alts: Record<string, number> = {}) {
	return {
		token: text,
		logprob: Math.log(p),
		top_logprobs: Object.entries(alts).map(([t, q]) => ({ token: t, logprob: Math.log(q) })),
	};
}

function answerWith(tokens: ReturnType<typeof tok>[], schema: Record<string, unknown>) {
	const raw = JSON.stringify({
		choices: [{ message: { content: tokens.map((t) => t.token).join("") }, finish_reason: "stop", logprobs: { content: tokens } }],
	});
	return parseOutput(raw, schema).checks;
}

function check(text: string): checks.Check {
	return checks.parseText(text.replace(/^\t+/gm, ""), "c");
}

const CHOICE = check(`
	id = "c"
	title = "t"
	[question]
	type = "choice"
	instructions = "q"
	labels = { accurate = "a", incomplete = "i", wrong = "w" }
	[verdict]
	accurate = "pass"
	incomplete = "block"
	wrong = "block"
`);
const BOOL = check(`
	id = "c"
	title = "t"
	[question]
	type = "bool"
	instructions = "q"
	[verdict]
	block_at = 0.85
	warn_at = 0.5
`);

function schemaFor(c: checks.Check) {
	return { type: "object", properties: { checks: { type: "object", properties: { c: checks.answerSchema(c) } } } };
}

function expectProbs(actual: [unknown, number][], expected: [unknown, number][]): void {
	const got = new Map(actual);
	expect([...got.keys()].sort()).toEqual(expected.map(([k]) => k).sort());
	for (const [k, p] of expected) expect(got.get(k)).toBeCloseTo(p, 4);
}

test("choice probabilities from tokens", () => {
	// "In" counts for `incomplete` (case is ignored); "The" is not a label and is dropped.
	const tokens = [
		tok('{"checks": {"c": {"answer": "'),
		tok("acc", 0.5, { In: 0.2, inc: 0.1, The: 0.1, wr: 0.05 }),
		tok("urate"),
		tok('", "confidence": 1, "findings": [], "summary": "s"}}}'),
	];
	const entry = answerWith(tokens, schemaFor(CHOICE)).c;
	expectProbs(entry.answer_probs, [
		["accurate", 0.5 / 0.85],
		["incomplete", 0.3 / 0.85],
		["wrong", 0.05 / 0.85],
	]);
	const r = checks.validateEntry(CHOICE, entry);
	expect(r.verdict).toBe("pass");
	expect(r.confidence).toBeCloseTo(0.5 / 0.85, 3); // not the self-reported 1
});

test("number probabilities and verdict mass", () => {
	// The model wrote 0.9, with 0.1 on "1", 0.27 on "0.1…" and 0.09 on "0.8…".
	const tokens = [
		tok('{"checks": {"c": {"answer": '),
		tok("0", 0.9, { "1": 0.1 }),
		tok("."),
		tok("9", 0.6, { "1": 0.3, "8": 0.1 }),
		tok(', "confidence": 1, "findings": [], "summary": "s"}}}'),
	];
	const entry = answerWith(tokens, schemaFor(BOOL)).c;
	expectProbs(entry.answer_probs, [
		[1, 0.1],
		[0.15, 0.27],
		[0.85, 0.09],
		[0.9, 0.54],
	]);
	const r = checks.validateEntry(BOOL, entry);
	expect(r.verdict).toBe("block");
	expect(r.confidence).toBeCloseTo(0.73, 3); // every answer at or above block_at
});

test("without logprobs the self-reported confidence stands", () => {
	const raw = completion('{"checks": {"c": {"answer": "wrong", "confidence": 0.8, "findings": [], "summary": "s"}}}');
	const entry = parseOutput(raw, schemaFor(CHOICE)).checks.c;
	expect("answer_probs" in entry).toBe(false);
	expect(checks.validateEntry(CHOICE, entry).confidence).toBe(0.8);
});
