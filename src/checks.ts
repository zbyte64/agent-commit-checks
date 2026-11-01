/** Check files: load, validate, verdict mapping, serialization. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Table } from "./config.ts";
import { pyRepr } from "./text.ts";

export const ID_RE = /^[a-z0-9-]+$/;
export const STATUSES = ["proposed", "advisory", "active"] as const;
export const INPUTS = ["diff", "message", "file_list"] as const;
export const TYPES = ["bool", "choice", "score"] as const;
export const VERDICTS = ["pass", "warn", "block"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type Status = (typeof STATUSES)[number];
export const SEVERITY: Record<Verdict, number> = { pass: 0, warn: 1, block: 2 };
const STATUS_LINE_RE = /^(status\s*=\s*)"[^"]*"(.*)$/m;

export class CheckError extends Error {
	readonly errors: string[];
	constructor(errors: string[]) {
		super(errors.join("; "));
		this.name = "CheckError";
		this.errors = errors;
	}
}

export class AnswerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnswerError";
	}
}

export interface CheckInit {
	id: string;
	title: string;
	questionType: string;
	instructions: string;
	verdict: Table;
	status?: string;
	enabled?: boolean;
	author?: string;
	appliesTo?: string[];
	inputs?: string[];
	labels?: Record<string, string>;
	levels?: string[];
	grading?: Table;
	path?: string | null;
	text?: string;
}

export class Check {
	id: string;
	title: string;
	questionType: string;
	instructions: string;
	verdict: Table;
	status: string;
	enabled: boolean;
	author: string;
	appliesTo: string[];
	inputs: string[];
	labels: Record<string, string>;
	levels: string[];
	grading: Table;
	path: string | null;
	text: string;

	constructor(init: CheckInit) {
		this.id = init.id;
		this.title = init.title;
		this.questionType = init.questionType;
		this.instructions = init.instructions;
		this.verdict = init.verdict;
		this.status = init.status ?? "proposed";
		this.enabled = init.enabled ?? true;
		this.author = init.author ?? "user";
		this.appliesTo = init.appliesTo ?? ["**/*"];
		this.inputs = init.inputs ?? ["diff"];
		this.labels = init.labels ?? {};
		this.levels = init.levels ?? [];
		this.grading = init.grading ?? {};
		this.path = init.path ?? null;
		this.text = init.text ?? "";
	}

	get runsInGate(): boolean {
		return this.enabled && (this.status === "advisory" || this.status === "active");
	}

	get canBlock(): boolean {
		return this.status === "active";
	}

	get contentHash(): string {
		return contentHash(this.text);
	}

	toDict(): Table {
		const question: Table = { type: this.questionType, instructions: this.instructions };
		const d: Table = {
			id: this.id,
			title: this.title,
			enabled: this.enabled,
			status: this.status,
			author: this.author,
			applies_to: this.appliesTo,
			inputs: this.inputs,
			question,
			verdict: this.verdict,
		};
		if (Object.keys(this.labels).length) question.labels = this.labels;
		if (this.levels.length) question.levels = this.levels;
		if (Object.keys(this.grading).length) d.grading = this.grading;
		return d;
	}
}

/** SHA-256 of a check file, ignoring the status line so promotion keeps the grade valid. */
export function contentHash(text: string): string {
	const normalized = text.replace(new RegExp(STATUS_LINE_RE.source, "gm"), '$1""$2');
	return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function isStrList(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isTable(v: unknown): v is Table {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isNumber = (v: unknown): v is number => typeof v === "number";

export function validateDict(d: Table, expectedId: string | null = null): string[] {
	const errs: string[] = [];
	const cid = d.id;
	if (typeof cid !== "string" || !ID_RE.test(cid)) {
		errs.push("id must be a string matching [a-z0-9-]+");
	} else if (expectedId !== null && cid !== expectedId) {
		errs.push(`id ${pyRepr(cid)} must equal the file name ${pyRepr(expectedId)}`);
	}
	if (typeof d.title !== "string" || !d.title) errs.push("title is required");
	if (typeof (d.enabled ?? true) !== "boolean") errs.push("enabled must be true or false");
	if (!(STATUSES as readonly string[]).includes(d.status ?? "proposed")) {
		errs.push(`status must be one of ${STATUSES.join(", ")}`);
	}
	if (!["user", "agent"].includes(d.author ?? "user")) errs.push("author must be 'user' or 'agent'");
	if ("scope" in d) {
		errs.push("scope was removed: every check reviews the whole range of pushed commits; delete the scope line");
	}
	const applies = d.applies_to ?? ["**/*"];
	if (!isStrList(applies) || !applies.length) errs.push("applies_to must be a non-empty list of globs");
	const inputs = d.inputs ?? ["diff"];
	if (!isStrList(inputs) || !inputs.length || inputs.some((i) => !(INPUTS as readonly string[]).includes(i))) {
		errs.push(`inputs must be a non-empty list drawn from ${INPUTS.join(", ")}`);
	}

	const q = d.question;
	const v = d.verdict;
	if (!isTable(q)) {
		errs.push("[question] table is required");
		return errs;
	}
	if (!isTable(v)) {
		errs.push("[verdict] table is required");
		return errs;
	}
	const qtype = q.type;
	if (!(TYPES as readonly string[]).includes(qtype)) {
		errs.push(`question.type must be one of ${TYPES.join(", ")}`);
		return errs;
	}
	if (typeof q.instructions !== "string" || !q.instructions.trim()) errs.push("question.instructions is required");

	if (qtype === "bool") {
		for (const k of ["block_at", "warn_at"]) {
			if (k in v && !(isNumber(v[k]) && v[k] >= 0 && v[k] <= 1)) {
				errs.push(`verdict.${k} must be a probability between 0 and 1`);
			}
		}
		if (!("block_at" in v) && !("warn_at" in v)) errs.push("bool checks need verdict.block_at and/or verdict.warn_at");
		if (isNumber(v.block_at) && isNumber(v.warn_at) && v.warn_at > v.block_at) {
			errs.push("verdict.warn_at must not exceed verdict.block_at");
		}
		const extra = Object.keys(v)
			.filter((k) => k !== "block_at" && k !== "warn_at")
			.sort();
		if (extra.length) errs.push(`unknown verdict keys for bool: ${extra.join(", ")}`);
	} else if (qtype === "choice") {
		const labels = q.labels;
		if (!isTable(labels) || Object.keys(labels).length < 2 || !Object.values(labels).every((x) => typeof x === "string")) {
			errs.push("choice checks need question.labels with 2+ label = description entries");
		} else {
			const missing = Object.keys(labels).filter((lbl) => !(lbl in v));
			if (missing.length) errs.push(`verdict is missing labels: ${missing.join(", ")}`);
			const unknown = Object.keys(v).filter((k) => !(k in labels));
			if (unknown.length) errs.push(`verdict names unknown labels: ${unknown.join(", ")}`);
			const bad = Object.entries(v)
				.filter(([, x]) => !(VERDICTS as readonly unknown[]).includes(x))
				.map(([k]) => k);
			if (bad.length) errs.push(`verdict values must be pass, warn or block (bad: ${bad.join(", ")})`);
		}
	} else if (qtype === "score") {
		const levels = q.levels;
		if (!isStrList(levels) || levels.length < 2) {
			errs.push("score checks need question.levels with 2+ ordered entries");
		} else {
			for (const k of ["block_at", "warn_at"]) {
				if (k in v && !(Number.isInteger(v[k]) && v[k] >= 0 && v[k] < levels.length)) {
					errs.push(`verdict.${k} must be a level index 0..${levels.length - 1}`);
				}
			}
			if (!("block_at" in v) && !("warn_at" in v)) errs.push("score checks need verdict.block_at and/or verdict.warn_at");
			if (Number.isInteger(v.block_at) && Number.isInteger(v.warn_at) && v.warn_at > v.block_at) {
				errs.push("verdict.warn_at must not exceed verdict.block_at");
			}
		}
	}
	if (qtype !== "choice" && "labels" in q) errs.push("question.labels is only valid for choice checks");
	if (qtype !== "score" && "levels" in q) errs.push("question.levels is only valid for score checks");

	const g = d.grading ?? {};
	if (!isTable(g)) {
		errs.push("[grading] must be a table");
	} else {
		if ("terms" in g && !isStrList(g.terms)) errs.push("grading.terms must be a list of strings");
		if ("expect_fail" in g && !isStrList(g.expect_fail)) {
			errs.push("grading.expect_fail must be a list of commit SHAs or A..B ranges");
		}
	}
	const known = new Set(["id", "title", "enabled", "status", "author", "applies_to", "inputs", "question", "verdict", "grading"]);
	const unknown = Object.keys(d)
		.filter((k) => !known.has(k))
		.sort();
	if (unknown.length) errs.push(`unknown top-level keys: ${unknown.join(", ")}`);
	return errs;
}

export function fromDict(d: Table, path: string | null = null, text = ""): Check {
	const q = d.question;
	return new Check({
		id: d.id,
		title: d.title,
		questionType: q.type,
		instructions: q.instructions.trim(),
		verdict: { ...d.verdict },
		status: d.status ?? "proposed",
		enabled: d.enabled ?? true,
		author: d.author ?? "user",
		appliesTo: [...(d.applies_to ?? ["**/*"])],
		inputs: [...(d.inputs ?? ["diff"])],
		labels: { ...(q.labels ?? {}) },
		levels: [...(q.levels ?? [])],
		grading: { ...(d.grading ?? {}) },
		path,
		text,
	});
}

/** Parse TOML text into a table; parser errors become `CheckError(["invalid TOML: ..."])`. */
export function parseTomlTable(text: string): Table {
	try {
		return parseToml(text) as Table;
	} catch (e) {
		throw new CheckError([`invalid TOML: ${(e as Error).message}`]);
	}
}

export function parseText(text: string, expectedId: string | null = null, path: string | null = null): Check {
	const d = parseTomlTable(text);
	const errs = validateDict(d, expectedId);
	if (errs.length) throw new CheckError(errs);
	return fromDict(d, path, text);
}

export function loadFile(path: string): Check {
	return parseText(readFileSync(path, "utf8"), parse(path).name, path);
}

/** Load every check file. Returns the valid checks and `{file name: errors}`. */
export function loadAll(checksDir: string): { checks: Check[]; errors: Record<string, string[]> } {
	const checks: Check[] = [];
	const errors: Record<string, string[]> = {};
	if (!existsSync(checksDir) || !statSync(checksDir).isDirectory()) return { checks, errors };
	for (const name of readdirSync(checksDir).filter((n) => n.endsWith(".toml")).sort()) {
		try {
			checks.push(loadFile(join(checksDir, name)));
		} catch (e) {
			if (!(e instanceof CheckError)) throw e;
			errors[name] = e.errors;
		}
	}
	return { checks, errors };
}

// ── answers and verdicts ─────────────────────────────────────────────────────

export function answerSchema(check: Check): Table {
	let answer: Table;
	if (check.questionType === "bool") answer = { type: "number", minimum: 0, maximum: 1 };
	else if (check.questionType === "choice") answer = { type: "string", enum: Object.keys(check.labels) };
	else answer = { type: "integer", minimum: 0, maximum: check.levels.length - 1 };
	return {
		type: "object",
		properties: {
			answer,
			confidence: { type: "number", minimum: 0, maximum: 1 },
			findings: {
				type: "array",
				items: {
					type: "object",
					properties: {
						file: { type: "string" },
						line: { type: "integer" },
						message: { type: "string" },
					},
					required: ["message"],
				},
			},
			summary: { type: "string" },
		},
		required: ["answer", "confidence", "findings", "summary"],
	};
}

function thresholds(v: Table, answer: number): Verdict {
	if ("block_at" in v && answer >= v.block_at) return "block";
	if ("warn_at" in v && answer >= v.warn_at) return "warn";
	return "pass";
}

/** Turn a model answer into pass/warn/block. Throws AnswerError if the answer is invalid. */
export function mapVerdict(check: Check, answer: unknown): Verdict {
	const v = check.verdict;
	if (check.questionType === "bool") {
		if (typeof answer !== "number" || !(answer >= 0 && answer <= 1)) {
			throw new AnswerError(`expected a probability 0-1, got ${pyRepr(answer)}`);
		}
		return thresholds(v, answer);
	}
	if (check.questionType === "choice") {
		if (typeof answer !== "string" || !Object.hasOwn(check.labels, answer)) {
			throw new AnswerError(`expected one of ${pyRepr(Object.keys(check.labels))}, got ${pyRepr(answer)}`);
		}
		return v[answer];
	}
	if (typeof answer !== "number" || !Number.isInteger(answer) || !(answer >= 0 && answer < check.levels.length)) {
		throw new AnswerError(`expected a level index 0..${check.levels.length - 1}, got ${pyRepr(answer)}`);
	}
	return thresholds(v, answer);
}

export interface Finding {
	file?: string;
	line?: number;
	message: string;
}

export interface ValidatedEntry {
	verdict: Verdict;
	findings: Finding[];
	summary: string;
	confidence: number;
}

/** Validate one model answer object. */
export function validateEntry(check: Check, entry: unknown): ValidatedEntry {
	if (!isTable(entry)) throw new AnswerError("answer entry is not an object");
	const verdict = mapVerdict(check, entry.answer);
	let confidence = entry.confidence;
	if (Array.isArray(entry.answer_probs) && entry.answer_probs.length) {
		// Measured by the backend: the probability the model gave to answers with this verdict.
		confidence = verdictProbability(check, entry.answer_probs, verdict);
	}
	if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) {
		throw new AnswerError(`expected a confidence 0-1, got ${pyRepr(confidence)}`);
	}
	const findings = entry.findings ?? [];
	if (!Array.isArray(findings)) throw new AnswerError("findings is not a list");
	const clean: Finding[] = [];
	for (const f of findings) {
		if (isTable(f) && typeof f.message === "string") {
			const kept: Table = {};
			for (const k of ["file", "line", "message"]) if (k in f) kept[k] = f[k];
			clean.push(kept as Finding);
		}
	}
	const summary = entry.summary ?? "";
	return { verdict, findings: clean, summary: typeof summary === "string" ? summary : "", confidence };
}

export function verdictProbability(check: Check, answerProbs: [unknown, number][], verdict: string): number {
	let total = 0;
	for (const [value, p] of answerProbs) {
		let same: boolean;
		try {
			same = mapVerdict(check, value) === verdict;
		} catch (e) {
			if (!(e instanceof AnswerError)) throw e;
			same = false;
		}
		total += same ? p : 0;
	}
	return Math.min(1, total);
}

export function worst(verdicts: string[]): Verdict {
	let out: Verdict = "pass";
	for (const v of verdicts as Verdict[]) if (SEVERITY[v] > SEVERITY[out]) out = v;
	return out;
}

export function describeAnswer(check: Check, answer: unknown): string {
	if (check.questionType === "score" && Number.isInteger(answer) && (answer as number) >= 0 && (answer as number) < check.levels.length) {
		return `${answer}: ${check.levels[answer as number]}`;
	}
	return typeof answer === "string" ? answer : JSON.stringify(answer);
}

// ── writing ──────────────────────────────────────────────────────────────────

function tomlValue(v: unknown): string {
	if (typeof v === "boolean") return v ? "true" : "false";
	if (typeof v === "number") return String(v);
	if (typeof v === "string") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
	if (isTable(v)) return `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`).join(", ")} }`;
	throw new TypeError(`cannot serialize ${typeof v} to TOML`);
}

function tomlKey(k: string): string {
	return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

/** Serialize a check dict in the canonical file layout. */
export function dumpCheck(d: Table): string {
	const lines: string[] = [];
	for (const key of ["id", "title", "enabled", "status", "author", "applies_to", "inputs"]) {
		if (key in d) lines.push(`${key} = ${tomlValue(d[key])}`);
	}
	for (const table of ["question", "verdict", "grading"]) {
		if (!(table in d)) continue;
		lines.push("", `[${table}]`);
		for (const [k, v] of Object.entries(d[table] as Table)) lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
	}
	return `${lines.join("\n")}\n`;
}

/** Rewrite only the status line. Returns the old and new lines. */
export function setStatus(path: string, status: string): { oldLine: string; newLine: string } {
	if (!(STATUSES as readonly string[]).includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
	let text = readFileSync(path, "utf8");
	const m = STATUS_LINE_RE.exec(text);
	let newLine = `status = "${status}"`;
	let oldLine = "";
	if (m) {
		oldLine = m[0];
		newLine = `${m[1]}"${status}"${m[2]}`;
		text = text.slice(0, m.index) + newLine + text.slice(m.index + m[0].length);
	} else {
		// Insert after the title line (top-level keys must precede tables).
		text = text.replace(/^(title\s*=.*)$/m, (_all, title: string) => `${title}\n${newLine}`);
	}
	writeFileSync(path, text);
	return { oldLine, newLine };
}
