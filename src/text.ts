/** Python-compatible string helpers, so ported parsing behaves exactly like the original. */

// The line boundaries of Python's str.splitlines().
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;

/** Python's `str.splitlines(keepends)`: no trailing empty element, every Unicode line boundary. */
export function splitlines(text: string, keepends = false): string[] {
	const out: string[] = [];
	let start = 0;
	for (const m of text.matchAll(LINE_BREAK)) {
		const end = m.index + m[0].length;
		out.push(text.slice(start, keepends ? end : m.index));
		start = end;
	}
	if (start < text.length) out.push(text.slice(start));
	return out;
}

/** Python's `str.split()` with no argument: split on whitespace runs, no empty strings. */
export function words(text: string): string[] {
	return text.split(/\s+/).filter(Boolean);
}

/**
 * Python's `repr()` for JSON-like values, used in messages that quote a bad value back
 * (`expected a probability 0-1, got 'x'`). JS cannot tell `1.0` from `1`, so floats with no
 * fractional part print as integers.
 */
export function pyRepr(value: unknown): string {
	if (value === null || value === undefined) return "None";
	if (typeof value === "boolean") return value ? "True" : "False";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : value > 0 ? "inf" : value < 0 ? "-inf" : "nan";
	if (typeof value === "string") {
		const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
		let out = "";
		for (const ch of value) {
			if (ch === quote || ch === "\\") out += `\\${ch}`;
			else if (ch === "\n") out += "\\n";
			else if (ch === "\r") out += "\\r";
			else if (ch === "\t") out += "\\t";
			else if (ch < " " || ch === "\x7f") out += `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
			else out += ch;
		}
		return quote + out + quote;
	}
	if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
	if (typeof value === "object") {
		return `{${Object.entries(value)
			.map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`)
			.join(", ")}}`;
	}
	return String(value);
}

/** Escape a string for use as a literal inside a RegExp. */
export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}
