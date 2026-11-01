/**
 * The check tools agents use: list, get, run, test, grade, add, update and promote checks.
 *
 * One definition serves the stdio MCP server (`acc mcp`, for Claude Code) and the omp and pi
 * extensions, which register the same tools natively. The tool list is fixed, so a check file added
 * during a session is usable at once.
 */
import { getBackend } from "./backends/index.ts";
import { BackendError } from "./backends/base.ts";
import { CheckError } from "./checks.ts";
import { type Config, ConfigError, type Table } from "./config.ts";
import { formatResult } from "./gate.ts";
import { GitError } from "./git.ts";
import { GradeError, grade, shortRange } from "./grading.ts";
import * as ops from "./ops.ts";
import type { RunResult } from "./runner.ts";

export const INSTRUCTIONS = `Checks are model-backed reviews of commits, stored as TOML files in .acc/checks/.
\`advisory\` and \`active\` checks run automatically before every \`git push\`; only \`active\`
checks can block. To add a check: draft a spec, try it with test_check, save it with
add_check (it starts as \`proposed\`), then grade_check it against history and report the
result before promote_check moves it to \`advisory\` or \`active\`.`;

const SPEC_HELP =
	"Check spec as a JSON object or TOML text with the check file fields: id, title, " +
	"applies_to (globs), inputs (diff|message|file_list), " +
	"question {type: bool|choice|score, instructions, labels | levels}, verdict, and optional " +
	"grading {terms, expect_fail}. A check answers once about all the pushed commits together " +
	"(their combined diff and every message). For bool checks `answer` is the probability that " +
	"the question's answer is yes, so phrase the question so that yes means a problem.";

/** A tool failure the caller should see as an error result, not a crash. */
export class ToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolError";
	}
}

export interface ToolResult {
	/** Human-readable result, shown to the model. */
	text: string;
	/** The same result as structured data. */
	data: Table;
}

export interface ToolEnv {
	/** Agent whose backend runs model calls: "claude", "omp" or "pi". */
	agent: string;
	/** Directory the tools run in (the project). */
	cwd: string;
}

export interface ToolDef {
	name: string;
	description: string;
	/** JSON Schema of the arguments. */
	inputSchema: Table;
	run(args: Table, env: ToolEnv): Promise<ToolResult>;
}

const EXPECTED = [ops.OpError, CheckError, BackendError, GitError, ConfigError, GradeError];

/** Expected failures (bad ids, invalid specs, backend errors...) become ToolErrors. */
async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		if (EXPECTED.some((cls) => e instanceof cls)) throw new ToolError((e as Error).message);
		throw e;
	}
}

function project(env: ToolEnv): Promise<{ root: string; cfg: Config }> {
	return guarded(() => ops.project(env.cwd));
}

function runPayload(res: RunResult): Table {
	return {
		verdict: res.verdict,
		range: res.range,
		commits: res.commits.map((c) => c.slice(0, 7)),
		entries: res.entries.map((e) => ({
			check: e.checkId,
			status: e.status,
			answer: e.answer ?? null,
			confidence: e.confidence,
			low_confidence: e.lowConfidence,
			verdict: e.verdict,
			raw_verdict: e.rawVerdict,
			summary: e.summary,
			findings: e.findings,
			...(e.error ? { error: e.error } : {}),
		})),
		secret_hits: res.secretHits.map((h) => ({
			commit: (h.commit ?? "").slice(0, 7),
			file: h.file,
			line: h.line,
			pattern: h.pattern,
			severity: h.severity,
		})),
		checks_skipped_no_matching_paths: res.checksSkipped,
		notes: res.notes,
		calls: res.calls,
	};
}

function runText(res: RunResult): string {
	if (!res.commits.length) return `No commits to review in ${res.range || "the range"}.`;
	if (res.verdict === "pass") {
		const ran = [...new Set(res.entries.map((e) => e.checkId))].sort();
		return `pass: ${res.commits.length} commit(s), checks run: ${ran.join(", ") || "none matched"}.`;
	}
	return formatResult(res);
}

function percent(x: number): string {
	return `${Math.round(x * 100)}%`;
}

const SPEC_SCHEMA = { anyOf: [{ type: "object", additionalProperties: true }, { type: "string" }] };
const STRING_LIST = { type: "array", items: { type: "string" } };

function str(v: unknown, name: string): string {
	if (typeof v !== "string") throw new ToolError(`${name} must be a string`);
	return v;
}

function strList(v: unknown, name: string): string[] | null {
	if (v === undefined || v === null) return null;
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ToolError(`${name} must be a list of strings`);
	return v;
}

function spec(v: unknown): Table | string {
	if (typeof v === "string" || (typeof v === "object" && v !== null && !Array.isArray(v))) return v as Table | string;
	throw new ToolError("spec must be a JSON object or TOML text");
}

export const TOOLS: ToolDef[] = [
	{
		name: "list_checks",
		description: "List checks with id, title, type, status, author and grade result.",
		inputSchema: { type: "object", properties: { status: { type: "string", enum: ["proposed", "advisory", "active"] } } },
		async run(args, env) {
			const { cfg } = await project(env);
			const rows = ops.listChecks(cfg, (args.status as string | undefined) ?? null);
			const lines = rows.map((r) =>
				r.invalid
					? `${r.id}: INVALID (${r.errors.join("; ")})`
					: `${r.id} [${r.status}, ${r.type}, by ${r.author}, grade ${r.grade}]: ${r.title}`,
			);
			return { text: lines.join("\n") || "No checks defined.", data: { checks: rows } };
		},
	},
	{
		name: "get_check",
		description: "Return a check's TOML text.",
		inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
		async run(args, env) {
			const { cfg } = await project(env);
			const id = str(args.id, "id");
			const check = await guarded(() => ops.getCheck(cfg, id));
			return { text: check.text, data: { id, path: check.path, toml: check.text } };
		},
	},
	{
		name: "run_checks",
		description:
			"Run checks against the unpushed commits (default) or a rev range like main..HEAD.\n\n" +
			"With no ids, runs every enabled advisory and active check (plus proposed ones if\n" +
			"include_proposed). Proposed checks run when named in ids.",
		inputSchema: {
			type: "object",
			properties: {
				ids: STRING_LIST,
				range: { type: "string", default: "unpushed" },
				include_proposed: { type: "boolean", default: false },
			},
		},
		async run(args, env) {
			const { cfg } = await project(env);
			const res = await guarded(() =>
				ops.run(cfg, env.cwd, env.agent, {
					ids: strList(args.ids, "ids"),
					revRange: (args.range as string | undefined) ?? "unpushed",
					includeProposed: Boolean(args.include_proposed),
				}),
			);
			return { text: runText(res), data: runPayload(res) };
		},
	},
	{
		name: "test_check",
		description: `Run an unsaved check spec against a range, as if it were active. ${SPEC_HELP}`,
		inputSchema: {
			type: "object",
			properties: { spec: SPEC_SCHEMA, range: { type: "string", default: "unpushed" } },
			required: ["spec"],
		},
		async run(args, env) {
			const { cfg } = await project(env);
			const res = await guarded(() => {
				const check = ops.specToCheck(spec(args.spec), { status: "active" });
				return ops.run(cfg, env.cwd, env.agent, { revRange: (args.range as string | undefined) ?? "unpushed", extra: [check] });
			});
			return { text: runText(res), data: runPayload(res) };
		},
	},
	{
		name: "grade_check",
		description:
			"Grade a check against ~20 relevant commits from history and write .acc/grades/<id>.json.\n\n" +
			"Each unit is reviewed as a range, like a push. History units are single first-parent\n" +
			"commits. Optionally grade each of `commits` on its own, or each `ranges` entry (A..B)\n" +
			"as one unit; not both. Grades on chosen commits or ranges are useful for testing, but\n" +
			"promote_check only accepts an automatic grade for `active`.\n" +
			"Report the block rate and any ranges it would block to the user.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" }, sample_size: { type: "integer" }, commits: STRING_LIST, ranges: STRING_LIST },
			required: ["id"],
		},
		async run(args, env) {
			const { root, cfg } = await project(env);
			const id = str(args.id, "id");
			const g = await guarded(() => {
				const check = ops.getCheck(cfg, id);
				const sampleSize = typeof args.sample_size === "number" ? args.sample_size : null;
				return grade(cfg, root, check, getBackend(cfg, env.agent), sampleSize, strList(args.commits, "commits"), strList(args.ranges, "ranges"));
			});
			const m = g.metrics;
			const lines = [
				`Grade for ${id}: ${g.result}`,
				`sample ${m.sample_size} of ${m.pool_size} eligible ranges; block rate ` +
					`${percent(m.block_rate)} (${m.blocked}); low-confidence blocks warned ${m.low_confidence}; ` +
					`errors ${m.errors}; unstable ${m.unstable}` +
					(m.catch_rate !== null ? `; catch rate ${percent(m.catch_rate)}` : ""),
			];
			for (const s of g.record.sample) {
				if (s.verdict === "block") lines.push(`would block ${shortRange(s.range)} (${s.reason}): ${s.summary}`);
			}
			for (const x of g.record.excluded) lines.push(`skipped ${shortRange(x.range)}: ${x.reason}`);
			lines.push(`wrote ${g.path}`);
			return { text: lines.join("\n"), data: { ...g.record, path: g.path } };
		},
	},
	{
		name: "add_check",
		description: `Validate and save a new check as author=agent, status=proposed. ${SPEC_HELP}`,
		inputSchema: { type: "object", properties: { spec: SPEC_SCHEMA }, required: ["spec"] },
		async run(args, env) {
			const { cfg } = await project(env);
			const path = await guarded(() => ops.addCheck(cfg, spec(args.spec)));
			return { text: `wrote ${path} (status proposed)`, data: { path, status: "proposed" } };
		},
	},
	{
		name: "update_check",
		description:
			"Replace an agent-authored check with a new full spec. Refused for checks " +
			`written by the user. Clears the grade; an active check drops to advisory. ${SPEC_HELP}`,
		inputSchema: { type: "object", properties: { id: { type: "string" }, spec: SPEC_SCHEMA }, required: ["id", "spec"] },
		async run(args, env) {
			const { cfg } = await project(env);
			const path = await guarded(() => ops.updateCheck(cfg, str(args.id, "id"), spec(args.spec)));
			return { text: `wrote ${path}; grade cleared`, data: { path } };
		},
	},
	{
		name: "promote_check",
		description:
			"Change a check's status. `active` needs a passing automatic grade (grade_check without\n" +
			"commits or range) for the check's current contents.\n\n" +
			"Report the returned path and changed line to the user.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" }, to: { type: "string", enum: ["advisory", "active"] } },
			required: ["id", "to"],
		},
		async run(args, env) {
			const { cfg } = await project(env);
			const r = await guarded(() => ops.promote(cfg, str(args.id, "id"), str(args.to, "to"), false, false));
			return { text: `${r.path}: ${r.old_line || "(none)"} -> ${r.new_line}`, data: r };
		},
	},
];

/** Run a tool by name; expected failures throw ToolError. */
export async function callTool(name: string, args: Table, env: ToolEnv): Promise<ToolResult> {
	const tool = TOOLS.find((t) => t.name === name);
	if (!tool) throw new ToolError(`unknown tool ${name}`);
	return tool.run(args ?? {}, env);
}
