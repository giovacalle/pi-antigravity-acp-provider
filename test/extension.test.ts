import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AntigravityAcpConnection } from "../src/acp/connection.js";
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
	vi.unstubAllGlobals();
	fs.rmSync(root, { recursive: true, force: true });
});

// Pi loads each extension instance with a fresh module graph.
async function load(sessionId: string, scenario?: string) {
	vi.resetModules();
	const { registerAntigravityAcp } = await import("../extensions/index.js");
	const pi = createFakeExtensionApi(registry);
	registerAntigravityAcp(pi.api, (options) => {
		const connection = new AntigravityAcpConnection({ ...options, command: process.execPath,
			args: [fakeAgent, ...(scenario ? [scenario] : [])], env: { ...process.env, FAKE_AGENT_LOG_FILE: log } });
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

	it("warns once per session about each Pi tool Antigravity cannot use", async () => {
		const { pi, ctx } = await load("parent");
		const provider = registry.get("antigravity-acp")!;
		const tuple = { name: "pair", description: "pair", parameters: Type.Object({ value: Type.Tuple([Type.String(), Type.Number()]) }) };
		const permission = { name: PERMISSION_TOOL_NAME, description: "broker", parameters: Type.Object({}) };
		await provider.streamSimple(model, normalizeContext({ tools: [tuple, permission], messages: [user("hello")] }), { sessionId: "parent", apiKey: "test-key" }).result();
		await pi.emit("turn_end", {}, ctx);
		await pi.emit("turn_end", {}, ctx);
		const warnings = ctx.ui.notify.mock.calls.filter(([, level]) => level === "warning");
		expect(warnings).toEqual([[expect.stringContaining("Antigravity cannot use Pi tool pair: schema omitted (unsupported_keyword)"), "warning"]]);
		expect(warnings[0]![0]).not.toContain(PERMISSION_TOOL_NAME);
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

	it("shows each shared process with its session count in doctor", async () => {
		const configDir = path.join(root, "agent", "antigravity-acp-provider");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ sharedProcess: true }));
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		const { pi, ctx } = await load("parent");

		await Promise.all([stream([user("hello")], "a"), stream([user("hello")], "b")]);
		await pi.commands.get("antigravity-acp")!.handler("doctor", ctx as never);

		const text = ctx.ui.notify.mock.calls.at(-1)![0] as string;
		expect(text).toContain("Shared processes: max 4 per process");
		expect(text.split("\n").filter((line) => line.includes("sessions=2"))).toHaveLength(1);
		expect(connections).toHaveLength(1);
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

	it("shows the live quota above the process totals", async () => {
		const { pi, ctx } = await load("parent");
		await pi.commands.get("antigravity-acp")!.handler("quota", ctx as never);
		const text = ctx.ui.notify.mock.calls.at(-1)![0] as string;
		expect(text).toContain("Gemini Models: weekly 81% (resets 2026-10-30T22:21:00.000Z), 5h 98% (resets 2026-10-30T04:10:00.000Z)");
		expect(text).toContain("Usage this process: turns=0");
		expect(text).not.toContain("not supplied");
	});

	it("forces a model catalog refresh for this provider", async () => {
		const { pi, ctx } = await load("parent");
		const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }));
		await pi.commands.get("antigravity-acp")!.handler("models", { ...ctx, modelRegistry: { refresh } } as never);
		expect(refresh).toHaveBeenCalledWith({ providers: ["antigravity-acp"], allowNetwork: true, force: true });
		expect(ctx.ui.notify.mock.calls.at(-1)).toEqual([expect.stringMatching(/^Antigravity models: gemini-3\.8-flash, /u), "info"]);
	});

	it("reports a failed model catalog refresh", async () => {
		const { pi, ctx } = await load("parent");
		const refresh = vi.fn(async () => ({ aborted: false, errors: new Map([["antigravity-acp", new Error("offline")]]) }));
		await pi.commands.get("antigravity-acp")!.handler("models", { ...ctx, modelRegistry: { refresh } } as never);
		expect(ctx.ui.notify.mock.calls.at(-1)).toEqual(["Antigravity model refresh failed: offline", "warning"]);
	});

	it("reports a cancelled model catalog refresh", async () => {
		const { pi, ctx } = await load("parent");
		const refresh = vi.fn(async () => ({ aborted: true, errors: new Map() }));
		await pi.commands.get("antigravity-acp")!.handler("models", { ...ctx, modelRegistry: { refresh } } as never);
		expect(ctx.ui.notify.mock.calls.at(-1)).toEqual(["Antigravity model refresh was cancelled", "warning"]);
	});

	it("shows why the live quota is unavailable", async () => {
		const { pi, ctx } = await load("parent", "usage-unavailable");
		await pi.commands.get("antigravity-acp")!.handler("quota", ctx as never);
		expect(ctx.ui.notify.mock.calls.at(-1)![0]).toContain("Antigravity quota: unavailable (");
	});
});

describe("quota request channel", () => {
	it("replies once with the live quota snapshot", async () => {
		const { pi } = await load("parent");
		const reply = vi.fn();
		pi.api.events.emit(QUOTA_REQUEST_CHANNEL, { reply });
		await vi.waitFor(() => expect(reply).toHaveBeenCalled());
		expect(reply).toHaveBeenCalledOnce();
		expect(reply).toHaveBeenCalledWith({ ok: true, quota: expect.objectContaining({
			groups: expect.arrayContaining([expect.objectContaining({ displayName: "Gemini Models" })]),
		}) });
	});

	it("replies once with an error when the quota cannot be read", async () => {
		const { pi } = await load("parent", "usage-unavailable");
		const reply = vi.fn(() => { throw new Error("listener failed"); });
		pi.api.events.emit(QUOTA_REQUEST_CHANNEL, { reply });
		await vi.waitFor(() => expect(reply).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(reply).toHaveBeenCalledOnce();
		expect(reply).toHaveBeenCalledWith({ ok: false, error: expect.stringContaining("Unable to retrieve quota status") });
	});

	it("ignores requests without a reply function", async () => {
		const { pi } = await load("parent");
		pi.api.events.emit(QUOTA_REQUEST_CHANNEL, undefined);
		pi.api.events.emit(QUOTA_REQUEST_CHANNEL, { reply: "no" });
		expect(connections).toHaveLength(0);
	});

	it("stops listening on session shutdown", async () => {
		const { pi } = await load("parent");
		expect(pi.eventListeners(QUOTA_REQUEST_CHANNEL)).toBe(1);
		for (const { pi: instance, ctx } of loaded.splice(0)) await instance.emit("session_shutdown", { reason: "quit" }, ctx);
		expect(pi.eventListeners(QUOTA_REQUEST_CHANNEL)).toBe(0);
	});
});
