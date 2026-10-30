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
	/** Idempotent. Never closes the process, which other leases may share. */
	release(): void;
}

interface PoolEntry {
	key: string;
	opened: Promise<OpenedConnection>;
	connection: AntigravityAcpConnection | undefined;
	leases: number;
	handlers: Map<string, AntigravityConnectionHandlers>;
}

/** Shares one initialized ACP connection per pool key between up to `maxSessionsPerProcess` sessions. */
export class AcpConnectionPool {
	/** Updates and permission requests for a session no lease registered; they are dropped or
	 * cancelled, never delivered to another session. */
	unknownSessionMessages = 0;
	private readonly maxSessionsPerProcess: number;
	private entries: PoolEntry[] = [];

	constructor(options: { maxSessionsPerProcess: number }) {
		this.maxSessionsPerProcess = options.maxSessionsPerProcess;
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
			(!candidate.connection || (candidate.connection.process.alive && !avoid?.(candidate.connection)))) ?? this.open(key, open);
		entry.leases += 1;
		let opened: OpenedConnection;
		try {
			opened = await waitUnlessAborted(entry.opened, signal);
		} catch (error) {
			entry.leases -= 1;
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
				entry.leases -= 1;
				for (const sessionId of [...registered.keys()]) unregister(sessionId);
			},
		};
	}

	/** Forgets every process; the runtime closes the connections themselves. */
	closeAll(): void {
		this.entries = [];
	}

	private open(key: string, open: () => Promise<OpenedConnection>): PoolEntry {
		const remove = () => { this.entries = this.entries.filter((candidate) => candidate !== entry); };
		const opened = open().then((opened) => {
			entry.connection = opened.connection;
			opened.connection.setHandlers({
				onUpdate: (notification) => {
					const handlers = entry.handlers.get(notification.sessionId);
					if (handlers) return handlers.onUpdate?.(notification);
					this.unknownSessionMessages += 1;
				},
				onPermission: (request) => {
					const handlers = entry.handlers.get(request.sessionId);
					if (handlers?.onPermission) return handlers.onPermission(request);
					if (!handlers) this.unknownSessionMessages += 1;
					return Promise.resolve({ outcome: { outcome: "cancelled" } });
				},
			});
			void opened.connection.process.exited.then(remove, remove);
			return opened;
		}, (error: unknown) => {
			remove();
			throw error;
		});
		const entry: PoolEntry = { key, opened, connection: undefined, leases: 0, handlers: new Map() };
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
