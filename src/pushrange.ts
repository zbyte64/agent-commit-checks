/** Resolve which commits a push will send, from local refs only (no fetch). */
import * as g from "./git.ts";
import type { PushSpec } from "./gitcmd.ts";
import { pyRepr, words } from "./text.ts";

export interface PushedRef {
	/** Local ref or rev being pushed. */
	name: string;
	/** sha */
	tip: string;
	/** sha (or empty tree) the branch diff is taken against. */
	base: string;
}

export class PushRange {
	remote: string | null;
	refs: PushedRef[];
	/** Oldest first, union over refs. */
	commits: string[];
	description: string;
	/** Shown to the agent, e.g. "push command not understood". */
	note: string;

	constructor(init: { remote: string | null; refs?: PushedRef[]; commits?: string[]; description?: string; note?: string }) {
		this.remote = init.remote;
		this.refs = init.refs ?? [];
		this.commits = init.commits ?? [];
		this.description = init.description ?? "";
		this.note = init.note ?? "";
	}

	get empty(): boolean {
		return !this.commits.length;
	}
}

/** Map a push target (remote name, URL or path) to a configured remote name. */
async function resolveRemote(cwd: string, name: string | null): Promise<string | null> {
	const configured = await g.remotes(cwd);
	if (name === null) {
		const branch = await g.currentBranch(cwd);
		const keys = [branch ? `branch.${branch}.pushRemote` : null, "remote.pushDefault", branch ? `branch.${branch}.remote` : null];
		for (const key of keys) {
			if (!key) continue;
			const val = await g.configGet(cwd, key);
			if (val && configured.includes(val)) return val;
		}
		if (configured.includes("origin")) return "origin";
		return configured.length === 1 ? configured[0] : null;
	}
	if (configured.includes(name)) return name;
	for (const r of configured) {
		const urls = [...(await g.configGetAll(cwd, `remote.${r}.url`)), ...(await g.configGetAll(cwd, `remote.${r}.pushurl`))];
		if (urls.includes(name)) return r;
	}
	return null;
}

function notRemote(remote: string | null): string[] {
	return remote ? ["--not", `--remotes=${remote}`] : ["--not", "--remotes"];
}

async function isTag(cwd: string, src: string): Promise<boolean> {
	if (src.startsWith("refs/tags/")) return true;
	const full = await g.gitOk(cwd, ["rev-parse", "--symbolic-full-name", src]);
	if (full?.trim().startsWith("refs/tags/")) return true;
	// A name that is a tag but not a branch.
	return (
		(await g.gitOk(cwd, ["show-ref", "--verify", "--quiet", `refs/tags/${src}`])) !== null &&
		(await g.gitOk(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${src}`])) === null
	);
}

async function localBranches(cwd: string): Promise<string[]> {
	return words(await g.git(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads/"]));
}

async function expandGlobRefspec(cwd: string, src: string): Promise<string[]> {
	const prefix = src.split("*", 1)[0];
	return words(await g.git(cwd, ["for-each-ref", "--format=%(refname)", prefix.endsWith("/") ? prefix : `${prefix}*`]));
}

/** Refs a bare `git push [<remote>]` sends, per remote.<r>.push and push.default. */
async function defaultSources(cwd: string, remote: string | null): Promise<string[]> {
	if (remote) {
		const configured = await g.configGetAll(cwd, `remote.${remote}.push`);
		if (configured.length) return configured;
	}
	const mode = (await g.configGet(cwd, "push.default")) || "simple";
	if (mode === "nothing") return [];
	if (mode === "matching") {
		if (!remote) return [];
		const out = await g.git(cwd, ["for-each-ref", "--format=%(refname:lstrip=3)", `refs/remotes/${remote}/`]);
		const sources: string[] = [];
		for (const b of words(out)) {
			if (b !== "HEAD" && (await g.revParse(cwd, `refs/heads/${b}`))) sources.push(`refs/heads/${b}`);
		}
		return sources;
	}
	const branch = await g.currentBranch(cwd);
	return branch ? [`refs/heads/${branch}`] : [];
}

async function sourceRefs(cwd: string, spec: PushSpec, remote: string | null): Promise<string[]> {
	if (spec.allBranches || spec.mirror) return localBranches(cwd);
	if (!spec.refspecs.length) return spec.tags ? [] : defaultSources(cwd, remote);
	const sources: string[] = [];
	for (const refspec of spec.refspecs) {
		const rs = refspec.replace(/^\++/, "");
		let src = rs.includes(":") ? rs.slice(0, rs.indexOf(":")) : rs;
		if (!src) continue; // ":dst" deletes dst
		if (src === "@") src = "HEAD";
		if (src.includes("*")) {
			sources.push(...(await expandGlobRefspec(cwd, src)).filter((r) => !r.startsWith("refs/tags/")));
		} else if (!(await isTag(cwd, src))) {
			sources.push(src);
		}
	}
	return sources;
}

/** Parent of the oldest unpushed commit on the tip's first-parent chain. */
async function firstParentBase(cwd: string, tip: string, remote: string | null): Promise<string> {
	const chain = words(await g.git(cwd, ["rev-list", "--first-parent", tip, ...notRemote(remote)]));
	if (!chain.length) return tip;
	return g.firstParent(cwd, chain[chain.length - 1]);
}

async function commitsFor(cwd: string, tips: string[], remote: string | null): Promise<string[]> {
	if (!tips.length) return [];
	return words(await g.git(cwd, ["rev-list", "--reverse", "--topo-order", ...tips, ...notRemote(remote)]));
}

/** Union of the ranges of the push invocations in one command, all run in `cwd`. */
export async function resolvePush(cwd: string, specs: PushSpec[]): Promise<PushRange> {
	const refs: PushedRef[] = [];
	const descriptions: string[] = [];
	const commits: string[] = [];
	const seen = new Set<string>();
	const remotesSeen = new Set<string | null>();
	for (const spec of specs) {
		if (spec.delete || spec.dryRun) continue;
		const remote = await resolveRemote(cwd, spec.remote);
		remotesSeen.add(remote);
		for (const src of await sourceRefs(cwd, spec, remote)) {
			const sha = await g.revParse(cwd, src);
			if (!sha || refs.some((r) => r.tip === sha)) continue;
			const fresh = (await commitsFor(cwd, [sha], remote)).filter((c) => !seen.has(c));
			if (!fresh.length) continue;
			for (const c of fresh) seen.add(c);
			commits.push(...fresh);
			const name = src.startsWith("refs/heads/") ? src.slice("refs/heads/".length) : src;
			const ref = { name, tip: sha, base: await firstParentBase(cwd, sha, remote) };
			refs.push(ref);
			descriptions.push(`${g.short(ref.base)}..${ref.name}`);
		}
	}
	const remote = remotesSeen.size === 1 ? [...remotesSeen][0] : null;
	return new PushRange({ remote, refs, commits, description: descriptions.join(", ") });
}

/** What a bare `git push` of the current branch would send; used by `acc run`. */
export async function resolveUnpushed(cwd: string): Promise<PushRange> {
	const remote = await resolveRemote(cwd, null);
	const upstream = await g.gitOk(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	const head = await g.revParse(cwd, "HEAD");
	if (!head) return new PushRange({ remote, description: "(no commits)" });
	const base = await firstParentBase(cwd, head, remote);
	const name = (await g.currentBranch(cwd)) || "HEAD";
	const commits = await commitsFor(cwd, [head], remote);
	const description = upstream ? `${upstream.trim()}..${name}` : `${g.short(base)}..${name}`;
	const refs = base !== head ? [{ name, tip: head, base }] : [];
	return new PushRange({ remote, refs, commits, description });
}

/** For commands we cannot parse: review `@{upstream}..HEAD` and say so. */
export async function resolveFallback(cwd: string, reason: string): Promise<PushRange> {
	const r = await resolveUnpushed(cwd);
	r.note =
		`acc could not tell exactly what this push sends (${reason}); ` +
		`it reviewed ${r.description || "the unpushed commits on HEAD"} instead.`;
	return r;
}

/** An explicit `A..B` range, or a single rev meaning `<rev>` against remotes. */
export async function resolveRevRange(cwd: string, revRange: string): Promise<PushRange> {
	if (revRange === "unpushed") return resolveUnpushed(cwd);
	if (revRange.includes("..")) {
		const at = revRange.indexOf("..");
		const a = revRange.slice(0, at) || "HEAD";
		const b = revRange.slice(at + 2) || "HEAD";
		const tip = await g.revParse(cwd, b);
		if (!tip || !(await g.revParse(cwd, a))) throw new g.GitError(`unknown revision range ${pyRepr(revRange)}`);
		const commits = words(await g.git(cwd, ["rev-list", "--reverse", "--topo-order", `${a}..${b}`]));
		const base = (await g.git(cwd, ["merge-base", a, b])).trim() || g.EMPTY_TREE;
		const refs = commits.length ? [{ name: b, tip, base }] : [];
		return new PushRange({ remote: null, refs, commits, description: revRange });
	}
	const tip = await g.revParse(cwd, revRange);
	if (!tip) throw new g.GitError(`unknown revision ${pyRepr(revRange)}`);
	const commits = words(await g.git(cwd, ["rev-list", "--reverse", "--topo-order", tip, "--not", "--remotes"]));
	const base = await firstParentBase(cwd, tip, null);
	const refs = commits.length ? [{ name: revRange, tip, base }] : [];
	return new PushRange({ remote: null, refs, commits, description: `${g.short(base)}..${revRange}` });
}
