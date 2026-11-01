/** Build the range inputs that checks see, and the per-commit inputs the secret scan reads. */
import * as g from "./git.ts";
import { matchAny } from "./globs.ts";
import { redactDiff, type SecretHit, scanDiff } from "./secrets.ts";
import { splitlines } from "./text.ts";

const FILE_HEADER = /^diff --git a\/([^\n]*?) b\/([^\n]*)$/;

/** One unit of input: a single commit (for the secret scan), or the combined diff of a range. */
export class Context {
	/** Data block id: "range", a short sha, or "<base7>..<tip7>" in grading. */
	label: string;
	/** Full sha for single-commit contexts. */
	commit: string | null;
	/** Filtered and redacted, before truncation. */
	diff: string;
	message: string;
	files: string[];
	/** "path (reason)" */
	skipped: string[];
	secretHits: SecretHit[];

	constructor(init: {
		label: string;
		commit: string | null;
		diff: string;
		message: string;
		files: string[];
		skipped?: string[];
		secretHits?: SecretHit[];
	}) {
		this.label = init.label;
		this.commit = init.commit;
		this.diff = init.diff;
		this.message = init.message;
		this.files = init.files;
		this.skipped = init.skipped ?? [];
		this.secretHits = init.secretHits ?? [];
	}

	/**
	 * Fit the diff in `maxChars`, sharing the budget fairly across files.
	 *
	 * Cutting from the front would hide later files entirely (e.g. tests/ after src/), so small files
	 * are kept whole and large ones are clipped with a marker.
	 */
	clippedDiff(maxChars: number): { diff: string; truncated: boolean } {
		if (this.diff.length <= maxChars) return { diff: this.diff, truncated: false };
		const split = splitFiles(this.diff).map(([, chunk]) => chunk);
		const chunks = split.length ? split : [this.diff];
		const alloc = new Array<number>(chunks.length).fill(0);
		let remaining = maxChars;
		const order = chunks.map((_, i) => i).sort((a, b) => chunks[a].length - chunks[b].length);
		order.forEach((i, k) => {
			alloc[i] = Math.min(chunks[i].length, Math.floor(remaining / (chunks.length - k)));
			remaining -= alloc[i];
		});
		const out: string[] = [];
		chunks.forEach((chunk, i) => {
			const budget = alloc[i];
			if (budget >= chunk.length) {
				out.push(chunk);
				return;
			}
			let cut = chunk.slice(0, budget);
			const nl = cut.lastIndexOf("\n");
			if (nl > 0) cut = cut.slice(0, nl + 1);
			out.push(`${cut}[acc: ${chunk.length - cut.length} more characters of this file not shown]\n`);
		});
		return { diff: out.join(""), truncated: true };
	}
}

/** Split a unified diff into `[path, chunk]` per file. */
export function splitFiles(diff: string): [string, string][] {
	const chunks: [string, string][] = [];
	let path: string | null = null;
	let buf: string[] = [];
	for (const line of splitlines(diff, true)) {
		const m = FILE_HEADER.exec(line.replace(/\n+$/, ""));
		if (m) {
			if (path !== null) chunks.push([path, buf.join("")]);
			path = m[2];
			buf = [line];
		} else if (path !== null) {
			buf.push(line);
		}
	}
	if (path !== null) chunks.push([path, buf.join("")]);
	return chunks;
}

function isBinary(chunk: string): boolean {
	return chunk.includes("\nGIT binary patch\n") || /^Binary files .* differ$/m.test(chunk);
}

export function rawDiff(cwd: string, base: string, tip: string): Promise<string> {
	return g.git(cwd, ["diff", "--no-color", "--no-ext-diff", "--find-renames", base, tip]);
}

export function buildContext(
	label: string,
	raw: string,
	message: string,
	excludeGlobs: string[],
	commit: string | null = null,
	scan = true,
): Context {
	const kept: string[] = [];
	const files: string[] = [];
	const skipped: string[] = [];
	for (const [path, chunk] of splitFiles(raw)) {
		if (matchAny(path, excludeGlobs)) {
			skipped.push(`${path} (excluded)`);
		} else if (isBinary(chunk)) {
			skipped.push(`${path} (binary)`);
		} else {
			kept.push(chunk);
			files.push(path);
		}
	}
	let diff = kept.join("");
	const hits = scan ? scanDiff(diff, commit) : [];
	if (hits.some((h) => h.severity === "warn")) diff = redactDiff(diff);
	return new Context({ label, commit, diff, message, files, skipped, secretHits: hits });
}

export async function commitMessage(cwd: string, sha: string): Promise<string> {
	return (await g.git(cwd, ["log", "-1", "--format=%B", sha])).trim();
}

export async function commitContext(cwd: string, sha: string, excludeGlobs: string[], scan = true): Promise<Context> {
	const raw = await rawDiff(cwd, await g.firstParent(cwd, sha), sha);
	return buildContext(g.short(sha), raw, await commitMessage(cwd, sha), excludeGlobs, sha, scan);
}

export async function rangeMessages(cwd: string, commits: string[]): Promise<string> {
	const messages: string[] = [];
	for (const c of commits) messages.push(`${g.short(c)}: ${await commitMessage(cwd, c)}`);
	return messages.join("\n\n");
}

/** A pushed ref: `[name, base, tip]`. */
export type RefTriple = [name: string, base: string, tip: string];

/** Combined diff over pushed refs with every pushed commit's message. */
export async function rangeContext(
	cwd: string,
	refs: RefTriple[],
	commits: string[],
	excludeGlobs: string[],
	scan = true,
	label = "range",
): Promise<Context> {
	let raw = "";
	for (const [, base, tip] of refs) raw += await rawDiff(cwd, base, tip);
	return buildContext(label, raw, await rangeMessages(cwd, commits), excludeGlobs, null, scan);
}
