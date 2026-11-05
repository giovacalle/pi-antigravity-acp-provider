import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AntigravityAcpError } from "../src/acp/errors.js";
import { parseUsageQuota } from "../src/acp/usage-quota.js";
import { QUOTA_REQUEST_CHANNEL } from "../src/constants.js";
import { PERMISSION_TOOL_NAME } from "../src/runtime.js";
import {
	createFakeContext,
	createFakeExtensionApi,
	type FakeContext,
	type FakeExtensionApi,
	type FakeProviderRegistry,
} from "./helpers/fake-extension-api.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const usageReply = fs.readFileSync(new URL("./fixtures/usage-reply.md", import.meta.url), "utf8");
const now = 1_800_000_000_000;
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
async function load(sessionId: string, events?: FakeExtensionApi["api"]["events"]) {
	vi.resetModules();
	const { registerAntigravityAcp } = await import("../extensions/index.js");
	const pi = createFakeExtensionApi(registry);
	if (events) pi.api.events = events;
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

// load() imports a fresh module graph; spy on that graph's runtime class.
async function spyQuota() {
	const { AntigravityRuntime } = await import("../src/runtime.js");
	return vi.spyOn(AntigravityRuntime.prototype, "quota");
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

	it("shares one provider across loads and closes it when the last instance quits", async () => {
		const instances = [await load("a"), await load("b"), await load("c")];
		expect(new Set(instances.map(({ pi }) => pi.providers[0])).size).toBe(1);
		await stream([user("hello")], "a");
		await stream([user("hello")], "b");
		expect(connections.length).toBeGreaterThan(0);

		for (const { pi, ctx } of loaded.splice(0)) await pi.emit("session_shutdown", { reason: "quit" }, ctx);

		expect(connections.every((connection) => !connection.process.alive)).toBe(true);
	});

	it("reports process token totals without counting reasoning twice", async () => {
		const { pi, ctx } = await load("parent");
		await stream([user("usage single")], "parent");
		await pi.commands.get("antigravity-acp")!.handler("quota", ctx as never);
		// Thought tokens are already part of output, so tokens= is input + output + cacheRead + cacheWrite.
		expect(ctx.ui.notify.mock.calls.at(-1)![0]).toContain(
			"Usage this process: turns=1 tokens=1200 input=600 output=200 reasoning=50 cacheRead=400",
		);
	});
});

describe("live quota", () => {
	it("shows the live quota above the process totals", async () => {
		const snapshot = parseUsageQuota(usageReply, now);
		const { pi, ctx } = await load("a");
		const quota = (await spyQuota()).mockResolvedValue(snapshot);

		await pi.commands.get("antigravity-acp")!.handler("quota", ctx as never);
		expect(quota).toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Gemini Models: weekly 75% (resets 2026-01-12T18:00:00.000Z), 5h 90% (resets 2026-01-08T04:30:00.000Z)"),
			"info",
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage this process: turns=0"), "info");
		expect(ctx.ui.notify.mock.calls[0]![0]).not.toContain("not supplied");
	});

	it("labels groups without percentages as no percentage limits reported", async () => {
		const snapshot = {
			at: now,
			groups: [{ displayName: "Other", buckets: [] }],
		};
		const { pi, ctx } = await load("a");
		(await spyQuota()).mockResolvedValue(snapshot);

		await pi.commands.get("antigravity-acp")!.handler("quota", ctx as never);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Other: no percentage limits reported"),
			"info",
		);
	});

	it("shows why the live quota is unavailable", async () => {
		const { pi, ctx } = await load("a");
		(await spyQuota()).mockRejectedValue(
			new AntigravityAcpError("protocol", "Antigravity /usage reply had no quota groups: Unable to retrieve quota status (backend unavailable)"),
		);

		await pi.commands.get("antigravity-acp")!.handler("quota", ctx as never);

		const text = ctx.ui.notify.mock.calls.at(-1)![0] as string;
		expect(text).toContain("Antigravity quota: unavailable (");
		expect(text).toContain("Unable to retrieve quota status");
	});

	it("replies once with the live quota snapshot", async () => {
		const snapshot = parseUsageQuota(usageReply, now);
		const { pi } = await load("a");
		(await spyQuota()).mockResolvedValue(snapshot);

		const reply = vi.fn();
		pi.api.events.emit(QUOTA_REQUEST_CHANNEL, { reply });

		await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
		expect(reply).toHaveBeenCalledWith({ ok: true, quota: snapshot });
	});

	it("replies once with an error when the quota cannot be read", async () => {
		const { pi } = await load("a");
		(await spyQuota()).mockRejectedValue(
			new AntigravityAcpError("protocol", "Antigravity /usage reply had no quota groups: Unable to retrieve quota status (backend unavailable)"),
		);

		let callCount = 0;
		const reply = vi.fn(() => {
			callCount++;
			if (callCount === 1) throw new Error("listener error");
		});

		pi.api.events.emit(QUOTA_REQUEST_CHANNEL, { reply });

		await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(reply).toHaveBeenCalledTimes(1);
		expect(reply).toHaveBeenCalledWith({
			ok: false,
			error: expect.stringContaining("Unable to retrieve quota status"),
		});
	});

	it("replies once when several instances share one event bus", async () => {
		const snapshot = parseUsageQuota(usageReply, now);
		const parent = await load("a");
		// Both instances share the runtime built by the first module graph.
		(await spyQuota()).mockResolvedValue(snapshot);
		const child = await load("b", parent.pi.api.events);

		const reply = vi.fn();
		parent.pi.api.events.emit(QUOTA_REQUEST_CHANNEL, { reply });

		await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(reply).toHaveBeenCalledTimes(1);
		expect(reply).toHaveBeenCalledWith({ ok: true, quota: snapshot });

		// The surviving instance still answers once the other one stops listening.
		await child.pi.emit("session_shutdown", { reason: "reload" }, child.ctx);
		const next = vi.fn();
		parent.pi.api.events.emit(QUOTA_REQUEST_CHANNEL, { reply: next });
		await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
	});

	it("ignores requests without a reply function", async () => {
		const { pi } = await load("a");
		const quota = (await spyQuota()).mockResolvedValue({ at: 0, groups: [] });

		pi.api.events.emit(QUOTA_REQUEST_CHANNEL, {});
		pi.api.events.emit(QUOTA_REQUEST_CHANNEL, { reply: "not-a-function" });

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(quota).not.toHaveBeenCalled();
	});

	it("stops listening on session shutdown", async () => {
		const { pi, ctx } = await load("a");
		expect(pi.listeners.get(QUOTA_REQUEST_CHANNEL)).toHaveLength(1);

		await pi.emit("session_shutdown", { reason: "reload" }, ctx);

		expect(pi.listeners.get(QUOTA_REQUEST_CHANNEL)).toHaveLength(0);
	});
});
