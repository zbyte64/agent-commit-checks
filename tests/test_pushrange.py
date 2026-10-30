from acc.gitcmd import parse_command
from acc.pushrange import resolve_fallback, resolve_push, resolve_rev_range, resolve_unpushed


def resolve(repo, cmd):
    return resolve_push(repo.path, parse_command(cmd).pushes)


def test_bare_push_current_branch(repo):
    a = repo.commit()
    b = repo.commit()
    r = resolve(repo, "git push")
    assert r.commits == [a, b]
    assert r.remote == "origin"
    assert len(r.refs) == 1 and r.refs[0].tip == b


def test_nothing_new(repo):
    assert resolve(repo, "git push").empty


def test_new_branch_without_upstream(repo):
    repo.git("checkout", "-q", "-b", "feature/x")
    a = repo.commit()
    r = resolve(repo, "git push -u origin feature/x")
    assert r.commits == [a]


def test_new_branch_excludes_commits_on_other_remote_branches(repo):
    repo.git("checkout", "-q", "-b", "base")
    repo.commit()
    repo.push("origin", "base")
    repo.git("checkout", "-q", "-b", "feature")
    c = repo.commit()
    assert resolve(repo, "git push origin feature").commits == [c]


def test_explicit_refspec_src_dst(repo):
    repo.git("checkout", "-q", "-b", "local")
    a = repo.commit()
    repo.git("checkout", "-q", "main")
    r = resolve(repo, "git push origin local:remote-name")
    assert r.commits == [a]


def test_head_refspec(repo):
    a = repo.commit()
    assert resolve(repo, "git push origin HEAD").commits == [a]
    assert resolve(repo, "git push origin HEAD:refs/heads/other").commits == [a]


def test_several_refspecs_union(repo):
    repo.git("checkout", "-q", "-b", "one")
    a = repo.commit()
    repo.git("checkout", "-q", "main")
    repo.git("checkout", "-q", "-b", "two")
    b = repo.commit()
    r = resolve(repo, "git push origin one two")
    assert set(r.commits) == {a, b}
    assert len(r.refs) == 2


def test_all_and_mirror(repo):
    repo.git("checkout", "-q", "-b", "one")
    a = repo.commit()
    repo.git("checkout", "-q", "main")
    b = repo.commit()
    assert set(resolve(repo, "git push --all origin").commits) == {a, b}
    assert set(resolve(repo, "git push --mirror origin").commits) == {a, b}


def test_force_push_same_rule(repo):
    repo.commit()
    repo.push()
    repo.git("commit", "-q", "--amend", "-m", "rewritten")
    head = repo.git("rev-parse", "HEAD")
    assert resolve(repo, "git push --force-with-lease").commits == [head]


def test_delete_and_tags_allow(repo):
    repo.commit()
    repo.git("tag", "v1")
    assert resolve(repo, "git push origin --delete old").empty
    assert resolve(repo, "git push origin :old").empty
    assert resolve(repo, "git push --tags").empty
    assert resolve(repo, "git push origin v1").empty
    assert resolve(repo, "git push origin refs/tags/v1").empty


def test_dry_run_allow(repo):
    repo.commit()
    assert resolve(repo, "git push -n").empty


def test_push_default_nothing(repo):
    repo.commit()
    repo.git("config", "push.default", "nothing")
    assert resolve(repo, "git push").empty


def test_push_default_matching(repo):
    repo.git("checkout", "-q", "-b", "local-only")
    repo.commit()
    repo.git("checkout", "-q", "main")
    m = repo.commit()
    repo.git("config", "push.default", "matching")
    assert resolve(repo, "git push origin").commits == [m]


def test_remote_by_url(repo):
    a = repo.commit()
    r = resolve(repo, f"git push {repo.remote} main")
    assert r.remote == "origin"
    assert r.commits == [a]


def test_stale_tracking_ref_reviews_more_never_less(repo):
    a = repo.commit()
    # Someone else's push already sent `a`, but our tracking ref is stale.
    repo.git("push", "-q", str(repo.remote), "HEAD:refs/heads/main")
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD~1")
    b = repo.commit()
    assert resolve(repo, "git push").commits == [a, b]


def test_merge_commits_included(repo):
    repo.git("checkout", "-q", "-b", "side")
    s = repo.commit()
    repo.git("checkout", "-q", "main")
    m1 = repo.commit()
    repo.git("merge", "-q", "--no-edit", "--no-ff", "side")
    merge = repo.git("rev-parse", "HEAD")
    r = resolve(repo, "git push")
    assert set(r.commits) == {s, m1, merge}
    assert r.commits[-1] == merge


def test_unknown_falls_back_to_upstream(repo):
    a = repo.commit()
    r = resolve_fallback(repo.path, "the push arguments use shell expansion")
    assert r.commits == [a]
    assert "could not tell" in r.note


def test_unpushed_and_rev_range(repo):
    a = repo.commit()
    b = repo.commit()
    assert resolve_unpushed(repo.path).commits == [a, b]
    assert resolve_rev_range(repo.path, "HEAD~1..HEAD").commits == [b]
    assert resolve_rev_range(repo.path, "unpushed").commits == [a, b]


def test_no_remote_at_all(tmp_path):
    from tests.conftest import Repo

    r = Repo(tmp_path)
    r.git("remote", "remove", "origin")
    a = r.commit()
    assert resolve_unpushed(r.path).commits == [a]
