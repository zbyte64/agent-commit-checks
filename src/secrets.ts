/**
 * Local secret scan on added diff lines.
 *
 * Patterns and `scanText` are ported from dev-decisions (https://github.com/adelvillar1/dev-decisions,
 * scripts/devdec/gitops.py at 039cea1), Copyright the dev-decisions authors, licensed under the Apache
 * License 2.0. Changes: PII heuristics dropped, hits carry no matched text so secrets never reach logs or
 * agent feedback, and scanning works per diff file.
 */
import { splitlines } from "./text.ts";

export type Severity = "block" | "warn";

// Order: most-specific first to reduce false positives.
const SECRET_PATTERNS: [RegExp, string, Severity][] = [
	[/(?:AKIA|ASIA)[0-9A-Z]{16}/, "AWS access key ID", "block"],
	[
		/(?:api[_-]?key|apikey|secret|token|password|passwd|private[_-]?key)\s*[=:]\s*['"]?([A-Za-z0-9_-]{32,})['"]?/i,
		"named secret value",
		"block",
	],
	[/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, "JWT token", "block"],
	[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "PEM private key", "block"],
	[/^[A-Z][A-Z0-9_]{2,}=.+$/m, "env-var dump", "warn"],
	[/gh[psu]_[A-Za-z0-9_]{36,}/, "GitHub PAT", "block"],
	[/xox[baprs]-[0-9a-zA-Z-]+/, "Slack token", "block"],
	[/AIza[0-9A-Za-z\-_]{35}/, "Google API key", "block"],
	[/(?:password|passwd)\s*[=:]\s*\S+/i, "password assignment", "warn"],
];

export interface SecretHit {
	pattern: string;
	severity: Severity;
	file: string;
	/** Line number in the new file. */
	line: number;
	commit: string | null;
}

/** `[lineno, pattern label, severity]` for each hit in `text`. */
export function scanText(text: string): [number, string, Severity][] {
	const hits: [number, string, Severity][] = [];
	splitlines(text).forEach((line, i) => {
		for (const [pattern, label, severity] of SECRET_PATTERNS) {
			if (pattern.test(line)) hits.push([i + 1, label, severity]);
		}
	});
	return hits;
}

export function lineHits(line: string): [string, Severity][] {
	return SECRET_PATTERNS.filter(([pattern]) => pattern.test(line)).map(([, label, sev]) => [label, sev]);
}

/** Scan only added lines of a unified diff, tracking file and new-file line numbers. */
export function scanDiff(diff: string, commit: string | null = null): SecretHit[] {
	const hits: SecretHit[] = [];
	let path = "";
	let newLine = 0;
	for (const raw of splitlines(diff)) {
		if (raw.startsWith("+++ ")) {
			const target = raw.slice(4);
			path = target.startsWith("b/") ? target.slice(2) : target;
			continue;
		}
		if (raw.startsWith("@@")) {
			const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
			newLine = m ? Number.parseInt(m[1], 10) : 0;
			continue;
		}
		if (raw.startsWith("+")) {
			for (const [label, severity] of lineHits(raw.slice(1))) {
				hits.push({ pattern: label, severity, file: path, line: newLine, commit });
			}
			newLine += 1;
		} else if (raw.startsWith(" ")) {
			newLine += 1;
		}
	}
	return hits;
}

/** Replace added lines that match a `warn` pattern so they are never sent to a model. */
export function redactDiff(diff: string): string {
	const out: string[] = [];
	for (const raw of splitlines(diff, true)) {
		if (raw.startsWith("+") && !raw.startsWith("+++ ") && lineHits(raw.slice(1)).length) {
			out.push("+[acc: line redacted by secret scan]\n");
		} else {
			out.push(raw);
		}
	}
	return out.join("");
}
