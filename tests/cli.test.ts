import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { captureIo, checkToml, makeRepo, useTmp } from "./helpers.ts";

const tmp = useTmp();

test("init creates .acc and prints the Claude Code snippets", async () => {
	const repo = makeRepo(tmp());
	let io = captureIo(repo.path);
	expect(await main(["init"], io)).toBe(0);
	for (const p of [".acc/config.toml", ".acc/checks/no-debug-leftovers.toml", ".acc/grades/.gitkeep"]) expect(existsSync(join(repo.path, p))).toBe(true);
	for (const s of ['"PreToolUse"', '"gate"', '"mcpServers"']) expect(io.text()).toContain(s);
	io = captureIo(repo.path);
	expect(await main(["init"], io)).toBe(0);
	expect(io.text()).toContain("nothing created");
	expect(await main(["validate"], captureIo(repo.path))).toBe(0);
});

test("list and validate", async () => {
	const repo = makeRepo(tmp());
	repo.enable({ checks: { a: checkToml("a"), b: "id = 'wrong'\n" } });
	let io = captureIo(repo.path);
	expect(await main(["list", "--json"], io)).toBe(0);
	const rows = JSON.parse(io.text());
	expect(rows[0].id).toBe("a");
	expect(rows[1].invalid).toBe(true);
	io = captureIo(repo.path);
	expect(await main(["validate"], io)).toBe(2);
	expect(io.text()).toContain("invalid");
});

test("run exit codes", async () => {
	const repo = makeRepo(tmp());
	repo.enable({ checks: { a: checkToml("a") }, answers: { "*": { answer: 0.1, findings: [], summary: "fine" } } });
	expect(await main(["run"], captureIo(repo.path))).toBe(0); // nothing unpushed
	repo.commit();
	expect(await main(["run"], captureIo(repo.path))).toBe(0);
	writeFileSync(join(repo.path, "answers.json"), JSON.stringify({ "*": { answer: 0.6, findings: [], summary: "hm" } }));
	expect(await main(["run"], captureIo(repo.path))).toBe(1);
	writeFileSync(join(repo.path, "answers.json"), JSON.stringify({ "*": { answer: 0.9, findings: [], summary: "no" } }));
	const io = captureIo(repo.path);
	expect(await main(["run", "--json"], io)).toBe(2);
	expect(JSON.parse(io.text()).verdict).toBe("block");
	const err = captureIo(repo.path);
	expect(await main(["run", "--check", "missing"], err)).toBe(3);
	expect(err.stderr.join("\n")).toContain("unknown check id(s): missing");
});

test("promote --force", async () => {
	const repo = makeRepo(tmp());
	repo.enable({ checks: { a: checkToml("a", { status: "proposed" }) } });
	expect(await main(["promote", "a"], captureIo(repo.path))).toBe(3);
	const io = captureIo(repo.path);
	expect(await main(["promote", "a", "--force"], io)).toBe(0);
	expect(io.text()).toContain('status = "active"');
});

test("doctor --offline", async () => {
	const repo = makeRepo(tmp());
	repo.enable({ checks: { a: checkToml("a") } });
	const io = captureIo(repo.path);
	expect(await main(["doctor", "--offline"], io)).toBe(0);
	expect(io.text()).toContain("backend 'fake'");
});

test("grade --commits and --range", async () => {
	const repo = makeRepo(tmp());
	const shas = [0, 1, 2].map((i) => repo.commit({ [`f${i}.py`]: "x\n" }));
	repo.enable({ checks: { a: checkToml("a", { appliesTo: '["*.py"]' }) }, answers: { "*": { answer: 0.1, findings: [], summary: "fine" } } });
	let io = captureIo(repo.path);
	expect(await main(["grade", "a", "--commits", shas[0], shas[1]], io)).toBe(1); // 2 < min_sample: insufficient
	expect(io.text()).toContain("on chosen commits: INSUFFICIENT");
	const [r1, r2] = [`${shas[0]}..${shas[1]}`, `${shas[1]}..${shas[2]}`];
	io = captureIo(repo.path);
	await main(["grade", "a", "--range", r1, "--range", r2], io);
	expect(io.text()).toContain(`on ranges ${r1}, ${r2}: INSUFFICIENT`);
	expect(io.text()).toContain("sample 2 of 2 eligible ranges");
	expect(await main(["grade", "a", "--commits", "nope"], captureIo(repo.path))).toBe(3);
	io = captureIo(repo.path);
	expect(await main(["grade", "a", "--commits", shas[0], "--range", "HEAD~1..HEAD"], io)).toBe(2);
	expect(io.stderr.join("\n")).toContain("not allowed with argument --commits");
});

test("usage errors exit 2", async () => {
	const repo = makeRepo(tmp());
	for (const argv of [["nope"], ["list", "--status", "live"], ["grade"], ["run", "--bogus"], ["grade", "a", "--sample", "x"]]) {
		const io = captureIo(repo.path);
		expect(await main(argv, io)).toBe(2);
		expect(io.stderr.join("\n")).toContain("error:");
	}
});

test("gate is only for Claude Code", async () => {
	const io = captureIo(tmp());
	expect(await main(["gate", "--agent", "omp"], io)).toBe(3);
	expect(io.stderr.join("\n")).toContain("inside the acc extension");
});

test("the launcher runs the CLI", () => {
	const repo = makeRepo(tmp());
	repo.enable({ checks: { a: checkToml("a") } });
	const proc = spawnSync(process.execPath, [join(import.meta.dir, "..", "bin", "acc.mjs"), "list"], { cwd: repo.path, encoding: "utf8" });
	expect(proc.status).toBe(0);
	expect(proc.stdout).toContain("a                                active    bool   user  grade=none");
});
