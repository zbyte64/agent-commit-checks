import json

import pytest

from acc import grading, ops
from acc.backends import get_backend
from tests.conftest import FAKE_AWS_KEY, check_toml


def history(repo, n, py_every=1, term_every=0):
    """n commits on main; every `py_every`-th touches a .py file, every `term_every`-th adds 'console.log'."""
    shas = []
    for i in range(1, n + 1):
        name = f"src/m{i}.py" if i % py_every == 0 else f"docs/d{i}.md"
        body = "console.log('x')\n" if term_every and i % term_every == 0 else f"value = {i}\n"
        shas.append(repo.commit({name: body}, f"change {i}"))
    repo.push()
    return shas


def setup(repo, answers=None, extra="", **kw):
    repo.enable(checks={"dbg": check_toml("dbg", applies_to='["**/*.py"]', extra=extra, **kw)},
                answers=answers or {"*": {"answer": 0.1, "findings": [], "summary": "ok"}})
    cfg = repo.config()
    return cfg, ops.get_check(cfg, "dbg")


def test_filter_and_size(repo):
    history(repo, 40, py_every=2)
    cfg, check = setup(repo)
    units, pool, _ = grading.select_sample(cfg, repo.path, check)
    assert pool == 20  # only .py commits are eligible
    assert len(units) == 20
    assert all(any(f.endswith(".py") for f in u.context.files) for u in units)


def test_top_scores_and_seeded_random(repo):
    history(repo, 60, term_every=5)
    cfg, check = setup(repo, extra='\n[grading]\nterms = ["console.log"]\n')
    units, pool, _ = grading.select_sample(cfg, repo.path, check)
    top = [u for u in units if u.reason == "top-score"]
    rand = [u for u in units if u.reason == "random"]
    assert len(top) == 10 and len(rand) == 10
    assert all(u.score >= 4 for u in top)  # 1 path + 3 per term hit
    again, _, _ = grading.select_sample(cfg, repo.path, check)
    assert [u.sha for u in units] == [u.sha for u in again]
    repo.commit({"src/new.py": "x = 1\n"})  # new HEAD reseeds the draw
    third, _, _ = grading.select_sample(cfg, repo.path, check)
    assert {u.sha for u in third if u.reason == "random"} != {u.sha for u in rand}


def test_small_pool_uses_all_and_is_insufficient(repo):
    history(repo, 6)
    cfg, check = setup(repo)
    units, pool, _ = grading.select_sample(cfg, repo.path, check)
    assert len(units) == pool == 6
    g = grading.grade(cfg, repo.path, check, get_backend(cfg, "claude"))
    assert g.result == "insufficient"


def test_excludes_secret_and_check_creation_commits(repo):
    history(repo, 12)
    repo.commit({"src/leak.py": f'K = "{FAKE_AWS_KEY}"\n'})
    cfg, check = setup(repo)
    repo.git("add", ".acc")
    repo.commit({"src/with_check.py": "x = 1\n"}, "add check")
    added = repo.git("rev-parse", "HEAD")
    units, pool, _ = grading.select_sample(cfg, repo.path, check)
    files = {f for u in units for f in u.context.files}
    assert "src/leak.py" not in files
    assert added not in {u.sha for u in units}


def test_grade_pass_writes_record(repo):
    history(repo, 25)
    cfg, check = setup(repo)
    g = grading.grade(cfg, repo.path, check, get_backend(cfg, "claude"))
    assert g.result == "pass"
    assert g.metrics["sample_size"] == 20 and g.metrics["calls"] == 3  # 20 entries / 8 per call
    rec = json.loads((cfg.grades_dir / "dbg.json").read_text())
    assert rec["check_sha256"] == check.content_hash
    assert len(rec["sample"]) == 20 and {s["reason"] for s in rec["sample"]} == {"top-score", "random"}
    assert grading.grade_status(cfg, check) == "pass"


def test_grade_fails_on_block_rate(repo):
    history(repo, 25)
    cfg, check = setup(repo, answers={"*": {"answer": 0.95, "findings": [], "summary": "bad"}})
    g = grading.grade(cfg, repo.path, check, get_backend(cfg, "claude"))
    assert g.result == "fail" and g.metrics["block_rate"] == 1.0
    # blocked and warned units are re-run for stability
    assert g.metrics["calls"] == 6


def test_expect_fail_catch_rate(repo):
    shas = history(repo, 25)
    target = shas[3]
    cfg, check = setup(repo, extra=f'\n[grading]\nexpect_fail = ["{target[:9]}"]\n',
                       answers={"*": {"answer": 0.1, "findings": [], "summary": "ok"}})
    g = grading.grade(cfg, repo.path, check, get_backend(cfg, "claude"))
    assert g.metrics["catch_rate"] == 0.0 and g.result == "fail"
    assert g.metrics["sample_size"] == 20  # expect_fail units are on top of the sample
    (repo.path / "answers.json").write_text(json.dumps({
        "*": {"answer": 0.1, "findings": [], "summary": "ok"},
        f"dbg@{target[:7]}": {"answer": 0.99, "findings": [], "summary": "caught"},
    }))
    g = grading.grade(cfg, repo.path, check, get_backend(cfg, "claude"))
    assert g.metrics["catch_rate"] == 1.0 and g.result == "pass"


def test_promote_requires_current_passing_grade(repo):
    history(repo, 25)
    cfg, check = setup(repo, status="proposed")
    with pytest.raises(ops.OpError, match="no grade"):
        ops.promote(cfg, "dbg", "active")
    r = ops.promote(cfg, "dbg", "advisory")
    assert r["new_line"] == 'status = "advisory"'
    grading.grade(cfg, repo.path, ops.get_check(cfg, "dbg"), get_backend(cfg, "claude"))
    r = ops.promote(cfg, "dbg", "active")
    assert r["old_line"] == 'status = "advisory"' and ops.get_check(cfg, "dbg").status == "active"
    # Promotion edits only the status line, so the grade still matches.
    assert grading.grade_status(cfg, ops.get_check(cfg, "dbg")) == "pass"


def test_editing_check_invalidates_grade(repo):
    history(repo, 25)
    cfg, check = setup(repo, status="advisory")
    grading.grade(cfg, repo.path, check, get_backend(cfg, "claude"))
    path = cfg.checks_dir / "dbg.toml"
    path.write_text(path.read_text().replace("Is there a problem?", "Is there any problem?"))
    assert grading.grade_status(cfg, ops.get_check(cfg, "dbg")) == "stale"
    with pytest.raises(ops.OpError, match="changed since"):
        ops.promote(cfg, "dbg", "active")
    assert ops.promote(cfg, "dbg", "active", force=True)["status"] == "active"


def test_explicit_commits_grade_exactly_those(repo):
    shas = history(repo, 30, py_every=2)  # odd commits touch docs only
    cfg, check = setup(repo)
    pick = [shas[1], shas[3][:9], shas[0]]  # two .py commits (one abbreviated), one docs commit
    units, pool, excluded = grading.select_sample(cfg, repo.path, check, commits=pick)
    assert [u.sha for u in units] == [shas[1], shas[3]]
    assert all(u.reason == "selected" for u in units)
    assert excluded == [{"sha": shas[0], "reason": "no changed path matches applies_to"}]


def test_range_draws_only_from_range(repo):
    shas = history(repo, 40)
    cfg, check = setup(repo)
    units, pool, excluded = grading.select_sample(cfg, repo.path, check, rev_range=f"{shas[4]}..{shas[9]}")
    assert {u.sha for u in units} == set(shas[5:10])
    assert pool == 5 and excluded == []
    units, pool, _ = grading.select_sample(cfg, repo.path, check, rev_range=f"{shas[0]}..{shas[-1]}")
    assert pool == 39 and len(units) == 20  # large ranges are still sampled
    assert {u.reason for u in units} == {"top-score", "random"}


def test_selection_errors(repo):
    shas = history(repo, 3)
    cfg, check = setup(repo)
    with pytest.raises(grading.GradeError, match="not both"):
        grading.select_sample(cfg, repo.path, check, commits=[shas[0]], rev_range="HEAD~1..HEAD")
    with pytest.raises(grading.GradeError, match="unknown commit"):
        grading.select_sample(cfg, repo.path, check, commits=["nope"])
    with pytest.raises(grading.GradeError, match="A..B"):
        grading.select_sample(cfg, repo.path, check, rev_range="HEAD")


def test_hand_picked_grade_promotes_for_user_not_agent(repo):
    shas = history(repo, 25)
    cfg, check = setup(repo, status="advisory")
    g = grading.grade(cfg, repo.path, check, get_backend(cfg, "claude"), commits=shas[:12])
    assert g.result == "pass"
    assert g.record["selection"] == {"mode": "commits", "commits": shas[:12]}
    with pytest.raises(ops.OpError, match="chosen commits or a range"):
        ops.promote(cfg, "dbg", "active", allow_hand_picked=False)
    assert ops.promote(cfg, "dbg", "active")["status"] == "active"


def test_automatic_grade_records_mode(repo):
    history(repo, 12)
    cfg, check = setup(repo)
    g = grading.grade(cfg, repo.path, check, get_backend(cfg, "claude"))
    assert g.record["selection"] == {"mode": "auto"} and g.record["excluded"] == []
    assert not grading.is_hand_picked(g.record)
    assert not grading.is_hand_picked({"result": "pass"})  # records from before this field
