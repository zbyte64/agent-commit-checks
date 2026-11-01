/**
 * agent-commit-checks for pi (https://pi.dev). Install with `pi install git:github.com/zbyte64/agent-commit-checks`.
 *
 * - Gates `git push` in the bash tool: the checks run in-process before the command does.
 *   block -> the push does not run and the findings go back to the model as the tool error.
 *   warn  -> the push runs and the findings are added to the bash tool's result.
 *   Any failure inside the gate blocks the push (fail closed).
 * - Registers the check tools (list_checks, run_checks, test_check, grade_check, add_check,
 *   update_check, promote_check) and the /acc command.
 */
import { Type } from "typebox";
import { checkTools, gateToolCall, registerAccCommand } from "../common.ts";
import type { HostApi } from "../host.ts";

export default function accCommitChecks(pi: HostApi): void {
	// pi's tool_call result can only block; a warning is added to the tool's own result instead.
	const warnings = new Map<string, string>();

	pi.on("tool_call", async (event, ctx) => {
		const d = await gateToolCall(event, ctx, "pi");
		if (!d || d.verdict === "pass") return undefined;
		if (d.verdict === "block") return { block: true, reason: d.reason || "acc: push blocked" };
		if (d.reason) warnings.set(event.toolCallId, d.reason);
		return undefined;
	});

	pi.on("tool_result", (event) => {
		const warning = warnings.get(event.toolCallId);
		if (warning === undefined) return undefined;
		warnings.delete(event.toolCallId);
		return { content: [...event.content, { type: "text", text: `\n${warning}` }] };
	});

	for (const tool of checkTools("pi", (schema) => Type.Unsafe(schema))) pi.registerTool(tool);
	registerAccCommand(pi, "pi");
}
