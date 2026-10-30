import filecmp
from pathlib import Path

import pytest

from acc import checks as c
from tests.conftest import check_toml

ROOT = Path(__file__).parent.parent


def parse(text, cid=None):
    return c.parse_text(text, expected_id=cid)


@pytest.mark.parametrize("qtype", ["bool", "choice", "score"])
def test_valid_types(qtype):
    check = parse(check_toml("x", qtype=qtype), "x")
    assert check.question_type == qtype


def test_id_must_match_file_name():
    with pytest.raises(c.CheckError, match="file name"):
        parse(check_toml("x"), "y")


@pytest.mark.parametrize("mutate,msg", [
    (lambda t: t.replace('id = "x"', 'id = "Bad_ID"'), "id must"),
    (lambda t: t.replace('status = "active"', 'status = "live"'), "status"),
    (lambda t: t.replace('scope = "range"', 'scope = "file"'), "scope"),
    (lambda t: t.replace('inputs = ["diff"]', 'inputs = ["code"]'), "inputs"),
    (lambda t: t.replace('applies_to = ["**/*"]', "applies_to = []"), "applies_to"),
    (lambda t: t.replace("block_at = 0.8", "block_at = 1.5"), "probability"),
    (lambda t: t.replace("block_at = 0.8", "block_at = 0.3"), "warn_at must not exceed"),
    (lambda t: t + "\nsurprise = 1\n", "unknown"),
])
def test_invalid(mutate, msg):
    with pytest.raises(c.CheckError, match=msg):
        parse(mutate(check_toml("x")), "x")


def test_choice_needs_full_verdict_table():
    t = check_toml("x", qtype="choice").replace('meh = "warn"\n', "")
    with pytest.raises(c.CheckError, match="missing labels: meh"):
        parse(t, "x")
    t = check_toml("x", qtype="choice").replace('bad = "block"', 'bad = "explode"')
    with pytest.raises(c.CheckError, match="pass, warn or block"):
        parse(t, "x")


def test_choice_needs_two_labels():
    t = check_toml("x", qtype="choice").replace(', meh = "So-so", bad = "Broken"', "")
    with pytest.raises(c.CheckError, match="2\\+"):
        parse(t, "x")


def test_score_level_index_range():
    t = check_toml("x", qtype="score").replace("block_at = 2", "block_at = 3")
    with pytest.raises(c.CheckError, match="level index"):
        parse(t, "x")


def test_verdict_bool():
    ch = parse(check_toml("x"))
    assert c.map_verdict(ch, 0.1) == "pass"
    assert c.map_verdict(ch, 0.5) == "warn"
    assert c.map_verdict(ch, 0.8) == "block"
    assert c.map_verdict(ch, 1) == "block"
    for bad in (1.2, -0.1, "0.9", True, None):
        with pytest.raises(c.AnswerError):
            c.map_verdict(ch, bad)


def test_verdict_choice():
    ch = parse(check_toml("x", qtype="choice"))
    assert [c.map_verdict(ch, a) for a in ("good", "meh", "bad")] == ["pass", "warn", "block"]
    with pytest.raises(c.AnswerError):
        c.map_verdict(ch, "unknown")


def test_verdict_score():
    ch = parse(check_toml("x", qtype="score"))
    assert [c.map_verdict(ch, i) for i in (0, 1, 2)] == ["pass", "warn", "block"]
    for bad in (3, -1, 1.0, "1", False):
        with pytest.raises(c.AnswerError):
            c.map_verdict(ch, bad)


def test_validate_entry_drops_malformed_findings():
    ch = parse(check_toml("x"))
    v, findings, summary = c.validate_entry(ch, {"answer": 0.9, "findings": [
        {"file": "a.py", "line": 3, "message": "bad"}, {"nope": 1}, "str"], "summary": "s"})
    assert v == "block"
    assert findings == [{"file": "a.py", "line": 3, "message": "bad"}]
    with pytest.raises(c.AnswerError):
        c.validate_entry(ch, {"answer": 0.9, "findings": "x"})


def test_dump_roundtrip():
    original = parse(check_toml("x", qtype="choice", extra='\n[grading]\nterms = ["a \\"q\\""]\n'))
    text = c.dump_check(original.to_dict())
    again = parse(text, "x")
    assert again.to_dict() == original.to_dict()


def test_set_status_changes_one_line(tmp_path):
    p = tmp_path / "x.toml"
    p.write_text(check_toml("x", status="proposed"))
    before = p.read_text()
    old, new = c.set_status(p, "active")
    assert (old, new) == ('status = "proposed"', 'status = "active"')
    after = p.read_text()
    diff = [(a, b) for a, b in zip(before.splitlines(), after.splitlines()) if a != b]
    assert diff == [(old, new)]


def test_set_status_inserts_when_missing(tmp_path):
    p = tmp_path / "x.toml"
    p.write_text(check_toml("x").replace('status = "active"\n', ""))
    c.set_status(p, "advisory")
    assert c.load_file(p).status == "advisory"


def test_content_hash_ignores_status():
    a = check_toml("x", status="proposed")
    b = check_toml("x", status="active")
    assert c.content_hash(a) == c.content_hash(b)
    assert c.content_hash(a) != c.content_hash(a.replace("Is there", "Is there really"))


def test_load_all_reports_errors(tmp_path):
    (tmp_path / "good.toml").write_text(check_toml("good"))
    (tmp_path / "bad.toml").write_text("id = [")
    loaded, errors = c.load_all(tmp_path)
    assert [x.id for x in loaded] == ["good"]
    assert list(errors) == ["bad.toml"]


def test_examples_match_templates_and_validate():
    tpl = ROOT / "src/acc/templates/checks"
    ex = ROOT / "examples/.acc/checks"
    names = sorted(p.name for p in tpl.glob("*.toml"))
    assert names == sorted(p.name for p in ex.glob("*.toml"))
    for n in names:
        assert filecmp.cmp(tpl / n, ex / n, shallow=False)
        c.load_file(tpl / n)
