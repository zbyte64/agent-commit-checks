/** Test fixtures: throwaway repos with a bare `origin`, fake-backend answers, check files. */
import { afterEach, beforeEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BackendError } from "../src/backends/base.ts";
import type { Io } from "../src/cli.ts";
import { type Config, loadConfig } from "../src/config.ts";

export const FIXTURES = join(import.meta.dir, "fixtures");
// Built at runtime so the source never contains a key-shaped literal that the secret scan (rightly)
// refuses to push.
export const FAKE_AWS_KEY = `AKIA${"ABCDEFGHIJKLMNOP"}`;

export function sh(cwd: string, ...args: string[]): string {
	return execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A throwaway repo with a local bare remote named origin. */
export class Repo {
	readonly tmp: string;
	readonly remote: string;
	readonly path: string;
	n = 0;

	constructor(tmp: string) {
		this.tmp = tmp;
		this.remote = join(tmp, "remote.git");
		this.path = join(tmp, "work");
		sh(tmp, "git", "init", "-q", "--bare", "-b", "main", this.remote);
		sh(tmp, "git", "init", "-q", "-b", "main", this.path);
		for (const [k, v] of [
			["user.name", "Test"],
			["user.email", "t@example.com"],
			["commit.gpgsign", "false"],
		]) {
			this.git("config", k, v);
		}
		this.git("remote", "add", "origin", this.remote);
	}

	git(...args: string[]): string {
		return sh(this.path, "git", ...args);
	}

	commit(files?: Record<string, string>, msg?: string): string {
		this.n += 1;
		const content = files ?? { [`file${this.n}.txt`]: `content ${this.n}\n` };
		for (const [name, text] of Object.entries(content)) {
			const p = join(this.path, name);
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, text);
			this.git("add", name);
		}
		this.git("commit", "-q", "-m", msg ?? `commit ${this.n}`);
		return this.git("rev-parse", "HEAD");
	}

	push(...args: string[]): void {
		this.git("push", "-q", ...args);
	}

	enable(opts: { config?: string; checks?: Record<string, string>; answers?: unknown } = {}): void {
		const acc = join(this.path, ".acc");
		mkdirSync(join(acc, "checks"), { recursive: true });
		const base =
			'[agents.claude]\nbackend = "fake"\n\n[agents.omp]\nbackend = "fake"\n\n[agents.pi]\nbackend = "fake"\n\n' +
			'[backends.fake]\nanswers = "answers.json"\n';
		writeFileSync(join(acc, "config.toml"), base + (opts.config ?? ""));
		for (const [cid, text] of Object.entries(opts.checks ?? {})) writeFileSync(join(acc, "checks", `${cid}.toml`), text);
		writeFileSync(join(this.path, "answers.json"), JSON.stringify(opts.answers ?? {}));
	}

	config(): Config {
		return loadConfig(this.path);
	}

	read(rel: string): string {
		return readFileSync(join(this.path, rel), "utf8");
	}

	exists(rel: string): boolean {
		return existsSync(join(this.path, rel));
	}
}

/**
 * Per-test temp dir and environment: `ACC_LOG_DIR` under the temp dir, no `ACC_FAKE_ANSWERS`.
 * Returns a getter for the current test's temp dir.
 */
export function useTmp(): () => string {
	let tmp = "";
	let saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "acc-test-"));
		saved = { ACC_LOG_DIR: process.env.ACC_LOG_DIR, ACC_FAKE_ANSWERS: process.env.ACC_FAKE_ANSWERS };
		process.env.ACC_LOG_DIR = join(tmp, "logs");
		delete process.env.ACC_FAKE_ANSWERS;
	});
	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(tmp, { recursive: true, force: true });
	});
	return () => tmp;
}

/** A repo with one pushed commit (`README.md`). */
export function makeRepo(tmp: string): Repo {
	const r = new Repo(tmp);
	r.commit({ "README.md": "hello\n" }, "initial");
	r.push("-u", "origin", "main");
	return r;
}

export function ans(a: unknown, summary = "s", findings: unknown[] = []): Record<string, unknown> {
	return { answer: a, findings: [...findings], summary };
}

/** A repo with acc enabled (one active check, fake backend) and nothing unpushed. */
export function makeEnabled(tmp: string): Repo {
	const repo = makeRepo(tmp);
	repo.enable({ checks: { a: checkToml("a") }, answers: { "*": ans(0.1) } });
	repo.git("add", ".acc", "answers.json");
	repo.git("commit", "-q", "-m", "add acc");
	repo.push();
	return repo;
}

export function setAnswers(repo: Repo, answers: unknown): void {
	writeFileSync(join(repo.path, "answers.json"), JSON.stringify(answers));
}

function walk(dir: string, name: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((entry) => {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) return walk(p, name);
		return entry === name ? [p] : [];
	});
}

export function logRows(tmp: string): Record<string, any>[] {
	return walk(join(tmp, "logs"), "events.jsonl").flatMap((p) =>
		readFileSync(p, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)),
	);
}

export function checkToml(
	cid: string,
	opts: { qtype?: string; status?: string; appliesTo?: string; inputs?: string; extra?: string } = {},
): string {
	const { qtype = "bool", status = "active", appliesTo = '["**/*"]', inputs = '["diff"]', extra = "" } = opts;
	let q: string;
	let v: string;
	if (qtype === "bool") {
		q = 'type = "bool"\ninstructions = "Is there a problem?"';
		v = "block_at = 0.8\nwarn_at = 0.5";
	} else if (qtype === "choice") {
		q = 'type = "choice"\ninstructions = "Pick one."\nlabels = { good = "Fine", meh = "So-so", bad = "Broken" }';
		v = 'good = "pass"\nmeh = "warn"\nbad = "block"';
	} else {
		q = 'type = "score"\ninstructions = "Rate it."\nlevels = ["fine", "minor", "major"]';
		v = "warn_at = 1\nblock_at = 2";
	}
	return (
		`id = "${cid}"\ntitle = "Check ${cid}"\nstatus = "${status}"\n` +
		`applies_to = ${appliesTo}\ninputs = ${inputs}\n\n[question]\n${q}\n\n[verdict]\n${v}\n${extra}`
	);
}

/**
 * An executable standing in for an agent CLI: it records its cwd, stdin, argv and
 * `MAX_THINKING_TOKENS` under `dir`, then prints `stdout` and exits with `code`.
 */
export function fakeCli(dir: string, stdout: string, code = 0): { path: string; seen(): Record<string, string> } {
	mkdirSync(dir, { recursive: true });
	const out = join(dir, "stdout.txt");
	writeFileSync(out, stdout);
	const path = join(dir, "fake-cli");
	writeFileSync(
		path,
		`#!/bin/sh\npwd > "${dir}/cwd"\ncat > "${dir}/stdin"\nprintf '%s\\n' "$@" > "${dir}/argv"\n` +
			`printf '%s' "$MAX_THINKING_TOKENS" > "${dir}/thinking"\ncat "${out}"\nexit ${code}\n`,
	);
	chmodSync(path, 0o755);
	const read = (name: string): string => readFileSync(join(dir, name), "utf8");
	return {
		path,
		seen: () => ({ cwd: read("cwd").trim(), stdin: read("stdin"), argv: read("argv"), thinking: read("thinking") }),
	};
}

/** A minimal event stream ending in one assistant message_end. */
export function assistantStream(text: string | null = null, message: Record<string, unknown> = {}): string {
	const msg = { role: "assistant", content: text !== null ? [{ type: "text", text }] : [], stopReason: "stop", ...message };
	return `${[
		{ type: "session", version: 3 },
		{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "q" }] } },
		{ type: "message_end", message: msg },
		{ type: "agent_end", messages: [] },
	]
		.map((e) => JSON.stringify(e))
		.join("\n")}\n`;
}

/** An Io that records output, like pytest's capsys. */
export function captureIo(cwd: string, stdin = ""): Io & { stdout: string[]; stderr: string[]; text(): string } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		cwd,
		stdout,
		stderr,
		out: (t) => stdout.push(t),
		err: (t) => stderr.push(t),
		readStdin: async () => stdin,
		text: () => stdout.join("\n"),
	};
}

/** The BackendError a call throws (fails the test if it throws nothing or something else). */
export function backendError(fn: () => unknown): BackendError {
	try {
		fn();
	} catch (e) {
		if (e instanceof BackendError) return e;
		throw e;
	}
	throw new Error("expected a BackendError");
}
