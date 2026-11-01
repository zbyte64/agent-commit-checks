import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Table } from "../src/config.ts";
import { handle } from "../src/mcp.ts";
import { checkToml, makeRepo, type Repo, useTmp } from "./helpers.ts";

const tmp = useTmp();

const SPEC = {
	id: "no-todo",
	title: "No new TODO comments",
	applies_to: ["**/*"],
	inputs: ["diff"],
	question: { type: "bool", instructions: "Do the added lines add TODO comments?" },
	verdict: { block_at: 0.9, warn_at: 0.5 },
};

function server(): Repo {
	const repo = makeRepo(tmp());
	repo.enable({
		checks: { "user-check": checkToml("user-check", { status: "advisory" }) },
		answers: { "*": { answer: 0.95, findings: [], summary: "found one" } },
	});
	return repo;
}

let nextId = 1;

/** Call a tool; returns `{text, data}` or throws with the error text, like the Python ToolError. */
async function call(repo: Repo, name: string, args: Table = {}): Promise<{ text: string; data: Table }> {
	const reply = await handle({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, { agent: "claude", cwd: repo.path });
	const result = reply?.result;
	if (result.isError) throw new Error(result.content[0].text);
	return { text: result.content[0].text, data: result.structuredContent };
}

test("list and get", async () => {
	const repo = server();
	let r = await call(repo, "list_checks");
	expect(r.data.checks[0].id).toBe("user-check");
	expect(r.text).toContain("user-check");
	r = await call(repo, "get_check", { id: "user-check" });
	expect(r.data.toml).toContain('id = "user-check"');
});

test("run_checks: text and structure", async () => {
	const repo = server();
	repo.commit();
	const r = await call(repo, "run_checks");
	expect(r.data.verdict).toBe("warn"); // advisory: block shown as warn
	expect(r.data.entries[0].raw_verdict).toBe("block");
	expect(r.text).toContain("found one");
});

test("test_check does not save", async () => {
	const repo = server();
	repo.commit();
	const r = await call(repo, "test_check", { spec: SPEC });
	expect(r.data.verdict).toBe("block");
	expect(repo.exists(".acc/checks/no-todo.toml")).toBe(false);
});

test("add_check flow", async () => {
	const repo = server();
	const r = await call(repo, "add_check", { spec: SPEC });
	expect(r.data.path).toBe(join(repo.path, ".acc/checks/no-todo.toml"));
	const text = repo.read(".acc/checks/no-todo.toml");
	expect(text).toContain('author = "agent"');
	expect(text).toContain('status = "proposed"');
	await expect(call(repo, "add_check", { spec: SPEC })).rejects.toThrow("already exists");
	// proposed checks run by name only
	repo.commit();
	let ran = new Set((await call(repo, "run_checks")).data.entries.map((e: Table) => e.check));
	expect(ran).toEqual(new Set(["user-check"]));
	ran = new Set((await call(repo, "run_checks", { ids: ["no-todo"] })).data.entries.map((e: Table) => e.check));
	expect(ran).toEqual(new Set(["no-todo"]));
});

test("add_check accepts TOML and reports validation errors", async () => {
	const repo = server();
	await expect(call(repo, "add_check", { spec: { ...SPEC, question: { type: "maybe", instructions: "x" } } })).rejects.toThrow("question.type");
	const r = await call(repo, "add_check", { spec: checkToml("from-toml") });
	expect(r.data.status).toBe("proposed");
});

test("update is refused for user checks", async () => {
	const repo = server();
	await expect(call(repo, "update_check", { id: "user-check", spec: { ...SPEC, id: "user-check" } })).rejects.toThrow("written by the user");
});

test("updating an agent check clears its grade", async () => {
	const repo = server();
	await call(repo, "add_check", { spec: SPEC });
	const grade = join(repo.path, ".acc/grades/no-todo.json");
	mkdirSync(join(repo.path, ".acc/grades"), { recursive: true });
	writeFileSync(grade, "{}");
	await call(repo, "update_check", { id: "no-todo", spec: { ...SPEC, question: { type: "bool", instructions: "Any TODO or FIXME added?" } } });
	expect(existsSync(grade)).toBe(false);
	expect(repo.read(".acc/checks/no-todo.toml")).toContain("FIXME");
});

test("promote to active is refused without a grade", async () => {
	const repo = server();
	await call(repo, "add_check", { spec: SPEC });
	await expect(call(repo, "promote_check", { id: "no-todo", to: "active" })).rejects.toThrow("no grade");
	const r = await call(repo, "promote_check", { id: "no-todo", to: "advisory" });
	expect(r.data.new_line).toBe('status = "advisory"');
});

test("grade_check", async () => {
	const repo = server();
	for (let i = 0; i < 12; i++) repo.commit({ [`f${i}.py`]: "x\n" });
	const r = await call(repo, "grade_check", { id: "user-check" });
	expect(r.data.result).toBe("fail"); // every unit blocked
	expect(r.text).toContain("would block");
});

test("a grade on chosen commits cannot promote to active", async () => {
	const repo = server();
	const shas = Array.from({ length: 12 }, (_, i) => repo.commit({ [`f${i}.py`]: "x\n" }));
	writeFileSync(join(repo.path, "answers.json"), '{"*": {"answer": 0.1, "findings": [], "summary": "ok"}}');
	const r = await call(repo, "grade_check", { id: "user-check", commits: shas });
	expect(r.data.result).toBe("pass");
	expect(r.data.selection.mode).toBe("commits");
	await expect(call(repo, "promote_check", { id: "user-check", to: "active" })).rejects.toThrow("chosen commits or a range");
});

test("grade_check with ranges", async () => {
	const repo = server();
	const shas = Array.from({ length: 4 }, (_, i) => repo.commit({ [`f${i}.py`]: "x\n" }));
	const ranges = [`${shas[0]}..${shas[1]}`, `${shas[1]}..${shas[3]}`];
	const r = await call(repo, "grade_check", { id: "user-check", ranges });
	expect(r.data.selection).toEqual({ mode: "ranges", ranges });
	expect(r.data.sample.map((s: Table) => s.commits)).toEqual([[shas[1]], shas.slice(2, 4)]);
	expect(r.text).toContain(`would block ${shas[1].slice(0, 7)}..${shas[3].slice(0, 7)}`);
});

test("acc mcp speaks MCP over stdio", async () => {
	const repo = server();
	const proc = spawn(process.execPath, [join(import.meta.dir, "..", "bin", "acc.mjs"), "mcp", "--agent", "claude"], { cwd: repo.path });
	const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
	const send = async (msg: Table): Promise<Table | null> => {
		proc.stdin.write(`${JSON.stringify(msg)}\n`);
		return "id" in msg ? JSON.parse((await lines.next()).value ?? "null") : null;
	};
	const init = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
	expect(init?.result.protocolVersion).toBe("2025-06-18");
	expect(init?.result.serverInfo.name).toBe("acc");
	expect(init?.result.instructions).toContain("grade_check");
	await send({ jsonrpc: "2.0", method: "notifications/initialized" });
	const tools = await send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	expect(tools?.result.tools.map((t: Table) => t.name)).toContain("add_check");
	const listed = await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_checks", arguments: {} } });
	expect(listed?.result.structuredContent.checks[0].id).toBe("user-check");
	const missing = await send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_check", arguments: { id: "nope" } } });
	expect(missing?.result.isError).toBe(true);
	expect(missing?.result.content[0].text).toBe("no check named 'nope'");
	const unknown = await send({ jsonrpc: "2.0", id: 5, method: "bogus" });
	expect(unknown?.error.code).toBe(-32601);
	proc.stdin.end();
	const { promise, resolve } = Promise.withResolvers<number | null>();
	proc.on("close", resolve);
	expect(await promise).toBe(0);
});
