/** Grade a check against the project's own history before it may block pushes. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Backend } from "./backends/index.ts";
import { Check } from "./checks.ts";
import type { Config, Table } from "./config.ts";
import { buildContext, type Context, rangeMessages, rawDiff } from "./diffs.ts";
import * as g from "./git.ts";
import { matchAny } from "./globs.ts";
import type { Entry } from "./prompt.ts";
import { resolveRevRange } from "./pushrange.ts";
import { type EntryResult, execute } from "./runner.ts";
import { pyRepr, splitlines, words } from "./text.ts";

const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

export type UnitReason = "" | "top-score" | "random" | "all" | "selected" | "expect_fail";

/** One graded range of commits, reviewed as a whole like a push. */
export interface Unit {
	/** sha, or the empty tree for a root commit. */
	base: string;
	tip: string;
	/** Oldest first. */
	commits: string[];
	context: Context;
	score: number;
	reason: UnitReason;
}

export interface Grade {
	checkId: string;
	/** pass | fail | insufficient */
	result: string;
	metrics: Table;
	record: Table;
	path: string | null;
}

export class GradeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GradeError";
	}
}

export async function defaultBranch(cwd: string): Promise<string> {
	const out = await g.gitOk(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
	if (out) return out.trim();
	for (const name of ["main", "master"]) {
		if (await g.revParse(cwd, `refs/heads/${name}`)) return `refs/heads/${name}`;
	}
	return "HEAD";
}

function label(base: string, tip: string): string {
	return `${g.short(base)}..${g.short(tip)}`;
}

/** `<sha>..<sha>` with both ends shortened, for display. */
export function shortRange(rng: string): string {
	const at = rng.indexOf("..");
	return label(rng.slice(0, at), rng.slice(at + 2));
}

/** A candidate unit before filtering. */
interface Candidate {
	base: string;
	tip: string;
	commits: string[];
	raw: string;
	messages: string;
}

/**
 * One single-step range per first-parent commit of `branch`, newest first.
 *
 * A merge's step carries the diff it brought in against its first parent.
 */
async function history(cwd: string, branch: string, maxHistory: number): Promise<Candidate[]> {
	const out = await g.git(cwd, [
		"log",
		branch,
		"-n",
		String(maxHistory),
		"--first-parent",
		"--diff-merges=first-parent",
		"-p",
		"--no-color",
		"--no-ext-diff",
		"--find-renames",
		`--format=${RECORD_SEP}%H${FIELD_SEP}%P${FIELD_SEP}%B${FIELD_SEP}`,
	]);
	const units: Candidate[] = [];
	for (const rec of out.split(RECORD_SEP).slice(1)) {
		const parts = splitN(rec, FIELD_SEP, 3);
		if (parts.length === 4) {
			const sha = parts[0].trim();
			const parents = words(parts[1]);
			const base = parents.length ? parents[0] : g.EMPTY_TREE;
			units.push({ base, tip: sha, commits: [sha], raw: parts[3], messages: `${g.short(sha)}: ${parts[2].trim()}` });
		}
	}
	return units;
}

/** Python's `text.split(sep, maxsplit)`. */
function splitN(text: string, sep: string, maxsplit: number): string[] {
	const out: string[] = [];
	let rest = text;
	while (out.length < maxsplit) {
		const at = rest.indexOf(sep);
		if (at < 0) break;
		out.push(rest.slice(0, at));
		rest = rest.slice(at + sep.length);
	}
	out.push(rest);
	return out;
}

function addedLines(diff: string): string {
	return splitlines(diff)
		.filter((ln) => ln.startsWith("+") && !ln.startsWith("+++"))
		.map((ln) => ln.slice(1))
		.join("\n");
}

async function checkAddedIn(cwd: string, check: Check): Promise<string | null> {
	if (check.path === null) return null;
	const rel = relative(realpathSync(await g.repoRoot(cwd)), realpathSync(check.path));
	const out = await g.gitOk(cwd, ["log", "--diff-filter=A", "--format=%H", "--", rel]);
	const shas = out ? words(out) : [];
	return shas.length ? shas[shas.length - 1] : null;
}

/** A single commit as a one-commit range. */
async function commitCandidate(cwd: string, rev: string): Promise<Candidate> {
	const sha = await g.revParse(cwd, rev);
	if (!sha) throw new GradeError(`unknown commit ${pyRepr(rev)}`);
	const base = await g.firstParent(cwd, sha);
	return { base, tip: sha, commits: [sha], raw: await rawDiff(cwd, base, sha), messages: await rangeMessages(cwd, [sha]) };
}

/** `A..B` as one unit: the diff from merge-base(A, B) to B, with every commit's message. */
async function rangeCandidate(cwd: string, revRange: string): Promise<Candidate> {
	if (!revRange.includes("..")) throw new GradeError(`range must look like A..B, got ${pyRepr(revRange)}`);
	let push;
	try {
		push = await resolveRevRange(cwd, revRange);
	} catch (e) {
		if (e instanceof g.GitError) throw new GradeError(e.message);
		throw e;
	}
	if (!push.refs.length) {
		const tip = (await g.revParse(cwd, revRange.slice(revRange.indexOf("..") + 2) || "HEAD")) ?? "";
		return { base: tip, tip, commits: [], raw: "", messages: "" };
	}
	const ref = push.refs[0];
	return {
		base: ref.base,
		tip: ref.tip,
		commits: push.commits,
		raw: await rawDiff(cwd, ref.base, ref.tip),
		messages: await rangeMessages(cwd, push.commits),
	};
}

function candidate(cwd: string, rev: string): Promise<Candidate> {
	return rev.includes("..") ? rangeCandidate(cwd, rev) : commitCandidate(cwd, rev);
}

/** Python's `str.count(sub)`. */
function countOf(text: string, sub: string): number {
	return sub ? text.split(sub).length - 1 : text.length + 1;
}

/**
 * A deterministic choice of `k` items, seeded by a string, so a grade picks the same sample for the
 * same check and HEAD. (The Python version used `random.Random(seed).sample`; the picks differ.)
 */
function seededSample<T>(items: T[], k: number, seed: string): T[] {
	const pool = [...items];
	const out: T[] = [];
	for (let i = 0; i < k && pool.length; i++) {
		const digest = createHash("sha256").update(`${seed}:${i}`).digest();
		const j = digest.readUInt32BE(0) % pool.length;
		out.push(pool.splice(j, 1)[0]);
	}
	return out;
}

export interface Sample {
	units: Unit[];
	/** Eligible pool size. */
	poolSize: number;
	/** `{range, commits, reason}` for explicit selections. */
	excluded: Table[];
}

/**
 * Pick the ranges to grade the check on.
 *
 * By default, ~sample_size single-commit steps relevant to the check are sampled from the default
 * branch's first-parent history. `commits` grades each listed commit as a one-commit range; `ranges`
 * grades each `A..B` as one unit, like a push of those commits.
 */
export async function selectSample(
	cfg: Config,
	cwd: string,
	check: Check,
	commits: string[] | null = null,
	ranges: string[] | null = null,
): Promise<Sample> {
	if (commits?.length && ranges?.length) throw new GradeError("pass either commits or ranges, not both");
	const gr = cfg.grading;
	const excludes: string[] = cfg.run.exclude_globs;
	const addedIn = await checkAddedIn(cwd, check);
	const expectFail: string[] = [...(check.grading.expect_fail ?? [])];
	const knownBad = new Set(expectFail.filter((e) => !e.includes("..")).map((e) => e.toLowerCase()));
	const terms: string[] = check.grading.terms ?? [];
	const explicit = Boolean(commits?.length || ranges?.length);

	const candidates: Candidate[] = [];
	if (commits?.length) for (const c of commits) candidates.push(await commitCandidate(cwd, c));
	else if (ranges?.length) for (const r of ranges) candidates.push(await rangeCandidate(cwd, r));
	else candidates.push(...(await history(cwd, await defaultBranch(cwd), gr.max_history)));

	const pool: Unit[] = [];
	const excluded: Table[] = [];
	const seen = new Set<string>();
	for (const { base, tip, commits: shas, raw, messages } of candidates) {
		const id = `${base}..${tip}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const ctx = buildContext(label(base, tip), raw, messages, excludes, shas.length === 1 ? shas[0] : null);
		const matching = ctx.files.filter((f) => matchAny(f, check.appliesTo));
		let reason = "";
		if (!shas.length) reason = "no commits in range";
		else if (shas.some((s) => [...knownBad].some((e) => s.startsWith(e)))) reason = "holds an expect_fail commit (graded separately)";
		else if (addedIn !== null && shas.includes(addedIn)) reason = "holds the commit that added the check file";
		else if (!ctx.diff.trim()) reason = "empty diff after excludes";
		else if (ctx.secretHits.some((h) => h.severity === "block")) reason = "secret scan hit (never sent to a model)";
		else if (!matching.length) reason = "no changed path matches applies_to";
		if (reason) {
			excluded.push({ range: id, commits: shas, reason });
			continue;
		}
		const text = `${addedLines(ctx.diff)}\n${messages}`;
		const score = matching.length + 3 * terms.reduce((sum, t) => sum + countOf(text, t), 0);
		pool.push({ base, tip, commits: shas, context: ctx, score, reason: "" });
	}

	const size: number = gr.sample_size;
	let chosen: Unit[];
	if (explicit) {
		chosen = pool;
		for (const u of chosen) u.reason = "selected";
	} else if (pool.length <= size) {
		chosen = pool;
		for (const u of chosen) u.reason = "all";
	} else {
		const topN = Math.floor(size / 2);
		const ranked = [...pool].sort((a, b) => b.score - a.score); // stable: newest first among ties
		const top = ranked.slice(0, topN);
		for (const u of top) u.reason = "top-score";
		const rest = ranked.slice(topN);
		const head = (await g.revParse(cwd, "HEAD")) ?? "";
		const rand = seededSample(rest, size - topN, `${check.id}:${head}`);
		for (const u of rand) u.reason = "random";
		chosen = [...top, ...rand];
	}

	for (const e of expectFail) {
		let c: Candidate;
		try {
			c = await candidate(cwd, e);
		} catch (err) {
			if (err instanceof GradeError) continue;
			throw err;
		}
		if (!c.commits.length || chosen.some((u) => u.base === c.base && u.tip === c.tip)) continue;
		const ctx = buildContext(label(c.base, c.tip), c.raw, c.messages, excludes);
		chosen.push({ base: c.base, tip: c.tip, commits: c.commits, context: ctx, score: 0, reason: "expect_fail" });
	}
	return { units: chosen, poolSize: pool.length, excluded: explicit ? excluded : [] };
}

/** Python's `round(x, n)` for the rates in a grade record. */
function round(x: number, n: number): number {
	const f = 10 ** n;
	return Math.round(x * f) / f;
}

function utcStamp(): string {
	return `${new Date().toISOString().slice(0, 19)}Z`;
}

export async function grade(
	cfg: Config,
	cwd: string,
	check: Check,
	backend: Backend,
	sampleSize: number | null = null,
	commits: string[] | null = null,
	ranges: string[] | null = null,
): Promise<Grade> {
	if (sampleSize) cfg.grading.sample_size = sampleSize;
	const gr = cfg.grading;
	const { units, poolSize, excluded } = await selectSample(cfg, cwd, check, commits, ranges);
	// Grade the check as if active so would-be blocks are visible.
	const graded = new Check({ ...check, status: "active" });

	const key = (u: Unit): string => `${check.id}@${u.context.label}`;
	const entries: Entry[] = units.map((u) => ({ key: key(u), check: graded, context: u.context }));
	const first = await execute(entries, backend, cfg);
	let calls = first.calls;
	const byKey = new Map(first.results.map((r) => [r.key, r]));
	const result = (u: Unit): EntryResult => byKey.get(key(u)) as EntryResult;

	const rerunEntries = entries.filter((e) => {
		const r = byKey.get(e.key) as EntryResult;
		return (r.verdict === "warn" || r.verdict === "block") && !r.error;
	});
	const rerun = await execute(rerunEntries, backend, cfg);
	calls += rerun.calls;
	const rerunByKey = new Map(rerun.results.map((r) => [r.key, r]));

	const historyUnits = units.filter((u) => u.reason !== "expect_fail");
	const known = units.filter((u) => u.reason === "expect_fail");
	const n = historyUnits.length;

	const blocked = historyUnits.filter((u) => result(u).verdict === "block");
	const errored = units.filter((u) => result(u).error);
	const unstable = units.filter((u) => rerunByKey.has(key(u)) && rerunByKey.get(key(u))?.verdict !== result(u).verdict);
	const caught = known.filter((u) => result(u).verdict === "block");
	const unsure = units.filter((u) => result(u).lowConfidence);

	const metrics: Table = {
		sample_size: n,
		pool_size: poolSize,
		block_rate: n ? round(blocked.length / n, 3) : 0.0,
		blocked: blocked.length,
		error_rate: units.length ? round(errored.length / units.length, 3) : 0.0,
		errors: errored.length,
		unstable: unstable.length,
		low_confidence: unsure.length,
		catch_rate: known.length ? round(caught.length / known.length, 3) : null,
		calls,
	};
	let outcome: string;
	if (n < gr.min_sample) {
		outcome = "insufficient";
	} else if (
		metrics.block_rate <= gr.max_block_rate &&
		!errored.length &&
		unstable.length <= gr.max_unstable &&
		(!known.length || caught.length === known.length)
	) {
		outcome = "pass";
	} else {
		outcome = "fail";
	}

	const bars: Table = {};
	for (const k of ["min_sample", "max_block_rate", "max_unstable", "sample_size"]) bars[k] = gr[k];
	const record: Table = {
		check_id: check.id,
		check_sha256: check.contentHash,
		graded_at: utcStamp(),
		head: await g.revParse(cwd, "HEAD"),
		backend: backend.name,
		model: backend.model,
		selection: selectionRecord(commits, ranges),
		excluded,
		bars,
		metrics,
		result: outcome,
		sample: units.map((u) => {
			const r = result(u);
			return {
				range: `${u.base}..${u.tip}`,
				commits: u.commits,
				reason: u.reason,
				score: u.score,
				answer: r.answer ?? null,
				confidence: r.confidence,
				verdict: r.verdict,
				rerun_verdict: rerunByKey.get(key(u))?.verdict ?? null,
				summary: r.summary,
				findings: r.findings,
				...(r.error ? { error: r.error } : {}),
			};
		}),
	};
	const path = join(cfg.gradesDir, `${check.id}.json`);
	mkdirSync(cfg.gradesDir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
	return { checkId: check.id, result: outcome, metrics, record, path };
}

export function selectionRecord(commits: string[] | null, ranges: string[] | null): Table {
	if (commits?.length) return { mode: "commits", commits: [...commits] };
	if (ranges?.length) return { mode: "ranges", ranges: [...ranges] };
	return { mode: "auto" };
}

/** Grades on chosen commits or ranges; older records without the field were automatic. */
export function isHandPicked(record: Table): boolean {
	return (record.selection?.mode ?? "auto") !== "auto";
}

export function loadGrade(cfg: Config, checkId: string): Table | null {
	const path = join(cfg.gradesDir, `${checkId}.json`);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** none | pass | fail | insufficient | stale (graded, but the check changed since). */
export function gradeStatus(cfg: Config, check: Check): string {
	const rec = loadGrade(cfg, check.id);
	if (rec === null) return "none";
	if (rec.check_sha256 !== check.contentHash) return "stale";
	return rec.result ?? "none";
}

export function clearGrade(cfg: Config, checkId: string): void {
	rmSync(join(cfg.gradesDir, `${checkId}.json`), { force: true });
}
