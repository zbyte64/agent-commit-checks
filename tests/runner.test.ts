import { expect, test } from "bun:test";
import type { Backend } from "../src/backends/base.ts";
import { BackendError, getBackend } from "../src/backends/index.ts";
import { loadAll } from "../src/checks.ts";
import type { Table } from "../src/config.ts";
import { resolveUnpushed } from "../src/pushrange.ts";
import { review, type RunResult } from "../src/runner.ts";
import { ans, checkToml, FAKE_AWS_KEY, makeRepo, type Repo, useTmp } from "./helpers.ts";

const tmp = useTmp();

interface Seen {
	system: string;
	prompt: string;
	stdin: string;
	schema: Table;
}

async function run(
	repo: Repo,
	answers: unknown,
	checks: [string, string][],
	opts: { config?: string; seen?: Seen[] } = {},
): Promise<RunResult> {
	repo.enable({ config: opts.config, checks: Object.fromEntries(checks), answers });
	const cfg = repo.config();
	const { checks: loaded, errors } = loadAll(cfg.checksDir);
	expect(errors).toEqual({});
	const backend: Backend = getBackend(cfg, "claude");
	if (opts.seen) {
		const seen = opts.seen;
		const ask = backend.ask.bind(backend);
		backend.ask = (system, prompt, stdin, schema, timeout) => {
			seen.push({ system, prompt, stdin, schema });
			return ask(system, prompt, stdin, schema, timeout);
		};
	}
	return review(cfg, repo.path, await resolveUnpushed(repo.path), loaded, backend);
}

test("pass", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	const res = await run(repo, { "*": ans(0.1) }, [["a", checkToml("a")]]);
	expect(res.verdict).toBe("pass");
	expect(res.calls).toBe(1);
	expect(res.entries.map((e) => e.key)).toEqual(["a"]);
});

test("block and warn aggregate", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	const res = await run(repo, { a: ans(0.9), b: ans(0.6) }, [
		["a", checkToml("a")],
		["b", checkToml("b")],
	]);
	expect(res.verdict).toBe("block");
	expect(Object.fromEntries(res.entries.map((e) => [e.checkId, e.verdict]))).toEqual({ a: "block", b: "warn" });
});

test("an advisory block becomes a warning", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	const res = await run(repo, { "*": ans(0.99) }, [["a", checkToml("a", { status: "advisory" })]]);
	expect(res.verdict).toBe("warn");
	expect(res.entries[0].rawVerdict).toBe("block");
});

test("the whole push is one entry", async () => {
	const repo = makeRepo(tmp());
	const a = repo.commit({ "a.py": "alpha = 1\n" }, "first");
	const b = repo.commit({ "b.py": "beta = 2\n" }, "second");
	const seen: Seen[] = [];
	const res = await run(repo, { pc: ans("bad") }, [["pc", checkToml("pc", { qtype: "choice", inputs: '["diff", "message"]' })]], { seen });
	expect(res.entries.map((e) => e.key)).toEqual(["pc"]);
	expect(res.calls).toBe(1);
	expect(res.verdict).toBe("block");
	// One call sees every commit's message and the combined diff.
	expect(seen.length).toBe(1);
	for (const text of [`${a.slice(0, 7)}: first`, `${b.slice(0, 7)}: second`, "alpha = 1", "beta = 2"]) expect(seen[0].stdin).toContain(text);
});

test("applies_to skips checks with no matching path", async () => {
	const repo = makeRepo(tmp());
	repo.commit({ "docs/readme.md": "x\n" });
	const res = await run(repo, { "*": ans(0.99) }, [["py", checkToml("py", { appliesTo: '["**/*.py"]' })]]);
	expect(res.verdict).toBe("pass");
	expect(res.calls).toBe(0);
	expect(res.checksSkipped).toEqual(["py"]);
});

test("applies_to matches any commit in the range", async () => {
	const repo = makeRepo(tmp());
	repo.commit({ "a.py": "x\n" });
	repo.commit({ "b.md": "x\n" });
	const res = await run(repo, { "*": ans(0.1) }, [["py", checkToml("py", { appliesTo: '["*.py"]' })]]);
	expect(res.entries.map((e) => e.key)).toEqual(["py"]);
});

test("batching and parallel calls", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	const checks = Array.from({ length: 5 }, (_, i) => [`c${i}`, checkToml(`c${i}`)] as [string, string]);
	const res = await run(repo, { "*": ans(0.1) }, checks, { config: "[run]\nmax_checks_per_call = 2\n" });
	expect(res.calls).toBe(3);
	expect(res.entries.length).toBe(5);
});

test("a missing entry is retried alone, then errors", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	const res = await run(repo, { a: ans(0.1), b: "omit" }, [
		["a", checkToml("a")],
		["b", checkToml("b")],
	]);
	expect(res.calls).toBe(2); // one batch + one retry for b
	const b = res.entries.find((e) => e.checkId === "b");
	expect(b?.error).toBeTruthy();
	expect(b?.verdict).toBe("block"); // on_backend_error defaults to block
});

test("an invalid answer is retried", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	const res = await run(repo, { a: ans(7) }, [["a", checkToml("a")]], { config: '[run]\non_backend_error = "warn"\n' });
	expect(res.calls).toBe(2);
	expect(res.entries[0].error.startsWith("invalid answer")).toBe(true);
	expect(res.verdict).toBe("warn");
});

test("a backend error is not retried", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	const res = await run(repo, { "*": "error" }, [
		["a", checkToml("a")],
		["b", checkToml("b")],
	]);
	expect(res.calls).toBe(1);
	expect(res.entries.every((e) => e.error && e.verdict === "block")).toBe(true);
});

test("a retryable error is retried even for a single-entry batch", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	const res = await run(repo, { "*": "retryable" }, [["a", checkToml("a")]]);
	expect(res.calls).toBe(2);
	expect(res.entries[0].error).toContain("fake backend error");
});

test("a backend error on an advisory check warns", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	const res = await run(repo, { "*": "error" }, [["a", checkToml("a", { status: "advisory" })]]);
	expect(res.verdict).toBe("warn");
});

test("a secret blocks without a model call", async () => {
	const repo = makeRepo(tmp());
	repo.commit({ "cfg.py": `KEY = "${FAKE_AWS_KEY}"\n` });
	const res = await run(repo, { "*": ans(0.1) }, [["a", checkToml("a")]]);
	expect(res.verdict).toBe("block");
	expect(res.calls).toBe(0);
	expect(res.secretHits[0].file).toBe("cfg.py");
});

test("a secret in an older commit still blocks", async () => {
	const repo = makeRepo(tmp());
	repo.commit({ "cfg.py": `KEY = "${FAKE_AWS_KEY}"\n` });
	repo.commit({ "cfg.py": "KEY = None\n" }); // removed later, but history still has it
	const res = await run(repo, { "*": ans(0.1) }, [["a", checkToml("a")]]);
	expect(res.verdict).toBe("block");
});

test("a warn-level secret is redacted from the model input", async () => {
	const repo = makeRepo(tmp());
	repo.commit({ "settings.ini": "DB_PASSWORD=hunter2\nname = x\n" });
	const seen: Seen[] = [];
	const res = await run(repo, { "*": ans(0.1) }, [["a", checkToml("a")]], { seen });
	expect(seen[0].stdin).not.toContain("hunter2");
	expect(seen[0].stdin).toContain("name = x");
	expect(res.verdict).toBe("pass");
	expect(res.notes.some((n) => n.includes("redacted"))).toBe(true);
});

test("excluded and binary files are skipped", async () => {
	const repo = makeRepo(tmp());
	repo.commit({ "package-lock.json": "{}\n", "img.bin": "\x00\x01\x02" });
	const res = await run(repo, { "*": ans(0.1) }, [["a", checkToml("a")]]);
	expect(res.checksSkipped).toEqual(["a"]); // nothing left to review
	expect([...res.skippedFiles].sort()).toEqual(["img.bin (binary)", "package-lock.json (excluded)"]);
});

test("truncation is reported", async () => {
	const repo = makeRepo(tmp());
	repo.commit({ "big.txt": "line\n".repeat(5000) });
	const res = await run(repo, { "*": ans(0.1) }, [["a", checkToml("a")]], { config: "[run]\nmax_diff_chars = 500\n" });
	expect(res.truncated).toBe(true);
	expect(res.entries[0].truncated).toBe(true);
	expect(res.notes.some((n) => n.includes("truncated"))).toBe(true);
});

test("truncation keeps every file visible", async () => {
	const repo = makeRepo(tmp());
	repo.commit({ "src/big.py": "x = 1\n".repeat(3000), "tests/test_big.py": "def test_x():\n    assert True\n" });
	const seen: Seen[] = [];
	await run(repo, { "*": ans(0.1) }, [["a", checkToml("a")]], { config: "[run]\nmax_diff_chars = 2000\n", seen });
	expect(seen[0].stdin).toContain("def test_x():"); // the small later file is shown whole
	expect(seen[0].stdin).toContain("more characters of this file not shown");
});

test("the prompt carries the inputs and the untrusted-data preamble", async () => {
	const repo = makeRepo(tmp());
	repo.commit({ "a.py": "print('x')\n" }, "add a");
	const seen: Seen[] = [];
	await run(repo, { "*": ans(0.1) }, [["a", checkToml("a", { inputs: '["diff", "message", "file_list"]' })]], { seen });
	const [captured] = seen;
	expect(captured.system).toContain("untrusted");
	expect(captured.stdin).toContain("print('x')");
	expect(captured.stdin).toContain("add a");
	expect(captured.stdin).toContain("a.py");
	expect(captured.prompt).toContain('Check key "a"');
	expect(captured.schema.properties.checks.required).toEqual(["a"]);
});

test("unknown backend", () => {
	const repo = makeRepo(tmp());
	repo.enable();
	const cfg = repo.config();
	cfg.data.agents.claude = { backend: "nope" };
	expect(() => getBackend(cfg, "claude")).toThrow(BackendError);
	expect(() => getBackend(cfg, "claude")).toThrow("nope");
});

test("a low-confidence block becomes a warning", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	const res = await run(
		repo,
		{ a: { ...ans(0.95), confidence: 0.69 }, b: { ...ans(0.95), confidence: 0.7 }, c: { ...ans(0.6), confidence: 0.1 } },
		[
			["a", checkToml("a")],
			["b", checkToml("b")],
			["c", checkToml("c")],
		],
	);
	const by = Object.fromEntries(res.entries.map((e) => [e.checkId, e]));
	expect([by.a.rawVerdict, by.a.verdict, by.a.lowConfidence]).toEqual(["block", "warn", true]);
	expect([by.b.verdict, by.b.lowConfidence]).toEqual(["block", false]); // at the threshold still blocks
	expect([by.c.verdict, by.c.lowConfidence]).toEqual(["warn", false]); // only blocks are softened
	expect(res.verdict).toBe("block");
});

test("min_block_confidence is configurable", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	const res = await run(repo, { a: { ...ans(0.95), confidence: 0.69 } }, [["a", checkToml("a")]], {
		config: "[run]\nmin_block_confidence = 0.5\n",
	});
	expect(res.verdict).toBe("block");
	expect(res.entries[0].confidence).toBe(0.69);
});

test("a missing confidence is retried, then errors", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	const res = await run(repo, { a: { ...ans(0.1), confidence: null } }, [["a", checkToml("a")]]);
	expect(res.calls).toBe(2);
	expect(res.entries[0].error).toContain("confidence");
	expect(res.verdict).toBe("block");
});
