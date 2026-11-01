/** Model backends by name. */
import type { Config } from "../config.ts";
import { type Backend, BackendError } from "./base.ts";
import { ClaudeBackend } from "./claude.ts";
import { FakeBackend } from "./fake.ts";
import { JudgeBackend } from "./judge.ts";
import { LocalBackend } from "./local.ts";
import { OmpBackend } from "./omp.ts";
import { PiBackend } from "./pi.ts";
import { TinyBackend } from "./tiny.ts";

export { type Backend, BackendError } from "./base.ts";

export function getBackend(cfg: Config, agent: string, override: string | null = null): Backend {
	const name = override || cfg.backendFor(agent);
	const settings = cfg.backendSettings(name);
	switch (name) {
		case "claude":
			return new ClaudeBackend(settings);
		case "omp":
			return new OmpBackend(settings, cfg.root);
		case "pi":
			return new PiBackend(settings, cfg.root);
		case "local":
			return new LocalBackend(settings);
		case "judge":
			return new JudgeBackend(settings);
		case "tiny":
			return new TinyBackend(settings);
		case "fake":
			return new FakeBackend(settings, cfg.root);
		default:
			throw new BackendError(`unknown or unavailable backend '${name}'`);
	}
}
