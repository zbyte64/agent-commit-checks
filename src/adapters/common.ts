/** What the omp and pi extensions share: the push gate, the check tools and the /acc command. */
import { resolve } from "node:path";
import { main } from "../cli.ts";
import { type Decision, safeDecide } from "../gate.ts";
import { ShellSplitError, shellSplit } from "../gitcmd.ts";
import { INSTRUCTIONS, TOOLS, type ToolEnv } from "../tools.ts";
import type { HostApi, HostContext, HostToolDefinition, ToolCallEvent } from "./host.ts";

export type Agent = "omp" | "pi";

/**
 * The gate decision for a bash tool call, or null when the call cannot be a push. The prefilter is
 * cheap; the gate parses the command properly and passes anything that is not a push.
 */
export async function gateToolCall(event: ToolCallEvent, ctx: HostContext, agent: Agent): Promise<Decision | null> {
	if (event.toolName !== "bash") return null;
	const { command, cwd } = event.input as { command?: unknown; cwd?: unknown };
	if (typeof command !== "string" || !/\bgit\b/.test(command) || !/\bpush\b/.test(command)) return null;
	const dir = typeof cwd === "string" && cwd ? resolve(ctx.cwd, cwd) : ctx.cwd;
	if (ctx.hasUI) ctx.ui.setStatus("acc", "acc: running push checks");
	try {
		const d = await safeDecide(command, dir, agent);
		if (d.userMessage && d.verdict !== "pass" && ctx.hasUI) {
			ctx.ui.notify(d.userMessage, d.verdict === "block" ? "warning" : "info");
		}
		return d;
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus("acc", undefined);
	}
}

/**
 * The check tools as host tool definitions. `schema` wraps a JSON Schema in the host's schema type
 * (both hosts accept TypeBox-style `Type.Unsafe`).
 */
export function checkTools(agent: Agent, schema: (json: Record<string, unknown>) => unknown): HostToolDefinition[] {
	return TOOLS.map((tool) => ({
		name: tool.name,
		label: `acc ${tool.name.replace("_", " ")}`,
		// Without MCP server instructions, the flow for new checks goes in the tool that starts it.
		description: tool.name === "add_check" ? `${tool.description}\n\n${INSTRUCTIONS}` : tool.description,
		parameters: schema(tool.inputSchema),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const env: ToolEnv = { agent, cwd: ctx.cwd };
			// A ToolError (bad id, invalid spec, backend error...) is thrown: both hosts report it as the tool error.
			const { text, data } = await tool.run(params ?? {}, env);
			return { content: [{ type: "text", text }], details: data };
		},
	}));
}

// `acc` subcommands that take --agent, and the ones that cannot run inside the agent.
const TAKES_AGENT = new Set(["run", "grade", "doctor"]);
const CLI_ONLY = new Set(["gate", "mcp"]);

/** Run `acc <args>` in-process for the /acc command; returns the exit code and the output. */
export async function runAcc(args: string, cwd: string, agent: Agent): Promise<{ code: number; text: string }> {
	let argv: string[];
	try {
		argv = shellSplit(args).filter((a) => a !== "\n");
	} catch (e) {
		if (e instanceof ShellSplitError) return { code: 2, text: `acc: could not parse the arguments (${e.message})` };
		throw e;
	}
	if (CLI_ONLY.has(argv[0])) return { code: 2, text: `acc ${argv[0]} reads stdin; run it from a shell, not as /acc.` };
	if (TAKES_AGENT.has(argv[0]) && !argv.some((a) => a === "--agent" || a.startsWith("--agent="))) argv.push("--agent", agent);
	if (argv[0] === "init" && !argv.includes("--omp") && !argv.includes("--pi")) argv.push(`--${agent}`);
	const lines: string[] = [];
	const code = await main(argv.length ? argv : ["--help"], {
		cwd,
		out: (text) => lines.push(text),
		err: (text) => lines.push(text),
		readStdin: async () => "",
	});
	return { code, text: lines.join("\n") };
}

/** Register the /acc command: the acc CLI, run in the session's directory. */
export function registerAccCommand(pi: HostApi, agent: Agent): void {
	pi.registerCommand("acc", {
		description: "Run an acc command (list, run, grade, promote, validate, init, doctor) in this project",
		async handler(args, ctx) {
			const { code, text } = await runAcc(args.trim(), ctx.cwd, agent);
			if (ctx.hasUI) ctx.ui.notify(text || `acc exited ${code}`, code === 0 ? "info" : "warning");
			else process.stdout.write(`${text}\n`);
		},
	});
}
