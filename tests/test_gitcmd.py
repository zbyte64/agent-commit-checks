import pytest

from acc.gitcmd import parse_command


@pytest.mark.parametrize("cmd", [
    "ls -la",
    "git status",
    "echo 'git push'",
    "git commit -m 'push the button'",
    "npm run push",
    "grep -r push src",
])
def test_not_a_push(cmd):
    assert parse_command(cmd).kind == "none"


@pytest.mark.parametrize("cmd,remote,refspecs", [
    ("git push", None, []),
    ("git push -u origin feature/x", "origin", ["feature/x"]),
    ("git push --set-upstream origin HEAD", "origin", ["HEAD"]),
    ("git push origin a:b", "origin", ["a:b"]),
    ("git push origin a b:c +d", "origin", ["a", "b:c", "+d"]),
    ("git push --force-with-lease origin main", "origin", ["main"]),
    ("git push -o ci.skip origin main", "origin", ["main"]),
    ("git push --repo=upstream", "upstream", []),
    ("git push origin main 2>&1", "origin", ["main"]),
    ("git push origin main > /tmp/out.log", "origin", ["main"]),
    ("git push origin main &>/dev/null", "origin", ["main"]),
    ("GIT_TRACE=1 git push origin main", "origin", ["main"]),
    ("env GIT_SSH_COMMAND='ssh -i k' git push origin main", "origin", ["main"]),
    ("command git push origin main", "origin", ["main"]),
    ("/usr/bin/git push origin main", "origin", ["main"]),
    ("git -c push.default=current push", None, []),
    ("git --no-pager push origin main | tail -5", "origin", ["main"]),
    ("git fetch && git push origin main", "origin", ["main"]),
    ("git push origin main # deploy", "origin", ["main"]),
])
def test_push_forms(cmd, remote, refspecs):
    p = parse_command(cmd)
    assert p.kind == "push", p.reason
    assert p.pushes[0].remote == remote
    assert p.pushes[0].refspecs == refspecs


def test_flags():
    assert parse_command("git push --all origin").pushes[0].all_branches
    assert parse_command("git push --mirror origin").pushes[0].mirror
    assert parse_command("git push --tags").pushes[0].tags_only
    assert not parse_command("git push --tags origin main").pushes[0].tags_only
    assert parse_command("git push origin --delete x").pushes[0].delete
    assert parse_command("git push -d origin x").pushes[0].delete
    assert parse_command("git push -n origin main").pushes[0].dry_run
    assert parse_command("git push -f origin main").pushes[0].force
    assert parse_command("git push -uf origin main").pushes[0].force


def test_cwd_tracking():
    p = parse_command("cd sub && git push")
    assert p.pushes[0].cwd == "sub"
    p = parse_command("git -C ../other push origin main")
    assert p.pushes[0].cwd == "../other"
    p = parse_command("cd a && cd b && git push")
    assert p.pushes[0].cwd == "a/b"


def test_multiple_pushes():
    p = parse_command("git push origin a; git push origin b")
    assert [s.refspecs for s in p.pushes] == [["a"], ["b"]]


@pytest.mark.parametrize("cmd", [
    "git commit -m 'x' && git push",
    "git add . && git commit -m 'msg' && git push origin main",
    "git commit --amend --no-edit; git push -f",
    "git merge feature && git push",
    "git cherry-pick abc && git push",
    "git pull --rebase && git push",
    "bash -c 'git commit -m x && git push'",
    'git commit -m "$(cat <<\'EOF\'\nFix things\n\nMore detail\nEOF\n)" && git push',
])
def test_commit_and_push(cmd):
    assert parse_command(cmd).kind == "commit_and_push"


def test_push_then_commit_is_plain_push():
    assert parse_command("git push && git commit -m 'next'").kind == "push"


@pytest.mark.parametrize("cmd", [
    "git push $REMOTE main",
    "git push origin $(git branch --show-current)",
    "git push origin `git rev-parse --abbrev-ref HEAD`",
    "eval git push origin main",
    "git push origin 'unterminated",
    "for b in a b; do git push origin $b; done",
    "xargs -n1 git push origin < branches.txt",
])
def test_unknown(cmd):
    assert parse_command(cmd).kind == "unknown"


def test_shell_c_recursion():
    p = parse_command("bash -c 'git push origin main'")
    assert p.kind == "push"
    assert p.pushes[0].refspecs == ["main"]
    p = parse_command("sh -lc \"cd repo && git push\"")
    assert p.pushes[0].cwd == "repo"


def test_heredoc_body_is_data():
    # Unbalanced quotes inside a heredoc used to make the whole command "unknown".
    cmd = ("python3 - <<'EOF'\ns = open('t.py').read()\ns = s.replace('''a''', '''b\n"
           '    gate(enabled, "git push")\n''\')\nEOF\nuv run pytest -q')
    assert parse_command(cmd).kind == "none"
    assert parse_command("cat > notes.txt <<EOF\nremember to git push\nEOF").kind == "none"
    assert parse_command("cat <<-EOF\n\tgit push origin main\n\tEOF\necho done").kind == "none"


def test_heredoc_fed_to_shell_is_parsed():
    p = parse_command("bash <<'EOF'\ncd repo\ngit push origin main\nEOF")
    assert p.kind == "push"
    assert p.pushes[0].refspecs == ["main"]


def test_email_in_quoted_message_is_not_a_redirect():
    msg = 'git commit -qm "Fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'
    assert parse_command(msg + " && git push").kind == "commit_and_push"
    assert parse_command('git tag -m "by <a@b.c>" v1; git push origin main').kind == "push"


def test_heredoc_then_push_on_later_line():
    p = parse_command("cat > f.txt <<EOF\ndon't\nEOF\ngit push origin main")
    assert p.kind == "push"


def test_subshell():
    p = parse_command("(cd sub && git push origin main)")
    assert p.kind == "push"
