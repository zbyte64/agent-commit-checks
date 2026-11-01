/** Path globs with `**` support, matched against repo-relative POSIX paths. */
import { escapeRegExp } from "./text.ts";

const cache = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
	let re = cache.get(pattern);
	if (re) return re;
	// A pattern without a slash matches the basename anywhere, like .gitignore.
	const p = pattern.includes("/") ? pattern : `**/${pattern}`;
	let out = "";
	let i = 0;
	while (i < p.length) {
		if (p.startsWith("**/", i)) {
			out += "(?:.*/)?";
			i += 3;
		} else if (p.startsWith("**", i)) {
			out += ".*";
			i += 2;
		} else if (p[i] === "*") {
			out += "[^/]*";
			i += 1;
		} else if (p[i] === "?") {
			out += "[^/]";
			i += 1;
		} else {
			out += escapeRegExp(p[i]);
			i += 1;
		}
	}
	re = new RegExp(`^(?:${out})$`);
	if (cache.size >= 512) cache.clear();
	cache.set(pattern, re);
	return re;
}

export function match(path: string, pattern: string): boolean {
	return compile(pattern).test(path);
}

export function matchAny(path: string, patterns: string[]): boolean {
	return patterns.some((p) => match(path, p));
}
