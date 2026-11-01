/**
 * Summarise bench/results/*.json as markdown tables.
 *
 * usage: bun bench/report.ts [bench/results]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CHECKS = ["commit-message-matches-diff", "src-changes-have-tests", "no-debug-leftovers"];
const KIND_ORDER: Record<string, number> = { claude: 0, judge: 1, gpu: 2, cpu: 3, tiny: 4 };

interface Row {
	check: string;
	expect: "pass" | "fail";
	verdict: string;
	confidence: number | null;
	error: string;
	seconds: number;
}

interface Result {
	kind: string;
	model: string;
	rev: string;
	machine: string;
	startup_seconds: number;
	rows: Row[];
}

const caught = (r: Row): boolean => r.verdict !== "pass";

/** Python's `f"{x:.{digits}f}"`: an exact tie rounds to even (JS's toFixed rounds it up). */
function fixed(x: number, digits: number): string {
	const scaled = x * 10 ** digits;
	if (Number.isInteger(scaled * 2) && !Number.isInteger(scaled)) {
		const down = Math.floor(scaled);
		return ((down % 2 === 0 ? down : down + 1) / 10 ** digits).toFixed(digits);
	}
	return x.toFixed(digits);
}

function score(rows: Row[]): string {
	const real = rows.filter((r) => r.expect === "pass");
	const bad = rows.filter((r) => r.expect === "fail");
	return `${real.filter((r) => !caught(r)).length}/${real.length} · ${bad.filter(caught).length}/${bad.length}`;
}

function mean(rows: Row[]): string {
	const xs = rows.map((r) => r.confidence).filter((c): c is number => c !== null);
	return xs.length ? fixed(xs.reduce((s, x) => s + x, 0) / xs.length, 2) : "–";
}

/** Mean confidence of right and wrong verdicts: a useful confidence is lower when wrong. */
function confidence(rows: Row[]): string {
	const right = rows.filter((r) => !r.error && caught(r) === (r.expect === "fail"));
	const wrong = rows.filter((r) => !r.error && !right.includes(r));
	return `${mean(right)} / ${mean(wrong)}`;
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const dir = process.argv[2] ?? join(import.meta.dirname, "results");
const results: Result[] = readdirSync(dir)
	.filter((n) => n.endsWith(".json"))
	.sort()
	.map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
results.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
const out: string[] = [
	"Real commits passed · altered commits caught (26 each, 52 cases per model).\n",
	"| Kind | Model | All | Messages | Tests | Debug | Errors | Confidence right / wrong | Median s | Max s | Load s |",
	"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];
for (const d of results) {
	const per = CHECKS.map((c) => score(d.rows.filter((r) => r.check === c)));
	const secs = d.rows.map((r) => r.seconds);
	out.push(
		`| ${d.kind} | ${d.model} | ${score(d.rows)} | ${per.join(" | ")} | ${d.rows.filter((r) => r.error).length} | ` +
			`${confidence(d.rows)} | ${fixed(median(secs), 1)} | ${fixed(Math.max(...secs), 0)} | ${fixed(d.startup_seconds, 0)} |`,
	);
}
const revs = [...new Set(results.map((d) => d.rev))].sort();
const machines = [...new Set(results.map((d) => d.machine))].sort();
out.push(`\nCases from rev ${revs.join(", ")}; run on ${machines.join(", ")}.`);
console.log(out.join("\n"));
