import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { PERMISSION_TOOL_NAME } from "../src/runtime.js";
import {
	createFakeContext,
	createFakeExtensionApi,
	type FakeContext,
	type FakeExtensionApi,
	type FakeProviderRegistry,
} from "./helpers/fake-extension-api.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const model: Model<"antigravity-acp"> = { id: "gemini-test", name: "Test", api: "antigravity-acp", provider: "antigravity-acp", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 8192 };
const user = (content: string, timestamp = 1): Context["messages"][number] => ({ role: "user", content, timestamp });

let root: string;
let log: string;
let registry: FakeProviderRegistry;
let loaded: Array<{ pi: FakeExtensionApi; ctx: FakeContext }>;
let connections: AntigravityAcpConnection[];

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-extension-"));
	fs.mkdirSync(path.join(root, "home"));
	fs.mkdirSync(path.join(root, "agent"));
	log = path.join(root, "calls.jsonl");
	fs.writeFileSync(log, "");
	// Never read or migrate a developer's real configuration.
	vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
	vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "home"));
	registry = new Map();
	loaded = [];
	connections = [];
});

afterEach(async () => {
	for (const { pi, ctx } of loaded.splice(0)) await pi.emit("session_shutdown", { reason: "quit" }, ctx);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

// Pi loads each extension instance with a fresh module graph.
async function load(sessionId: string) {
	vi.resetModules();
	const { registerAntigravityAcp } = await import("../extensions/index.js");
	const pi = createFakeExtensionApi(registry);
	registerAntigravityAcp(pi.api, (options) => {
		const connection = new AntigravityAcpConnection({ ...options, command: process.execPath,
			args: [fakeAgent], env: { ...process.env, FAKE_AGENT_LOG_FILE: log } });
		connections.push(connection);
		return connection;
	});
	const ctx = createFakeContext({ sessionId, cwd: root });
	loaded.push({ pi, ctx });
	return { pi, ctx };
}

function stream(messages: Context["messages"], sessionId: string, provider = registry.get("antigravity-acp")) {
	if (!provider) throw new Error("antigravity-acp provider is not registered");
	return provider.streamSimple(model, normalizeContext({ messages }), { sessionId, apiKey: "test-key" }).result();
}

// Synthetic ACP processes only: no Google account or real agent actions.
describe("extension entry point", () => {
	it("registers the provider, permission tool, and commands", async () => {
		const { pi } = await load("parent");
		expect(registry.get("antigravity-acp")).toBe(pi.providers[0]);
		expect(pi.tools.has(PERMISSION_TOOL_NAME)).toBe(true);
		expect([...pi.commands.keys()]).toEqual(["antigravity-acp", "gemini-acp"]);
	});

	it("keeps the parent session usable after a child instance shuts down", async () => {
		await load("parent");
		const child = await load("child");
		const first = await stream([user("hello")], "parent");
		expect(first.stopReason).toBe("stop");

		await child.pi.emit("session_shutdown", { reason: "quit" }, child.ctx);

		const second = await stream([user("hello"), first, user("next", 2)], "parent");
		expect(second.stopReason).toBe("stop");
	});

	it("closes only the child's ACP process when the child shuts down", async () => {
		await load("parent");
		const child = await load("child");
		const first = await stream([user("hello")], "parent");
		await stream([user("hello")], "child");
		const [parentConnection, childConnection] = connections;

		await child.pi.emit("session_shutdown", { reason: "quit" }, child.ctx);

		await childConnection!.process.exited;
		expect(parentConnection!.process.alive).toBe(true);
		await stream([user("hello"), first, user("next", 2)], "parent");
		expect(connections).toHaveLength(2);
		expect(parentConnection!.process.alive).toBe(true);
	});

	it("resolves a permission parked through one instance with another instance's permission tool", async () => {
		const parent = await load("parent");
		const child = await load("child");
		const parked = await stream([user("request permission")], "parent", parent.pi.providers[0]);
		const call = parked.content.find((block) => block.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("missing permission tool call");

		const ctx = createFakeContext({ sessionId: "child", selectAnswer: (labels) => labels[0] });
		const tool = child.pi.tools.get(PERMISSION_TOOL_NAME);
		if (!tool) throw new Error("missing permission tool");
		const result = await tool.execute("call", { requestId: call.id }, undefined, undefined, ctx as never);

		expect(result.details).toMatchObject({ requestId: call.id, optionId: "allow-once", cancelled: false });
	});

	it("starts each ACP session in its Pi session's working directory", async () => {
		const { pi } = await load("parent");
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acp-session-cwd-"));
		try {
			await pi.emit("session_start", { reason: "startup" }, createFakeContext({ sessionId: "x", cwd }));

			await stream([user("hello")], "x");
			await stream([user("hello")], "y");

			const sessions = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; cwd?: string })
				.filter((entry) => entry.method === "session/new");
			expect(sessions.map((entry) => entry.cwd)).toEqual([cwd, process.cwd()]);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("shares one provider across loads and closes it when the last instance quits", async () => {
		const instances = [await load("a"), await load("b"), await load("c")];
		expect(new Set(instances.map(({ pi }) => pi.providers[0])).size).toBe(1);
		await stream([user("hello")], "a");
		await stream([user("hello")], "b");
		expect(connections.length).toBeGreaterThan(0);

		for (const { pi, ctx } of loaded.splice(0)) await pi.emit("session_shutdown", { reason: "quit" }, ctx);

		expect(connections.every((connection) => !connection.process.alive)).toBe(true);
	});
});
