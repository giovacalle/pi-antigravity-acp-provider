import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AntigravityAcpConnection, type AntigravityConnectionHandlers } from "../src/acp/connection.js";
import { ACP_PROTOCOL_VERSION, ACP_SDK_VERSION } from "../src/constants.js";
import { quotaFromPrompt } from "../src/status.js";
import { usageFromPrompt } from "../src/stream/usage.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const fixtures: Array<{ connection: AntigravityAcpConnection; root: string }> = [];

function setup(scenario?: string) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-sdk-migration-"));
	const log = path.join(root, "calls.jsonl");
	fs.writeFileSync(log, "");
	const connection = new AntigravityAcpConnection({
		cwd: root,
		command: process.execPath,
		args: [fakeAgent, ...(scenario ? [scenario] : [])],
		env: { ...process.env, FAKE_AGENT_LOG_FILE: log },
	});
	fixtures.push({ connection, root });
	const entries = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	return { connection, entries };
}

afterEach(async () => {
	for (const { connection, root } of fixtures.splice(0)) {
		await connection.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("SDK 2 app migration over ACP v1", () => {
	it("keeps protocol v1 and advertises no filesystem or terminal callbacks", async () => {
		const { connection, entries } = setup();
		await connection.initialize();
		const initialize = entries().find((entry) => entry.method === "initialize");
		expect(initialize.params).toMatchObject({
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		});
		expect(ACP_PROTOCOL_VERSION).toBe(1);
		const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		expect(ACP_SDK_VERSION).toBe(pkg.dependencies["@agentclientprotocol/sdk"]);
	});

	it("preserves draft prompt usage and quota metadata through the full-v1 entrypoint", async () => {
		const { connection } = setup("sdk-usage");
		const session = await connection.newSession(process.cwd());
		const response = await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
		expect(response.usage).toMatchObject({ inputTokens: 17, outputTokens: 5, cachedReadTokens: 3, thoughtTokens: 2 });
		expect(usageFromPrompt(response)).toMatchObject({ input: 14, output: 7, cacheRead: 3, reasoning: 2, totalTokens: 24 });
		expect(quotaFromPrompt(response)).toEqual({ remaining: 12, limit: 20 });
	});

	it("defaults permission requests to cancelled and supports replacing handlers", async () => {
		const { connection } = setup();
		const session = await connection.newSession(process.cwd());
		const updates: string[] = [];
		const onUpdate: NonNullable<AntigravityConnectionHandlers["onUpdate"]> = (notification) => {
			if (notification.update.sessionUpdate === "agent_message_chunk" && notification.update.content.type === "text") updates.push(notification.update.content.text);
		};
		connection.setHandlers({ onUpdate });
		const request = { sessionId: session.sessionId, prompt: [{ type: "text" as const, text: "request permission" }] };
		await connection.prompt(request);
		expect(updates).toEqual(["Decision: cancelled"]);
		connection.setHandlers({ onUpdate, onPermission: async (permission) => ({ outcome: { outcome: "selected", optionId: permission.options[0]!.optionId } }) });
		await connection.prompt(request);
		expect(updates).toEqual(["Decision: cancelled", "Decision: selected"]);
	});

	it("sends session/cancel as a notification and reuses the healthy connection", async () => {
		const { connection, entries } = setup();
		const session = await connection.newSession(process.cwd());
		const controller = new AbortController();
		const pending = connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hang" }] }, controller.signal);
		const rejected = expect(pending).rejects.toThrow("aborted");
		await vi.waitFor(() => expect(entries().some((entry) => entry.method === "session/prompt")).toBe(true));
		controller.abort();
		await rejected;
		expect(connection.process.alive).toBe(true);
		await expect(connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] })).resolves.toMatchObject({ stopReason: "end_turn" });
	});

	it("closes the SDK lifecycle and promptly rejects an outstanding prompt", async () => {
		const { connection, entries } = setup();
		const session = await connection.newSession(process.cwd());
		const pending = connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hang" }] });
		const rejected = expect(pending).rejects.toBeInstanceOf(Error);
		await vi.waitFor(() => expect(entries().some((entry) => entry.method === "session/prompt")).toBe(true));
		await connection.close();
		await rejected;
		expect(connection.process.alive).toBe(false);
	});
});
