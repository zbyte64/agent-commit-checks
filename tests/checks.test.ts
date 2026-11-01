import { expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as c from "../src/checks.ts";
import { checkToml, useTmp } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");
const tmp = useTmp();

function parse(text: string, cid: string | null = null): c.Check {
	return c.parseText(text, cid);
}

test.each(["bool", "choice", "score"])("valid %s check", (qtype) => {
	expect(parse(checkToml("x", { qtype }), "x").questionType).toBe(qtype);
});

test("id must match the file name", () => {
	expect(() => parse(checkToml("x"), "y")).toThrow(/file name/);
});

test.each([
	[(t: string) => t.replace('id = "x"', 'id = "Bad_ID"'), "id must"],
	[(t: string) => t.replace('status = "active"', 'status = "live"'), "status"],
	[(t: string) => t.replace("applies_to", 'scope = "per_commit"\napplies_to'), "scope was removed"],
	[(t: string) => t.replace('inputs = ["diff"]', 'inputs = ["code"]'), "inputs"],
	[(t: string) => t.replace('applies_to = ["**/*"]', "applies_to = []"), "applies_to"],
	[(t: string) => t.replace("block_at = 0.8", "block_at = 1.5"), "probability"],
	[(t: string) => t.replace("block_at = 0.8", "block_at = 0.3"), "warn_at must not exceed"],
	[(t: string) => `${t}\nsurprise = 1\n`, "unknown"],
] as [(t: string) => string, string][])("invalid check %#", (mutate, msg) => {
	expect(() => parse(mutate(checkToml("x")), "x")).toThrow(c.CheckError);
	expect(() => parse(mutate(checkToml("x")), "x")).toThrow(msg);
});

test("choice needs a full verdict table", () => {
	let t = checkToml("x", { qtype: "choice" }).replace('meh = "warn"\n', "");
	expect(() => parse(t, "x")).toThrow("missing labels: meh");
	t = checkToml("x", { qtype: "choice" }).replace('bad = "block"', 'bad = "explode"');
	expect(() => parse(t, "x")).toThrow("pass, warn or block");
});

test("choice needs two labels", () => {
	const t = checkToml("x", { qtype: "choice" }).replace(', meh = "So-so", bad = "Broken"', "");
	expect(() => parse(t, "x")).toThrow("2+");
});

test("score level index range", () => {
	const t = checkToml("x", { qtype: "score" }).replace("block_at = 2", "block_at = 3");
	expect(() => parse(t, "x")).toThrow("level index");
});

test("bool verdicts", () => {
	const ch = parse(checkToml("x"));
	expect(c.mapVerdict(ch, 0.1)).toBe("pass");
	expect(c.mapVerdict(ch, 0.5)).toBe("warn");
	expect(c.mapVerdict(ch, 0.8)).toBe("block");
	expect(c.mapVerdict(ch, 1)).toBe("block");
	for (const bad of [1.2, -0.1, "0.9", true, null]) expect(() => c.mapVerdict(ch, bad)).toThrow(c.AnswerError);
});

test("choice verdicts", () => {
	const ch = parse(checkToml("x", { qtype: "choice" }));
	expect(["good", "meh", "bad"].map((a) => c.mapVerdict(ch, a))).toEqual(["pass", "warn", "block"]);
	expect(() => c.mapVerdict(ch, "unknown")).toThrow(c.AnswerError);
	expect(() => c.mapVerdict(ch, "constructor")).toThrow(c.AnswerError);
});

test("score verdicts", () => {
	const ch = parse(checkToml("x", { qtype: "score" }));
	expect([0, 1, 2].map((i) => c.mapVerdict(ch, i))).toEqual(["pass", "warn", "block"]);
	// JSON cannot tell 1.0 from 1 in JS, so only non-integers are rejected.
	for (const bad of [3, -1, 1.5, "1", false]) expect(() => c.mapVerdict(ch, bad)).toThrow(c.AnswerError);
});

test("validateEntry drops malformed findings", () => {
	const ch = parse(checkToml("x"));
	const r = c.validateEntry(ch, {
		answer: 0.9,
		confidence: 0.8,
		findings: [{ file: "a.py", line: 3, message: "bad" }, { nope: 1 }, "str"],
		summary: "s",
	});
	expect(r.verdict).toBe("block");
	expect(r.confidence).toBe(0.8);
	expect(r.findings).toEqual([{ file: "a.py", line: 3, message: "bad" }]);
	expect(() => c.validateEntry(ch, { answer: 0.9, confidence: 0.8, findings: "x" })).toThrow(c.AnswerError);
});

test.each([null, 1.5, -0.1, true, "high"])("validateEntry needs a confidence (%p)", (confidence) => {
	const ch = parse(checkToml("x"));
	const entry: Record<string, unknown> = { answer: 0.9, findings: [], summary: "s" };
	if (confidence !== null) entry.confidence = confidence;
	expect(() => c.validateEntry(ch, entry)).toThrow(/confidence/);
});

test("answer schema requires a confidence", () => {
	const schema = c.answerSchema(parse(checkToml("x")));
	expect(schema.required).toContain("confidence");
	expect(schema.properties.confidence).toEqual({ type: "number", minimum: 0, maximum: 1 });
});

test("dumpCheck round-trips", () => {
	const original = parse(checkToml("x", { qtype: "choice", extra: '\n[grading]\nterms = ["a \\"q\\""]\n' }));
	const again = parse(c.dumpCheck(original.toDict()), "x");
	expect(again.toDict()).toEqual(original.toDict());
});

test("setStatus changes one line", () => {
	const p = join(tmp(), "x.toml");
	writeFileSync(p, checkToml("x", { status: "proposed" }));
	const before = readFileSync(p, "utf8");
	const { oldLine, newLine } = c.setStatus(p, "active");
	expect([oldLine, newLine]).toEqual(['status = "proposed"', 'status = "active"']);
	const after = readFileSync(p, "utf8").split("\n");
	const diff = before
		.split("\n")
		.map((line, i) => [line, after[i]])
		.filter(([a, b]) => a !== b);
	expect(diff).toEqual([[oldLine, newLine]]);
});

test("setStatus inserts a missing status line", () => {
	const p = join(tmp(), "x.toml");
	writeFileSync(p, checkToml("x").replace('status = "active"\n', ""));
	c.setStatus(p, "advisory");
	expect(c.loadFile(p).status).toBe("advisory");
});

test("contentHash ignores the status line", () => {
	const a = checkToml("x", { status: "proposed" });
	const b = checkToml("x", { status: "active" });
	expect(c.contentHash(a)).toBe(c.contentHash(b));
	expect(c.contentHash(a)).not.toBe(c.contentHash(a.replace("Is there", "Is there really")));
});

test("contentHash keeps grades written by the Python version valid", () => {
	// The value the Python version stored in .acc/grades/*.json for this text.
	const text = 'id = "x"\ntitle = "T é"\nstatus = "active"  # note\n\n[question]\ntype = "bool"\n';
	expect(c.contentHash(text)).toBe("c2b4c95984f858c648c589afefd864d2f7e57ee2b5e1f77626b0c46ee820b058");
});

test("loadAll reports errors", () => {
	writeFileSync(join(tmp(), "good.toml"), checkToml("good"));
	writeFileSync(join(tmp(), "bad.toml"), "id = [");
	const { checks, errors } = c.loadAll(tmp());
	expect(checks.map((x) => x.id)).toEqual(["good"]);
	expect(Object.keys(errors)).toEqual(["bad.toml"]);
});

test("examples match the templates and validate", () => {
	const tpl = join(ROOT, "src/templates/checks");
	const ex = join(ROOT, "examples/.acc/checks");
	const names = readdirSync(tpl)
		.filter((n) => n.endsWith(".toml"))
		.sort();
	expect(
		readdirSync(ex)
			.filter((n) => n.endsWith(".toml"))
			.sort(),
	).toEqual(names);
	for (const n of names) {
		expect(readFileSync(join(tpl, n), "utf8")).toBe(readFileSync(join(ex, n), "utf8"));
		c.loadFile(join(tpl, n));
	}
});
