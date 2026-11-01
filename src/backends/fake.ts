/**
 * Fake backend: canned answers from a JSON fixture, for tests without network or login.
 *
 * The fixture maps a check key (`id@sha7`), a check id, or `*` to either an answer object, the
 * string "omit" (leave the entry out), "error" (fail the whole call), or "retryable" (fail the
 * call with a retryable error, e.g. invalid output). An answer object without `confidence` is
 * returned with confidence 1. `ACC_FAKE_ANSWERS` overrides `[backends.fake] answers`.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Table } from "../config.ts";
import { type Backend, BackendError } from "./base.ts";

export class FakeBackend implements Backend {
	name = "fake";
	model = "fake";
	answers: Table = {};

	constructor(settings: Table, root: string) {
		const path: string = process.env.ACC_FAKE_ANSWERS || settings.answers || "";
		if (path) this.answers = JSON.parse(readFileSync(isAbsolute(path) ? path : join(root, path), "utf8"));
	}

	async ask(_system: string, _prompt: string, _stdin: string, schema: Table): Promise<Table> {
		const out: Table = {};
		for (const key of schema.properties.checks.required as string[]) {
			const checkId = key.split("@", 1)[0];
			const ans = this.answers[key] ?? this.answers[checkId] ?? this.answers["*"];
			if (ans === "error" || ans === "retryable") {
				throw new BackendError(`fake backend error for ${key}`, ans === "retryable");
			}
			if (ans === undefined || ans === null || ans === "omit") continue;
			out[key] = typeof ans === "object" && !Array.isArray(ans) ? { confidence: 1.0, ...ans } : ans;
		}
		return { checks: out };
	}
}
