/** The omp and pi extensions, loaded against a stand-in host API, on throwaway repos. */
import { expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { HostCommand, HostContext, HostToolDefinition } from "../src/adapters/host.ts";
import ompExtension from "../src/adapters/omp/index.ts";
import piExtension from "../src/adapters/pi/index.ts";
import { ans, checkToml, logRows, makeEnabled, setAnswers, useTmp } from "./helpers.ts";

const tmp = useTmp();

type Handler = (event: unknown, ctx: HostContext) => unknown;

/** Records what an extension registers; `fire` runs the handlers like the host does. */
function host(agent: "omp" | "pi") {
	const handlers: Record<string, Handler[]> = {};
	const tools = new Map<string, HostToolDefinition>();
	const commands = new Map<string, HostCommand>();
	const notes: string[] = [];
	const settings = { scope: "omp-settings" };
	const api = {
		on(event: string, handler: Handler) {
			(handlers[event] ??= []).push(handler);
		},
		registerTool(tool: HostToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: HostCommand) {
			commands.set(name, command);
		},
		// omp only
		setLabel(_label: string) {},
		typebox: { Type: { Unsafe: (schema: Record<string, unknown>) => schema } },
		pi: { settings },
	};
	// The stand-in takes every event name; the extensions' parameter types list the ones they use.
	const stand = api as unknown as Parameters<typeof ompExtension>[0];
	if (agent === "omp") ompExtension(stand);
	else piExtension(stand);
	const ctx = (cwd: string): HostContext => ({
		cwd,
		hasUI: true,
		ui: { notify: (message) => notes.push(message), setStatus: () => {} },
	});
	return {
		tools,
		commands,
		notes,
		settings,
		async fire(event: string, payload: unknown, cwd: string): Promise<unknown> {
			let result: unknown;
			for (const h of handlers[event] ?? []) result = (await h(payload, ctx(cwd))) ?? result;
			return result;
		},
		ctx,
	};
}

function bash(command: string, input: Record<string, unknown> = {}) {
	return { toolName: "bash", toolCallId: "t1", input: { command, ...input } };
}

for (const agent of ["omp", "pi"] as const) {
	test(`${agent}: a block returns the findings as the reason`, async () => {
		const repo = makeEnabled(tmp());
		repo.commit();
		setAnswers(repo, { a: ans(0.95, "Leaves a debug print", [{ file: "x.py", line: 3, message: "print" }]) });
		const h = host(agent);
		const out = (await h.fire("tool_call", bash("git push origin main"), repo.path)) as Record<string, any>;
		expect(out.block).toBe(true);
		expect(out.reason).toContain("acc: push blocked");
		expect(out.reason).toContain("print (x.py:3)");
		expect(h.notes.at(-1)).toStartWith("acc: push blocked");
		expect(logRows(tmp()).at(-1)?.agent).toBe(agent);
	});

	test(`${agent}: pass, non-pushes and other tools return nothing`, async () => {
		const repo = makeEnabled(tmp());
		const h = host(agent);
		repo.commit();
		expect(await h.fire("tool_call", bash("git push"), repo.path)).toBeUndefined();
		expect(logRows(tmp()).at(-1)?.verdict).toBe("pass");
		setAnswers(repo, { "*": "error" });
		expect(await h.fire("tool_call", bash("git status"), repo.path)).toBeUndefined();
		expect(await h.fire("tool_call", { ...bash("git push"), toolName: "python" }, repo.path)).toBeUndefined();
	});

	test(`${agent}: commit and push is blocked without a model call`, async () => {
		const repo = makeEnabled(tmp());
		setAnswers(repo, { "*": "error" });
		const out = (await host(agent).fire("tool_call", bash("git commit -am x && git push"), repo.path)) as Record<string, any>;
		expect(out.block).toBe(true);
		expect(out.reason).toContain("as its own command");
		expect(logRows(tmp())).toEqual([]);
	});

	test(`${agent}: backend errors and invalid configs block`, async () => {
		const repo = makeEnabled(tmp());
		repo.commit();
		setAnswers(repo, { "*": "error" });
		const h = host(agent);
		expect(((await h.fire("tool_call", bash("git push"), repo.path)) as Record<string, any>).reason).toContain("fake backend error");
		writeFileSync(join(repo.path, ".acc/config.toml"), "[run\n");
		expect(((await h.fire("tool_call", bash("git push"), repo.path)) as Record<string, any>).reason).toContain("config.toml");
	});

	test(`${agent}: the check tools run in the session's project`, async () => {
		const repo = makeEnabled(tmp());
		const h = host(agent);
		expect([...h.tools.keys()]).toEqual(["list_checks", "get_check", "run_checks", "test_check", "grade_check", "add_check", "update_check", "promote_check"]);
		const list = await h.tools.get("list_checks")?.execute("1", {}, undefined, undefined, h.ctx(repo.path));
		expect(list?.content[0].text).toContain("a [active, bool, by user, grade none]: Check a");
		await expect(h.tools.get("get_check")?.execute("2", { id: "missing" }, undefined, undefined, h.ctx(repo.path)) as Promise<unknown>).rejects.toThrow(
			"no check named 'missing'",
		);
	});

	test(`${agent}: /acc runs the CLI with this agent's backend`, async () => {
		const repo = makeEnabled(tmp());
		const h = host(agent);
		await h.commands.get("acc")?.handler("doctor --offline", h.ctx(repo.path));
		expect(h.notes.at(-1)).toContain(`agent '${agent}' uses backend 'fake'`);
		await h.commands.get("acc")?.handler("mcp", h.ctx(repo.path));
		expect(h.notes.at(-1)).toContain("run it from a shell");
	});
}

test("omp: a warning goes to the model as additional context", async () => {
	const repo = makeEnabled(tmp());
	repo.commit();
	setAnswers(repo, { a: ans(0.6, "Maybe a debug print") });
	const out = (await host("omp").fire("tool_call", bash("git push"), repo.path)) as Record<string, any>;
	expect(out.block).toBeUndefined();
	expect(out.additionalContext).toContain("Maybe a debug print");
});

test("omp: the bash cwd input is resolved against the session cwd", async () => {
	const repo = makeEnabled(tmp());
	repo.commit();
	setAnswers(repo, { a: ans(0.95) });
	const h = host("omp");
	// The session sits outside the repo; the bash call names the repo through its cwd input.
	expect(await h.fire("tool_call", bash("git push"), tmp())).toBeUndefined();
	const out = (await h.fire("tool_call", bash("git push", { cwd: relative(tmp(), repo.path) }), tmp())) as Record<string, any>;
	expect(out.block).toBe(true);
});

test("omp: an advisory block is a warning", async () => {
	const repo = makeEnabled(tmp());
	repo.commit();
	writeFileSync(join(repo.path, ".acc/checks/a.toml"), checkToml("a", { status: "advisory" }));
	setAnswers(repo, { a: ans(0.95, "Would block") });
	const out = (await host("omp").fire("tool_call", bash("git push"), repo.path)) as Record<string, any>;
	expect(out.additionalContext).toContain("Would block");
});

test("omp: the tool_call timeout is raised for the gate unless the user set it", async () => {
	const repo = makeEnabled(tmp());
	const overrides: unknown[] = [];
	let configured = false;
	mock.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({
		lookup: (id: string) =>
			id === "extensionHandlers.toolCallTimeoutMs"
				? { isConfigured: () => configured, get: () => 30000, override: (_scope: unknown, value: unknown) => overrides.push(value) }
				: undefined,
	}));
	const h = host("omp");
	await h.fire("session_start", {}, repo.path);
	expect(overrides).toEqual([180000]); // two rounds of the default 90 s timeout
	configured = true;
	await h.fire("session_start", {}, repo.path);
	expect(overrides).toEqual([180000]);
	await h.fire("session_start", {}, tmp()); // not a repo: nothing to gate
	expect(overrides).toEqual([180000]);
});

test("pi: a warning is added to the bash tool's result", async () => {
	const repo = makeEnabled(tmp());
	repo.commit();
	setAnswers(repo, { a: ans(0.6, "Maybe a debug print") });
	const h = host("pi");
	expect(await h.fire("tool_call", bash("git push"), repo.path)).toBeUndefined();
	const patched = (await h.fire("tool_result", { toolName: "bash", toolCallId: "t1", content: [{ type: "text", text: "pushed" }], isError: false }, repo.path)) as {
		content: { text: string }[];
	};
	expect(patched.content[0].text).toBe("pushed");
	expect(patched.content[1].text).toContain("Maybe a debug print");
	// Each warning is delivered once.
	expect(await h.fire("tool_result", { toolName: "bash", toolCallId: "t1", content: [], isError: false }, repo.path)).toBeUndefined();
});
