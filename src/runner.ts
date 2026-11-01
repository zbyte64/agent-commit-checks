/** The review pipeline shared by `acc gate`, `acc run`, grading and the MCP server. */
import { createHash } from "node:crypto";
import { type Backend, BackendError } from "./backends/index.ts";
import { AnswerError, type Check, describeAnswer, type Finding, validateEntry, type Verdict, worst } from "./checks.ts";
import type { Config, Table } from "./config.ts";
import { type Context, commitContext, rangeContext } from "./diffs.ts";
import { matchAny } from "./globs.ts";
import { build, type Entry, SYSTEM } from "./prompt.ts";
import type { PushRange } from "./pushrange.ts";
import type { SecretHit } from "./secrets.ts";

export interface EntryResult {
	checkId: string;
	key: string;
	/** Check status at run time. */
	status: string;
	/** What the verdict table says. */
	rawVerdict: string;
	/** After advisory demotion and error handling. */
	verdict: Verdict;
	answer: unknown;
	answerText: string;
	confidence: number | null;
	/** A block below run.min_block_confidence, reported as a warning. */
	lowConfidence: boolean;
	findings: Finding[];
	summary: string;
	error: string;
	truncated: boolean;
}

export function entryToDict(e: EntryResult): Table {
	return {
		check_id: e.checkId,
		key: e.key,
		status: e.status,
		raw_verdict: e.rawVerdict,
		verdict: e.verdict,
		answer: e.answer ?? null,
		answer_text: e.answerText,
		confidence: e.confidence,
		low_confidence: e.lowConfidence,
		findings: e.findings,
		summary: e.summary,
		error: e.error,
		truncated: e.truncated,
	};
}

export class RunResult {
	verdict: Verdict = "pass";
	entries: EntryResult[] = [];
	secretHits: SecretHit[] = [];
	/** Block-severity hits stopped the run before any model call. */
	secretBlocked = false;
	notes: string[] = [];
	range = "";
	commits: string[] = [];
	calls = 0;
	truncated = false;
	diffSha256 = "";
	diffChars = 0;
	skippedFiles: string[] = [];
	/** Checks with no matching paths. */
	checksSkipped: string[] = [];
	backend = "";
	model = "";
	latencyMs = 0;

	toDict(): Table {
		return {
			verdict: this.verdict,
			entries: this.entries.map(entryToDict),
			secret_hits: this.secretHits.map((h) => ({ pattern: h.pattern, severity: h.severity, file: h.file, line: h.line, commit: h.commit })),
			secret_blocked: this.secretBlocked,
			notes: this.notes,
			range: this.range,
			commits: this.commits,
			calls: this.calls,
			truncated: this.truncated,
			diff_sha256: this.diffSha256,
			diff_chars: this.diffChars,
			skipped_files: this.skippedFiles,
			checks_skipped: this.checksSkipped,
			backend: this.backend,
			model: this.model,
			latency_ms: this.latencyMs,
		};
	}
}

/** Only `active` checks can block; others report a would-be block as a warning. */
export function demote(check: Check, verdict: string): Verdict {
	return (verdict === "block" && !check.canBlock ? "warn" : verdict) as Verdict;
}

/** A block the model is not confident about is reported as a warning instead. */
export function isUnsure(verdict: string, confidence: number, cfg: Config): boolean {
	return verdict === "block" && confidence < cfg.run.min_block_confidence;
}

// ── executing entries ────────────────────────────────────────────────────────

/** `fn` over `items` with at most `limit` running at once; results keep the input order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
	return out;
}

/**
 * Group entries into calls of up to `size` checks, never mixing data blocks.
 *
 * Several ranges in one prompt make each answer depend on its neighbours: the same commit was judged
 * differently depending on which commits shared the call. Checks about the same range still share a call.
 */
function batches(entries: Entry[], size: number): Entry[][] {
	const byBlock = new Map<string, Entry[]>();
	const sorted = [...entries].sort((a, b) =>
		a.context.label === b.context.label ? cmp(a.check.id, b.check.id) : cmp(a.context.label, b.context.label),
	);
	for (const e of sorted) {
		const group = byBlock.get(e.context.label) ?? [];
		group.push(e);
		byBlock.set(e.context.label, group);
	}
	const step = Math.max(1, size);
	const out: Entry[][] = [];
	for (const group of byBlock.values()) for (let i = 0; i < group.length; i += step) out.push(group.slice(i, i + step));
	return out;
}

/** Python's string ordering (by code point). */
function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

interface AskResult {
	answers: Table | null;
	error: string;
	retryable: boolean;
	truncated: Record<string, boolean>;
}

async function ask(backend: Backend, batch: Entry[], cfg: Config): Promise<AskResult> {
	const { prompt, stdin, schema, truncated } = build(batch, cfg.run.max_diff_chars);
	const timeout = Number(cfg.run.timeout_seconds);
	try {
		// A classifier reads the checks, not the JSON prompt.
		const out = backend.decide ? await backend.decide(batch, stdin, timeout) : await backend.ask(SYSTEM, prompt, stdin, schema, timeout);
		return { answers: out.checks ?? {}, error: "", retryable: false, truncated };
	} catch (e) {
		if (!(e instanceof BackendError)) throw e;
		return { answers: null, error: e.message, retryable: e.retryable, truncated };
	}
}

/** Run entries in batched, parallel calls. Missing or invalid entries are retried alone once. */
export async function execute(entries: Entry[], backend: Backend, cfg: Config): Promise<{ results: EntryResult[]; calls: number }> {
	if (!entries.length) return { results: [], calls: 0 };
	const onError: string = cfg.run.on_backend_error;
	const results = new Map<string, EntryResult>();
	let calls = 0;

	const settle = (e: Entry, raw: unknown, err: string, truncated: boolean): EntryResult | null => {
		const c = e.check;
		const base = {
			checkId: c.id,
			key: e.key,
			status: c.status,
			truncated,
			answer: null,
			answerText: "",
			confidence: null,
			lowConfidence: false,
			findings: [],
			summary: "",
			error: "",
		};
		if (err) return { ...base, rawVerdict: onError, verdict: demote(c, onError), error: err };
		if (raw === undefined || raw === null) return null;
		let validated;
		try {
			validated = validateEntry(c, raw);
		} catch (ex) {
			if (!(ex instanceof AnswerError)) throw ex;
			return { ...base, rawVerdict: onError, verdict: demote(c, onError), error: `invalid answer: ${ex.message}` };
		}
		const { verdict, findings, summary, confidence } = validated;
		const answer = (raw as Table).answer;
		const unsure = isUnsure(verdict, confidence, cfg);
		return {
			...base,
			rawVerdict: verdict,
			verdict: demote(c, unsure ? "warn" : verdict),
			answer,
			answerText: describeAnswer(c, answer),
			confidence,
			lowConfidence: unsure,
			findings,
			summary,
		};
	};

	const runBatch = async (batch: Entry[]): Promise<{ done: EntryResult[]; retry: Entry[] }> => {
		const { answers, error, retryable, truncated } = await ask(backend, batch, cfg);
		const done: EntryResult[] = [];
		const retry: Entry[] = [];
		for (const e of batch) {
			const tr = truncated[e.context.label] ?? false;
			if (answers === null) {
				if (retryable) retry.push(e);
				else done.push(settle(e, null, error, tr) as EntryResult);
				continue;
			}
			const r = settle(e, answers[e.key], "", tr);
			if (r === null || r.error) retry.push(e);
			else done.push(r);
		}
		return { done, retry };
	};

	const runAlone = async (e: Entry): Promise<EntryResult> => {
		const { answers, error, truncated } = await ask(backend, [e], cfg);
		const tr = truncated[e.context.label] ?? false;
		if (answers === null) return settle(e, null, error, tr) as EntryResult;
		const r = settle(e, answers[e.key], "", tr);
		return r ?? (settle(e, null, "no answer for this check after retry", tr) as EntryResult);
	};

	const parallel = Number(cfg.run.parallel);
	const retries: Entry[] = [];
	for (const { done, retry } of await mapPool(batches(entries, cfg.run.max_checks_per_call), parallel, runBatch)) {
		calls += 1;
		for (const r of done) results.set(r.key, r);
		retries.push(...retry);
	}
	for (const r of await mapPool(retries, parallel, runAlone)) {
		calls += 1;
		results.set(r.key, r);
	}
	return { results: entries.map((e) => results.get(e.key) as EntryResult), calls };
}

// ── the review pipeline ──────────────────────────────────────────────────────

/** An unknown id in an explicit check selection. */
export class UnknownCheckError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnknownCheckError";
	}
}

export function selectChecks(checks: Check[], ids: string[] | null, gate: boolean, includeProposed = false): Check[] {
	if (ids?.length) {
		const byId = new Map(checks.map((c) => [c.id, c]));
		const missing = ids.filter((i) => !byId.has(i));
		if (missing.length) throw new UnknownCheckError(`unknown check id(s): ${missing.join(", ")}`);
		return ids.map((i) => byId.get(i) as Check);
	}
	if (gate) return checks.filter((c) => c.runsInGate);
	return checks.filter((c) => c.enabled && (includeProposed || c.status !== "proposed"));
}

export async function review(cfg: Config, cwd: string, push: PushRange, checks: Check[], backend: Backend): Promise<RunResult> {
	const started = performance.now();
	const elapsed = (): number => Math.floor(performance.now() - started);
	const res = new RunResult();
	res.range = push.description;
	res.commits = [...push.commits];
	res.backend = backend.name;
	res.model = backend.model;
	if (push.note) res.notes.push(push.note);
	if (push.empty) {
		res.latencyMs = elapsed();
		return res;
	}

	const excludes: string[] = cfg.run.exclude_globs;
	const scan = Boolean(cfg.run.secret_scan);
	// Secrets are scanned per commit: one added and then removed is still in the pushed history.
	const commitCtx: Context[] = [];
	for (const sha of push.commits) commitCtx.push(await commitContext(cwd, sha, excludes, scan));
	const rangeCtx = await rangeContext(
		cwd,
		push.refs.map((r) => [r.name, r.base, r.tip]),
		push.commits,
		excludes,
		scan,
	);

	const hits = commitCtx.flatMap((ctx) => ctx.secretHits.filter((h) => h.severity === "block"));
	if (hits.length) {
		res.secretHits = hits;
		res.secretBlocked = true;
		res.verdict = "block";
		res.notes.push("The local secret scan found likely secrets; nothing was sent to a model.");
		res.latencyMs = elapsed();
		return res;
	}
	const warnHits = commitCtx.flatMap((ctx) => ctx.secretHits);
	if (warnHits.length) {
		res.secretHits = warnHits;
		res.notes.push("Lines matching a secret pattern were redacted before review.");
	}

	res.diffSha256 = createHash("sha256").update(rangeCtx.diff, "utf8").digest("hex");
	res.diffChars = rangeCtx.diff.length;
	res.skippedFiles = rangeCtx.skipped;

	// Each check sees the whole push at once: the combined diff and every commit message.
	const entries: Entry[] = [];
	for (const c of checks) {
		if (rangeCtx.files.some((f) => matchAny(f, c.appliesTo))) entries.push({ key: c.id, check: c, context: rangeCtx });
		else res.checksSkipped.push(c.id);
	}

	const { results, calls } = await execute(entries, backend, cfg);
	res.entries = results;
	res.calls = calls;
	res.truncated = res.entries.some((e) => e.truncated);
	if (res.truncated) res.notes.push(`Some diffs were truncated to ${cfg.run.max_diff_chars} characters.`);
	res.verdict = worst(res.entries.map((e) => e.verdict));
	res.latencyMs = elapsed();
	return res;
}
