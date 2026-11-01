/** JSONL decision log (shape after dev-decisions). Never stores diff text or secret matches. */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homeDir } from "./config.ts";

export function logDir(): string {
	const override = process.env.ACC_LOG_DIR;
	if (override) return override;
	const base = process.env.XDG_DATA_HOME || join(homeDir(), ".local", "share");
	return join(base, "acc", "logs");
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

export function write(row: Record<string, unknown>): string | null {
	const now = new Date();
	const y = now.getUTCFullYear();
	const mo = pad(now.getUTCMonth() + 1);
	const d = pad(now.getUTCDate());
	const ts = `${y}-${mo}-${d}T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}Z`;
	const path = join(logDir(), String(y), mo, d, "events.jsonl");
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify({ ts, ...row })}\n`);
		return path;
	} catch (e) {
		// Logging must never break the gate.
		process.stderr.write(`acc: could not write log: ${(e as Error).message}\n`);
		return null;
	}
}
