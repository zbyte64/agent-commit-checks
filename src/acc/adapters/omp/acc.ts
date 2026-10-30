/**
 * agent-commit-checks for oh-my-pi: runs `acc gate --agent omp` before any `git push`
 * issued through the bash tool. Install with `acc init --omp`, which copies this file to
 * ~/.omp/agent/extensions/acc.ts with the absolute `acc` path filled in.
 *
 * block -> the push does not run and the findings go back to the model as the tool error.
 * warn  -> the push runs and the findings reach the model after the tool results.
 * If acc cannot run or prints invalid JSON, the push is blocked (fail closed).
 */
import * as path from "node:path";
import type { ExecResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const ACC = "__ACC__";
// Caps a hung gate. omp also bounds the handler with extensionHandlers.toolCallTimeoutMs
// (default 30s, fail closed); `acc init --omp` explains how to raise it.
const GATE_TIMEOUT_MS = 180_000;

interface GateResult {
	verdict: "pass" | "warn" | "block";
	reason?: string;
	context?: string;
	message?: string;
}

export default function accCommitChecks(pi: ExtensionAPI) {
	pi.setLabel("acc commit checks");

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const { command, cwd } = event.input as { command?: unknown; cwd?: unknown };
		// Cheap prefilter; `acc gate` parses the command properly and allows anything that is not a push.
		if (typeof command !== "string" || !/\bgit\b/.test(command) || !/\bpush\b/.test(command)) return;
		const dir = typeof cwd === "string" && cwd ? path.resolve(ctx.cwd, cwd) : ctx.cwd;

		if (ctx.hasUI) ctx.ui.setStatus("acc", "acc: running push checks");
		let res: ExecResult;
		try {
			res = await pi.exec(ACC, ["gate", "--agent", "omp", "--cwd", dir, "--command", command], {
				timeout: GATE_TIMEOUT_MS,
			});
		} catch (err) {
			return { block: true, reason: `acc gate could not run (${ACC}): ${err}` };
		} finally {
			if (ctx.hasUI) ctx.ui.setStatus("acc", undefined);
		}

		let out: GateResult;
		try {
			out = JSON.parse(res.stdout) as GateResult;
		} catch {
			const detail = (res.stderr || res.stdout).trim() || `exit code ${res.code}`;
			return {
				block: true,
				reason:
					`acc gate failed${res.killed ? " (timed out)" : ""}: ${detail}. ` +
					"Report this to the user; do not try to bypass the check.",
			};
		}

		if (out.message && out.verdict !== "pass" && ctx.hasUI) {
			ctx.ui.notify(out.message, out.verdict === "block" ? "warning" : "info");
		}
		if (out.verdict === "block") return { block: true, reason: out.reason || "acc: push blocked" };
		if (out.verdict === "warn" && out.context) return { additionalContext: out.context };
	});
}
