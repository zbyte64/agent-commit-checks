/** Parser contracts against recorded `pi -p --mode json` event streams (pi 1.4.0). */
import { expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { BackendError } from "../src/backends/base.ts";
import { PiBackend, parseOutput, providerError } from "../src/backends/pi.ts";
import { assistantStream, backendError, fakeCli, FIXTURES, useTmp } from "./helpers.ts";

const tmp = useTmp();
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");


test("recorded success (a fenced JSON answer)", () => {
	expect(parseOutput(fixture("pi_success.jsonl")).checks.dbg.answer).toBe(0.9);
});

test("a recorded provider error shows the provider's message, not its JSON envelope", () => {
	// Recorded with an invalid GEMINI_API_KEY: Google's 400 arrives as JSON inside a JSON string.
	const e = backendError(() => parseOutput(fixture("pi_provider_error.jsonl")));
	expect(e.message).toBe("pi -p failed (google/gemini-2.5-flash): API key not valid. Please pass a valid API key.");
	expect(e.retryable).toBe(false);
});

test.each([
	['{"error": {"code": 429, "message": "rate limited"}}', "rate limited", 429],
	["529 overloaded\nretry later", "529 overloaded", 529],
	["socket hang up", "socket hang up", null],
] as [string, string, number | null][])("providerError(%p)", (raw, text, status) => {
	expect(providerError(raw)).toEqual({ text, status });
});

test("rate limits and server errors are retryable", () => {
	for (const [message, retryable] of [
		['{"error": {"code": 429, "message": "slow down"}}', true],
		["503 unavailable", true],
		["401 unauthorized", false],
	] as [string, boolean][]) {
		const e = backendError(() => parseOutput(assistantStream(null, { stopReason: "error", errorMessage: message })));
		expect(e.retryable).toBe(retryable);
	}
});

test("pi's own startup errors are reported from stderr", () => {
	// Recorded: a model id several providers offer, none of them logged in.
	const stderr =
		'Error: Model "claude-haiku-4-5" is ambiguous across providers: anthropic/claude-haiku-4-5, opencode/claude-haiku-4-5. ' +
		"No matching provider is authenticated. Use --provider or provider/model.\n";
	const e = backendError(() => parseOutput("", stderr, 1));
	expect(e.message).toStartWith("pi -p exited 1 without JSON events: Error: Model");
	expect(e.retryable).toBe(false);
});

test("argv keeps the call lean and extensions out", () => {
	const argv = new PiBackend({ command: "/x/pi", model: "google/gemini-2.5-flash" }).argv("sys", "prompt", { type: "object" });
	expect(argv.slice(0, 2)).toEqual(["/x/pi", "-p"]);
	expect(argv[argv.indexOf("--model") + 1]).toBe("google/gemini-2.5-flash");
	expect(argv[argv.indexOf("--mode") + 1]).toBe("json");
	expect(argv[argv.indexOf("--thinking") + 1]).toBe("off");
	expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("sys");
	// --no-extensions keeps the acc extension out of the spawned run, so the gate cannot recurse.
	for (const flag of ["--no-tools", "--no-session", "--no-extensions", "--no-context-files"]) expect(argv).toContain(flag);
	expect(argv[argv.length - 1]).toContain('{"type":"object"}');
});

test("the default model names its provider", () => {
	expect(new PiBackend({}).model).toBe("anthropic/claude-haiku-4-5");
});

test("runs in the project dir with the data on stdin", async () => {
	const cli = fakeCli(join(tmp(), "cli"), fixture("pi_success.jsonl"));
	const out = await new PiBackend({ command: cli.path }, tmp()).ask("s", "p", "DATA", { type: "object" }, 5);
	expect(out.checks.dbg.answer).toBe(0.9);
	expect(cli.seen().cwd).toBe(realpathSync(tmp()));
	expect(cli.seen().stdin).toBe("DATA");
});

test("missing binary", async () => {
	await expect(new PiBackend({ command: "/nonexistent/pi" }).ask("s", "p", "", { type: "object" }, 5)).rejects.toThrow("pi CLI not found");
});
