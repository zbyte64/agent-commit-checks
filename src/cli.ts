/** `acc` command line. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	gateBudgetMs,
	legacyOmpExtensions,
	ompConfigGet,
	ompPluginInstalled,
	PACKAGE_SOURCE,
	piPackageInstalled,
} from "./agentSetup.ts";
import { BackendError } from "./backends/base.ts";
import { getBackend } from "./backends/index.ts";
import { RECOMMENDED_MODELS as JUDGE_MODELS, JudgeBackend } from "./backends/judge.ts";
import { DEFAULT_URL, LocalBackend, listDevices, RECOMMENDED_MODELS, serverLog } from "./backends/local.ts";
import { DEFAULT_FILE as TINY_FILE, RECOMMENDED_MODEL as TINY_MODEL, TinyBackend } from "./backends/tiny.ts";
import { CheckError, loadAll, loadFile, STATUSES } from "./checks.ts";
import { ConfigError, homeDir, homeRelative, loadConfig, type Table } from "./config.ts";
import { formatResult, runClaudeHook } from "./gate.ts";
import { GitError } from "./git.ts";
import { GradeError, grade, shortRange } from "./grading.ts";
import { serve } from "./mcp.ts";
import * as ops from "./ops.ts";
import { run as runProcess, which } from "./proc.ts";
import { escapeRegExp } from "./text.ts";

const EXIT: Record<string, number> = { pass: 0, warn: 1, block: 2 };
const EXIT_ERROR = 3;
const EXIT_USAGE = 2;
const MIN_HOOK_VERSION = [2, 1, 295]; // `args`, `if` and `onFailure` hook fields
const TEMPLATES = fileURLToPath(new URL("./templates/", import.meta.url));

export interface Io {
	cwd: string;
	/** Write one line (a newline is added). */
	out(text: string): void;
	/** Write one line to the error stream. */
	err(text: string): void;
	readStdin(): Promise<string>;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
	return Buffer.concat(chunks).toString("utf8");
}

function defaultIo(): Io {
	return {
		cwd: process.cwd(),
		out: (text) => process.stdout.write(`${text}\n`),
		err: (text) => process.stderr.write(`${text}\n`),
		readStdin: () => readAll(process.stdin),
	};
}

// ── argument parsing (the subset of argparse acc uses) ───────────────────────

type OptKind = "flag" | "value" | "append" | "multi" | "optional";

interface OptSpec {
	flag: string;
	key: string;
	kind: OptKind;
	help: string;
	default?: unknown;
	choices?: readonly string[];
	/** Value of an `optional` option given without a value. */
	const?: string;
	int?: boolean;
	metavar?: string;
}

interface CommandSpec {
	help: string;
	positionals: { key: string; optional?: boolean; help?: string }[];
	opts: OptSpec[];
	/** Options that cannot be combined. */
	exclusive?: [string, string];
	run(a: Args, io: Io): Promise<number>;
}

type Args = Record<string, any>;

class UsageError extends Error {}

function agentOpt(): OptSpec {
	return { flag: "--agent", key: "agent", kind: "value", default: "claude", help: "agent whose backend to use (default: claude)" };
}

function parseArgs(spec: CommandSpec, argv: string[]): Args {
	const a: Args = {};
	for (const o of spec.opts) a[o.key] = o.default ?? (o.kind === "flag" ? false : null);
	for (const p of spec.positionals) a[p.key] = null;
	const seen = new Set<string>();
	let pos = 0;
	let onlyPositionals = false;
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (!onlyPositionals && tok === "--") {
			onlyPositionals = true;
			continue;
		}
		if (!onlyPositionals && tok.startsWith("-") && tok !== "-") {
			const eq = tok.indexOf("=");
			const flag = eq > 0 ? tok.slice(0, eq) : tok;
			const inline = eq > 0 ? tok.slice(eq + 1) : null;
			const o = spec.opts.find((x) => x.flag === flag);
			if (!o) throw new UsageError(`unrecognized arguments: ${tok}`);
			seen.add(o.key);
			const take = (): string => {
				if (inline !== null) return inline;
				const v = argv[i + 1];
				if (v === undefined || (v.startsWith("-") && v !== "-")) throw new UsageError(`argument ${o.flag}: expected one argument`);
				i += 1;
				return v;
			};
			const check = (v: string): string | number => {
				if (o.choices && !o.choices.includes(v)) {
					throw new UsageError(`argument ${o.flag}: invalid choice: '${v}' (choose from ${o.choices.map((c) => `'${c}'`).join(", ")})`);
				}
				if (o.int) {
					if (!/^-?\d+$/.test(v)) throw new UsageError(`argument ${o.flag}: invalid int value: '${v}'`);
					return Number.parseInt(v, 10);
				}
				return v;
			};
			if (o.kind === "flag") {
				if (inline !== null) throw new UsageError(`argument ${o.flag}: ignored explicit argument '${inline}'`);
				a[o.key] = true;
			} else if (o.kind === "value") {
				a[o.key] = check(take());
			} else if (o.kind === "append") {
				a[o.key] = [...(a[o.key] ?? []), check(take())];
			} else if (o.kind === "optional") {
				const next = argv[i + 1];
				if (inline !== null) a[o.key] = check(inline);
				else if (next !== undefined && !next.startsWith("-")) {
					a[o.key] = check(next);
					i += 1;
				} else a[o.key] = o.const;
			} else {
				const values: string[] = inline !== null ? [inline] : [];
				while (inline === null && argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) values.push(argv[++i]);
				if (!values.length) throw new UsageError(`argument ${o.flag}: expected at least one argument`);
				a[o.key] = values.map(check);
			}
			continue;
		}
		const p = spec.positionals[pos++];
		if (!p) throw new UsageError(`unrecognized arguments: ${tok}`);
		a[p.key] = tok;
	}
	const missing = spec.positionals.slice(pos).filter((p) => !p.optional);
	if (missing.length) throw new UsageError(`the following arguments are required: ${missing.map((p) => p.key).join(", ")}`);
	if (spec.exclusive) {
		const [x, y] = spec.exclusive;
		if (seen.has(x) && seen.has(y)) {
			const fx = spec.opts.find((o) => o.key === x)?.flag;
			const fy = spec.opts.find((o) => o.key === y)?.flag;
			throw new UsageError(`argument ${fy}: not allowed with argument ${fx}`);
		}
	}
	return a;
}

function usage(name: string, spec: CommandSpec): string {
	const lines = [`usage: acc ${name} [options]${spec.positionals.map((p) => (p.optional ? ` [${p.key}]` : ` ${p.key}`)).join("")}`, "", spec.help];
	if (spec.positionals.length || spec.opts.length) lines.push("");
	for (const p of spec.positionals) lines.push(`  ${p.key.padEnd(24)} ${p.help ?? ""}`.trimEnd());
	for (const o of spec.opts) {
		const meta = o.kind === "flag" ? "" : o.kind === "multi" ? ` ${o.metavar ?? "VALUE"} ...` : o.kind === "optional" ? ` [${o.metavar ?? "VALUE"}]` : ` ${o.metavar ?? o.key.toUpperCase()}`;
		lines.push(`  ${`${o.flag}${meta}`.padEnd(24)} ${o.help}`);
	}
	return lines.join("\n");
}

// ── commands ─────────────────────────────────────────────────────────────────

function accPath(): string {
	return which("acc") ?? resolve(process.argv[1] ?? "acc");
}

async function cmdGate(a: Args, io: Io): Promise<number> {
	if (a.agent !== "claude") {
		io.err(`acc: no gate command for agent '${a.agent}'; omp and pi run the gate inside the acc extension`);
		return EXIT_ERROR;
	}
	const out = await runClaudeHook(await io.readStdin());
	if (out) io.out(out);
	return 0;
}

async function cmdRun(a: Args, io: Io): Promise<number> {
	const { cfg } = await ops.project(io.cwd);
	const res = await ops.run(cfg, io.cwd, a.agent, {
		ids: a.check,
		revRange: a.range,
		includeProposed: a.include_proposed,
		backendName: a.backend,
	});
	if (a.json) {
		io.out(JSON.stringify(res.toDict(), null, 2));
	} else if (!res.commits.length) {
		io.out(`acc: no commits to review in ${a.range}.`);
	} else if (res.verdict === "pass") {
		const names = [...new Set(res.entries.map((e) => e.checkId))].sort();
		io.out(`acc: pass (${res.commits.length} commits, checks: ${names.join(", ") || "none matched"}).`);
	} else {
		io.out(formatResult(res));
	}
	return EXIT[res.verdict];
}

async function cmdList(a: Args, io: Io): Promise<number> {
	const { cfg } = await ops.project(io.cwd);
	const rows = ops.listChecks(cfg, a.status);
	if (a.json) {
		io.out(JSON.stringify(rows, null, 2));
		return 0;
	}
	if (!rows.length) io.out("No checks. Add TOML files under .acc/checks/ or run `acc init`.");
	for (const r of rows) {
		if (r.invalid) {
			io.out(`${r.id.padEnd(32)} INVALID  ${r.errors.join("; ")}`);
			continue;
		}
		const flag = r.enabled ? "" : " (disabled)";
		io.out(`${r.id.padEnd(32)} ${r.status.padEnd(9)} ${r.type.padEnd(6)} ${r.author.padEnd(5)} grade=${r.grade}${flag}`);
	}
	return 0;
}

async function cmdValidate(a: Args, io: Io): Promise<number> {
	let paths: string[];
	if (a.file) {
		paths = [a.file];
	} else {
		const { cfg } = await ops.project(io.cwd);
		paths = existsSync(cfg.checksDir)
			? readdirSync(cfg.checksDir)
					.filter((n) => n.endsWith(".toml"))
					.sort()
					.map((n) => join(cfg.checksDir, n))
			: [];
	}
	let bad = 0;
	for (const p of paths) {
		try {
			loadFile(isAbsolute(p) ? p : resolve(io.cwd, p));
			io.out(`ok       ${p}`);
		} catch (e) {
			bad += 1;
			if (e instanceof CheckError) {
				io.out(`invalid  ${p}`);
				for (const msg of e.errors) io.out(`  - ${msg}`);
			} else {
				io.out(`invalid  ${p}: ${(e as Error).message}`);
			}
		}
	}
	return bad ? 2 : 0;
}

function percent(x: number): string {
	return `${Math.round(x * 100)}%`;
}

async function cmdGrade(a: Args, io: Io): Promise<number> {
	const { root, cfg } = await ops.project(io.cwd);
	const check = ops.getCheck(cfg, a.id);
	const g = await grade(cfg, root, check, getBackend(cfg, a.agent, a.backend), a.sample, a.commits, a.range);
	const m = g.metrics;
	const sel = g.record.selection;
	const chosen = sel.mode === "commits" ? "chosen commits" : sel.mode === "ranges" ? `ranges ${(sel.ranges ?? []).join(", ")}` : "history";
	io.out(`acc: grade for ${a.id} on ${chosen}: ${g.result.toUpperCase()}`);
	io.out(
		`  sample ${m.sample_size} of ${m.pool_size} eligible ranges, block rate ${percent(m.block_rate)} ` +
			`(${m.blocked} blocked, ${m.low_confidence} low-confidence blocks warned), errors ${m.errors}, ` +
			`unstable ${m.unstable}, calls ${m.calls}` +
			(m.catch_rate !== null ? `, catch rate ${percent(m.catch_rate)}` : ""),
	);
	for (const s of g.record.sample) {
		if (s.verdict === "block" || s.verdict === "warn" || s.error) {
			io.out(`  ${s.verdict.padEnd(5)} ${shortRange(s.range)} (${s.reason}): ${s.error || s.summary}`);
		}
	}
	for (const x of g.record.excluded) io.out(`  skip  ${shortRange(x.range)}: ${x.reason}`);
	io.out(`  wrote ${g.path}`);
	return g.result === "pass" ? 0 : 1;
}

async function cmdPromote(a: Args, io: Io): Promise<number> {
	const { cfg } = await ops.project(io.cwd);
	const r = ops.promote(cfg, a.id, a.to, a.force);
	io.out(`${r.path}: ${r.old_line || "(no status line)"} -> ${r.new_line}`);
	return 0;
}

function snippets(acc: string): string {
	const hook = {
		hooks: {
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [
						{
							type: "command",
							if: "Bash(git push*)",
							command: acc,
							args: ["gate", "--agent", "claude"],
							timeout: 180,
							statusMessage: "Running push checks",
							onFailure: "block",
						},
					],
				},
			],
		},
	};
	const mcp = { mcpServers: { acc: { command: acc, args: ["mcp", "--agent", "claude"] } } };
	return (
		"Claude Code hook: merge into ~/.claude/settings.json (all projects) or\n" +
		".claude/settings.local.json (this project, not committed):\n\n" +
		JSON.stringify(hook, null, 2) +
		"\n\nMCP server: add to .mcp.json in the project root (or run\n" +
		`\`claude mcp add --scope project acc -- ${acc} mcp --agent claude\`):\n\n` +
		JSON.stringify(mcp, null, 2) +
		"\n"
	);
}

async function cmdInit(a: Args, io: Io): Promise<number> {
	const { root } = await ops.project(io.cwd);
	const accDir = join(root, ".acc");
	const claude = which("claude");
	const omp = which("omp");
	const pi = which("pi");
	const llama = which("llama-server");
	const created: string[] = [];
	mkdirSync(join(accDir, "checks"), { recursive: true });
	mkdirSync(join(accDir, "grades"), { recursive: true });
	const keep = join(accDir, "grades", ".gitkeep");
	if (!existsSync(keep)) writeFileSync(keep, "");
	const cfgPath = join(accDir, "config.toml");
	if (!existsSync(cfgPath)) {
		// Keep the launcher path: resolving symlinks would pin a versioned binary that auto-update removes.
		// Write it relative to ~ so the committed config names no username.
		const launcher = (found: string | null, name: string): string => (found ? homeRelative(resolve(found)) : name);
		const text = readFileSync(join(TEMPLATES, "config.toml"), "utf8")
			.replace("__CLAUDE__", launcher(claude, "claude"))
			.replace("__OMP__", launcher(omp, "omp"))
			.replace("__PI__", launcher(pi, "pi"))
			.replace("__LLAMA_SERVER__", launcher(llama, "llama-server"))
			.replace("__LOCAL_MODEL__", RECOMMENDED_MODELS.cpu);
		writeFileSync(cfgPath, text);
		created.push(cfgPath);
	}
	for (const name of ["no-debug-leftovers.toml", "commit-message-matches-diff.toml"]) {
		const dest = join(accDir, "checks", name);
		if (!existsSync(dest)) {
			writeFileSync(dest, readFileSync(join(TEMPLATES, "checks", name), "utf8"));
			created.push(dest);
		}
	}
	for (const p of created) io.out(`created ${relative(root, p)}`);
	if (!created.length) io.out(".acc/ already set up; nothing created.");
	if (a.local) await initLocal(cfgPath, a.local, llama, io);
	if (a.omp) return initOmp(root, io);
	if (a.pi) return initPi(root, io);
	if (!claude) io.out("warning: `claude` not found on PATH; set backends.claude.command to its absolute path.");
	io.out("");
	io.out(snippets(accPath()));
	io.out("For oh-my-pi or pi, run `acc init --omp` or `acc init --pi`.");
	return 0;
}

/**
 * Config text with `key = value` lines (values are TOML literals) set in `[table]`, which is added if
 * missing. A commented-out `# key = ...` line is replaced. `defaults` are set only when the table has
 * no such key.
 */
export function setKeys(text: string, table: string, values: Record<string, string>, defaults: Record<string, string> = {}): string {
	const head = new RegExp(`^\\[${escapeRegExp(table)}\\]$`, "m").exec(text);
	if (!head) {
		const lines = Object.entries({ ...defaults, ...values }).map(([k, v]) => `${k} = ${v}`);
		return `${text.replace(/\n+$/, "")}${text.trim() ? "\n\n" : ""}[${table}]\n${lines.join("\n")}\n`;
	}
	const headEnd = head.index + head[0].length;
	// Only this table: other tables (e.g. [agents.*]) may have keys with the same names.
	const end = /^\[/m.exec(text.slice(headEnd));
	const stop = end ? headEnd + end.index : text.length;
	let body = text.slice(headEnd, stop);
	for (const [key, value] of Object.entries(values)) {
		const re = new RegExp(`^#? *${escapeRegExp(key)} *=.*$`, "m");
		if (re.test(body)) body = body.replace(re, () => `${key} = ${value}`);
		else body = `\n${key} = ${value}${body}`;
	}
	for (const [key, value] of Object.entries(defaults)) {
		if (!new RegExp(`^ *${escapeRegExp(key)} *=`, "m").test(body)) body = `\n${key} = ${value}${body}`;
	}
	return text.slice(0, headEnd) + body + text.slice(stop);
}

export const LOCAL_PRESETS = ["cpu", "gpu", "judge", "tiny"] as const;

/**
 * Config text that runs every check on a local model: a chat model in llama-server on the `cpu` or
 * `gpu`, a `judge` model in llama-server on the GPU, or the `tiny` in-process classifier.
 */
export function enableLocal(text: string, preset: string, server: string): string {
	const q = (s: string): string => JSON.stringify(s);
	if (preset === "tiny") {
		const withTiny = setKeys(text, "backends.tiny", { model: q(TINY_MODEL), file: q(TINY_FILE) });
		return setKeys(withTiny, "run", { backend: q("tiny") });
	}
	if (preset === "judge") {
		const withJudge = setKeys(
			text,
			"backends.judge",
			{ format: q("guardian"), model: q(JUDGE_MODELS.guardian) },
			{ url: q(DEFAULT_URL), device: q("gpu"), server: q(server) },
		);
		return setKeys(withJudge, "run", { backend: q("judge") });
	}
	const withLocal = setKeys(
		text,
		"backends.local",
		{ device: q(preset), model: q(RECOMMENDED_MODELS[preset]) },
		{ url: q(DEFAULT_URL), server: q(server) },
	);
	return setKeys(withLocal, "run", { backend: q("local") });
}

async function tinyDepsVersion(): Promise<string | null> {
	try {
		// Optional packages: only present when the tiny backend was set up.
		const ort = (await import("onnxruntime-node")) as { env?: { versions?: { common?: string } } };
		await import("@huggingface/tokenizers");
		return ort.env?.versions?.common ?? "installed";
	} catch {
		return null;
	}
}

async function initLocal(cfgPath: string, preset: string, llama: string | null, io: Io): Promise<void> {
	const server = llama ? homeRelative(resolve(llama)) : "llama-server";
	writeFileSync(cfgPath, enableLocal(readFileSync(cfgPath, "utf8"), preset, server));
	const backend = preset === "tiny" || preset === "judge" ? preset : "local";
	io.out(`set run.backend = "${backend}" in ${basename(cfgPath)}: every agent now uses the local ${preset} model`);
	if (preset === "tiny") {
		if ((await tinyDepsVersion()) === null) {
			io.out(
				"warning: the tiny backend needs two optional packages next to acc: onnxruntime-node and " +
					"@huggingface/tokenizers (e.g. `npm install -g onnxruntime-node @huggingface/tokenizers`).",
			);
		}
		io.out("Run `acc doctor` once: it downloads the model into ~/.cache/acc/models.");
		return;
	}
	if (!llama) {
		io.out(
			"warning: `llama-server` not found on PATH. Install llama.cpp " +
				"(https://github.com/ggml-org/llama.cpp/releases), then set backends.local.server " +
				"to its absolute path.",
		);
	} else if (preset === "gpu" || preset === "judge") {
		const devices = await listDevices(llama);
		if (devices.length) io.out(`llama-server sees: ${devices.join(", ")}`);
		else {
			io.out(
				"warning: this llama-server build sees no GPU. Install a GPU build (Vulkan for AMD or " +
					"Intel, CUDA for NVIDIA, or ROCm) from https://github.com/ggml-org/llama.cpp/releases.",
			);
		}
	}
	io.out("Run `acc doctor` once: it starts llama-server, which downloads the model on first use.");
}

function found(cmd: string): boolean {
	return isAbsolute(cmd) ? existsSync(cmd) : which(cmd) !== null;
}

async function initOmp(root: string, io: Io): Promise<number> {
	const cfg = loadConfig(root);
	const { command: omp, model } = cfg.backendSettings("omp");
	if (!found(omp)) io.out("warning: `omp` not found on PATH; set backends.omp.command to its absolute path.");
	for (const p of legacyOmpExtensions(root)) {
		io.out(`warning: remove ${p}: it is the old acc extension, which calls \`acc gate --agent omp\` (gone).`);
	}
	if ((await ompPluginInstalled(omp, root)) === false) {
		io.out(`Install the acc extension in omp:\n\n  ${omp} install ${PACKAGE_SOURCE}\n`);
	} else {
		io.out("The acc extension is installed in omp.");
	}
	if (model.startsWith("@")) {
		const role = model.slice(1);
		const roles = (await ompConfigGet(omp, "modelRoles", root)) as Table | null;
		if (roles && typeof roles === "object" && roles[role]) io.out(`omp role ${model} -> ${roles[role]}`);
		else {
			io.out(
				`omp role ${model} is not set. Add it to ~/.omp/agent/config.yml (or a project ` +
					".omp/config.yml), or pick it in omp's /model Roles view:\n\n" +
					`modelRoles:\n  ${role}: anthropic/claude-haiku-5-5\n`,
			);
		}
	}
	io.out(
		"The extension gates `git push` in omp's bash tool, raises extensionHandlers.toolCallTimeoutMs " +
			"for the gate unless you set it yourself, and adds the check tools (list_checks, run_checks, " +
			"add_check, ...) and the /acc command. Restart omp, then run `/acc doctor --agent omp`.",
	);
	return 0;
}

async function initPi(root: string, io: Io): Promise<number> {
	const cfg = loadConfig(root);
	const { command: pi, model } = cfg.backendSettings("pi");
	if (!found(pi)) io.out("warning: `pi` not found on PATH; set backends.pi.command to its absolute path.");
	if ((await piPackageInstalled(pi, root)) === false) {
		io.out(`Install the acc extension in pi:\n\n  ${pi} install ${PACKAGE_SOURCE}\n`);
	} else {
		io.out("The acc extension is installed in pi.");
	}
	io.out(
		`Checks run on backends.pi.model = ${JSON.stringify(model)}. Set it in .acc/config.toml to a model ` +
			"pi is logged in to (`pi --list-models`); pi has no model roles.",
	);
	io.out(
		"The extension gates `git push` in pi's bash tool and adds the check tools (list_checks, " +
			"run_checks, add_check, ...) and the /acc command. Restart pi or run /reload, then run " +
			"`/acc doctor --agent pi`.",
	);
	return 0;
}

function versionTuple(text: string): number[] {
	const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	return m ? m.slice(1).map(Number) : [];
}

function versionAtLeast(v: number[], min: number[]): boolean {
	for (let i = 0; i < min.length; i++) {
		if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i];
	}
	return true;
}

async function cmdDoctor(a: Args, io: Io): Promise<number> {
	let ok = true;
	const report = (good: boolean, msg: string, warnOnly = false): void => {
		const tag = good ? "ok  " : warnOnly ? "warn" : "FAIL";
		if (!good && !warnOnly) ok = false;
		io.out(`[${tag}] ${msg}`);
	};

	let root: string;
	let cfg;
	try {
		({ root, cfg } = await ops.project(io.cwd));
	} catch (e) {
		if (e instanceof ops.OpError || e instanceof ConfigError) {
			report(false, e.message);
			return 1;
		}
		throw e;
	}
	const hasAcc = existsSync(cfg.accDir);
	report(hasAcc, `.acc/ directory in ${root}${hasAcc ? "" : " (run `acc init`)"}`);
	report(true, "config.toml parses");

	const { checks, errors } = loadAll(cfg.checksDir);
	const invalid = Object.keys(errors);
	report(!invalid.length, `${checks.length} valid check file(s)${invalid.length ? `, invalid: ${invalid.join(", ")}` : ""}`);

	const name = cfg.backendFor(a.agent);
	report(true, `agent '${a.agent}' uses backend '${name}'`);

	const binary = (backend: string): string | null => {
		const cmd: string = cfg.backendSettings(backend).command ?? backend;
		report(isAbsolute(cmd), `backends.${backend}.command is absolute: ${cmd}`, true);
		const path = isAbsolute(cmd) ? cmd : which(cmd);
		const exists = path !== null && which(path) !== null;
		report(exists, `${backend} binary is executable: ${path ?? cmd}`);
		return exists ? path : null;
	};

	if (name === "claude") {
		const path = binary("claude");
		if (path) {
			let ver = "";
			try {
				ver = (await runProcess(path, ["--version"], { timeoutMs: 30_000 })).stdout.trim();
			} catch {
				// reported below as an unknown version
			}
			const v = versionTuple(ver);
			report(
				v.length > 0 && versionAtLeast(v, MIN_HOOK_VERSION),
				`Claude Code ${ver || "?"}; hook \`args\`/\`if\`/\`onFailure\` need ${MIN_HOOK_VERSION.join(".")}+`,
				true,
			);
		}
	} else if (name === "local" || name === "judge") {
		const settings = cfg.backendSettings(name);
		const local = name === "local" ? new LocalBackend(settings) : new JudgeBackend(settings);
		const up = await local.ready();
		report(up, `model server at ${local.url} ${up ? "is ready" : `is not running${local.server ? " (acc will start it)" : ""}`}`, Boolean(local.server));
		if (up) {
			try {
				await local.checkModel();
				report(true, `server serves ${local.model}`);
			} catch (e) {
				if (!(e instanceof BackendError)) throw e;
				report(false, e.message);
			}
		}
		const binaryPath = local.server ? (isAbsolute(local.server) ? local.server : which(local.server)) : null;
		if (!up && local.server) {
			report(Boolean(binaryPath), `llama-server binary: ${binaryPath ?? local.server}`);
			report(true, `model ${local.model} on ${local.device}; server log ${serverLog()}`);
		}
		if (local.device === "gpu" && binaryPath) {
			const devices = await listDevices(binaryPath);
			report(
				devices.length > 0,
				devices.length ? `llama-server GPUs: ${devices.join(", ")}` : "llama-server sees no GPU: install a Vulkan, CUDA or ROCm build of llama.cpp",
			);
		}
	} else if (name === "tiny") {
		const version = await tinyDepsVersion();
		report(
			version !== null,
			version !== null
				? `onnxruntime-node ${version}`
				: "onnxruntime-node and @huggingface/tokenizers are not installed next to acc (see `acc init --local tiny`)",
		);
		const tiny = new TinyBackend(cfg.backendSettings("tiny"));
		report(true, `model ${tiny.model} (${tiny.file})`);
	} else if (name === "omp") {
		const path = binary("omp");
		const model: string = cfg.backendSettings("omp").model;
		if (path && model.startsWith("@")) {
			const roles = (await ompConfigGet(path, "modelRoles", root)) as Table | null;
			const target = roles && typeof roles === "object" ? roles[model.slice(1)] : null;
			report(
				Boolean(target),
				target
					? `omp role ${model} -> ${target}`
					: `omp role ${model} is not set: add modelRoles.${model.slice(1)} to ~/.omp/agent/config.yml (see \`acc init --omp\`)`,
				true,
			);
		}
	} else if (name === "pi") {
		binary("pi");
		report(true, `pi model ${cfg.backendSettings("pi").model}`);
	}

	if (!a.offline) {
		try {
			const backend = getBackend(cfg, a.agent);
			const schema = { type: "object", properties: { checks: { type: "object" } }, required: ["checks"] };
			await backend.ask("Reply with the requested JSON only.", 'Return {"checks": {}}.', "", schema, Number(cfg.run.timeout_seconds));
			report(true, `test call to ${backend.name} (${backend.model}) succeeded`);
		} catch (e) {
			if (!(e instanceof BackendError)) throw e;
			report(false, `test call failed: ${e.message}`);
		}
	}

	if (a.agent === "claude") {
		const settings = [join(homeDir(), ".claude", "settings.json"), join(root, ".claude", "settings.local.json"), join(root, ".claude", "settings.json")];
		const hooked = settings.filter((p) => {
			if (!existsSync(p)) return false;
			const text = readFileSync(p, "utf8");
			return text.includes("gate") && text.includes("acc");
		});
		report(hooked.length > 0, `PreToolUse hook found in ${hooked.length ? hooked.join(", ") : "no Claude Code settings file (see `acc init`)"}`, true);
	} else if (a.agent === "omp") {
		await doctorOmpExtension(cfg.backendSettings("omp").command, Number(cfg.run.timeout_seconds), root, report);
	} else if (a.agent === "pi") {
		const installed = await piPackageInstalled(cfg.backendSettings("pi").command, root);
		report(installed === true, installed ? "acc extension installed in pi" : `acc extension not found in \`pi list\` (run \`pi install ${PACKAGE_SOURCE}\`)`, true);
	}
	return ok ? 0 : 1;
}

async function doctorOmpExtension(
	omp: string,
	timeoutSeconds: number,
	root: string,
	report: (good: boolean, msg: string, warnOnly?: boolean) => void,
): Promise<void> {
	const installed = await ompPluginInstalled(omp, root);
	report(installed === true, installed ? "acc extension installed in omp" : `acc extension not found in \`omp plugin list\` (run \`omp install ${PACKAGE_SOURCE}\`)`, true);
	// A leftover blocks every push (it calls a gate command that is gone), so this one is a failure.
	for (const p of legacyOmpExtensions(root)) report(false, `old acc extension ${p} is still installed: delete it`);
	const budget = gateBudgetMs(timeoutSeconds);
	const current = await ompConfigGet(omp, "extensionHandlers.toolCallTimeoutMs", root);
	const enough = typeof current === "number" && current >= budget;
	report(
		enough,
		`omp extensionHandlers.toolCallTimeoutMs is ${current}; the gate can need ${budget}` +
			(enough ? "" : " (the acc extension raises it in omp sessions unless you set it yourself)"),
		true,
	);
}

async function cmdMcp(a: Args, io: Io): Promise<number> {
	await serve({ agent: a.agent, cwd: io.cwd });
	return 0;
}

const COMMANDS: Record<string, CommandSpec> = {
	gate: {
		help: "decide on a Claude Code push (PreToolUse hook JSON on stdin)",
		positionals: [],
		opts: [agentOpt()],
		run: cmdGate,
	},
	run: {
		help: "run checks on demand",
		positionals: [],
		opts: [
			agentOpt(),
			{ flag: "--check", key: "check", kind: "append", help: "check id (repeatable); default: non-proposed checks" },
			{ flag: "--range", key: "range", kind: "value", default: "unpushed", help: "'unpushed' (default) or a rev range like main..HEAD" },
			{ flag: "--include-proposed", key: "include_proposed", kind: "flag", help: "also run proposed checks" },
			{ flag: "--backend", key: "backend", kind: "value", help: "override the backend (e.g. fake)" },
			{ flag: "--json", key: "json", kind: "flag", help: "print the full result as JSON" },
		],
		run: cmdRun,
	},
	grade: {
		help: "grade a check against prior commits",
		positionals: [{ key: "id", help: "check id" }],
		opts: [
			agentOpt(),
			{ flag: "--sample", key: "sample", kind: "value", int: true, help: "target sample size (default from config)" },
			{ flag: "--backend", key: "backend", kind: "value", help: "override the backend" },
			{ flag: "--commits", key: "commits", kind: "multi", metavar: "REV", help: "grade each of these commits on its own" },
			{ flag: "--range", key: "range", kind: "append", metavar: "A..B", help: "grade this range as one unit, like a push of its commits (repeatable)" },
		],
		exclusive: ["commits", "range"],
		run: cmdGrade,
	},
	list: {
		help: "list checks",
		positionals: [],
		opts: [
			{ flag: "--status", key: "status", kind: "value", choices: STATUSES, help: "only checks with this status" },
			{ flag: "--json", key: "json", kind: "flag", help: "print JSON" },
		],
		run: cmdList,
	},
	validate: {
		help: "schema-check one or all check files",
		positionals: [{ key: "file", optional: true, help: "a check file (default: every file in .acc/checks)" }],
		opts: [],
		run: cmdValidate,
	},
	promote: {
		help: "change a check's status",
		positionals: [{ key: "id", help: "check id" }],
		opts: [
			{ flag: "--to", key: "to", kind: "value", choices: ["advisory", "active"], default: "active", help: "new status (default: active)" },
			{ flag: "--force", key: "force", kind: "flag", help: "promote to active without a passing grade" },
		],
		run: cmdPromote,
	},
	init: {
		help: "create .acc/ and print setup snippets",
		positionals: [],
		opts: [
			{ flag: "--omp", key: "omp", kind: "flag", help: "set up oh-my-pi instead of Claude Code: print the omp setup" },
			{ flag: "--pi", key: "pi", kind: "flag", help: "set up pi instead of Claude Code: print the pi setup" },
			{
				flag: "--local",
				key: "local",
				kind: "optional",
				const: "cpu",
				choices: LOCAL_PRESETS,
				metavar: "PRESET",
				help:
					"run every check on a local model instead of the agent's own: cpu (default) or gpu run a chat " +
					"model in llama-server, judge runs a yes/no judge model (Granite Guardian) in llama-server on " +
					"the GPU, tiny runs a small ONNX classifier in-process",
			},
		],
		run: cmdInit,
	},
	doctor: {
		help: "verify backend, auth, config and check files",
		positionals: [],
		opts: [agentOpt(), { flag: "--offline", key: "offline", kind: "flag", help: "skip the test model call" }],
		run: cmdDoctor,
	},
	mcp: {
		help: "serve the MCP tools over stdio",
		positionals: [],
		opts: [agentOpt()],
		run: cmdMcp,
	},
};

function mainUsage(): string {
	const lines = ["usage: acc <command> [options]", "", "Model-backed checks on commits before an agent pushes.", "", "commands:"];
	for (const [name, spec] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(10)} ${spec.help}`);
	return lines.join("\n");
}

/** Run `acc <argv>`; returns the exit code. Output goes through `io` only. */
export async function main(argv: string[], ioOverrides: Partial<Io> = {}): Promise<number> {
	const io: Io = { ...defaultIo(), ...ioOverrides };
	const [name, ...rest] = argv;
	if (!name || name === "-h" || name === "--help") {
		(name ? io.out : io.err)(mainUsage());
		return name ? 0 : EXIT_USAGE;
	}
	const spec = COMMANDS[name];
	if (!spec || !Object.hasOwn(COMMANDS, name)) {
		io.err(`${mainUsage()}\nacc: error: invalid command '${name}'`);
		return EXIT_USAGE;
	}
	if (rest.includes("-h") || rest.includes("--help")) {
		io.out(usage(name, spec));
		return 0;
	}
	let a: Args;
	try {
		a = parseArgs(spec, rest);
	} catch (e) {
		if (!(e instanceof UsageError)) throw e;
		io.err(`${usage(name, spec)}\nacc ${name}: error: ${e.message}`);
		return EXIT_USAGE;
	}
	try {
		return await spec.run(a, io);
	} catch (e) {
		if ([ops.OpError, ConfigError, CheckError, BackendError, GitError, GradeError].some((cls) => e instanceof cls)) {
			io.err(`acc: ${(e as Error).message}`);
			return EXIT_ERROR;
		}
		throw e;
	}
}
