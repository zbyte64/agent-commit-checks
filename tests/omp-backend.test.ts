/** Parser contracts against recorded `omp -p --mode json` event streams. */
import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { BackendError } from "../src/backends/base.ts";
import { OmpBackend, parseOutput } from "../src/backends/omp.ts";
import { assistantStream, backendError, fakeCli, FIXTURES, useTmp } from "./helpers.ts";

const tmp = useTmp();
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");


test("recorded success", () => {
	expect(parseOutput(fixture("omp_success.jsonl")).checks["no-debug-leftovers"].answer).toBe(0.95);
});

test("a recorded provider error is not retryable", () => {
	// Recorded: a 402 billing error ends the run with stopReason "error" and exit 1.
	const e = backendError(() => parseOutput(fixture("omp_provider_error.jsonl"), "", 1));
	expect(e.message).toContain("Insufficient Balance");
	expect(e.retryable).toBe(false);
});

test.each([
	[429, true],
	[529, true],
	[401, false],
	[null, false],
] as [number | null, boolean][])("provider error %p retryable=%p", (status, retryable) => {
	const e = backendError(() => parseOutput(assistantStream(null, { stopReason: "error", errorStatus: status, errorMessage: "boom\ndetail" })));
	expect(e.retryable).toBe(retryable);
	expect(e.message.endsWith("boom")).toBe(true);
});

test("a fenced answer is accepted", () => {
	expect(parseOutput(assistantStream('Here you go:\n```json\n{"checks": {"a": {"answer": 1}}}\n```')).checks.a.answer).toBe(1);
});

test.each([
	["I think the answer is yes.", "stop", "not a JSON object"],
	['{"checks": {"a": ', "length", "cut off"],
	['{"result": {}}', "stop", "no `checks` object"],
])("invalid answer %p is retryable", (text, stop, match) => {
	const e = backendError(() => parseOutput(assistantStream(text, { stopReason: stop })));
	expect(e.message).toContain(match);
	expect(e.retryable).toBe(true);
});

test("an unset role names the fix", () => {
	// Recorded: `omp -p --model @decision` with no modelRoles.decision prints this on stderr and exits 1.
	const stderr = 'Model "@decision" not found\n\nRun `omp models find <pattern>` to search, or `omp models` to list all.\n';
	const e = backendError(() => parseOutput("", stderr, 1, "@decision"));
	expect(e.message).toContain("modelRoles");
	expect(e.message).toContain('Model "@decision" not found');
	expect(e.retryable).toBe(false);
});

test("argv flags", () => {
	const argv = new OmpBackend({ command: "/x/omp", model: "@decision" }).argv("sys", "prompt", { type: "object" });
	expect(argv.slice(0, 2)).toEqual(["/x/omp", "-p"]);
	expect(argv[argv.indexOf("--model") + 1]).toBe("@decision");
	expect(argv[argv.indexOf("--mode") + 1]).toBe("json");
	expect(argv[argv.indexOf("--thinking") + 1]).toBe("off");
	expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("sys");
	// No tools, no session and no extensions: one text answer, and the gate cannot recurse.
	for (const flag of ["--no-tools", "--no-session", "--no-extensions"]) expect(argv).toContain(flag);
	// The overlay turns omp memory off, so one review's diff is never recalled into the next.
	expect(existsSync(argv[argv.indexOf("--config") + 1])).toBe(true);
	const last = argv[argv.length - 1];
	expect(last.startsWith("prompt")).toBe(true);
	expect(last).toContain('{"type":"object"}');
});

test("runs in the project dir with the data on stdin", async () => {
	const cli = fakeCli(join(tmp(), "cli"), fixture("omp_success.jsonl"));
	await new OmpBackend({ command: cli.path }, tmp()).ask("s", "p", "DATA", { type: "object" }, 5);
	expect(cli.seen().cwd).toBe(realpathSync(tmp()));
	expect(cli.seen().stdin).toBe("DATA");
});

test("missing binary", async () => {
	await expect(new OmpBackend({ command: "/nonexistent/omp" }).ask("s", "p", "", { type: "object" }, 5)).rejects.toThrow("not found");
});
