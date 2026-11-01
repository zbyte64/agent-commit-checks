/** The push gate: decide on an agent's push command, in the agent's own feedback format. */
import { basename, resolve } from "node:path";
import { getBackend } from "./backends/index.ts";
import { type Finding, loadAll, type Verdict } from "./checks.ts";
import { ConfigError, isEnabled, loadConfig } from "./config.ts";
import * as g from "./git.ts";
import { parseCommand } from "./gitcmd.ts";
import * as log from "./log.ts";
import { resolveFallback, resolvePush } from "./pushrange.ts";
import { type EntryResult, review, type RunResult } from "./runner.ts";

const FIX_HINT =
	"Fix these with a new commit, or by amending or rebasing the unpushed commits, " +
	"then run the push again as its own command.";

export interface Decision {
	verdict: Verdict;
	/** Agent-facing text for warn/block. */
	reason: string;
	/** Short line for the user. */
	userMessage: string;
}

function decision(verdict: Verdict, reason = "", userMessage = ""): Decision {
	return { verdict, reason, userMessage };
}

function findingText(f: Finding): string {
	let loc = f.file ?? "";
	if (loc && f.line) loc += `:${f.line}`;
	return loc ? `${f.message} (${loc})` : f.message;
}

/** Agent-facing feedback: each check's answer about the pushed commits as a whole. */
export function formatResult(res: RunResult): string {
	const lines: string[] = [];
	if (res.secretBlocked) {
		lines.push("acc: push blocked by the local secret scan (no model was called).");
		for (const h of res.secretHits) lines.push(`- ${g.short(h.commit ?? "")} ${h.file}:${h.line}: possible ${h.pattern}`);
		lines.push(
			"Remove the secret from every unpushed commit that adds it (amend or rebase; a new " +
				"commit that deletes it is not enough, because history still contains it), " +
				"then push again. Rotate the credential if it is real.",
		);
		return lines.join("\n");
	}

	const blocks = res.entries.filter((e) => e.verdict === "block");
	const warns = res.entries.filter((e) => e.verdict === "warn");
	const n = res.commits.length;
	const reviewed = `${n} commit${n !== 1 ? "s" : ""} reviewed together`;
	if (blocks.length) lines.push(`acc: push blocked (${reviewed}).`);
	else if (warns.length) lines.push(`acc: push allowed with warnings (${reviewed}).`);

	const emit = (e: EntryResult, label: string): void => {
		const head = `- [${label}] ${e.checkId}`;
		if (e.error) {
			lines.push(`${head}: check could not run (${e.error})`);
			return;
		}
		const conf = e.confidence !== null ? `, confidence ${e.confidence.toFixed(2)}` : "";
		lines.push(`${head} (answer: ${e.answerText}${conf}): ${e.summary}`.replace(/[: ]+$/, ""));
		for (const f of e.findings) lines.push(`    ${findingText(f)}`);
	};

	for (const e of blocks) emit(e, "block");
	for (const e of warns) {
		if (e.rawVerdict === e.verdict) emit(e, "warn");
		else if (e.lowConfidence) emit(e, "warn, low confidence");
		else emit(e, `warn, ${e.status} check`);
	}
	for (const note of res.notes) lines.push(`Note: ${note}`);
	if (blocks.length) lines.push(FIX_HINT);
	return lines.join("\n");
}

export async function decide(command: string, cwd: string, agent: string): Promise<Decision> {
	const parsed = parseCommand(command);
	if (parsed.kind === "none") return decision("pass");
	let dir = cwd;
	if (parsed.pushes.length && parsed.pushes[0].cwd) dir = resolve(cwd, parsed.pushes[0].cwd);
	let root: string;
	try {
		root = await g.repoRoot(dir);
	} catch (e) {
		if (e instanceof g.GitError) return decision("pass"); // not a git repo: nothing to review
		throw e;
	}
	if (!isEnabled(root)) return decision("pass");
	if (parsed.kind === "commit_and_push") {
		return decision(
			"block",
			"acc: this command creates a commit and pushes in one step, so the new commit cannot be " +
				"reviewed before the push. Run the commit first, then run `git push` as its own command.",
			"acc: asked the agent to push in a separate command",
		);
	}

	const cfg = loadConfig(root);
	const push = parsed.kind === "unknown" ? await resolveFallback(dir, parsed.reason) : await resolvePush(dir, parsed.pushes);
	if (push.empty) return decision("pass");

	const { checks, errors } = loadAll(cfg.checksDir);
	const gateChecks = checks.filter((c) => c.runsInGate);
	const backend = getBackend(cfg, agent);
	const res = await review(cfg, dir, push, gateChecks, backend);
	const invalid = Object.keys(errors).sort();
	if (invalid.length) res.notes.push(`Invalid check files were skipped: ${invalid.join(", ")} (run \`acc validate\`).`);

	log.write({
		repo: basename(root),
		agent,
		backend: res.backend,
		model: res.model,
		command,
		range: res.range,
		commits: res.commits.length,
		diff_sha256: res.diffSha256,
		diff_chars: res.diffChars,
		truncated: res.truncated,
		calls: res.calls,
		checks: res.entries.map((e) => ({
			id: e.checkId,
			answer: e.answer ?? null,
			confidence: e.confidence,
			verdict: e.verdict,
			...(e.error ? { error: e.error } : {}),
		})),
		secret_hits: res.secretHits.filter((h) => h.severity === "block").length,
		verdict: res.verdict,
		latency_ms: res.latencyMs,
	});

	if (res.verdict === "pass") return decision("pass");
	const text = formatResult(res);
	let counts =
		`${res.entries.filter((e) => e.verdict === "block").length} blocking, ` +
		`${res.entries.filter((e) => e.verdict === "warn").length} warning`;
	const summary = res.verdict === "block" ? "acc: push blocked" : "acc: push checks warned";
	if (res.secretBlocked) counts = "secret scan";
	return decision(res.verdict, text, `${summary} (${counts})`);
}

/** `decide`, but every failure becomes a block with the error as the reason. */
export async function safeDecide(command: string, cwd: string, agent: string): Promise<Decision> {
	try {
		return await decide(command, cwd, agent);
	} catch (e) {
		if (e instanceof ConfigError) return decision("block", `acc gate: invalid .acc/config.toml: ${e.message}`, "acc: gate failed");
		const err = e instanceof Error ? e : new Error(String(e));
		return decision(
			"block",
			`acc gate failed before reviewing the push: ${err.name}: ${err.message}. ` +
				"Report this to the user; do not try to bypass the check.",
			"acc: gate error",
		);
	}
}

/** Claude Code PreToolUse hook JSON. `pass` gives nothing so the normal permission flow runs. */
export function claudeOutput(d: Decision): Record<string, unknown> | null {
	if (d.verdict === "pass") return null;
	if (d.verdict === "warn") {
		return {
			systemMessage: d.userMessage,
			hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: d.reason },
		};
	}
	return {
		systemMessage: d.userMessage,
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: d.reason,
		},
	};
}

/** Entry point for `acc gate --agent claude`. Always returns hook JSON (or empty), never throws. */
export async function runClaudeHook(stdinText: string): Promise<string> {
	let payload: Record<string, any>;
	try {
		payload = JSON.parse(stdinText);
	} catch (e) {
		return JSON.stringify(claudeOutput(decision("block", `acc gate: invalid hook input: ${(e as Error).message}`, "acc: gate failed")));
	}
	if (payload?.tool_name !== "Bash") return "";
	const command: string = payload.tool_input?.command || "";
	const cwd = resolve(payload.cwd || ".");
	const out = claudeOutput(await safeDecide(command, cwd, "claude"));
	return out ? JSON.stringify(out) : "";
}
