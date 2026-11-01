/**
 * Find `git push` invocations in a shell command string.
 *
 * The parser is deliberately conservative: when it cannot tell what a command does but the text
 * mentions git and push, it returns kind="unknown" so the gate reviews `@{upstream}..HEAD` instead
 * of letting the push through unchecked.
 */

const SEPARATORS = new Set(["&&", "||", ";", "|", "&", "|&", ";;", "(", ")", "{", "}", "\n"]);
const WRAPPERS = new Set(["command", "exec", "nohup", "time", "builtin", "sudo"]);
const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// git subcommands that create commits the gate cannot see yet.
const COMMIT_CREATING = new Set(["commit", "merge", "cherry-pick", "revert", "am", "rebase", "pull"]);
// git global options that take a separate value.
const GIT_OPTS_WITH_VALUE = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--config-env",
	"--super-prefix",
	"--list-cmds",
]);
const PUSH_OPTS_WITH_VALUE = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec", "--recurse-submodules"]);
const MENTIONS_PUSH = /\bgit\b.*\bpush\b/s;
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const INDIRECTION = /\$\(|`|\beval\b|\bxargs\b|\bsource\b|^\s*\./;

/** One `git push` invocation. */
export class PushSpec {
	args: string[];
	/** Relative or absolute dir from `cd` / `git -C`. */
	cwd: string | null;
	remote: string | null = null;
	refspecs: string[] = [];
	allBranches = false;
	mirror = false;
	tags = false;
	delete = false;
	dryRun = false;
	force = false;

	constructor(args: string[], cwd: string | null = null) {
		this.args = args;
		this.cwd = cwd;
	}

	get tagsOnly(): boolean {
		return this.tags && !this.refspecs.length && !this.allBranches && !this.mirror;
	}
}

export type CommandKind = "none" | "push" | "commit_and_push" | "unknown";

export interface ParsedCommand {
	kind: CommandKind;
	pushes: PushSpec[];
	reason: string;
}

function parsed(kind: CommandKind, pushes: PushSpec[] = [], reason = ""): ParsedCommand {
	return { kind, pushes, reason };
}

// Python's `\w` and `\d` are Unicode-aware; these classes keep the same matches.
// Redirections such as `2>&1`, `>out.log`, `&>/dev/null`; dropped before tokenizing so their targets
// are not mistaken for push arguments. Targets never swallow quote characters, so a `<name@host>`
// inside a quoted commit message cannot eat the closing quote.
const REDIRECT =
	/(?<![\p{L}\p{N}_>-])\p{Nd}*(?:&>>?|>>?&?|<<<|<<-?|<&?)\s*(?:&?\p{Nd}+-?(?=[\s;&|)]|$)|[^\s;&|()'"]+)/gu;
const HEREDOC = /(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;
const FEEDS_SHELL = /(?:^|[\s;&|(])(?:ba|z|da|k)?sh(?:\s+-[\p{L}\p{N}_]+)*\s*$/u;

/**
 * Drop heredoc bodies, which are data rather than commands.
 *
 * A body fed to a shell (`bash <<EOF`) does run as commands, so it is kept and appended as extra
 * command lines.
 */
function stripHeredocs(command: string): string {
	const lines = command.split("\n");
	const out: string[] = [];
	const shellBodies: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		out.push(line);
		i += 1;
		for (const m of line.matchAll(HEREDOC)) {
			const stripTabs = m[1];
			const delim = m[3];
			const body: string[] = [];
			while (i < lines.length) {
				const current = lines[i];
				i += 1;
				if ((stripTabs ? current.replace(/^\t+/, "") : current) === delim) break;
				body.push(current);
			}
			if (FEEDS_SHELL.test(line.slice(0, m.index))) shellBodies.push(...body);
		}
	}
	return [...out, ...shellBodies].join("\n");
}

const WHITESPACE = " \t\r\n";
const PUNCTUATION = ";&|()";
const QUOTES = "'\"";

/** An unterminated quote or a trailing backslash. */
export class ShellSplitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ShellSplitError";
	}
}

/**
 * Split shell text into words and operator runs (`;&|()` characters, e.g. `&&`, `;;`, `|&`), the way
 * Python's `shlex.shlex(text, posix=True, punctuation_chars=";&|()")` with `whitespace_split` does,
 * with three shell rules shlex lacks:
 *
 * - `#` starts a comment only at the start of a word, as in sh: `issue#12` is one word.
 * - A comment ends at the end of its line, and an unquoted newline is a `"\n"` token, so the next
 *   line is a new command.
 * - A backslash before a newline continues the line.
 */
export function shellSplit(text: string): string[] {
	const tokens: string[] = [];
	let pos = 0;
	let pushback: string | null = null;
	let state: string | null = " ";
	const read = (): string => {
		if (pushback !== null) {
			const c = pushback;
			pushback = null;
			return c;
		}
		return pos < text.length ? text[pos++] : "";
	};
	const skipComment = (): void => {
		const nl = text.indexOf("\n", pos);
		pos = nl === -1 ? text.length : nl;
	};

	while (state !== null) {
		let token = "";
		let quoted = false;
		let escapedState = " ";
		for (;;) {
			const c = read();
			if (state === " ") {
				if (!c) {
					state = null;
					break;
				} else if (c === "\n") {
					token = c;
					break;
				} else if (WHITESPACE.includes(c)) {
					if (token || quoted) break;
				} else if (c === "#") {
					skipComment();
				} else if (c === "\\") {
					escapedState = "a";
					state = c;
				} else if (PUNCTUATION.includes(c)) {
					token = c;
					state = "c";
				} else if (QUOTES.includes(c)) {
					state = c;
				} else {
					token = c;
					state = "a";
				}
			} else if (state === "'" || state === '"') {
				quoted = true;
				if (!c) throw new ShellSplitError("No closing quotation");
				if (c === state) {
					state = "a";
				} else if (c === "\\" && state === '"') {
					escapedState = state;
					state = c;
				} else {
					token += c;
				}
			} else if (state === "\\") {
				if (!c) throw new ShellSplitError("No escaped character");
				state = escapedState;
				// A backslash-newline joins the lines, inside double quotes too.
				if (c === "\n") continue;
				// In posix shells, only the quote itself or the escape character may be escaped within quotes.
				if (QUOTES.includes(escapedState) && c !== "\\" && c !== escapedState) token += "\\";
				token += c;
			} else {
				// state "a" (word) or "c" (punctuation run)
				if (!c) {
					state = null;
					break;
				} else if (c === "\n") {
					// The newline becomes its own token after this one.
					pushback = c;
					state = " ";
					if (token || quoted) break;
				} else if (WHITESPACE.includes(c)) {
					state = " ";
					if (token || quoted) break;
				} else if (state === "c") {
					if (PUNCTUATION.includes(c)) {
						token += c;
					} else {
						pushback = c;
						state = " ";
						break;
					}
				} else if (QUOTES.includes(c)) {
					state = c;
				} else if (c === "\\") {
					escapedState = "a";
					state = c;
				} else if (!PUNCTUATION.includes(c)) {
					token += c;
				} else {
					pushback = c;
					state = " ";
					if (token || quoted) break;
				}
			}
		}
		// An unquoted empty token is Python's end-of-input marker.
		if (!quoted && token === "") break;
		tokens.push(token);
	}
	return tokens;
}

function tokenize(command: string): string[] {
	return shellSplit(command.replace(REDIRECT, " "));
}

function segments(tokens: string[]): string[][] {
	const segs: string[][] = [[]];
	for (const tok of tokens) {
		if (SEPARATORS.has(tok) || (tok && [...tok].every((ch) => PUNCTUATION.includes(ch)))) {
			segs.push([]);
		} else {
			segs[segs.length - 1].push(tok);
		}
	}
	return segs.filter((s) => s.length);
}

function stripPrefix(argv: string[]): string[] {
	let i = 0;
	while (i < argv.length) {
		const tok = argv[i];
		if (ENV_ASSIGN.test(tok)) {
			i += 1;
		} else if (tok === "env") {
			i += 1;
			while (i < argv.length && (ENV_ASSIGN.test(argv[i]) || argv[i].startsWith("-"))) i += 1;
		} else if (KEYWORDS.has(tok)) {
			i += 1;
		} else if (WRAPPERS.has(tok)) {
			i += 1;
			while (i < argv.length && argv[i].startsWith("-")) i += 1;
		} else {
			break;
		}
	}
	return argv.slice(i);
}

export function parsePushArgs(args: string[], cwd: string | null = null): PushSpec {
	const spec = new PushSpec(args, cwd);
	const positionals: string[] = [];
	let endOfOpts = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (endOfOpts || !a.startsWith("-") || a === "-") {
			positionals.push(a);
		} else if (a === "--") {
			endOfOpts = true;
		} else if (PUSH_OPTS_WITH_VALUE.has(a)) {
			if (a === "--repo" && i + 1 < args.length) spec.remote = args[i + 1];
			i += 1;
		} else if (a.startsWith("--repo=")) {
			spec.remote = a.slice("--repo=".length);
		} else if (a === "--all" || a === "--branches") {
			spec.allBranches = true;
		} else if (a === "--mirror") {
			spec.mirror = true;
		} else if (a === "--tags") {
			spec.tags = true;
		} else if (a === "-d" || a === "--delete") {
			spec.delete = true;
		} else if (a === "-n" || a === "--dry-run") {
			spec.dryRun = true;
		} else if (a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a === "--force-if-includes") {
			spec.force = true;
		} else if (!a.startsWith("--") && a.length > 2) {
			// Combined short flags, e.g. -uf.
			const flags = a.slice(1);
			spec.force ||= flags.includes("f");
			spec.delete ||= flags.includes("d");
			spec.dryRun ||= flags.includes("n");
		}
	}
	if (positionals.length) {
		spec.remote = spec.remote || positionals[0];
		spec.refspecs = positionals.slice(1);
	}
	return spec;
}

function hasExpansion(tokens: string[]): boolean {
	return tokens.some((t) => t.includes("$") || t.includes("`") || (t.includes("*") && !t.startsWith("refs/")));
}

/** Python's `os.path.basename`: everything after the last slash (empty for a trailing slash). */
function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** Python's `os.path.join` for two POSIX parts. */
function pathJoin(base: string, path: string): string {
	if (path.startsWith("/")) return path;
	if (!base || base.endsWith("/")) return base + path;
	return `${base}/${path}`;
}

function join(base: string | null, path: string | null): string | null {
	if (path === null) return base;
	if (base === null || path.startsWith("/")) return path;
	return pathJoin(base, path);
}

function parse(command: string, depth = 0): ParsedCommand {
	let tokens: string[];
	try {
		tokens = tokenize(stripHeredocs(command));
	} catch (e) {
		if (!(e instanceof ShellSplitError)) throw e;
		return parsed("unknown", [], `could not parse the command (${e.message})`);
	}

	const pushes: PushSpec[] = [];
	let commitSeen = false;
	let commitBeforePush = false;
	let unknownReason = "";
	let cd: string | null = null;

	for (const segment of segments(tokens)) {
		const argv = stripPrefix(segment);
		if (!argv.length) continue;
		const prog = basename(argv[0]);
		if (prog === "cd" && argv.length >= 2) {
			const target = argv[1];
			cd = target.startsWith("/") || cd === null ? target : pathJoin(cd, target);
			continue;
		}
		let cFlag: number | null = null;
		for (let j = 1; j < argv.length; j++) {
			const a = argv[j];
			if (a.startsWith("-") && !a.startsWith("--") && a.includes("c")) {
				cFlag = j;
				break;
			}
		}
		if (SHELLS.has(prog) && cFlag !== null) {
			if (cFlag + 1 < argv.length && depth < 3) {
				const inner = parse(argv[cFlag + 1], depth + 1);
				for (const p of inner.pushes) p.cwd = join(cd, p.cwd);
				pushes.push(...inner.pushes);
				if (inner.kind === "commit_and_push" || (commitSeen && inner.pushes.length)) commitBeforePush = true;
				if (inner.kind === "unknown") unknownReason = inner.reason;
			}
			continue;
		}
		if (prog === "eval" && depth < 3) {
			const inner = parse(argv.slice(1).join(" "), depth + 1);
			pushes.push(...inner.pushes);
			if (inner.kind === "unknown" || inner.pushes.length) unknownReason ||= "push runs through eval";
			continue;
		}
		if (prog !== "git") continue;

		let i = 1;
		let gitCwd = cd;
		while (i < argv.length && argv[i].startsWith("-")) {
			const opt = argv[i];
			if (opt === "-C" && i + 1 < argv.length) gitCwd = join(gitCwd, argv[i + 1]);
			if (GIT_OPTS_WITH_VALUE.has(opt)) i += 1;
			i += 1;
		}
		if (i >= argv.length) continue;
		const sub = argv[i];
		const rest = argv.slice(i + 1);
		if (COMMIT_CREATING.has(sub)) {
			commitSeen = true;
		} else if (sub === "push") {
			if (commitSeen) commitBeforePush = true;
			if (hasExpansion(rest) || (gitCwd && gitCwd.includes("$"))) {
				unknownReason = "the push arguments use shell expansion";
			}
			pushes.push(parsePushArgs(rest, gitCwd));
		}
	}

	if (commitBeforePush) return parsed("commit_and_push", pushes, "the command creates a commit and pushes in one step");
	if (unknownReason) return parsed("unknown", pushes, unknownReason);
	if (pushes.length) return parsed("push", pushes);
	if (MENTIONS_PUSH.test(command) && INDIRECTION.test(command)) {
		return parsed("unknown", [], "git push may run through shell indirection");
	}
	return parsed("none");
}

/** Classify a shell command: does it push, and can we tell what? */
export function parseCommand(command: string): ParsedCommand {
	if (!command.includes("push")) return parsed("none");
	return parse(command);
}
