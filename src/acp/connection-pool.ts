import type { InitializeResponse } from "@agentclientprotocol/sdk";

import type { AntigravityAcpConnection, AntigravityConnectionHandlers } from "./connection.js";
import { abortError } from "./errors.js";

export interface OpenedConnection {
	connection: AntigravityAcpConnection;
	initialize: InitializeResponse;
}

export interface ConnectionLease extends OpenedConnection {
	/** Route this session's updates and permission requests to `handlers`; returns the unregister call. */
	register(sessionId: string, handlers: AntigravityConnectionHandlers): () => void;
	/** Idempotent. Closes the process only once no lease holds it and it is draining or idle. */
	release(): void;
}

interface PoolEntry {
	key: string;
	opened: Promise<OpenedConnection>;
	connection: AntigravityAcpConnection | undefined;
	leases: number;
	handlers: Map<string, AntigravityConnectionHandlers>;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** Updates and permission requests for a session no lease registered; they are dropped or
	 * cancelled, never delivered to another session. */
	unknownSessionMessages: number;
}

export interface PooledProcessSnapshot {
	pid?: number;
	generation: number;
	/** Live leases. */
	sessions: number;
	/** Session setups started on the process. */
	created: number;
	draining: boolean;
	unknownSessionUpdates: number;
}

/**
 * Shares one initialized ACP connection per pool key between up to `maxSessionsPerProcess` sessions.
 * agy frees a session's memory only when its process exits, so a process that has set up
 * `recycleAfterSessions` sessions drains: it takes no new leases and closes when its last one leaves.
 * Setups are counted when they start, so leases acquired together may overshoot the threshold
 * by up to `maxSessionsPerProcess - 1`.
 */
export class AcpConnectionPool {
	private readonly maxSessionsPerProcess: number;
	private readonly recycleAfterSessions: number;
	private readonly idleTtlMs: number;
	private entries: PoolEntry[] = [];

	/** `idleTtlMs` 0 closes an empty process at once, as a per-session process closes with its session. */
	constructor(options: { maxSessionsPerProcess: number; recycleAfterSessions: number; idleTtlMs: number }) {
		this.maxSessionsPerProcess = options.maxSessionsPerProcess;
		this.recycleAfterSessions = options.recycleAfterSessions;
		this.idleTtlMs = options.idleTtlMs;
	}

	/** `avoid` skips processes the caller cannot use, such as one that abandoned the session it restores. */
	async acquire(
		key: string,
		open: () => Promise<OpenedConnection>,
		signal?: AbortSignal,
		avoid?: (connection: AntigravityAcpConnection) => boolean,
	): Promise<ConnectionLease> {
		if (signal?.aborted) throw abortError();
		// Reserved synchronously so concurrent first acquires share one open().
		const entry = this.entries.find((candidate) => candidate.key === key && candidate.leases < this.maxSessionsPerProcess &&
			(!candidate.connection || (candidate.connection.process.alive && !this.draining(candidate.connection) && !avoid?.(candidate.connection)))) ??
			this.open(key, open);
		entry.leases += 1;
		clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
		let opened: OpenedConnection;
		try {
			opened = await waitUnlessAborted(entry.opened, signal);
		} catch (error) {
			this.leave(entry);
			throw error;
		}
		const registered = new Map<string, AntigravityConnectionHandlers>();
		const unregister = (sessionId: string) => {
			const handlers = registered.get(sessionId);
			registered.delete(sessionId);
			if (handlers && entry.handlers.get(sessionId) === handlers) entry.handlers.delete(sessionId);
		};
		let released = false;
		return {
			...opened,
			register: (sessionId, handlers) => {
				if (released) return () => undefined;
				registered.set(sessionId, handlers);
				entry.handlers.set(sessionId, handlers);
				return () => unregister(sessionId);
			},
			release: () => {
				if (released) return;
				released = true;
				for (const sessionId of [...registered.keys()]) unregister(sessionId);
				this.leave(entry);
			},
		};
	}

	/** Processes still starting are left out. */
	snapshot(): PooledProcessSnapshot[] {
		return this.entries.flatMap(({ connection, leases, unknownSessionMessages }) => {
			if (!connection) return [];
			const pid = connection.process.pid;
			return [{
				...(pid === undefined ? {} : { pid }),
				generation: connection.process.generation,
				sessions: leases,
				created: connection.sessionSetups,
				draining: this.draining(connection),
				unknownSessionUpdates: unknownSessionMessages,
			}];
		});
	}

	/** Forgets every process; the runtime closes the connections themselves. */
	closeAll(): void {
		for (const entry of this.entries) clearTimeout(entry.idleTimer);
		this.entries = [];
	}

	private draining(connection: AntigravityAcpConnection): boolean {
		return connection.sessionSetups >= this.recycleAfterSessions;
	}

	private leave(entry: PoolEntry): void {
		entry.leases -= 1;
		this.closeIfEmpty(entry);
	}

	private closeIfEmpty(entry: PoolEntry): void {
		const connection = entry.connection;
		if (entry.leases > 0 || !connection || !this.entries.includes(entry)) return;
		if (this.draining(connection) || this.idleTtlMs === 0) {
			this.retire(entry, connection);
			return;
		}
		entry.idleTimer = setTimeout(() => this.retire(entry, connection), this.idleTtlMs);
		entry.idleTimer.unref();
	}

	private retire(entry: PoolEntry, connection: AntigravityAcpConnection): void {
		clearTimeout(entry.idleTimer);
		this.entries = this.entries.filter((candidate) => candidate !== entry);
		void connection.close().catch(() => undefined);
	}

	private open(key: string, open: () => Promise<OpenedConnection>): PoolEntry {
		const remove = () => { this.entries = this.entries.filter((candidate) => candidate !== entry); };
		const opened = open().then((opened) => {
			entry.connection = opened.connection;
			opened.connection.setHandlers({
				onUpdate: (notification) => {
					const handlers = entry.handlers.get(notification.sessionId);
					if (handlers) return handlers.onUpdate?.(notification);
					entry.unknownSessionMessages += 1;
				},
				onPermission: (request) => {
					const handlers = entry.handlers.get(request.sessionId);
					if (handlers?.onPermission) return handlers.onPermission(request);
					if (!handlers) entry.unknownSessionMessages += 1;
					return Promise.resolve({ outcome: { outcome: "cancelled" } });
				},
			});
			void opened.connection.process.exited.then(remove, remove);
			// Every waiter may have aborted while the process started.
			this.closeIfEmpty(entry);
			return opened;
		}, (error: unknown) => {
			remove();
			throw error;
		});
		const entry: PoolEntry = { key, opened, connection: undefined, leases: 0, handlers: new Map(), idleTimer: undefined, unknownSessionMessages: 0 };
		this.entries.push(entry);
		return entry;
	}
}

/** Rejects this caller on abort without cancelling `promise`, which other callers may share. */
export function waitUnlessAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
