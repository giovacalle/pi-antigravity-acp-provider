import fs from "node:fs";
import path from "node:path";

// agy 1.4.x writes this guide for its run_workflow tool into the session cwd on
// every session setup, and again at each prompt when it is missing.
const PARTS = ["skills", "system", "run-workflow", "SKILL.md"] as const;

// Whether each path in PARTS existed before this Pi process first set up a
// session in that cwd. The first record wins so a tree agy wrote is never
// mistaken for the user's.
const preexisting = new Map<string, boolean[]>();

function paths(cwd: string): string[] {
	return PARTS.map((_, index) => path.join(cwd, ...PARTS.slice(0, index + 1)));
}

export function rememberSystemSkillTree(cwd: string): void {
	if (preexisting.has(cwd)) return;
	preexisting.set(cwd, paths(cwd).map((entry) => {
		try {
			fs.lstatSync(entry);
			return true;
		} catch {
			return false;
		}
	}));
}

/** Best-effort: removes only what was absent before, and directories only when empty. */
export function removeSystemSkillTree(cwd: string): void {
	const existed = preexisting.get(cwd);
	if (!existed) return;
	const entries = paths(cwd);
	for (let index = entries.length - 1; index >= 0; index--) {
		if (existed[index]) return;
		const entry = entries[index]!;
		try {
			const stat = fs.lstatSync(entry);
			if (index === entries.length - 1 ? !stat.isFile() : !stat.isDirectory()) return;
			if (stat.isFile()) fs.unlinkSync(entry);
			else fs.rmdirSync(entry);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
		}
	}
}
