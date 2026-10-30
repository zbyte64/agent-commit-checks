// Loads the omp extension against a minimal stand-in for omp's ExtensionAPI, fires one
// tool_call event and prints the handler's result as JSON (null when it returns nothing).
// Usage: bun tests/omp_harness.ts <extension.ts> <tool_call event JSON> <session cwd>
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

const [extensionPath, eventJson, cwd] = Bun.argv.slice(2);
const handlers: Record<string, Handler[]> = {};

const pi = {
	setLabel(_label: string) {},
	on(name: string, handler: Handler) {
		(handlers[name] ??= []).push(handler);
	},
	// Same contract as omp's pi.exec: exec form, cwd defaults to the session cwd.
	async exec(command: string, args: string[], options: { cwd?: string } = {}) {
		const proc = Bun.spawn([command, ...args], { cwd: options.cwd ?? cwd, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, code, killed: false };
	},
};

// The extension path is a CLI argument (a rendered copy in a temp dir), so it cannot be a static import.
const mod = await import(extensionPath);
mod.default(pi);
const ctx = { cwd, hasUI: false, ui: {} };
let result: unknown = null;
for (const handler of handlers.tool_call ?? []) {
	result = (await handler(JSON.parse(eventJson), ctx)) ?? result;
}
console.log(JSON.stringify(result ?? null));
