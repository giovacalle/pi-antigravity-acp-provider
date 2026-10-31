import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import antigravityAcpExtension from "../extensions/index.js";
import { AntigravityAcpError } from "../src/acp/errors.js";
import { parseUsageQuota } from "../src/acp/usage-quota.js";
import { QUOTA_REQUEST_CHANNEL } from "../src/constants.js";
import { AntigravityRuntime } from "../src/runtime.js";

const usageReply = fs.readFileSync(new URL("./fixtures/usage-reply.md", import.meta.url), "utf8");
const now = 1_800_000_000_000;

describe("antigravity-acp extension", () => {
	let tmp: string;
	let commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
	let lifecycle: Map<string, Array<(...args: any[]) => Promise<void> | void>>;
	let eventHandlers: Map<string, Set<(data: unknown) => void>>;
	let pi: ExtensionAPI;
	let notify: ReturnType<typeof vi.fn>;
	let ctx: any;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-test-"));
		vi.stubEnv("HOME", tmp);
		vi.stubEnv("PI_CODING_AGENT_DIR", tmp);

		commands = new Map();
		lifecycle = new Map();
		eventHandlers = new Map();
		notify = vi.fn();
		ctx = { ui: { notify, select: vi.fn() }, sessionManager: { getSessionId: () => "sess-1" } };

		pi = {
			registerProvider: vi.fn(),
			registerTool: vi.fn(),
			registerCommand: (name: string, def: any) => {
				commands.set(name, def);
			},
			on: (type: string, handler: any) => {
				const list = lifecycle.get(type) ?? [];
				list.push(handler);
				lifecycle.set(type, list);
			},
			events: {
				on: (channel: string, handler: (data: unknown) => void) => {
					let set = eventHandlers.get(channel);
					if (!set) {
						set = new Set();
						eventHandlers.set(channel, set);
					}
					set.add(handler);
					return () => set.delete(handler);
				},
				emit: (channel: string, data: unknown) => {
					for (const handler of [...(eventHandlers.get(channel) ?? [])]) {
						handler(data);
					}
				},
			},
		} as unknown as ExtensionAPI;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("shows the live quota above the process totals", async () => {
		const snapshot = parseUsageQuota(usageReply, now);
		const quotaSpy = vi.spyOn(AntigravityRuntime.prototype, "quota").mockResolvedValue(snapshot);

		antigravityAcpExtension(pi);
		const cmd = commands.get("antigravity-acp");
		expect(cmd).toBeDefined();

		await cmd!.handler("quota", ctx);
		expect(quotaSpy).toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Gemini Models: weekly 75% (resets 2026-01-12T18:00:00.000Z), 5h 90% (resets 2026-01-08T04:30:00.000Z)"),
			"info",
		);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage this process: turns=0"), "info");
		expect(notify.mock.calls[0]![0]).not.toContain("not supplied");
	});

	it("labels groups without percentages as no percentage limits reported", async () => {
		const snapshot = {
			at: now,
			groups: [{ displayName: "Other", buckets: [] }],
		};
		vi.spyOn(AntigravityRuntime.prototype, "quota").mockResolvedValue(snapshot);

		antigravityAcpExtension(pi);
		const cmd = commands.get("antigravity-acp");
		await cmd!.handler("quota", ctx);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Other: no percentage limits reported"),
			"info",
		);
	});

	it("shows why the live quota is unavailable", async () => {
		vi.spyOn(AntigravityRuntime.prototype, "quota").mockRejectedValue(
			new AntigravityAcpError("protocol", "Antigravity /usage reply had no quota groups: Unable to retrieve quota status (backend unavailable)"),
		);

		antigravityAcpExtension(pi);
		const cmd = commands.get("antigravity-acp");
		await cmd!.handler("quota", ctx);

		const text = notify.mock.calls.at(-1)![0] as string;
		expect(text).toContain("Antigravity quota: unavailable (");
		expect(text).toContain("Unable to retrieve quota status");
	});

	it("replies once with the live quota snapshot", async () => {
		const snapshot = parseUsageQuota(usageReply, now);
		vi.spyOn(AntigravityRuntime.prototype, "quota").mockResolvedValue(snapshot);

		antigravityAcpExtension(pi);
		const reply = vi.fn();
		pi.events.emit(QUOTA_REQUEST_CHANNEL, { reply });

		await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
		expect(reply).toHaveBeenCalledWith({ ok: true, quota: snapshot });
	});

	it("replies once with an error when the quota cannot be read", async () => {
		vi.spyOn(AntigravityRuntime.prototype, "quota").mockRejectedValue(
			new AntigravityAcpError("protocol", "Antigravity /usage reply had no quota groups: Unable to retrieve quota status (backend unavailable)"),
		);

		antigravityAcpExtension(pi);
		let callCount = 0;
		const reply = vi.fn(() => {
			callCount++;
			if (callCount === 1) throw new Error("listener error");
		});

		pi.events.emit(QUOTA_REQUEST_CHANNEL, { reply });

		await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(reply).toHaveBeenCalledTimes(1);
		expect(reply).toHaveBeenCalledWith({
			ok: false,
			error: expect.stringContaining("Unable to retrieve quota status"),
		});
	});

	it("ignores requests without a reply function", async () => {
		const quotaSpy = vi.spyOn(AntigravityRuntime.prototype, "quota").mockResolvedValue({ at: 0, groups: [] });

		antigravityAcpExtension(pi);
		pi.events.emit(QUOTA_REQUEST_CHANNEL, {});
		pi.events.emit(QUOTA_REQUEST_CHANNEL, { reply: "not-a-function" });

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(quotaSpy).not.toHaveBeenCalled();
	});

	it("stops listening on session shutdown", async () => {
		antigravityAcpExtension(pi);
		expect(eventHandlers.get(QUOTA_REQUEST_CHANNEL)?.size).toBe(1);

		const shutdowns = lifecycle.get("session_shutdown") ?? [];
		expect(shutdowns).toHaveLength(1);
		await shutdowns[0]!({ reason: "exit" }, ctx);

		expect(eventHandlers.get(QUOTA_REQUEST_CHANNEL)?.size).toBe(0);
	});
});
