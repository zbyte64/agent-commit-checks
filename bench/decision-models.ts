/**
 * Benchmark decision models on labeled cases built from this repo's own history.
 *
 * Each case is one check on one commit from `--rev` (default HEAD), first parent only:
 *
 * - commit-message-matches-diff: the commit as is (should pass), and its diff with the message of
 *   the commit 17 places further back (should be caught).
 * - src-changes-have-tests: a commit that changes src/ and tests/ as is (should pass), and its diff
 *   with the tests/ files removed (should be caught).
 * - no-debug-leftovers: a Python commit as is (should pass), and its diff with
 *   `print("DEBUG >>>", locals())  # TODO remove` added after the first added .py line (should be caught).
 *
 * That is 26 real cases and 26 altered ones, each run as its own model call through the same runner
 * as the gate, plus one call with all three checks on one commit. "Caught" means any verdict other
 * than pass. The check files are read at `--rev` too, so cases and checks come from the same commit.
 *
 * usage (from the repo root; the tiny kind needs onnxruntime-node and @huggingface/tokenizers):
 *   bun bench/decision-models.ts KIND MODEL --rev 6befd26 --out bench/results/NAME.json
 *   KIND is claude (MODEL e.g. haiku), cpu or gpu (llama-server, MODEL a GGUF repo:quant), judge (a
 *   yes/no judge model in llama-server on the GPU, with --format guardian or selene), or tiny (MODEL
 *   is repo:file of an ONNX model).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { arch } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Backend } from "../src/backends/base.ts";
import { ClaudeBackend } from "../src/backends/claude.ts";
import { JudgeBackend } from "../src/backends/judge.ts";
import { LocalBackend } from "../src/backends/local.ts";
import { TinyBackend } from "../src/backends/tiny.ts";
import { type Check, parseText } from "../src/checks.ts";
import { expandPath, loadConfig } from "../src/config.ts";
import { type Context, commitContext, splitFiles } from "../src/diffs.ts";
import * as g from "../src/git.ts";
import { execute } from "../src/runner.ts";
import { splitlines, words } from "../src/text.ts";

const ROOT = join(import.meta.dirname, "..");
const CHECKS = ["commit-message-matches-diff", "no-debug-leftovers", "src-changes-have-tests"];

interface Case {
	check: string;
	expect: "pass" | "fail";
	label: string;
	commit: string;
	ctx: Context;
}

function altered(base: Context, label: string, alter: { diff?: string; message?: string } = {}): Context {
	const diff = alter.diff ?? base.diff;
	return new (base.constructor as typeof Context)({
		label,
		commit: null,
		diff,
		message: alter.message ?? base.message,
		files: splitFiles(diff).map(([p]) => p),
	});
}

/** The cases, and the context for the batched call. */
async function buildCases(excludeGlobs: string[], rev: string): Promise<{ cases: Case[]; batch: Context }> {
	const shas = words(await g.git(ROOT, ["rev-list", "--first-parent", "--no-merges", rev, "--max-count", "60"]));
	const all: Context[] = [];
	for (const s of shas) all.push(await commitContext(ROOT, s, excludeGlobs, false));
	const ctxs = all.filter((c) => c.diff && c.diff.length < 30000);
	const cases: Case[] = [];
	const add = (check: string, expect: "pass" | "fail", label: string, base: Context, alter: { diff?: string; message?: string } = {}): void => {
		cases.push({ check, expect, label, commit: (base.commit ?? "").slice(0, 7), ctx: altered(base, label, alter) });
	};

	ctxs.slice(0, 10).forEach((c, i) => {
		add("commit-message-matches-diff", "pass", `m${i}`, c);
		add("commit-message-matches-diff", "fail", `mx${i}`, c, { message: ctxs[(i + 17) % ctxs.length].message });
	});
	const both = ctxs
		.filter((c) => c.files.some((f) => f.startsWith("src/") && f.endsWith(".py")) && c.files.some((f) => f.startsWith("tests/")))
		.slice(0, 8);
	both.forEach((c, i) => {
		add("src-changes-have-tests", "pass", `t${i}`, c);
		const diff = splitFiles(c.diff)
			.filter(([p]) => !p.startsWith("tests/"))
			.map(([, ch]) => ch)
			.join("");
		add("src-changes-have-tests", "fail", `tx${i}`, c, { diff });
	});
	ctxs
		.filter((c) => c.files.some((f) => f.endsWith(".py")))
		.slice(0, 8)
		.forEach((c, i) => {
			add("no-debug-leftovers", "pass", `d${i}`, c);
			const lines = splitlines(c.diff, true);
			const at = lines.findIndex((ln, k) => ln.startsWith("+") && !ln.startsWith("+++") && lines.slice(0, k).join("").includes(".py"));
			const body = lines[at].slice(1);
			const indent = body.slice(0, body.length - body.trimStart().length);
			lines.splice(at + 1, 0, `+${indent}print("DEBUG >>>", locals())  # TODO remove\n`);
			add("no-debug-leftovers", "fail", `dx${i}`, c, { diff: lines.join("") });
		});
	return { cases, batch: ctxs[0] };
}

function machine(): string {
	if (existsSync("/proc/cpuinfo")) {
		for (const line of readFileSync("/proc/cpuinfo", "utf8").split("\n")) {
			if (line.startsWith("model name")) return line.split(":", 2)[1].trim();
		}
	}
	return arch();
}

function makeBackend(kind: string, model: string, port: number, server: string, format: string): Backend {
	if (kind === "claude") return new ClaudeBackend({ command: expandPath("~/.local/bin/claude"), model });
	if (kind === "tiny") {
		const at = model.indexOf(":");
		return new TinyBackend({ model: model.slice(0, at), file: model.slice(at + 1) });
	}
	if (kind === "judge") {
		return new JudgeBackend({ url: `http://127.0.0.1:${port}`, model, format, server: expandPath(server), startup_seconds: 1800 });
	}
	return new LocalBackend({ url: `http://127.0.0.1:${port}`, model, device: kind, server: expandPath(server), startup_seconds: 900 });
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

async function main(): Promise<void> {
	const { values: a, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			rev: { type: "string", default: "HEAD" },
			port: { type: "string", default: "8790" },
			server: { type: "string", default: "~/.local/bin/llama-server" },
			format: { type: "string", default: "guardian" },
			out: { type: "string" },
		},
	});
	const [kind, model] = positionals;
	if (!["claude", "cpu", "gpu", "judge", "tiny"].includes(kind) || !model || !a.out) {
		throw new Error("usage: bun bench/decision-models.ts {claude,cpu,gpu,judge,tiny} MODEL --out FILE [--rev REV]");
	}

	const cfg = loadConfig(ROOT);
	cfg.run.parallel = 1;
	cfg.run.timeout_seconds = 120;
	const found: Record<string, Check> = {};
	for (const c of CHECKS) found[c] = parseText(await g.git(ROOT, ["show", `${a.rev}:.acc/checks/${c}.toml`]), c);
	const { cases, batch } = await buildCases(cfg.run.exclude_globs, a.rev as string);
	const port = Number(a.port);
	const backend = makeBackend(kind, model, port, a.server as string, a.format as string);
	const t0 = performance.now();
	if (backend instanceof TinyBackend) await backend.load();
	else if (backend instanceof LocalBackend) await backend.ensureServer();
	const startup = (performance.now() - t0) / 1000;
	const rows: Record<string, unknown>[] = [];
	let batched: Record<string, unknown>;
	try {
		for (const c of cases) {
			const t = performance.now();
			const { results, calls } = await execute([{ key: c.check, check: found[c.check], context: c.ctx }], backend, cfg);
			const r = results[0];
			rows.push({
				check: c.check,
				expect: c.expect,
				label: c.label,
				commit: c.commit,
				verdict: r.rawVerdict,
				answer: r.answer ?? null,
				confidence: r.confidence,
				error: r.error,
				calls,
				seconds: round2((performance.now() - t) / 1000),
				chars: c.ctx.diff.length,
			});
			console.log(JSON.stringify(rows[rows.length - 1]));
		}
		const t = performance.now();
		const res = await execute(
			Object.entries(found).map(([k, v]) => ({ key: k, check: v, context: batch })),
			backend,
			cfg,
		);
		batched = {
			seconds: round2((performance.now() - t) / 1000),
			calls: res.calls,
			results: res.results.map((r) => [r.key, r.rawVerdict, r.error]),
		};
	} finally {
		if (["cpu", "gpu", "judge"].includes(kind)) {
			try {
				execFileSync("pkill", ["-f", "--", `llama-server.*--port ${port}`]);
			} catch {
				// no server left
			}
		}
	}
	const record = {
		kind,
		model: model + (kind === "judge" ? ` (${a.format})` : ""),
		rev: (await g.git(ROOT, ["rev-parse", "--short", a.rev as string])).trim(),
		date: new Date().toISOString().slice(0, 10),
		machine: machine(),
		startup_seconds: Math.round(startup * 10) / 10,
		rows,
		batched,
	};
	writeFileSync(a.out, `${JSON.stringify(record, null, 1)}\n`);
}

await main();
