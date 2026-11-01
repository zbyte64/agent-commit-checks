/** `acc init --omp/--pi` and `acc doctor --agent omp/pi` against stand-in omp and pi CLIs. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { main } from "../src/cli.ts";
import { captureIo, checkToml, makeRepo, useTmp } from "./helpers.ts";

const tmp = useTmp();
let saved: Record<string, string | undefined>;
beforeEach(() => {
	saved = { HOME: process.env.HOME, PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
});
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

/** Fake `omp` and `pi` on PATH and an isolated home. Returns setters for what they report. */
function agentEnv() {
	const home = join(tmp(), "home");
	const bindir = join(home, ".local", "bin");
	mkdirSync(bindir, { recursive: true });
	const agentDir = join(home, ".omp", "agent");
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PATH = `${bindir}${delimiter}${process.env.PATH}`;
	const write = (name: string, body: string): void => {
		const p = join(bindir, name);
		writeFileSync(p, `#!/bin/sh\n${body}`);
		chmodSync(p, 0o755);
	};
	const omp = (roles: Record<string, string>, timeoutMs = 30000, installed = false): void => {
		// `omp config get <key> --json` prints {"key", "value", ...}; `omp plugin list --json` lists npm plugins.
		const values: Record<string, unknown> = { modelRoles: roles, "extensionHandlers.toolCallTimeoutMs": timeoutMs };
		const cases = Object.entries(values)
			.map(([key, v]) => `  ${key}) echo '${JSON.stringify({ key, value: v })}' ;;\n`)
			.join("");
		const plugins = JSON.stringify({ npm: installed ? [{ name: "agent-commit-checks", version: "0.1.0", enabled: true }] : [], marketplace: [] });
		write("omp", `if [ "$1" = plugin ]; then echo '${plugins}'; exit 0; fi\ncase "$3" in\n${cases}  *) exit 1 ;;\nesac\n`);
	};
	const pi = (installed: boolean): void => {
		write("pi", installed ? `echo "User packages:\n  npm:agent-commit-checks\n    agent-commit-checks"` : 'echo "No packages installed."');
	};
	omp({});
	pi(false);
	return { home, agentDir, omp, pi };
}

test("init --omp explains the install, the role and the extension", async () => {
	const env = agentEnv();
	const repo = makeRepo(tmp());
	let io = captureIo(repo.path);
	expect(await main(["init", "--omp"], io)).toBe(0);
	const config = repo.read(".acc/config.toml");
	expect(config).toContain('command = "~/.local/bin/omp"');
	expect(config).toContain('model = "@decision"');
	expect(io.text()).toContain("omp install npm:agent-commit-checks");
	expect(io.text()).toContain("modelRoles:\n  decision:");
	expect(io.text()).not.toContain("PreToolUse");

	env.omp({ decision: "anthropic/claude-haiku-5-5" }, 180000, true);
	io = captureIo(repo.path);
	expect(await main(["init", "--omp"], io)).toBe(0);
	expect(io.text()).toContain("The acc extension is installed in omp.");
	expect(io.text()).toContain("omp role @decision -> anthropic/claude-haiku-5-5");
});

test("doctor --agent omp", async () => {
	const env = agentEnv();
	const repo = makeRepo(tmp());
	repo.enable({ checks: { a: checkToml("a") } });
	let io = captureIo(repo.path);
	expect(await main(["doctor", "--agent", "omp", "--offline"], io)).toBe(0);
	expect(io.text()).toContain("[warn] acc extension not found in `omp plugin list`");
	expect(io.text()).toContain("[warn] omp extensionHandlers.toolCallTimeoutMs is 30000");

	env.omp({ decision: "anthropic/claude-haiku-5-5" }, 180000, true);
	io = captureIo(repo.path);
	expect(await main(["doctor", "--agent", "omp", "--offline"], io)).toBe(0);
	expect(io.text()).toContain("[ok  ] acc extension installed in omp");
	expect(io.text()).toContain("[ok  ] omp extensionHandlers.toolCallTimeoutMs is 180000");

	// The Python version's extension file calls a gate command that is gone: it would block every push.
	const legacy = join(env.agentDir, "extensions", "acc.ts");
	mkdirSync(join(env.agentDir, "extensions"), { recursive: true });
	writeFileSync(legacy, "// old\n");
	io = captureIo(repo.path);
	expect(await main(["doctor", "--agent", "omp", "--offline"], io)).toBe(1);
	expect(io.text()).toContain(`[FAIL] old acc extension ${legacy} is still installed`);
});

test("doctor reports an unset omp role", async () => {
	const env = agentEnv();
	const repo = makeRepo(tmp());
	mkdirSync(join(repo.path, ".acc"));
	writeFileSync(join(repo.path, ".acc/config.toml"), '[backends.omp]\ncommand = "~/.local/bin/omp"\n');
	let io = captureIo(repo.path);
	await main(["doctor", "--agent", "omp", "--offline"], io);
	expect(io.text()).toContain("[ok  ] omp binary is executable");
	expect(io.text()).toContain("[warn] omp role @decision is not set");
	env.omp({ decision: "anthropic/claude-haiku-5-5" });
	io = captureIo(repo.path);
	await main(["doctor", "--agent", "omp", "--offline"], io);
	expect(io.text()).toContain("[ok  ] omp role @decision -> anthropic/claude-haiku-5-5");
});

test("init --pi and doctor --agent pi", async () => {
	const env = agentEnv();
	const repo = makeRepo(tmp());
	let io = captureIo(repo.path);
	expect(await main(["init", "--pi"], io)).toBe(0);
	expect(repo.read(".acc/config.toml")).toContain('command = "~/.local/bin/pi"');
	expect(io.text()).toContain("pi install npm:agent-commit-checks");
	expect(io.text()).toContain('backends.pi.model = "anthropic/claude-haiku-4-5"');

	io = captureIo(repo.path);
	expect(await main(["doctor", "--agent", "pi", "--offline"], io)).toBe(0);
	expect(io.text()).toContain("[ok  ] pi binary is executable");
	expect(io.text()).toContain("[warn] acc extension not found in `pi list`");
	env.pi(true);
	io = captureIo(repo.path);
	await main(["doctor", "--agent", "pi", "--offline"], io);
	expect(io.text()).toContain("[ok  ] acc extension installed in pi");
});
