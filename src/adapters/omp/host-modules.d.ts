// Modules omp provides to its extensions at runtime; not installed as packages.
declare module "@oh-my-pi/pi-coding-agent/config/registry" {
	export function lookup(id: string): unknown;
}
