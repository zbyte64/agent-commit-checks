/** Pipe recorded-shape PreToolUse payloads into `acc gate --agent claude`, through the real launcher. */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ans, checkToml, FAKE_AWS_KEY, logRows, makeEnabled, makeRepo, type Repo, setAnswers, useTmp } from "./helpers.ts";

const tmp = useTmp();
const ACC = join(import.meta.dir, "..", "bin", "acc.mjs");

function gate(repo: Repo, command: string, opts: { tool?: string; cwd?: string; raw?: string } = {}): Record<string, any> | null {
	const payload =
		opts.raw ??
		JSON.stringify({
			session_id: "s",
			transcript_path: "/tmp/t.jsonl",
			cwd: opts.cwd ?? repo.path,
			permission_mode: "default",
			hook_event_name: "PreToolUse",
			tool_name: opts.tool ?? "Bash",
			tool_input: { command, description: "Push" },
			tool_use_id: "toolu_1",
		});
	const proc = spawnSync(process.execPath, [ACC, "gate", "--agent", "claude"], { input: payload, encoding: "utf8", env: process.env });
	expect(proc.status, proc.stderr).toBe(0);
	return proc.stdout.trim() ? JSON.parse(proc.stdout) : null;
}

const reasonOf = (out: Record<string, any> | null): string => out?.hookSpecificOutput.permissionDecisionReason;

test("not a push", () => {
	expect(gate(makeEnabled(tmp()), "ls")).toBeNull();
});

test("another tool", () => {
	expect(gate(makeEnabled(tmp()), "git push", { tool: "Edit" })).toBeNull();
});

test("pass prints nothing and logs the run", () => {
	const repo = makeEnabled(tmp());
	repo.commit();
	expect(gate(repo, "git push")).toBeNull();
	const row = logRows(tmp()).at(-1) ?? {};
	expect(row.verdict).toBe("pass");
	expect(row.commits).toBe(1);
	expect(row.agent).toBe("claude");
	expect(row.calls).toBe(1);
	expect("diff" in row).toBe(false);
});

test("block denies with findings", () => {
	const repo = makeEnabled(tmp());
	repo.commit();
	setAnswers(repo, { a: ans(0.95, "Leaves a debug print", [{ file: "x.py", line: 3, message: "print" }]) });
	const out = gate(repo, "git push origin main");
	const hso = out?.hookSpecificOutput;
	expect(hso.hookEventName).toBe("PreToolUse");
	expect(hso.permissionDecision).toBe("deny");
	const reason: string = hso.permissionDecisionReason;
	for (const s of ["acc: push blocked", "Leaves a debug print", "print (x.py:3)", "push again"]) expect(reason).toContain(s);
	expect(logRows(tmp()).at(-1)?.verdict).toBe("block");
});

test("a block reviews the commits together", () => {
	const repo = makeEnabled(tmp());
	repo.commit();
	repo.commit();
	setAnswers(repo, { a: ans(0.9, "bad") });
	const reason = reasonOf(gate(repo, "git push"));
	expect(reason).toContain("push blocked (2 commits reviewed together)");
	expect(reason).toContain("- [block] a (answer: 0.9, confidence 1.00): bad");
});

test("a low-confidence block warns", () => {
	const repo = makeEnabled(tmp());
	repo.commit();
	setAnswers(repo, { a: { ...ans(0.95, "maybe a debug print"), confidence: 0.4 } });
	const out = gate(repo, "git push");
	expect("permissionDecision" in out?.hookSpecificOutput).toBe(false);
	expect(out?.hookSpecificOutput.additionalContext).toContain("- [warn, low confidence] a (answer: 0.95, confidence 0.40): maybe a debug print");
});

test("warn adds context", () => {
	const repo = makeEnabled(tmp());
	repo.commit();
	setAnswers(repo, { a: ans(0.6, "Maybe a debug print") });
	const out = gate(repo, "git push");
	expect("permissionDecision" in out?.hookSpecificOutput).toBe(false);
	expect(out?.hookSpecificOutput.additionalContext).toContain("Maybe a debug print");
	expect(out?.systemMessage.startsWith("acc:")).toBe(true);
});

test("commit and push is denied without a model call", () => {
	const repo = makeEnabled(tmp());
	setAnswers(repo, { "*": "error" });
	const out = gate(repo, "git commit -am 'x' && git push");
	expect(out?.hookSpecificOutput.permissionDecision).toBe("deny");
	expect(reasonOf(out)).toContain("as its own command");
	expect(logRows(tmp())).toEqual([]);
});

test("nothing to push", () => {
	const repo = makeEnabled(tmp());
	setAnswers(repo, { "*": "error" });
	expect(gate(repo, "git push")).toBeNull();
});

test("deletes and tags are allowed", () => {
	const repo = makeEnabled(tmp());
	repo.commit();
	setAnswers(repo, { "*": "error" });
	expect(gate(repo, "git push origin --delete old")).toBeNull();
	expect(gate(repo, "git push --tags")).toBeNull();
});

test("a backend error blocks with its reason", () => {
	const repo = makeEnabled(tmp());
	repo.commit();
	setAnswers(repo, { "*": "error" });
	const reason = reasonOf(gate(repo, "git push"));
	expect(reason).toContain("could not run");
	expect(reason).toContain("fake backend error");
});

test("an unknown command reviews the upstream range", () => {
	const repo = makeEnabled(tmp());
	repo.commit();
	setAnswers(repo, { a: ans(0.95) });
	expect(reasonOf(gate(repo, "git push origin $(git branch --show-current)"))).toContain("could not tell exactly");
});

test("cd into the repo", () => {
	const repo = makeEnabled(tmp());
	repo.commit();
	setAnswers(repo, { a: ans(0.95) });
	expect(gate(repo, `cd ${repo.path} && git push`, { cwd: tmp() })?.hookSpecificOutput.permissionDecision).toBe("deny");
	expect(gate(repo, `cd ${relative(tmp(), repo.path)} && git push`, { cwd: tmp() })?.hookSpecificOutput.permissionDecision).toBe("deny");
});

test("secret block", () => {
	const repo = makeEnabled(tmp());
	repo.commit({ "k.py": `K = "${FAKE_AWS_KEY}"\n` });
	const reason = reasonOf(gate(repo, "git push"));
	expect(reason).toContain("secret scan");
	expect(reason).toContain("k.py:1");
	expect(reason).not.toContain(FAKE_AWS_KEY);
	const row = logRows(tmp()).at(-1) ?? {};
	expect(row.calls).toBe(0);
	expect(JSON.stringify(row)).not.toContain(FAKE_AWS_KEY);
});

test("a redacted secret does not mask a check's block", () => {
	const repo = makeEnabled(tmp());
	repo.commit({ "settings.ini": "DB_PASSWORD=hunter2\n" });
	setAnswers(repo, { a: ans(0.95, "Real problem") });
	const reason = reasonOf(gate(repo, "git push"));
	expect(reason.split("\n")[0]).not.toContain("secret scan");
	expect(reason).toContain("Real problem");
	expect(reason).toContain("redacted");
});

test("a repo without .acc is ignored", () => {
	const repo = makeRepo(tmp());
	repo.commit();
	expect(gate(repo, "git push")).toBeNull();
});

test("outside a git repo", () => {
	const repo = makeRepo(tmp());
	expect(gate(repo, "git push", { cwd: tmp() })).toBeNull();
});

test("an invalid payload blocks", () => {
	const out = gate(makeRepo(tmp()), "", { raw: "not json" });
	expect(out?.hookSpecificOutput.permissionDecision).toBe("deny");
});

test("an invalid config blocks", () => {
	const repo = makeEnabled(tmp());
	repo.commit();
	writeFileSync(join(repo.path, ".acc/config.toml"), "[run\n");
	expect(reasonOf(gate(repo, "git push"))).toContain("config.toml");
});

test("proposed checks skip the gate", () => {
	const repo = makeEnabled(tmp());
	repo.commit();
	writeFileSync(join(repo.path, ".acc/checks/a.toml"), checkToml("a", { status: "proposed" }));
	setAnswers(repo, { "*": "error" });
	expect(gate(repo, "git push")).toBeNull();
});
