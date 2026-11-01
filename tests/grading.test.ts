import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBackend } from "../src/backends/index.ts";
import type { Check } from "../src/checks.ts";
import type { Config } from "../src/config.ts";
import * as grading from "../src/grading.ts";
import * as ops from "../src/ops.ts";
import { checkToml, FAKE_AWS_KEY, makeRepo, type Repo, useTmp } from "./helpers.ts";

const tmp = useTmp();

/** n commits on main; every `pyEvery`-th touches a .py file, every `termEvery`-th adds 'console.log'. */
function history(repo: Repo, n: number, pyEvery = 1, termEvery = 0): string[] {
	const shas: string[] = [];
	for (let i = 1; i <= n; i++) {
		const name = i % pyEvery === 0 ? `src/m${i}.py` : `docs/d${i}.md`;
		const body = termEvery && i % termEvery === 0 ? "console.log('x')\n" : `value = ${i}\n`;
		shas.push(repo.commit({ [name]: body }, `change ${i}`));
	}
	repo.push();
	return shas;
}

function setup(repo: Repo, opts: { answers?: unknown; extra?: string; status?: string } = {}): { cfg: Config; check: Check } {
	repo.enable({
		checks: { dbg: checkToml("dbg", { appliesTo: '["**/*.py"]', extra: opts.extra ?? "", status: opts.status }) },
		answers: opts.answers ?? { "*": { answer: 0.1, findings: [], summary: "ok" } },
	});
	const cfg = repo.config();
	return { cfg, check: ops.getCheck(cfg, "dbg") };
}

const ok = (cfg: Config) => getBackend(cfg, "claude");
const range = (u: grading.Unit): string => `${u.base}..${u.tip}`;

test("filter and size", async () => {
	const repo = makeRepo(tmp());
	history(repo, 40, 2);
	const { cfg, check } = setup(repo);
	const { units, poolSize } = await grading.selectSample(cfg, repo.path, check);
	expect(poolSize).toBe(20); // only .py commits are eligible
	expect(units.length).toBe(20);
	expect(units.every((u) => u.context.files.some((f) => f.endsWith(".py")))).toBe(true);
});

test("top scores and a seeded random draw", async () => {
	const repo = makeRepo(tmp());
	history(repo, 60, 1, 5);
	const { cfg, check } = setup(repo, { extra: '\n[grading]\nterms = ["console.log"]\n' });
	const { units } = await grading.selectSample(cfg, repo.path, check);
	const top = units.filter((u) => u.reason === "top-score");
	const rand = units.filter((u) => u.reason === "random");
	expect(top.length).toBe(10);
	expect(rand.length).toBe(10);
	expect(top.every((u) => u.score >= 4)).toBe(true); // 1 path + 3 per term hit
	const again = await grading.selectSample(cfg, repo.path, check);
	expect(again.units.map(range)).toEqual(units.map(range));
	repo.commit({ "src/new.py": "x = 1\n" }); // a new HEAD reseeds the draw
	const third = await grading.selectSample(cfg, repo.path, check);
	expect(new Set(third.units.filter((u) => u.reason === "random").map((u) => u.tip))).not.toEqual(new Set(rand.map((u) => u.tip)));
});

test("a small pool uses all and is insufficient", async () => {
	const repo = makeRepo(tmp());
	history(repo, 6);
	const { cfg, check } = setup(repo);
	const { units, poolSize } = await grading.selectSample(cfg, repo.path, check);
	expect(units.length).toBe(6);
	expect(poolSize).toBe(6);
	expect((await grading.grade(cfg, repo.path, check, ok(cfg))).result).toBe("insufficient");
});

test("excludes secret and check-creation commits", async () => {
	const repo = makeRepo(tmp());
	history(repo, 12);
	repo.commit({ "src/leak.py": `K = "${FAKE_AWS_KEY}"\n` });
	const { cfg, check } = setup(repo);
	repo.git("add", ".acc");
	repo.commit({ "src/with_check.py": "x = 1\n" }, "add check");
	const added = repo.git("rev-parse", "HEAD");
	const { units } = await grading.selectSample(cfg, repo.path, check);
	expect(units.flatMap((u) => u.context.files)).not.toContain("src/leak.py");
	expect(units.map((u) => u.tip)).not.toContain(added);
});

test("a passing grade writes its record", async () => {
	const repo = makeRepo(tmp());
	history(repo, 25);
	const { cfg, check } = setup(repo);
	const g = await grading.grade(cfg, repo.path, check, ok(cfg));
	expect(g.result).toBe("pass");
	expect(g.metrics.sample_size).toBe(20);
	expect(g.metrics.calls).toBe(20); // one call per range
	const rec = JSON.parse(readFileSync(join(cfg.gradesDir, "dbg.json"), "utf8"));
	expect(rec.check_sha256).toBe(check.contentHash);
	expect(rec.sample.length).toBe(20);
	expect(new Set(rec.sample.map((s: { reason: string }) => s.reason))).toEqual(new Set(["top-score", "random"]));
	expect(grading.gradeStatus(cfg, check)).toBe("pass");
});

test("a grade fails on its block rate", async () => {
	const repo = makeRepo(tmp());
	history(repo, 25);
	const { cfg, check } = setup(repo, { answers: { "*": { answer: 0.95, findings: [], summary: "bad" } } });
	const g = await grading.grade(cfg, repo.path, check, ok(cfg));
	expect(g.result).toBe("fail");
	expect(g.metrics.block_rate).toBe(1.0);
	// blocked and warned units are re-run for stability
	expect(g.metrics.calls).toBe(40);
});

test("expect_fail catch rate", async () => {
	const repo = makeRepo(tmp());
	const shas = history(repo, 25);
	const target = shas[3];
	const { cfg, check } = setup(repo, { extra: `\n[grading]\nexpect_fail = ["${target.slice(0, 9)}"]\n` });
	let g = await grading.grade(cfg, repo.path, check, ok(cfg));
	expect(g.metrics.catch_rate).toBe(0.0);
	expect(g.result).toBe("fail");
	expect(g.metrics.sample_size).toBe(20); // expect_fail units are on top of the sample
	writeFileSync(
		join(repo.path, "answers.json"),
		JSON.stringify({
			"*": { answer: 0.1, findings: [], summary: "ok" },
			[`dbg@${shas[2].slice(0, 7)}..${target.slice(0, 7)}`]: { answer: 0.99, findings: [], summary: "caught" },
		}),
	);
	g = await grading.grade(cfg, repo.path, check, ok(cfg));
	expect(g.metrics.catch_rate).toBe(1.0);
	expect(g.result).toBe("pass");
});

test("promotion needs a current passing grade", async () => {
	const repo = makeRepo(tmp());
	history(repo, 25);
	const { cfg } = setup(repo, { status: "proposed" });
	expect(() => ops.promote(cfg, "dbg", "active")).toThrow("no grade");
	expect(ops.promote(cfg, "dbg", "advisory").new_line).toBe('status = "advisory"');
	await grading.grade(cfg, repo.path, ops.getCheck(cfg, "dbg"), ok(cfg));
	const r = ops.promote(cfg, "dbg", "active");
	expect(r.old_line).toBe('status = "advisory"');
	expect(ops.getCheck(cfg, "dbg").status).toBe("active");
	// Promotion edits only the status line, so the grade still matches.
	expect(grading.gradeStatus(cfg, ops.getCheck(cfg, "dbg"))).toBe("pass");
});

test("editing a check invalidates its grade", async () => {
	const repo = makeRepo(tmp());
	history(repo, 25);
	const { cfg, check } = setup(repo, { status: "advisory" });
	await grading.grade(cfg, repo.path, check, ok(cfg));
	const path = join(cfg.checksDir, "dbg.toml");
	writeFileSync(path, readFileSync(path, "utf8").replace("Is there a problem?", "Is there any problem?"));
	expect(grading.gradeStatus(cfg, ops.getCheck(cfg, "dbg"))).toBe("stale");
	expect(() => ops.promote(cfg, "dbg", "active")).toThrow("changed since");
	expect(ops.promote(cfg, "dbg", "active", true).status).toBe("active");
});

test("explicit commits are graded each alone", async () => {
	const repo = makeRepo(tmp());
	const shas = history(repo, 30, 2); // odd commits touch docs only
	const { cfg, check } = setup(repo);
	const pick = [shas[1], shas[3].slice(0, 9), shas[0]]; // two .py commits (one abbreviated), one docs commit
	const { units, excluded } = await grading.selectSample(cfg, repo.path, check, pick);
	expect(units.map((u) => [u.tip, u.commits])).toEqual([
		[shas[1], [shas[1]]],
		[shas[3], [shas[3]]],
	]);
	expect(range(units[0])).toBe(`${shas[0]}..${shas[1]}`);
	expect(units.every((u) => u.reason === "selected")).toBe(true);
	const root = repo.git("rev-parse", `${shas[0]}^`);
	expect(excluded).toEqual([{ range: `${root}..${shas[0]}`, commits: [shas[0]], reason: "no changed path matches applies_to" }]);
});

test("each range is one unit", async () => {
	const repo = makeRepo(tmp());
	const shas = history(repo, 40);
	const { cfg, check } = setup(repo);
	const ranges = [`${shas[4]}..${shas[9]}`, `${shas[20]}..${shas[22]}`];
	const { units, poolSize, excluded } = await grading.selectSample(cfg, repo.path, check, null, ranges);
	expect(poolSize).toBe(2);
	expect(excluded).toEqual([]);
	expect(units.map(range)).toEqual(ranges);
	expect(units[0].commits).toEqual(shas.slice(5, 10));
	expect(units[1].commits).toEqual(shas.slice(21, 23));
	expect([...units[1].context.files].sort()).toEqual(["src/m22.py", "src/m23.py"]);
	expect(units[1].context.message).toContain(`${shas[21].slice(0, 7)}: change 22`);
	expect(new Set(units.map((u) => u.reason))).toEqual(new Set(["selected"]));
});

test("ranges are graded in separate calls", async () => {
	const repo = makeRepo(tmp());
	const shas = history(repo, 12);
	const { cfg, check } = setup(repo);
	const backend = ok(cfg);
	const calls: string[][] = [];
	const ask = backend.ask.bind(backend);
	backend.ask = (system, prompt, stdin, schema, timeout) => {
		calls.push(schema.properties.checks.required);
		return ask(system, prompt, stdin, schema, timeout);
	};
	const ranges = [`${shas[0]}..${shas[5]}`, `${shas[5]}..${shas[11]}`];
	const g = await grading.grade(cfg, repo.path, check, backend, null, null, ranges);
	expect(calls.map((c) => c.join()).sort()).toEqual(
		[`dbg@${shas[0].slice(0, 7)}..${shas[5].slice(0, 7)}`, `dbg@${shas[5].slice(0, 7)}..${shas[11].slice(0, 7)}`].sort(),
	);
	expect(g.record.selection).toEqual({ mode: "ranges", ranges });
	expect(g.record.sample.map((s: { commits: string[] }) => s.commits)).toEqual([shas.slice(1, 6), shas.slice(6, 12)]);
	expect(g.result).toBe("insufficient"); // two ranges are below min_sample
	expect(grading.isHandPicked(g.record)).toBe(true);
});

test("a range holding the check commit, or no commits, is excluded", async () => {
	const repo = makeRepo(tmp());
	const shas = history(repo, 3);
	const { cfg, check } = setup(repo);
	repo.git("add", ".acc");
	const added = repo.commit({ "src/with_check.py": "x = 1\n" }, "add check");
	const { units, excluded } = await grading.selectSample(cfg, repo.path, check, null, [`${shas[0]}..${added}`, `${shas[2]}..${shas[2]}`]);
	expect(units).toEqual([]);
	expect(excluded.map((x) => x.reason)).toEqual(["holds the commit that added the check file", "no commits in range"]);
});

test("selection errors", async () => {
	const repo = makeRepo(tmp());
	const shas = history(repo, 3);
	const { cfg, check } = setup(repo);
	await expect(grading.selectSample(cfg, repo.path, check, [shas[0]], ["HEAD~1..HEAD"])).rejects.toThrow("not both");
	await expect(grading.selectSample(cfg, repo.path, check, ["nope"])).rejects.toThrow("unknown commit");
	await expect(grading.selectSample(cfg, repo.path, check, null, ["HEAD"])).rejects.toThrow("A..B");
	await expect(grading.selectSample(cfg, repo.path, check, null, ["nope..HEAD"])).rejects.toThrow("unknown revision range");
});

test("a hand-picked grade promotes for the user, not the agent", async () => {
	const repo = makeRepo(tmp());
	const shas = history(repo, 25);
	const { cfg, check } = setup(repo, { status: "advisory" });
	const g = await grading.grade(cfg, repo.path, check, ok(cfg), null, shas.slice(0, 12));
	expect(g.result).toBe("pass");
	expect(g.record.selection).toEqual({ mode: "commits", commits: shas.slice(0, 12) });
	expect(() => ops.promote(cfg, "dbg", "active", false, false)).toThrow("chosen commits or a range");
	expect(ops.promote(cfg, "dbg", "active").status).toBe("active");
});

test("an automatic grade records its mode", async () => {
	const repo = makeRepo(tmp());
	history(repo, 12);
	const { cfg, check } = setup(repo);
	const g = await grading.grade(cfg, repo.path, check, ok(cfg));
	expect(g.record.selection).toEqual({ mode: "auto" });
	expect(g.record.excluded).toEqual([]);
	expect(grading.isHandPicked(g.record)).toBe(false);
	expect(grading.isHandPicked({ result: "pass" })).toBe(false); // records from before this field
});

test("low-confidence blocks are not counted as blocks", async () => {
	const repo = makeRepo(tmp());
	history(repo, 25);
	const { cfg, check } = setup(repo, { answers: { "*": { answer: 0.95, confidence: 0.3, findings: [], summary: "unsure" } } });
	const g = await grading.grade(cfg, repo.path, check, ok(cfg));
	expect(g.metrics.blocked).toBe(0);
	expect(g.metrics.low_confidence).toBe(20);
	expect(g.result).toBe("pass");
	expect(new Set(g.record.sample.map((s: { verdict: string; confidence: number }) => `${s.verdict}|${s.confidence}`))).toEqual(new Set(["warn|0.3"]));
});
