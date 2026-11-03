import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LIVE_FLAGS = ["PI_ANTIGRAVITY_ACP_REAL", "PI_ANTIGRAVITY_ACP_LIVE", "PI_ANTIGRAVITY_ACP_QUALIFY"];

// Opt-in live suites need the real Antigravity store; every other run gets a throwaway home so a test
// that forgets to stub HOME/GEMINI_HOME cannot rewrite the developer's credentials or settings.
export default function isolateHome(): (() => void) | undefined {
	if (LIVE_FLAGS.some((name) => process.env[name] === "1")) return undefined;
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-test-home-")));
	process.env.HOME = home;
	delete process.env.GEMINI_HOME;
	return () => fs.rmSync(home, { recursive: true, force: true });
}
