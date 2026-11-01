/** Running external programs: git, the agent CLIs and llama-server. */
import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Python's `shutil.which`: the path a command name runs from, or null. Paths are checked as given. */
export function which(command: string): string | null {
	if (command.includes("/")) return isExecutableFile(command) ? command : null;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, command);
		if (isExecutableFile(candidate)) return candidate;
	}
	return null;
}

export interface RunOptions {
	cwd?: string;
	/** Written to stdin, then closed. Without it stdin is not connected, so a child never reads the agent's terminal. */
	input?: string;
	/** Kills the process (SIGKILL) after this many milliseconds. */
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

export interface RunResult {
	stdout: string;
	stderr: string;
	/** Exit code, or null when a signal ended the process. */
	code: number | null;
	timedOut: boolean;
}

/** The program could not be started (missing or not executable). */
export class SpawnError extends Error {
	readonly command: string;
	readonly code: string;
	constructor(command: string, code: string, message: string) {
		super(message);
		this.name = "SpawnError";
		this.command = command;
		this.code = code;
	}
}

function spawnError(command: string, err: unknown): SpawnError {
	const e = err as NodeJS.ErrnoException;
	return new SpawnError(command, e.code ?? "ESPAWN", `${command}: ${e.message}`);
}

/** Run a program to completion and capture its output as UTF-8 (invalid bytes become U+FFFD). */
export function run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
	const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
	let child: ChildProcess;
	try {
		child = spawn(command, args, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
	} catch (err) {
		reject(spawnError(command, err));
		return promise;
	}
	const out: Buffer[] = [];
	const errOut: Buffer[] = [];
	let timedOut = false;
	const timer =
		opts.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, opts.timeoutMs);
	child.stdout?.on("data", (b: Buffer) => out.push(b));
	child.stderr?.on("data", (b: Buffer) => errOut.push(b));
	child.on("error", (err) => {
		clearTimeout(timer);
		reject(spawnError(command, err));
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		resolve({
			stdout: Buffer.concat(out).toString("utf8"),
			stderr: Buffer.concat(errOut).toString("utf8"),
			code,
			timedOut,
		});
	});
	if (opts.input !== undefined && child.stdin) {
		// A child that exits without reading all of stdin is not an error here; its exit status says what happened.
		child.stdin.on("error", () => {});
		child.stdin.end(opts.input);
	}
	return promise;
}
