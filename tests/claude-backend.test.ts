/** Parser contracts against recorded `claude -p --output-format json` results. */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BackendError } from "../src/backends/base.ts";
import { ClaudeBackend, parseOutput } from "../src/backends/claude.ts";
import { backendError, fakeCli, FIXTURES, useTmp } from "./helpers.ts";

const tmp = useTmp();
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");


test("success object", () => {
	expect(parseOutput(fixture("claude_success_object.json")).checks.dbg.answer).toBe(0.95);
});

test("verbose array falls back to the StructuredOutput tool call", () => {
	// Recorded with --max-turns 1: the run ends with error_max_turns after the StructuredOutput call,
	// so the answer is recovered from the tool input.
	expect(parseOutput(fixture("claude_max_turns_array.json")).checks.dbg.answer).toBe(0.99);
});

test("auth error", () => {
	const e = backendError(() => parseOutput(fixture("claude_auth_error.json")));
	expect(e.message).toContain("login");
	expect(e.retryable).toBe(false);
});

test("not JSON", () => {
	expect(() => parseOutput("", "Error: not logged in", 1)).toThrow("without JSON");
});

test("a missing checks key is retryable", () => {
	const e = backendError(() => parseOutput('{"type": "result", "is_error": false, "structured_output": {"other": 1}}'));
	expect(e.retryable).toBe(true);
});

test("argv flags", () => {
	const argv = new ClaudeBackend({ command: "/x/claude", model: "haiku" }).argv("sys", "prompt", { type: "object" });
	expect(argv[0]).toBe("/x/claude");
	expect(argv).not.toContain("--bare");
	const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
	expect(settings.disableAllHooks).toBe(true);
	expect(settings.alwaysThinkingEnabled).toBe(false);
	expect(argv[argv.indexOf("--tools") + 1]).toBe("");
	expect(argv[argv.indexOf("--max-turns") + 1]).toBe("4");
	expect(argv[argv.length - 1]).toBe("prompt");
});

test("missing binary", async () => {
	await expect(new ClaudeBackend({ command: "/nonexistent/claude" }).ask("s", "p", "", { type: "object" }, 5)).rejects.toThrow("not found");
});

const savedThinking = process.env.MAX_THINKING_TOKENS;
afterEach(() => {
	if (savedThinking === undefined) delete process.env.MAX_THINKING_TOKENS;
	else process.env.MAX_THINKING_TOKENS = savedThinking;
});

test("thinking is forced off even if the agent's env enables it", async () => {
	process.env.MAX_THINKING_TOKENS = "8000";
	const cli = fakeCli(join(tmp(), "cli"), fixture("claude_success_object.json"));
	await new ClaudeBackend({ command: cli.path }).ask("s", "p", "DATA", { type: "object" }, 5);
	expect(cli.seen().thinking).toBe("0");
	expect(cli.seen().stdin).toBe("DATA");
});
