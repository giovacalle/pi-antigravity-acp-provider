import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

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
		const pool = new AcpConnectionPool({ maxSessionsPerProcess: 4, recycleAfterSessions: 6, idleTtlMs: 60_000 });
		const { open, opened } = opener();

		const leases = await Promise.all([pool.acquire("managed", open), pool.acquire("managed", open), pool.acquire("key:other", open)]);

		expect(opened).toHaveLength(2);
		expect(leases[0]!.connection).toBe(leases[1]!.connection);
		expect(leases[2]!.connection).not.toBe(leases[0]!.connection);
	});

	it("drops and counts updates and permission requests for a session no lease registered", async () => {
		const pool = new AcpConnectionPool({ maxSessionsPerProcess: 4, recycleAfterSessions: 6, idleTtlMs: 60_000 });
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
		const pool = new AcpConnectionPool({ maxSessionsPerProcess: 4, recycleAfterSessions: 6, idleTtlMs: 60_000 });
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
		const pool = new AcpConnectionPool({ maxSessionsPerProcess: 4, recycleAfterSessions: 6, idleTtlMs: 60_000 });
		const { open, opened } = opener();
		const failing = () => Promise.reject(new Error("spawn failed"));

		const results = await Promise.allSettled([pool.acquire("managed", failing), pool.acquire("managed", failing)]);

		expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
		await pool.acquire("managed", open);
		expect(opened).toHaveLength(1);
	});

	it("opens a new process past the session limit or after the shared one exits", async () => {
		const pool = new AcpConnectionPool({ maxSessionsPerProcess: 1, recycleAfterSessions: 6, idleTtlMs: 60_000 });
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

	it("drains a process after the recycle threshold and closes it when its last lease leaves", async () => {
		const pool = new AcpConnectionPool({ maxSessionsPerProcess: 4, recycleAfterSessions: 2, idleTtlMs: 60_000 });
		const { open, opened } = opener();
		const leases = [];
		for (let i = 0; i < 3; i += 1) {
			const lease = await pool.acquire("managed", open);
			await lease.connection.newSession(tmp());
			leases.push(lease);
		}
		expect(opened).toHaveLength(2);
		expect(leases[1]!.connection).toBe(leases[0]!.connection);

		leases[0]!.release();
		expect(opened[0]!.process.alive).toBe(true);
		leases[1]!.release();

		await opened[0]!.process.exited;
		expect(opened[1]!.process.alive).toBe(true);
	});

	it("closes an empty process after the idle TTL unless it is acquired again", async () => {
		const pool = new AcpConnectionPool({ maxSessionsPerProcess: 4, recycleAfterSessions: 6, idleTtlMs: 200 });
		const { open, opened } = opener();
		const first = await pool.acquire("managed", open);
		first.release();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const again = await pool.acquire("managed", open);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(again.connection.process.alive).toBe(true);

		const started = Date.now();
		again.release();

		await opened[0]!.process.exited;
		expect(Date.now() - started).toBeGreaterThanOrEqual(150);
		expect(opened).toHaveLength(1);
	});

	it("closes an empty process at once when the idle TTL is disabled", async () => {
		const pool = new AcpConnectionPool({ maxSessionsPerProcess: 4, recycleAfterSessions: 6, idleTtlMs: 0 });
		const { open, opened } = opener();
		(await pool.acquire("managed", open)).release();

		await opened[0]!.process.exited;
		await pool.acquire("managed", open);
		expect(opened).toHaveLength(2);
	});

	it("counts resumed sessions toward the recycle threshold", async () => {
		const pool = new AcpConnectionPool({ maxSessionsPerProcess: 4, recycleAfterSessions: 2, idleTtlMs: 60_000 });
		const { open, opened } = opener();
		const lease = await pool.acquire("managed", open);
		const cwd = tmp();
		const session = await lease.connection.newSession(cwd);
		await lease.connection.resumeSession(session.sessionId, cwd);

		await pool.acquire("managed", open);

		expect(opened).toHaveLength(2);
	});

	it("closes a process after the idle TTL when its only waiter aborted during the open", async () => {
		const pool = new AcpConnectionPool({ maxSessionsPerProcess: 4, recycleAfterSessions: 6, idleTtlMs: 200 });
		const { open, opened } = opener();
		const controller = new AbortController();
		const aborted = pool.acquire("managed", open, controller.signal);
		controller.abort();
		await expect(aborted).rejects.toThrow("aborted");

		await vi.waitFor(() => expect(opened).toHaveLength(1));
		await opened[0]!.process.exited;
	});
});
