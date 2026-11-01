/**
 * agent-commit-checks for oh-my-pi. Install with `omp install npm:agent-commit-checks`.
 *
 * - Gates `git push` in the bash tool: the checks run in-process before the command does.
 *   block -> the push does not run and the findings go back to the model as the tool error.
 *   warn  -> the push runs and the findings reach the model after the tool results.
 *   Any failure inside the gate blocks the push (fail closed).
 * - Registers the check tools (list_checks, run_checks, test_check, grade_check, add_check,
 *   update_check, promote_check) and the /acc command.
 * - Raises extensionHandlers.toolCallTimeoutMs to the gate's worst case for the session, unless the
 *   user set it: omp stops a slower tool_call handler and blocks the push.
 */
import { gateBudgetMs } from "../../agentSetup.ts";
import { isEnabled, loadConfig } from "../../config.ts";
import * as g from "../../git.ts";
import { checkTools, gateToolCall, registerAccCommand } from "../common.ts";
import type { HostApi, HostContext } from "../host.ts";

interface SettingHandle {
	isConfigured(scope: unknown): boolean;
	get(scope: unknown): unknown;
	override(scope: unknown, value: unknown): void;
}

interface OmpApi extends HostApi {
	setLabel(label: string): void;
	typebox: { Type: { Unsafe(schema: Record<string, unknown>): unknown } };
	pi: { settings: unknown };
}

const TIMEOUT_SETTING = "extensionHandlers.toolCallTimeoutMs";

async function raiseToolCallTimeout(pi: OmpApi, ctx: HostContext): Promise<void> {
	let root: string;
	try {
		root = await g.repoRoot(ctx.cwd);
	} catch {
		return; // not a git repo: no pushes to gate here
	}
	if (!isEnabled(root)) return;
	let budget: number;
	try {
		budget = gateBudgetMs(Number(loadConfig(root).run.timeout_seconds));
	} catch {
		return; // an invalid config blocks pushes with its own message
	}
	let lookup: ((id: string) => SettingHandle | undefined) | undefined;
	try {
		// Host module: the settings registry exists only inside omp (and only in recent versions).
		({ lookup } = (await import("@oh-my-pi/pi-coding-agent/config/registry")) as { lookup: typeof lookup });
	} catch {
		return;
	}
	const setting = lookup?.(TIMEOUT_SETTING);
	const scope = pi.pi.settings;
	if (!setting || setting.isConfigured(scope)) return;
	const current = setting.get(scope);
	if (typeof current !== "number" || current < budget) setting.override(scope, budget);
}

export default function accCommitChecks(pi: OmpApi): void {
	pi.setLabel("acc commit checks");

	pi.on("session_start", (_event, ctx) => raiseToolCallTimeout(pi, ctx));

	pi.on("tool_call", async (event, ctx) => {
		const d = await gateToolCall(event, ctx, "omp");
		if (!d || d.verdict === "pass") return undefined;
		if (d.verdict === "block") return { block: true, reason: d.reason || "acc: push blocked" };
		return d.reason ? { additionalContext: d.reason } : undefined;
	});

	for (const tool of checkTools("omp", (schema) => pi.typebox.Type.Unsafe(schema))) pi.registerTool(tool);
	registerAccCommand(pi, "omp");
}
