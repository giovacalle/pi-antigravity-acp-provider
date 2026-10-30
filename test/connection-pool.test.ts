import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AcpConnectionPool } from "../src/acp/connection-pool.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const connections: AntigravityAcpConnection[] = [];
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(connections.splice(0).map((connection) => connection.close()));
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function opener() {
	const opened: AntigravityAcpConnection[] = [];
	const open = async () => {
		const connection = new AntigravityAcpConnection({ cwd: process.cwd(), command: process.execPath, args: [fakeAgent], sessionScopedFaults: true });
		connections.push(connection);
		opened.push(connection);
		return { connection, initialize: await connection.initialize() };
	};
	return { open, opened };
}

function tmp(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-pool-")); roots.push(root);
	return root;
}

describe("AcpConnectionPool", () => {
	it("shares one open between concurrent acquires of a key", async () => {
		const pool = new AcpConnectionPool({ maxSessionsPerProcess: 4 });
		const { open, opened } = opener();

		const leases = await Promise.all([pool.acquire("managed", open), pool.acquire("managed", open), pool.acquire("key:other", open)]);

		expect(opened).toHaveLength(2);
		expect(leases[0]!.connection).toBe(leases[1]!.connection);
		expect(leases[2]!.connection).not.toBe(leases[0]!.connection);
	});

	it("drops and counts updates and permission requests for a session no lease registered", async () => {
		const pool = new AcpConnectionPool({ maxSessionsPerProcess: 4 });
		const lease = await pool.acquire("managed", opener().open);
		const owned = await lease.connection.newSession(tmp());
		const stray = await lease.connection.newSession(tmp());
		const received: SessionNotification[] = [];
		lease.register(owned.sessionId, { onUpdate: (notification) => { received.push(notification); } });
		// A restore that fell back to a new session gives its registration up.
		lease.register(stray.sessionId, { onUpdate: (notification) => { received.push(notification); } })();

		await lease.connection.prompt({ sessionId: stray.sessionId, prompt: [{ type: "text", text: "hello" }] });
		const decision = await lease.connection.prompt({ sessionId: stray.sessionId, prompt: [{ type: "text", text: "permission" }] });

		expect(received).toEqual([]);
		// Two updates for "hello", then the permission request and its decision update.
		expect(pool.unknownSessionMessages).toBe(4);
		expect(decision.stopReason).toBe("end_turn");
	});

	it("rejects only an aborted waiter and keeps the shared open", async () => {
		const pool = new AcpConnectionPool({ maxSessionsPerProcess: 4 });
		const { open, opened } = opener();
		const controller = new AbortController();
		const aborted = pool.acquire("managed", open, controller.signal);
		const kept = pool.acquire("managed", open);

		controller.abort();

		await expect(aborted).rejects.toThrow("aborted");
		expect((await kept).connection.process.alive).toBe(true);
		expect(opened).toHaveLength(1);
	});

	it("rejects every waiter when the open fails and opens afresh next time", async () => {
		const pool = new AcpConnectionPool({ maxSessionsPerProcess: 4 });
		const { open, opened } = opener();
		const failing = () => Promise.reject(new Error("spawn failed"));

		const results = await Promise.allSettled([pool.acquire("managed", failing), pool.acquire("managed", failing)]);

		expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
		await pool.acquire("managed", open);
		expect(opened).toHaveLength(1);
	});

	it("opens a new process past the session limit or after the shared one exits", async () => {
		const pool = new AcpConnectionPool({ maxSessionsPerProcess: 1 });
		const { open, opened } = opener();
		const first = await pool.acquire("managed", open);
		await pool.acquire("managed", open);
		expect(opened).toHaveLength(2);

		first.release();
		first.release();
		expect((await pool.acquire("managed", open)).connection).toBe(first.connection);

		await first.connection.close();
		await pool.acquire("managed", open);
		expect(opened).toHaveLength(3);
	});
});
