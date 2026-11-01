import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, homeRelative, loadConfig } from "../src/config.ts";
import { useTmp } from "./helpers.ts";

const tmp = useTmp();

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
	savedEnv = { HOME: process.env.HOME, PATH: process.env.PATH };
});
afterEach(() => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

function writeConfig(root: string, command: string): void {
	mkdirSync(join(root, ".acc"), { recursive: true });
	writeFileSync(join(root, ".acc/config.toml"), `[backends.claude]\ncommand = "${command}"\n`);
}

describe("config", () => {
	test("tilde and $HOME expand", () => {
		process.env.HOME = "/home/someone";
		for (const command of ["~/.local/bin/claude", "$HOME/.local/bin/claude", "${HOME}/.local/bin/claude"]) {
			writeConfig(tmp(), command);
			expect(loadConfig(tmp()).backendSettings("claude").command).toBe("/home/someone/.local/bin/claude");
		}
	});

	test("plain names untouched", () => {
		writeConfig(tmp(), "claude");
		expect(loadConfig(tmp()).backendSettings("claude").command).toBe("claude");
	});

	test("homeRelative", () => {
		process.env.HOME = "/home/someone";
		expect(homeRelative("/home/someone/.local/bin/claude")).toBe("~/.local/bin/claude");
		expect(homeRelative("/home/someoneelse/bin/claude")).toBe("/home/someoneelse/bin/claude");
		expect(homeRelative("/usr/bin/claude")).toBe("/usr/bin/claude");
	});

	test("min_block_confidence is validated", () => {
		mkdirSync(join(tmp(), ".acc"));
		expect(loadConfig(tmp()).run.min_block_confidence).toBe(0.7);
		for (const bad of ["1.5", "-1", '"high"', "true"]) {
			writeFileSync(join(tmp(), ".acc/config.toml"), `[run]\nmin_block_confidence = ${bad}\n`);
			expect(() => loadConfig(tmp())).toThrow(ConfigError);
			expect(() => loadConfig(tmp())).toThrow(/min_block_confidence/);
		}
	});

	test("run.backend overrides every agent", () => {
		mkdirSync(join(tmp(), ".acc"));
		writeFileSync(join(tmp(), ".acc/config.toml"), '[run]\nbackend = "fake"\n\n[agents.omp]\nbackend = "claude"\n');
		const cfg = loadConfig(tmp());
		expect(cfg.backendFor("claude")).toBe("fake");
		expect(cfg.backendFor("omp")).toBe("claude"); // an explicit per-agent route still wins
		writeFileSync(join(tmp(), ".acc/config.toml"), "");
		expect(loadConfig(tmp()).backendFor("claude")).toBe("claude");
	});
});
