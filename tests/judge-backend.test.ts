/** The judge backend against a stand-in llama-server that returns token probabilities. */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BackendError } from "../src/backends/base.ts";
import { getBackend } from "../src/backends/index.ts";
import { criteria, JudgeBackend, pYes } from "../src/backends/judge.ts";
import * as checks from "../src/checks.ts";
import { enableLocal } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { Context } from "../src/diffs.ts";
import { useTmp } from "./helpers.ts";

const tmp = useTmp();

function tok(text: string, p = 1.0, alts: Record<string, number> = {}) {
	return { token: text, logprob: Math.log(p), top_logprobs: Object.entries(alts).map(([t, q]) => ({ token: t, logprob: Math.log(q) })) };
}

function completion(tokens: ReturnType<typeof tok>[]): string {
	return JSON.stringify({
		choices: [{ message: { content: tokens.map((t) => t.token).join("") }, finish_reason: "stop", logprobs: { content: tokens } }],
	});
}

/** Guardian's no-think output with P(yes) = p; "Yes" counts as yes, other tokens are ignored. */
function guardianSays(p: number): string {
	return completion([
		tok("<think>\n</think>\n"),
		tok("<score>"),
		tok(" yes", p * 0.8, { Yes: p * 0.2, " no": 1 - p - 0.01, maybe: 0.01 }),
		tok("</score>"),
	]);
}

function check(qtype: string, body: string): checks.Check {
	return checks.parseText(`id = "c"\ntitle = "t"\n[question]\ntype = "${qtype}"\ninstructions = "q"\n${body.replace(/^\t+/gm, "")}`, "c");
}

const BOOL = check("bool", "[verdict]\nblock_at = 0.85\nwarn_at = 0.5\n");
const CHOICE = check(
	"choice",
	`labels = { accurate = "a", incomplete = "i", wrong = "w" }
	[verdict]
	accurate = "pass"
	incomplete = "block"
	wrong = "block"
`,
);

/** Replies to POSTs from a queue and records request bodies. */
function server() {
	const replies: string[] = [];
	const requests: any[] = [];
	const srv = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			if (req.method === "GET") return new Response('{"data": []}');
			requests.push(await req.json());
			return new Response(replies.shift() ?? "");
		},
	});
	running.push(srv);
	return { url: `http://127.0.0.1:${srv.port}`, replies, requests };
}
const running: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const s of running.splice(0)) s.stop(true);
});

const ctx = new Context({ label: "range", commit: null, diff: "", message: "", files: [] });

async function decide(url: string, c: checks.Check, format = "guardian") {
	const backend = new JudgeBackend({ url, model: "m", format });
	return (await backend.decide([{ key: "c", check: c, context: ctx }], "DATA", 5)).checks.c;
}

test("pYes reads the token after the marker", () => {
	const [p, reason] = pYes(guardianSays(0.9), "<score>");
	expect(p).toBeCloseTo(0.9 / 0.99, 6); // "maybe" is not a judgement
	expect(reason).toBe("");
});

test("Selene's reasoning becomes the summary", async () => {
	const s = server();
	s.replies.push(completion([tok("**Reasoning:** The diff adds a print call.\n\n**Result:**"), tok(" Yes", 0.7, { " No": 0.3 })]));
	const entry = await decide(s.url, BOOL, "selene");
	expect(entry.answer).toBeCloseTo(0.7, 6);
	expect(entry.summary).toBe("The diff adds a print call.");
	const content: string = s.requests[0].messages[0].content;
	expect(content.indexOf("DATA")).toBeLessThan(content.indexOf("Score Rubrics")); // data first, for the prompt cache
});

test("Guardian bool", async () => {
	const s = server();
	s.replies.push(guardianSays(0.9));
	const entry = await decide(s.url, BOOL);
	expect(entry.answer).toBeCloseTo(0.9091, 3);
	expect(checks.validateEntry(BOOL, entry).verdict).toBe("block");
	const req = s.requests[0];
	expect(req.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
	expect(req.messages[1].content).toBe("DATA");
	expect(req.messages[2].content).toContain("### Criteria: Question about the commits: q");
	expect(req.logprobs).toBe(true);
	expect(req.temperature).toBe(0);
});

test("Guardian choice asks about each label", async () => {
	const s = server();
	for (const p of [0.2, 0.6, 0.2]) s.replies.push(guardianSays(p));
	const entry = await decide(s.url, CHOICE);
	expect(s.requests.length).toBe(3);
	expect(s.requests.map((r) => r.messages[2].content.includes('"accurate"'))).toEqual([true, false, false]);
	expect(entry.answer).toBe("incomplete");
	const r = checks.validateEntry(CHOICE, entry);
	expect(r.verdict).toBe("block");
	expect(r.confidence).toBeCloseTo(0.8, 3); // incomplete and wrong both block
});

test("no judgement is retryable", async () => {
	const s = server();
	s.replies.push(completion([tok("I cannot judge this.")]));
	try {
		await decide(s.url, BOOL);
		throw new Error("expected a BackendError");
	} catch (e) {
		expect(e).toBeInstanceOf(BackendError);
		expect((e as BackendError).message).toContain("no '<score>'");
		expect((e as BackendError).retryable).toBe(true);
	}
});

test("criteria per question type", () => {
	expect(criteria(BOOL)[0][1].endsWith("the correct answer to the question is yes.")).toBe(true);
	expect(criteria(CHOICE).map(([v]) => v)).toEqual(["accurate", "incomplete", "wrong"]);
});

test("unknown format", () => {
	expect(() => new JudgeBackend({ format: "gpt" })).toThrow("format must be one of guardian, selene");
});

test("judge preset", () => {
	mkdirSync(join(tmp(), ".acc"));
	writeFileSync(join(tmp(), ".acc/config.toml"), enableLocal("", "judge", "llama-server"));
	const backend = getBackend(loadConfig(tmp()), "claude") as JudgeBackend;
	expect([backend.name, backend.format, backend.device]).toEqual(["judge", "guardian", "gpu"]);
	expect(backend.model).toContain("granite-guardian");
});
