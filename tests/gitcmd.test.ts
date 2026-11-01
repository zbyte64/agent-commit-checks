import { expect, test } from "bun:test";
import { parseCommand } from "../src/gitcmd.ts";

test.each(["ls -la", "git status", "echo 'git push'", "git commit -m 'push the button'", "npm run push", "grep -r push src"])(
	"not a push: %s",
	(cmd) => {
		expect(parseCommand(cmd).kind).toBe("none");
	},
);

test.each([
	["git push", null, []],
	["git push -u origin feature/x", "origin", ["feature/x"]],
	["git push --set-upstream origin HEAD", "origin", ["HEAD"]],
	["git push origin a:b", "origin", ["a:b"]],
	["git push origin a b:c +d", "origin", ["a", "b:c", "+d"]],
	["git push --force-with-lease origin main", "origin", ["main"]],
	["git push -o ci.skip origin main", "origin", ["main"]],
	["git push --repo=upstream", "upstream", []],
	["git push origin main 2>&1", "origin", ["main"]],
	["git push origin main > /tmp/out.log", "origin", ["main"]],
	["git push origin main &>/dev/null", "origin", ["main"]],
	["GIT_TRACE=1 git push origin main", "origin", ["main"]],
	["env GIT_SSH_COMMAND='ssh -i k' git push origin main", "origin", ["main"]],
	["command git push origin main", "origin", ["main"]],
	["/usr/bin/git push origin main", "origin", ["main"]],
	["git -c push.default=current push", null, []],
	["git --no-pager push origin main | tail -5", "origin", ["main"]],
	["git fetch && git push origin main", "origin", ["main"]],
	["git push origin main # deploy", "origin", ["main"]],
] as [string, string | null, string[]][])("push form: %s", (cmd, remote, refspecs) => {
	const p = parseCommand(cmd);
	expect(p.kind).toBe("push");
	expect(p.pushes[0].remote).toBe(remote);
	expect(p.pushes[0].refspecs).toEqual(refspecs);
});

test("flags", () => {
	expect(parseCommand("git push --all origin").pushes[0].allBranches).toBe(true);
	expect(parseCommand("git push --mirror origin").pushes[0].mirror).toBe(true);
	expect(parseCommand("git push --tags").pushes[0].tagsOnly).toBe(true);
	expect(parseCommand("git push --tags origin main").pushes[0].tagsOnly).toBe(false);
	expect(parseCommand("git push origin --delete x").pushes[0].delete).toBe(true);
	expect(parseCommand("git push -d origin x").pushes[0].delete).toBe(true);
	expect(parseCommand("git push -n origin main").pushes[0].dryRun).toBe(true);
	expect(parseCommand("git push -f origin main").pushes[0].force).toBe(true);
	expect(parseCommand("git push -uf origin main").pushes[0].force).toBe(true);
});

test("cwd tracking", () => {
	expect(parseCommand("cd sub && git push").pushes[0].cwd).toBe("sub");
	expect(parseCommand("git -C ../other push origin main").pushes[0].cwd).toBe("../other");
	expect(parseCommand("cd a && cd b && git push").pushes[0].cwd).toBe("a/b");
});

test("multiple pushes", () => {
	expect(parseCommand("git push origin a; git push origin b").pushes.map((s) => s.refspecs)).toEqual([["a"], ["b"]]);
});

test.each([
	"git commit -m 'x' && git push",
	"git add . && git commit -m 'msg' && git push origin main",
	"git commit --amend --no-edit; git push -f",
	"git merge feature && git push",
	"git cherry-pick abc && git push",
	"git pull --rebase && git push",
	"bash -c 'git commit -m x && git push'",
	"git commit -m \"$(cat <<'EOF'\nFix things\n\nMore detail\nEOF\n)\" && git push",
])("commit and push: %s", (cmd) => {
	expect(parseCommand(cmd).kind).toBe("commit_and_push");
});

test("push then commit is a plain push", () => {
	expect(parseCommand("git push && git commit -m 'next'").kind).toBe("push");
});

test.each([
	"git push $REMOTE main",
	"git push origin $(git branch --show-current)",
	"git push origin `git rev-parse --abbrev-ref HEAD`",
	"eval git push origin main",
	"git push origin 'unterminated",
	"for b in a b; do git push origin $b; done",
	"xargs -n1 git push origin < branches.txt",
])("unknown: %s", (cmd) => {
	expect(parseCommand(cmd).kind).toBe("unknown");
});

test("shell -c recursion", () => {
	let p = parseCommand("bash -c 'git push origin main'");
	expect(p.kind).toBe("push");
	expect(p.pushes[0].refspecs).toEqual(["main"]);
	p = parseCommand('sh -lc "cd repo && git push"');
	expect(p.pushes[0].cwd).toBe("repo");
});

test("a heredoc body is data", () => {
	// Unbalanced quotes inside a heredoc used to make the whole command "unknown".
	const cmd = "python3 - <<'EOF'\ns = open('t.py').read()\ns = s.replace('''a''', '''b\n" + '    gate(enabled, "git push")\n\'\'\')\nEOF\nuv run pytest -q';
	expect(parseCommand(cmd).kind).toBe("none");
	expect(parseCommand("cat > notes.txt <<EOF\nremember to git push\nEOF").kind).toBe("none");
	expect(parseCommand("cat <<-EOF\n\tgit push origin main\n\tEOF\necho done").kind).toBe("none");
});

test("a heredoc fed to a shell is parsed", () => {
	const p = parseCommand("bash <<'EOF'\ncd repo\ngit push origin main\nEOF");
	expect(p.kind).toBe("push");
	expect(p.pushes[0].refspecs).toEqual(["main"]);
});

test("an email in a quoted message is not a redirect", () => {
	const msg = 'git commit -qm "Fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>"';
	expect(parseCommand(`${msg} && git push`).kind).toBe("commit_and_push");
	expect(parseCommand('git tag -m "by <a@b.c>" v1; git push origin main').kind).toBe("push");
});

test("heredoc, then a push on a later line", () => {
	expect(parseCommand("cat > f.txt <<EOF\ndon't\nEOF\ngit push origin main").kind).toBe("push");
});

test("a comment ends at its line: the next line still pushes", () => {
	const p = parseCommand("echo hi # note\ngit push origin main");
	expect(p.kind).toBe("push");
	expect(p.pushes[0].refspecs).toEqual(["main"]);
	expect(parseCommand("# git push later\necho done").kind).toBe("none");
});

test("# inside a word is not a comment", () => {
	const p = parseCommand("echo issue#12 && git push origin main");
	expect(p.kind).toBe("push");
	expect(p.pushes[0].refspecs).toEqual(["main"]);
	expect(parseCommand('git commit -m "fix #3" && git push').kind).toBe("commit_and_push");
});

test("a backslash-newline continues the command", () => {
	const p = parseCommand("git push \\\n  origin main");
	expect(p.kind).toBe("push");
	expect(p.pushes[0].remote).toBe("origin");
	expect(p.pushes[0].refspecs).toEqual(["main"]);
});

test("subshell", () => {
	expect(parseCommand("(cd sub && git push origin main)").kind).toBe("push");
});
