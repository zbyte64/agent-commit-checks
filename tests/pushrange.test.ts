import { expect, test } from "bun:test";
import { parseCommand } from "../src/gitcmd.ts";
import { type PushRange, resolveFallback, resolvePush, resolveRevRange, resolveUnpushed } from "../src/pushrange.ts";
import { makeRepo, Repo, useTmp } from "./helpers.ts";

const tmp = useTmp();

function resolve(repo: Repo, cmd: string): Promise<PushRange> {
	return resolvePush(repo.path, parseCommand(cmd).pushes);
}

test("bare push sends the current branch", async () => {
	const repo = makeRepo(tmp());
	const a = repo.commit();
	const b = repo.commit();
	const r = await resolve(repo, "git push");
	expect(r.commits).toEqual([a, b]);
	expect(r.remote).toBe("origin");
	expect(r.refs.length).toBe(1);
	expect(r.refs[0].tip).toBe(b);
});

test("nothing new", async () => {
	expect((await resolve(makeRepo(tmp()), "git push")).empty).toBe(true);
});

test("new branch without upstream", async () => {
	const repo = makeRepo(tmp());
	repo.git("checkout", "-q", "-b", "feature/x");
	const a = repo.commit();
	expect((await resolve(repo, "git push -u origin feature/x")).commits).toEqual([a]);
});

test("a new branch excludes commits on other remote branches", async () => {
	const repo = makeRepo(tmp());
	repo.git("checkout", "-q", "-b", "base");
	repo.commit();
	repo.push("origin", "base");
	repo.git("checkout", "-q", "-b", "feature");
	const c = repo.commit();
	expect((await resolve(repo, "git push origin feature")).commits).toEqual([c]);
});

test("explicit src:dst refspec", async () => {
	const repo = makeRepo(tmp());
	repo.git("checkout", "-q", "-b", "local");
	const a = repo.commit();
	repo.git("checkout", "-q", "main");
	expect((await resolve(repo, "git push origin local:remote-name")).commits).toEqual([a]);
});

test("HEAD refspec", async () => {
	const repo = makeRepo(tmp());
	const a = repo.commit();
	expect((await resolve(repo, "git push origin HEAD")).commits).toEqual([a]);
	expect((await resolve(repo, "git push origin HEAD:refs/heads/other")).commits).toEqual([a]);
});

test("several refspecs: the union", async () => {
	const repo = makeRepo(tmp());
	repo.git("checkout", "-q", "-b", "one");
	const a = repo.commit();
	repo.git("checkout", "-q", "main");
	repo.git("checkout", "-q", "-b", "two");
	const b = repo.commit();
	const r = await resolve(repo, "git push origin one two");
	expect(new Set(r.commits)).toEqual(new Set([a, b]));
	expect(r.refs.length).toBe(2);
});

test("--all and --mirror", async () => {
	const repo = makeRepo(tmp());
	repo.git("checkout", "-q", "-b", "one");
	const a = repo.commit();
	repo.git("checkout", "-q", "main");
	const b = repo.commit();
	expect(new Set((await resolve(repo, "git push --all origin")).commits)).toEqual(new Set([a, b]));
	expect(new Set((await resolve(repo, "git push --mirror origin")).commits)).toEqual(new Set([a, b]));
});

test("force push follows the same rule", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	repo.push();
	repo.git("commit", "-q", "--amend", "-m", "rewritten");
	const head = repo.git("rev-parse", "HEAD");
	expect((await resolve(repo, "git push --force-with-lease")).commits).toEqual([head]);
});

test("deletes and tags are allowed", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	repo.git("tag", "v1");
	for (const cmd of ["git push origin --delete old", "git push origin :old", "git push --tags", "git push origin v1", "git push origin refs/tags/v1"]) {
		expect((await resolve(repo, cmd)).empty).toBe(true);
	}
});

test("dry run is allowed", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	expect((await resolve(repo, "git push -n")).empty).toBe(true);
});

test("push.default nothing", async () => {
	const repo = makeRepo(tmp());
	repo.commit();
	repo.git("config", "push.default", "nothing");
	expect((await resolve(repo, "git push")).empty).toBe(true);
});

test("push.default matching", async () => {
	const repo = makeRepo(tmp());
	repo.git("checkout", "-q", "-b", "local-only");
	repo.commit();
	repo.git("checkout", "-q", "main");
	const m = repo.commit();
	repo.git("config", "push.default", "matching");
	expect((await resolve(repo, "git push origin")).commits).toEqual([m]);
});

test("remote given by URL", async () => {
	const repo = makeRepo(tmp());
	const a = repo.commit();
	const r = await resolve(repo, `git push ${repo.remote} main`);
	expect(r.remote).toBe("origin");
	expect(r.commits).toEqual([a]);
});

test("a stale tracking ref reviews more, never less", async () => {
	const repo = makeRepo(tmp());
	const a = repo.commit();
	// Someone else's push already sent `a`, but our tracking ref is stale.
	repo.git("push", "-q", repo.remote, "HEAD:refs/heads/main");
	repo.git("update-ref", "refs/remotes/origin/main", "HEAD~1");
	const b = repo.commit();
	expect((await resolve(repo, "git push")).commits).toEqual([a, b]);
});

test("merge commits are included", async () => {
	const repo = makeRepo(tmp());
	repo.git("checkout", "-q", "-b", "side");
	const s = repo.commit();
	repo.git("checkout", "-q", "main");
	const m1 = repo.commit();
	repo.git("merge", "-q", "--no-edit", "--no-ff", "side");
	const merge = repo.git("rev-parse", "HEAD");
	const r = await resolve(repo, "git push");
	expect(new Set(r.commits)).toEqual(new Set([s, m1, merge]));
	expect(r.commits[r.commits.length - 1]).toBe(merge);
});

test("unknown commands fall back to the upstream", async () => {
	const repo = makeRepo(tmp());
	const a = repo.commit();
	const r = await resolveFallback(repo.path, "the push arguments use shell expansion");
	expect(r.commits).toEqual([a]);
	expect(r.note).toContain("could not tell");
});

test("unpushed and rev ranges", async () => {
	const repo = makeRepo(tmp());
	const a = repo.commit();
	const b = repo.commit();
	expect((await resolveUnpushed(repo.path)).commits).toEqual([a, b]);
	expect((await resolveRevRange(repo.path, "HEAD~1..HEAD")).commits).toEqual([b]);
	expect((await resolveRevRange(repo.path, "unpushed")).commits).toEqual([a, b]);
});

test("no remote at all", async () => {
	const r = new Repo(tmp());
	r.git("remote", "remove", "origin");
	const a = r.commit();
	expect((await resolveUnpushed(r.path)).commits).toEqual([a]);
});
