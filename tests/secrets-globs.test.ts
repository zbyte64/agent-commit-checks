import { expect, test } from "bun:test";
import { match } from "../src/globs.ts";
import { redactDiff, scanDiff, scanText } from "../src/secrets.ts";
import { FAKE_AWS_KEY } from "./helpers.ts";

const DIFF = `diff --git a/app/config.py b/app/config.py
--- a/app/config.py
+++ b/app/config.py
@@ -10,2 +10,4 @@ x
 unchanged = 1
+AWS = "${FAKE_AWS_KEY}"
+DB_PASSWORD=hunter2
-removed = "${FAKE_AWS_KEY.replace("ABCD", "ZZZZ")}"
 tail = 2
`;

test("scanDiff reads added lines only, with new-file line numbers", () => {
	const hits = scanDiff(DIFF, "abc");
	const labels = hits.map((h) => `${h.pattern}|${h.line}|${h.severity}`);
	expect(labels).toContain("AWS access key ID|11|block");
	expect(hits.some((h) => h.line === 12 && h.severity === "warn")).toBe(true);
	expect(hits.every((h) => h.file === "app/config.py" && h.commit === "abc")).toBe(true);
	expect(hits.some((h) => h.line === 13)).toBe(false);
});

test("hits carry no secret text", () => {
	for (const h of scanDiff(DIFF)) expect(JSON.stringify(h)).not.toContain(FAKE_AWS_KEY);
});

test("redactDiff", () => {
	const out = redactDiff(DIFF);
	expect(out).not.toContain("hunter2");
	expect(out).not.toContain(FAKE_AWS_KEY);
	expect(out).toContain("unchanged = 1");
	expect(out.split("[acc: line redacted").length - 1).toBe(2);
});

test("scanText (ported API)", () => {
	expect(scanText(`token = 'ghp_${"a".repeat(36)}'`).length).toBeGreaterThan(0);
});

test("globs", () => {
	expect(match("src/a/b.py", "**/*.py")).toBe(true);
	expect(match("b.py", "**/*.py")).toBe(true);
	expect(match("src/x.py", "src/**/*.py")).toBe(true);
	expect(match("src/a/x.py", "src/**")).toBe(true);
	expect(match("lib/x.py", "src/**")).toBe(false);
	expect(match("deep/dir/package-lock.json", "package-lock.json")).toBe(true);
	expect(match("src/a/b.py", "src/*.py")).toBe(false);
	expect(match("anything/at/all", "**/*")).toBe(true);
});
