#!/usr/bin/env node
// The `acc` command. acc is TypeScript: Bun runs it as is; Node loads it through jiti.
const cli = new URL("../src/cli.ts", import.meta.url);
let mod;
if (globalThis.Bun) {
	mod = await import(cli.href);
} else {
	const { createJiti } = await import("jiti");
	mod = await createJiti(import.meta.url).import(cli.pathname);
}
process.exitCode = await mod.main(process.argv.slice(2));
