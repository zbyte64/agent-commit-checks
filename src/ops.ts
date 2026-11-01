/** Operations shared by the CLI, the MCP server and the agent extensions. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { getBackend } from "./backends/index.ts";
import { type Check, CheckError, dumpCheck, loadAll, loadFile, parseTomlTable, parseText, setStatus, validateDict } from "./checks.ts";
import { type Config, loadConfig, type Table } from "./config.ts";
import * as g from "./git.ts";
import { clearGrade, gradeStatus, isHandPicked, loadGrade } from "./grading.ts";
import { resolveRevRange } from "./pushrange.ts";
import { type RunResult, review, selectChecks, UnknownCheckError } from "./runner.ts";
import { pyRepr } from "./text.ts";

export class OpError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OpError";
	}
}

export async function project(cwd: string): Promise<{ root: string; cfg: Config }> {
	let root: string;
	try {
		root = await g.repoRoot(cwd);
	} catch (e) {
		if (e instanceof g.GitError) throw new OpError(`not inside a git repository: ${cwd}`);
		throw e;
	}
	return { root, cfg: loadConfig(root) };
}

export function listChecks(cfg: Config, status: string | null = null): Table[] {
	const { checks, errors } = loadAll(cfg.checksDir);
	const rows: Table[] = [];
	for (const c of checks) {
		if (status && c.status !== status) continue;
		rows.push({
			id: c.id,
			title: c.title,
			type: c.questionType,
			status: c.status,
			enabled: c.enabled,
			author: c.author,
			grade: gradeStatus(cfg, c),
		});
	}
	for (const [name, errs] of Object.entries(errors)) {
		if (!status) rows.push({ id: parse(name).name, invalid: true, errors: errs });
	}
	return rows;
}

export function getCheck(cfg: Config, checkId: string): Check {
	const path = join(cfg.checksDir, `${checkId}.toml`);
	if (!existsSync(path)) throw new OpError(`no check named ${pyRepr(checkId)}`);
	return loadFile(path);
}

export interface RunOptions {
	ids?: string[] | null;
	revRange?: string;
	includeProposed?: boolean;
	extra?: Check[] | null;
	backendName?: string | null;
}

export async function run(cfg: Config, cwd: string, agent: string, opts: RunOptions = {}): Promise<RunResult> {
	const { checks } = loadAll(cfg.checksDir);
	let selected: Check[];
	if (opts.extra) {
		selected = opts.extra;
	} else {
		try {
			selected = selectChecks(checks, opts.ids ?? null, false, opts.includeProposed ?? false);
		} catch (e) {
			if (e instanceof UnknownCheckError) throw new OpError(e.message);
			throw e;
		}
	}
	const push = await resolveRevRange(cwd, opts.revRange ?? "unpushed");
	return review(cfg, cwd, push, selected, getBackend(cfg, agent, opts.backendName ?? null));
}

/** Accept a check spec as a table or TOML text; validate it like `acc validate`. */
export function specToCheck(spec: Table | string, opts: { author?: string | null; status?: string | null } = {}): Check {
	const d: Table = typeof spec === "string" ? parseTomlTable(spec) : { ...spec };
	if (opts.author) d.author = opts.author;
	if (opts.status) d.status = opts.status;
	const errs = validateDict(d);
	if (errs.length) throw new CheckError(errs);
	return parseText(dumpCheck(d), d.id);
}

export function addCheck(cfg: Config, spec: Table | string): string {
	const check = specToCheck(spec, { author: "agent", status: "proposed" });
	const path = join(cfg.checksDir, `${check.id}.toml`);
	if (existsSync(path)) throw new OpError(`a check named ${pyRepr(check.id)} already exists; use update_check`);
	mkdirSync(cfg.checksDir, { recursive: true });
	writeFileSync(path, dumpCheck(check.toDict()));
	return path;
}

export function updateCheck(cfg: Config, checkId: string, spec: Table | string): string {
	const current = getCheck(cfg, checkId);
	if (current.author === "user") throw new OpError(`${pyRepr(checkId)} was written by the user; agents may not update it`);
	const fresh = specToCheck(spec, { author: "agent", status: current.status });
	if (fresh.id !== checkId) throw new OpError("the spec id must match the check being updated");
	// An edited check can no longer block until it is graded again.
	if (fresh.status === "active") fresh.status = "advisory";
	const path = current.path as string;
	writeFileSync(path, dumpCheck(fresh.toDict()));
	clearGrade(cfg, checkId);
	return path;
}

const PROMOTE_HINTS: Record<string, string> = {
	none: "it has no grade; run grade_check first",
	stale: "the check changed since it was graded; grade it again",
	fail: "its grade failed",
	insufficient: "its grade had too few ranges",
};

/**
 * `allowHandPicked = false` (the agent's path) refuses grades on chosen commits or ranges, so an agent
 * cannot pick easy commits to pass its own check.
 */
export function promote(cfg: Config, checkId: string, to: string, force = false, allowHandPicked = true): Table {
	if (to !== "advisory" && to !== "active") throw new OpError("promotion target must be 'advisory' or 'active'");
	const check = getCheck(cfg, checkId);
	if (to === "active" && !force) {
		const status = gradeStatus(cfg, check);
		if (status !== "pass") {
			throw new OpError(`cannot promote ${pyRepr(checkId)} to active: ${PROMOTE_HINTS[status] ?? status}`);
		}
		const record = loadGrade(cfg, checkId) ?? {};
		if (!allowHandPicked && isHandPicked(record)) {
			throw new OpError(
				`cannot promote ${pyRepr(checkId)} to active: its grade used chosen commits or a range; ` +
					"run grade_check without commits or range, or ask the user to run `acc promote`",
			);
		}
	}
	const { oldLine, newLine } = setStatus(check.path as string, to);
	return { path: check.path, old_line: oldLine, new_line: newLine, status: to };
}
