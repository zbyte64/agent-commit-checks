from acc import globs, secrets
from tests.conftest import FAKE_AWS_KEY

DIFF = f"""diff --git a/app/config.py b/app/config.py
--- a/app/config.py
+++ b/app/config.py
@@ -10,2 +10,4 @@ x
 unchanged = 1
+AWS = "{FAKE_AWS_KEY}"
+DB_PASSWORD=hunter2
-removed = "{FAKE_AWS_KEY.replace("ABCD", "ZZZZ")}"
 tail = 2
"""


def test_scan_diff_added_lines_only_with_line_numbers():
    hits = secrets.scan_diff(DIFF, "abc")
    labels = {(h.pattern, h.line, h.severity) for h in hits}
    assert ("AWS access key ID", 11, "block") in labels
    assert any(h.line == 12 and h.severity == "warn" for h in hits)
    assert all(h.file == "app/config.py" and h.commit == "abc" for h in hits)
    assert not any(h.line == 13 for h in hits)


def test_hits_carry_no_secret_text():
    for h in secrets.scan_diff(DIFF):
        assert FAKE_AWS_KEY not in repr(h)


def test_redact():
    out = secrets.redact_diff(DIFF)
    assert "hunter2" not in out and FAKE_AWS_KEY not in out
    assert "unchanged = 1" in out
    assert out.count("[acc: line redacted") == 2


def test_scan_text_ported_api():
    assert secrets.scan_text("token = 'ghp_" + "a" * 36 + "'")


def test_globs():
    assert globs.match("src/a/b.py", "**/*.py")
    assert globs.match("b.py", "**/*.py")
    assert globs.match("src/x.py", "src/**/*.py")
    assert globs.match("src/a/x.py", "src/**")
    assert not globs.match("lib/x.py", "src/**")
    assert globs.match("deep/dir/package-lock.json", "package-lock.json")
    assert not globs.match("src/a/b.py", "src/*.py")
    assert globs.match("anything/at/all", "**/*")
