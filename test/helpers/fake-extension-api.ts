import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

// Shared across API instances: like pi's native provider registry, the last registration wins.
export type FakeProviderRegistry = Map<string, Provider>;

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

export interface FakeExtensionApi {
	api: ExtensionAPI;
	providers: Provider[];
	tools: Map<string, Tool>;
	commands: Map<string, Command>;
	handlers: Map<string, Handler[]>;
	emit(type: string, payload: object, ctx: FakeContext): Promise<void>;
}

export function createFakeExtensionApi(registry: FakeProviderRegistry): FakeExtensionApi {
	const providers: Provider[] = [];
	const tools = new Map<string, Tool>();
	const commands = new Map<string, Command>();
	const handlers = new Map<string, Handler[]>();
	const api = {
		registerProvider(provider: Provider) {
			providers.push(provider);
			registry.set(provider.id, provider);
		},
		registerTool(tool: Tool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		on(type: string, handler: Handler) {
			handlers.set(type, [...(handlers.get(type) ?? []), handler]);
			return () => handlers.set(type, (handlers.get(type) ?? []).filter((item) => item !== handler));
		},
	};
	return {
		api: api as unknown as ExtensionAPI,
		providers,
		tools,
		commands,
		handlers,
		async emit(type, payload, ctx) {
			for (const handler of handlers.get(type) ?? []) await handler({ type, ...payload }, ctx);
		},
	};
}

export interface FakeContext {
	cwd: string;
	hasUI: true;
	sessionManager: { getSessionId(): string };
	ui: { select: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
}

export function createFakeContext(options: { sessionId: string; cwd?: string; selectAnswer?: (labels: string[]) => string | undefined }): FakeContext {
	return {
		cwd: options.cwd ?? process.cwd(),
		hasUI: true,
		sessionManager: { getSessionId: () => options.sessionId },
		ui: {
			select: vi.fn(async (_title: string, labels: string[]) => options.selectAnswer?.(labels)),
			notify: vi.fn(),
		},
	};
}
