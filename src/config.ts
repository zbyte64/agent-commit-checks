/** Load `.acc/config.toml` with defaults. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { parse as parseToml } from "smol-toml";

export const ACC_DIR = ".acc";

/**
 * Parsed TOML or JSON: config tables, check verdict tables, model answers. Values are checked where
 * they are read (`loadConfig`, `validateDict`, `validateEntry`), as the Python version's dicts were.
 */
export type Table = Record<string, any>;

export const AGENTS = ["claude", "omp", "pi"] as const;
export type Agent = (typeof AGENTS)[number];

export const DEFAULTS: Table = {
	backends: {
		claude: { command: "claude", model: "haiku" },
		omp: { command: "omp", model: "@decision" },
		// Defaults for the local backends live in backends/local.ts, judge.ts and tiny.ts.
		local: {},
		judge: {},
		tiny: {},
		fake: { answers: "" },
	},
	agents: {},
	run: {
		backend: "",
		max_diff_chars: 12000,
		timeout_seconds: 90,
		parallel: 4,
		max_checks_per_call: 8,
		on_backend_error: "block",
		min_block_confidence: 0.7,
		secret_scan: true,
		exclude_globs: [
			"**/package-lock.json",
			"**/yarn.lock",
			"**/pnpm-lock.yaml",
			"**/uv.lock",
			"**/poetry.lock",
			"**/Cargo.lock",
			"**/go.sum",
			"**/*.min.js",
			"**/*.min.css",
		],
	},
	grading: {
		sample_size: 20,
		min_sample: 10,
		max_block_rate: 0.1,
		max_unstable: 1,
		max_history: 500,
	},
};

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

function isTable(v: unknown): v is Table {
	return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function merge(base: Table, over: Table): Table {
	const out: Table = structuredClone(base);
	for (const [k, v] of Object.entries(over)) {
		out[k] = isTable(v) && isTable(out[k]) ? merge(out[k], v) : v;
	}
	return out;
}

export class Config {
	readonly root: string;
	readonly data: Table;

	constructor(root: string, data: Table = structuredClone(DEFAULTS)) {
		this.root = root;
		this.data = data;
	}

	get accDir(): string {
		return join(this.root, ACC_DIR);
	}

	get checksDir(): string {
		return join(this.accDir, "checks");
	}

	get gradesDir(): string {
		return join(this.accDir, "grades");
	}

	get run(): Table {
		return this.data.run;
	}

	get grading(): Table {
		return this.data.grading;
	}

	/**
	 * Backend name for an agent: `[agents.<name>] backend`, else `run.backend` (which overrides every
	 * agent's own CLI, e.g. with a local model), else the agent's own CLI.
	 */
	backendFor(agent: string): string {
		return this.data.agents?.[agent]?.backend || this.run.backend || agent;
	}

	backendSettings(name: string): Table {
		return this.data.backends?.[name] ?? {};
	}
}

/** The user's home directory: `$HOME` when set (as Python's `Path.home()` reads it), else the OS's. */
export function homeDir(): string {
	return process.env.HOME || homedir();
}

/**
 * Expand `~` and environment variables such as `$HOME`, so a committed config can name per-user
 * binaries without hard-coding a username. Unknown variables are left as written.
 */
export function expandPath(value: string): string {
	const vars = value.replace(/\$(\w+|\{[^}]*\})/g, (m, name: string) => {
		const key = name.startsWith("{") ? name.slice(1, -1) : name;
		return process.env[key] ?? m;
	});
	if (vars === "~") return homeDir();
	if (vars.startsWith("~/")) return homeDir() + vars.slice(1);
	return vars;
}

/** The inverse for display: `/home/me/.local/bin/x` becomes `~/.local/bin/x`. */
export function homeRelative(path: string): string {
	const home = homeDir();
	return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

export function loadConfig(root: string): Config {
	const path = join(root, ACC_DIR, "config.toml");
	let data: Table = {};
	if (existsSync(path)) {
		try {
			data = parseToml(readFileSync(path, "utf8")) as Table;
		} catch (e) {
			throw new ConfigError(`${path}: ${(e as Error).message}`);
		}
	}
	const cfg = new Config(root, merge(DEFAULTS, data));
	for (const backend of Object.values(cfg.data.backends as Table)) {
		for (const key of ["command", "server"]) {
			if (typeof backend[key] === "string") backend[key] = expandPath(backend[key]);
		}
	}
	if (!["warn", "block"].includes(cfg.run.on_backend_error)) {
		throw new ConfigError("run.on_backend_error must be 'warn' or 'block'");
	}
	const mbc = cfg.run.min_block_confidence;
	if (typeof mbc !== "number" || !(mbc >= 0 && mbc <= 1)) {
		throw new ConfigError("run.min_block_confidence must be a number from 0 to 1");
	}
	return cfg;
}

/** A project opts in by having a `.acc/` directory. */
export function isEnabled(root: string): boolean {
	try {
		return statSync(join(root, ACC_DIR)).isDirectory();
	} catch {
		return false;
	}
}
