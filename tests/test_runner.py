import json

from acc import checks as checks_mod
from acc.backends import BackendError, get_backend
from acc.pushrange import resolve_unpushed
from acc.runner import review
from tests.conftest import FAKE_AWS_KEY, check_toml


def run(repo, answers, *checks_text, config=""):
    repo.enable(config=config, checks=dict(checks_text), answers=answers)
    cfg = repo.config()
    loaded, errors = checks_mod.load_all(cfg.checks_dir)
    assert not errors
    return review(cfg, repo.path, resolve_unpushed(repo.path), loaded, get_backend(cfg, "claude"))


def ans(a, summary="s", findings=()):
    return {"answer": a, "findings": list(findings), "summary": summary}


def test_pass(repo):
    repo.commit()
    res = run(repo, {"*": ans(0.1)}, ("a", check_toml("a")))
    assert res.verdict == "pass" and res.calls == 1
    assert [e.key for e in res.entries] == ["a"]


def test_block_and_warn_aggregate(repo):
    repo.commit()
    res = run(repo, {"a": ans(0.9), "b": ans(0.6)}, ("a", check_toml("a")), ("b", check_toml("b")))
    assert res.verdict == "block"
    assert {e.check_id: e.verdict for e in res.entries} == {"a": "block", "b": "warn"}


def test_advisory_block_becomes_warn(repo):
    repo.commit()
    res = run(repo, {"*": ans(0.99)}, ("a", check_toml("a", status="advisory")))
    assert res.verdict == "warn"
    assert res.entries[0].raw_verdict == "block"


def test_per_commit_keys_and_messages(repo):
    a = repo.commit(msg="first")
    b = repo.commit(msg="second")
    res = run(repo, {f"pc@{b[:7]}": ans("bad"), "pc": ans("good")},
              ("pc", check_toml("pc", qtype="choice", scope="per_commit", inputs='["diff", "message"]')))
    assert [e.key for e in res.entries] == [f"pc@{a[:7]}", f"pc@{b[:7]}"]
    assert [e.verdict for e in res.entries] == ["pass", "block"]
    assert res.entries[1].commit == b[:7]


def test_applies_to_skips(repo):
    repo.commit({"docs/readme.md": "x\n"})
    res = run(repo, {"*": ans(0.99)}, ("py", check_toml("py", applies_to='["**/*.py"]')))
    assert res.verdict == "pass" and res.calls == 0
    assert res.checks_skipped == ["py"]


def test_per_commit_applies_to_per_commit(repo):
    repo.commit({"a.py": "x\n"})
    repo.commit({"b.md": "x\n"})
    res = run(repo, {"*": ans(0.1)}, ("py", check_toml("py", scope="per_commit", applies_to='["*.py"]')))
    assert len(res.entries) == 1


def test_batching_and_parallel_calls(repo):
    repo.commit()
    checks = [(f"c{i}", check_toml(f"c{i}")) for i in range(5)]
    res = run(repo, {"*": ans(0.1)}, *checks, config="[run]\nmax_checks_per_call = 2\n")
    assert res.calls == 3
    assert len(res.entries) == 5


def test_missing_entry_retried_alone_then_errors(repo, tmp_path):
    repo.commit()
    res = run(repo, {"a": ans(0.1), "b": "omit"}, ("a", check_toml("a")), ("b", check_toml("b")))
    assert res.calls == 2  # one batch + one retry for b
    b = next(e for e in res.entries if e.check_id == "b")
    assert b.error and b.verdict == "block"  # on_backend_error defaults to block


def test_invalid_answer_retried(repo):
    repo.commit()
    res = run(repo, {"a": ans(7)}, ("a", check_toml("a")), config='[run]\non_backend_error = "warn"\n')
    assert res.calls == 2
    assert res.entries[0].error.startswith("invalid answer")
    assert res.verdict == "warn"


def test_backend_error_not_retried(repo):
    repo.commit()
    res = run(repo, {"*": "error"}, ("a", check_toml("a")), ("b", check_toml("b")))
    assert res.calls == 1
    assert all(e.error and e.verdict == "block" for e in res.entries)


def test_retryable_error_retried_even_for_single_entry_batch(repo):
    repo.commit()
    res = run(repo, {"*": "retryable"}, ("a", check_toml("a")))
    assert res.calls == 2
    assert "fake backend error" in res.entries[0].error


def test_backend_error_on_advisory_is_warn(repo):
    repo.commit()
    res = run(repo, {"*": "error"}, ("a", check_toml("a", status="advisory")))
    assert res.verdict == "warn"


def test_secret_blocks_without_model_call(repo):
    repo.commit({"cfg.py": f'KEY = "{FAKE_AWS_KEY}"\n'})
    res = run(repo, {"*": ans(0.1)}, ("a", check_toml("a")))
    assert res.verdict == "block" and res.calls == 0
    assert res.secret_hits[0].file == "cfg.py"


def test_secret_in_older_commit_still_blocks(repo):
    repo.commit({"cfg.py": f'KEY = "{FAKE_AWS_KEY}"\n'})
    repo.commit({"cfg.py": "KEY = None\n"})  # removed later, but history still has it
    res = run(repo, {"*": ans(0.1)}, ("a", check_toml("a")))
    assert res.verdict == "block"


def test_warn_secret_redacted_from_model_input(repo, monkeypatch):
    repo.commit({"settings.ini": "DB_PASSWORD=hunter2\nname = x\n"})
    seen = {}
    from acc.backends.fake import FakeBackend

    orig = FakeBackend.ask

    def spy(self, system, prompt, stdin, schema, timeout):
        seen["stdin"] = stdin
        return orig(self, system, prompt, stdin, schema, timeout)

    monkeypatch.setattr(FakeBackend, "ask", spy)
    res = run(repo, {"*": ans(0.1)}, ("a", check_toml("a")))
    assert "hunter2" not in seen["stdin"]
    assert "name = x" in seen["stdin"]
    assert res.verdict == "pass"
    assert any("redacted" in n for n in res.notes)


def test_excluded_and_binary_files_skipped(repo):
    repo.commit({"package-lock.json": "{}\n", "img.bin": "\x00\x01\x02"})
    res = run(repo, {"*": ans(0.1)}, ("a", check_toml("a")))
    assert res.checks_skipped == ["a"]  # nothing left to review
    assert sorted(res.skipped_files) == ["img.bin (binary)", "package-lock.json (excluded)"]


def test_truncation_reported(repo):
    repo.commit({"big.txt": "line\n" * 5000})
    res = run(repo, {"*": ans(0.1)}, ("a", check_toml("a")), config="[run]\nmax_diff_chars = 500\n")
    assert res.truncated and res.entries[0].truncated
    assert any("truncated" in n for n in res.notes)


def test_truncation_keeps_every_file_visible(repo, monkeypatch):
    repo.commit({"src/big.py": "x = 1\n" * 3000, "tests/test_big.py": "def test_x():\n    assert True\n"})
    captured = {}
    from acc.backends.fake import FakeBackend

    orig = FakeBackend.ask

    def spy(self, system, prompt, stdin, schema, timeout):
        captured["stdin"] = stdin
        return orig(self, system, prompt, stdin, schema, timeout)

    monkeypatch.setattr(FakeBackend, "ask", spy)
    run(repo, {"*": ans(0.1)}, ("a", check_toml("a")), config="[run]\nmax_diff_chars = 2000\n")
    assert "def test_x():" in captured["stdin"]  # the small later file is shown whole
    assert "more characters of this file not shown" in captured["stdin"]


def test_max_commits_limits_per_commit(repo):
    for _ in range(4):
        repo.commit()
    res = run(repo, {"*": ans(0.1)}, ("pc", check_toml("pc", scope="per_commit")),
              config="[run]\nmax_commits = 2\n")
    assert len(res.entries) == 2
    assert any("skipped 2" in n for n in res.notes)


def test_prompt_contains_inputs_and_untrusted_preamble(repo, monkeypatch):
    repo.commit({"a.py": "print('x')\n"}, msg="add a")
    captured = {}
    from acc.backends.fake import FakeBackend

    orig = FakeBackend.ask

    def spy(self, system, prompt, stdin, schema, timeout):
        captured.update(system=system, prompt=prompt, stdin=stdin, schema=schema)
        return orig(self, system, prompt, stdin, schema, timeout)

    monkeypatch.setattr(FakeBackend, "ask", spy)
    run(repo, {"*": ans(0.1)}, ("a", check_toml("a", inputs='["diff", "message", "file_list"]')))
    assert "untrusted" in captured["system"]
    assert "print('x')" in captured["stdin"] and "add a" in captured["stdin"]
    assert "a.py" in captured["stdin"]
    assert 'Check key "a"' in captured["prompt"]
    assert captured["schema"]["properties"]["checks"]["required"] == ["a"]
    json.dumps(captured["schema"])


def test_unknown_backend(repo):
    repo.enable()
    cfg = repo.config()
    cfg.data["agents"]["claude"] = {"backend": "nope"}
    try:
        get_backend(cfg, "claude")
    except BackendError as e:
        assert "nope" in str(e)
    else:
        raise AssertionError
