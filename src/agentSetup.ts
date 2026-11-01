/** Inspecting the omp and pi side of the setup: settings, installed packages, leftovers. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "./config.ts";
import { run } from "./proc.ts";

/** The npm package name, which both omp and pi list once the package is installed. */
export const PACKAGE_NAME = "agent-commit-checks";
/** What users install: the git repository (omp and pi both accept this form). */
export const PACKAGE_SOURCE = "git:github.com/zbyte64/agent-commit-checks";

async function capture(cmd: string, args: string[], cwd: string): Promise<string | null> {
	try {
		const proc = await run(cmd, args, { cwd, timeoutMs: 30_000 });
		return proc.code === 0 ? proc.stdout : null;
	} catch {
		return null;
	}
}

/** A merged omp setting as seen from `cwd` (so project overlays count), or null if unavailable. */
export async function ompConfigGet(omp: string, key: string, cwd: string): Promise<unknown> {
	const out = await capture(omp, ["config", "get", key, "--json"], cwd);
	if (out === null) return null;
	try {
		return JSON.parse(out)?.value ?? null;
	} catch {
		return null;
	}
}

/** Worst case for one gate run: a round of parallel batches, then a round of single retries. */
export function gateBudgetMs(timeoutSeconds: number): number {
	return Math.floor(2 * timeoutSeconds * 1000);
}

/** Whether omp lists this package among its installed plugins (null: omp could not be asked). */
export async function ompPluginInstalled(omp: string, cwd: string): Promise<boolean | null> {
	const out = await capture(omp, ["plugin", "list", "--json"], cwd);
	if (out === null) return null;
	try {
		const data = JSON.parse(out);
		const all = [...(data?.npm ?? []), ...(data?.marketplace ?? [])];
		return all.some((p) => p?.name === PACKAGE_NAME || p?.id === PACKAGE_NAME);
	} catch {
		return null;
	}
}

/** Whether `pi list` shows this package (null: pi could not be asked). */
export async function piPackageInstalled(pi: string, cwd: string): Promise<boolean | null> {
	const out = await capture(pi, ["list"], cwd);
	return out === null ? null : out.includes(PACKAGE_NAME);
}

/**
 * Extension files written by the Python version's `acc init --omp`. They call the old `acc gate --agent
 * omp`, which no longer exists, so a leftover blocks every push; with the package installed it would
 * also run the gate twice.
 */
export function legacyOmpExtensions(root: string): string[] {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homeDir(), ".omp", "agent");
	return [join(root, ".omp", "extensions", "acc.ts"), join(agentDir, "extensions", "acc.ts")].filter((p) => existsSync(p));
}
