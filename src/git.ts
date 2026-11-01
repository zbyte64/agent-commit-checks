/** Thin wrapper around the git binary. */
import { run } from "./proc.ts";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class GitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GitError";
	}
}

/** Run git and return stdout; a non-zero exit raises GitError unless `check` is false. */
export async function git(cwd: string, args: string[], check = true): Promise<string> {
	const proc = await run("git", args, { cwd });
	if (check && proc.code !== 0) throw new GitError(`git ${args.join(" ")}: ${proc.stderr.trim()}`);
	return proc.stdout;
}

/** Run git and return stdout, or null if it failed. */
export async function gitOk(cwd: string, args: string[]): Promise<string | null> {
	const proc = await run("git", args, { cwd });
	return proc.code === 0 ? proc.stdout : null;
}

export async function repoRoot(cwd: string): Promise<string> {
	return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

export async function revParse(cwd: string, rev: string): Promise<string | null> {
	const out = await gitOk(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
	return out ? out.trim() : null;
}

export async function configGet(cwd: string, key: string): Promise<string | null> {
	const out = await gitOk(cwd, ["config", "--get", key]);
	return out ? out.trim() : null;
}

export async function configGetAll(cwd: string, key: string): Promise<string[]> {
	const out = await gitOk(cwd, ["config", "--get-all", key]);
	return out ? out.split("\n").slice(0, -1) : [];
}

export async function remotes(cwd: string): Promise<string[]> {
	return (await git(cwd, ["remote"])).split(/\s+/).filter(Boolean);
}

export async function currentBranch(cwd: string): Promise<string | null> {
	const out = await gitOk(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	return out ? out.trim() : null;
}

/** The first parent of a commit, or the empty tree for a root commit. */
export async function firstParent(cwd: string, sha: string): Promise<string> {
	return (await revParse(cwd, `${sha}^1`)) ?? EMPTY_TREE;
}

export function short(sha: string): string {
	return sha.slice(0, 7);
}
