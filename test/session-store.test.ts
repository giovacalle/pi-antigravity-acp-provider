import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AcpSessionStore, resolveSessionStorePath } from "../src/acp/session-store.js";

const roots: string[] = [];
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	if (originalPiCodingAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AcpSessionStore", () => {
	it("drops a record with an unknown systemPromptDelivery", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-sessions-"));
		roots.push(root);
		const file = path.join(root, "sessions.json");
		const base = { acpSessionId: "acp", acpModelId: "gemini-low", cwd: "/tmp/project", messageCount: 2, historyFingerprint: "abc", lastActive: Date.now() };
		fs.writeFileSync(file, JSON.stringify([
			{ ...base, piSessionId: "ok", systemPromptDelivery: "append" },
			{ ...base, piSessionId: "bad", systemPromptDelivery: "other" },
		]));
		const store = new AcpSessionStore(file);
		expect(store.get("ok")?.systemPromptDelivery).toBe("append");
		expect(store.get("bad")).toBeUndefined();
	});

	it("persists, replaces, and removes Pi-to-ACP bindings", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-sessions-"));
		roots.push(root);
		const file = path.join(root, "sessions.json");
		const store = new AcpSessionStore(file);
		store.save({
			piSessionId: "pi-1",
			acpSessionId: "acp-1",
			acpModelId: "gemini-low",
			cwd: "/tmp/project",
			messageCount: 2,
			historyFingerprint: "abc",
			lastActive: Date.now(),
		});
		expect(new AcpSessionStore(file).get("pi-1")?.acpSessionId).toBe("acp-1");
		store.save({ ...store.get("pi-1")!, acpSessionId: "acp-2", lastActive: Date.now() });
		expect(store.get("pi-1")?.acpSessionId).toBe("acp-2");
		store.remove("pi-1");
		expect(store.get("pi-1")).toBeUndefined();
	});

	it("ignores malformed records", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-sessions-"));
		roots.push(root);
		const file = path.join(root, "sessions.json");
		fs.writeFileSync(file, '[{"piSessionId":"bad"}]');
		expect(new AcpSessionStore(file).get("bad")).toBeUndefined();
	});

	it("uses default session store path when PI_CODING_AGENT_DIR is unset", () => {
		delete process.env.PI_CODING_AGENT_DIR;
		expect(resolveSessionStorePath()).toBe(
			path.join(os.homedir(), ".pi", "agent", "antigravity-acp-provider", "sessions.json"),
		);
	});

	it("keeps bindings isolated across custom profiles", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-session-profiles-"));
		roots.push(root);
		process.env.PI_CODING_AGENT_DIR = path.join(root, "one");
		const first = new AcpSessionStore();
		first.save({ piSessionId: "shared-id", acpSessionId: "profile-one", acpModelId: "auto", cwd: root,
			messageCount: 1, historyFingerprint: "one", lastActive: Date.now() });
		process.env.PI_CODING_AGENT_DIR = path.join(root, "two");
		const second = new AcpSessionStore();
		expect(second.get("shared-id")).toBeUndefined();
		second.save({ piSessionId: "shared-id", acpSessionId: "profile-two", acpModelId: "auto", cwd: root,
			messageCount: 1, historyFingerprint: "two", lastActive: Date.now() });
		expect(first.get("shared-id")?.acpSessionId).toBe("profile-one");
		expect(second.get("shared-id")?.acpSessionId).toBe("profile-two");
	});

	it("saves records to custom directory when PI_CODING_AGENT_DIR is set", () => {
		const customAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-agent-sessions-"));
		roots.push(customAgentDir);
		process.env.PI_CODING_AGENT_DIR = customAgentDir;

		const expectedFile = path.join(customAgentDir, "antigravity-acp-provider", "sessions.json");
		expect(resolveSessionStorePath()).toBe(expectedFile);

		const store = new AcpSessionStore();
		store.save({
			piSessionId: "pi-custom-1",
			acpSessionId: "acp-custom-1",
			acpModelId: "gemini-pro",
			cwd: "/tmp/custom",
			messageCount: 1,
			historyFingerprint: "custom-hash",
			lastActive: Date.now(),
		});

		expect(fs.existsSync(expectedFile)).toBe(true);
		expect(new AcpSessionStore().get("pi-custom-1")?.acpSessionId).toBe("acp-custom-1");
	});
});
