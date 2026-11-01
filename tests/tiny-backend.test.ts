/** The tiny backend's decisions, with a stub model in place of onnxruntime. */
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BackendError } from "../src/backends/base.ts";
import { TinyBackend, type TinyModel } from "../src/backends/tiny.ts";
import * as checks from "../src/checks.ts";
import { loadConfig } from "../src/config.ts";
import { Context } from "../src/diffs.ts";
import { execute } from "../src/runner.ts";
import { useTmp } from "./helpers.ts";

const tmp = useTmp();

/** Answer tokens are single ids; every other text encodes to filler ids. Logits come from `probs`. */
class StubModel implements TinyModel {
	readonly context = 64;
	readonly vocab = new Map(["yes", "Yes", "no", "No", ...Array.from({ length: 10 }, (_, i) => String(i))].map((t, i) => [t, i]));
	readonly seen: number[][] = [];
	readonly probs: Record<string, number>;

	constructor(probs: Record<string, number>) {
		this.probs = probs;
	}

	encode(text: string): number[] {
		const id = this.vocab.get(text);
		return id !== undefined ? [id] : new Array(text.split(/\s+/).filter(Boolean).length + 1).fill(100);
	}

	async lastLogits(ids: number[]): Promise<number[]> {
		this.seen.push(ids);
		const logits: number[] = [];
		for (const [text, i] of this.vocab) logits[i] = Math.log(this.probs[text] ?? 1e-9);
		return logits;
	}
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

function backendWith(model: TinyModel): TinyBackend {
	const backend = new TinyBackend({});
	backend.load = async () => model;
	return backend;
}

const ctx = new Context({ label: "range", commit: null, diff: "diff --git a/x b/x\n+x\n", message: "m", files: ["x"] });

async function decide(c: checks.Check, probs: Record<string, number>) {
	return (await backendWith(new StubModel(probs)).decide([{ key: "c", check: c, context: ctx }], "data")).checks.c;
}

test("a bool answer is P(yes)", async () => {
	const entry = await decide(BOOL, { yes: 0.4, Yes: 0.4, no: 0.1, No: 0.1 });
	expect(entry.answer).toBeCloseTo(0.8, 6); // both spellings of yes, against both of no
	expect(checks.validateEntry(BOOL, entry).verdict).toBe("warn");
});

test("choice reads option numbers", async () => {
	// Options are numbered from 1 in label order: 1 accurate, 2 incomplete, 3 wrong.
	const entry = await decide(CHOICE, { "1": 0.2, "2": 0.45, "3": 0.35 });
	expect(entry.answer).toBe("incomplete");
	const r = checks.validateEntry(CHOICE, entry);
	expect(r.verdict).toBe("block");
	expect(r.confidence).toBeCloseTo(0.8, 6); // incomplete and wrong both block
	expect(r.summary.startsWith("accurate 0.20, incomplete 0.45, wrong 0.35")).toBe(true);
});

test("long data is clipped to the context", async () => {
	const model = new StubModel({ yes: 1 });
	await backendWith(model).decide([{ key: "c", check: BOOL, context: ctx }], "word ".repeat(500));
	expect(model.seen[0].length).toBe(model.context);
});

test("multi-token answers are refused", async () => {
	const model = new StubModel({});
	model.vocab.delete("yes");
	await expect(backendWith(model).decide([{ key: "c", check: BOOL, context: ctx }], "data")).rejects.toThrow(BackendError);
	await expect(backendWith(model).decide([{ key: "c", check: BOOL, context: ctx }], "data")).rejects.toThrow("not one token");
});

test("the runner sends checks to decide()", async () => {
	mkdirSync(join(tmp(), ".acc"));
	const cfg = loadConfig(tmp());
	const { results, calls } = await execute([{ key: "c", check: CHOICE, context: ctx }], backendWith(new StubModel({ "1": 0.9, "2": 0.05, "3": 0.05 })), cfg);
	expect([results[0].verdict, results[0].answer, calls]).toEqual(["pass", "accurate", 1]);
	expect(results[0].confidence).toBeCloseTo(0.9, 6);
});
