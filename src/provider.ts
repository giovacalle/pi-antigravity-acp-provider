import type {
	ApiStreamOptions,
	AssistantMessageEventStream,
	TranscriptContext,
	Model,
	Provider,
	RefreshModelsContext,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { AntigravityAcpError } from "./acp/errors.js";
import { hasSavedGoogleLogin, isGoogleLoginMarker, newGoogleLoginMarker } from "./auth.js";
import { FALLBACK_MODELS, modelForAcpStream, projectModels, PROVIDER_ID, restoreModels } from "./models.js";
import { AntigravityRuntime } from "./runtime.js";

// A stored catalog younger than this is reused without launching agy.
const CATALOG_FRESH_MS = 24 * 60 * 60_000;

export interface AntigravityProviderBundle {
	provider: Provider<"antigravity-acp">;
	runtime: AntigravityRuntime;
}

export function createAntigravityProvider(runtime = new AntigravityRuntime()): AntigravityProviderBundle {
	let models = [...FALLBACK_MODELS];
	const provider: Provider<"antigravity-acp"> = {
		id: PROVIDER_ID,
		name: "Google Antigravity (ACP)",
		auth: {
			oauth: {
				name: "Google Antigravity (ACP)",
				loginLabel: "Sign in with Google",
				async login(interaction) {
					interaction.notify({ type: "progress", message: "Starting Antigravity Google login…" });
					await runtime.loginGoogle(
						interaction.signal,
						(message) => interaction.notify({ type: "progress", message }),
						{
							showAuthorizationUrl(url, instructions) {
								interaction.notify({
									type: "info",
									message: instructions,
									links: [{ url, label: "Google authorization" }],
								});
							},
							promptForCallback: (signal) =>
								interaction.prompt({
									type: "manual_code",
									message: "Paste the final localhost callback URL (or authorization code):",
									placeholder: "http://127.0.0.1:PORT/?state=…&code=…",
									signal,
								}),
						},
					);
					const marker = newGoogleLoginMarker();
					return {
						type: "oauth",
						// The marker identifies the login without copying Google's tokens into Pi's auth store.
						refresh: marker,
						access: marker,
						expires: Number.MAX_SAFE_INTEGER,
					};
				},
				async refresh(credential) {
					return credential;
				},
				async toAuth(credential) {
					return { apiKey: savedGoogleLogin(credential.access) };
				},
			},
			apiKey: {
				name: "Antigravity Gemini API key",
				async login(interaction) {
					const key = await interaction.prompt({
						type: "secret",
						message: "Gemini API key",
						placeholder: "AIza…",
					});
					if (!key.trim()) throw new Error("Gemini API key is required");
					interaction.notify({ type: "progress", message: "Verifying Gemini API key…" });
					await runtime.verifyApiKey(key.trim(), interaction.signal, (message) =>
						interaction.notify({ type: "progress", message }),
					);
					return { type: "api_key", key: key.trim() };
				},
				async check({ ctx, credential }) {
					if (credential?.key) return { type: "api_key", source: "Pi auth store" };
					if (await ctx.env("GEMINI_API_KEY")) return { type: "api_key", source: "GEMINI_API_KEY" };
					return undefined;
				},
				async resolve({ ctx, credential }) {
					const key = credential?.key ?? (await ctx.env("GEMINI_API_KEY"));
					if (key) {
						return {
							auth: { apiKey: key },
							source: credential?.key ? "Pi auth store" : "GEMINI_API_KEY",
						};
					}
					return undefined;
				},
			},
		},
		getModels: () => models,
		async refreshModels(context: RefreshModelsContext) {
			// Publish the last discovered catalog first, so models outside the offline
			// fallback stay selectable while startup model patterns resolve.
			const restored = restoreModels(context.stored?.models ?? []);
			if (restored.length > 0) {
				const published = await context.publish({
					update: () => {
						models = restored;
					},
				});
				if (!published) return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			// A catalog discovered in the last day is reused without launching agy.
			if (restored.length > 0 && !context.force && fresh(context.stored?.checkedAt)) return;
			let discovered;
			try {
				const key =
					context.credential?.type === "oauth"
						? savedGoogleLogin(context.credential.access)
						: context.credential?.type === "api_key"
							? context.credential.key
							: process.env.GEMINI_API_KEY?.trim();
				if (!key) return;
				discovered = projectModels(await runtime.discoverModels(key, context.signal));
			} catch (error) {
				// Startup refresh must not hide the restored or offline catalog when
				// authentication is absent, expired, or temporarily unavailable. A
				// forced refresh reports the failure; the catalog stays in place.
				if (context.force) throw error;
				return;
			}
			if (discovered.length === 0) return;
			await context.publish({
				persist: { models: discovered, checkedAt: Date.now() },
				update: () => {
					models = discovered;
				},
			});
		},
		stream(model, context, options) {
			return stream(runtime, modelForAcpStream(model, models), context, options);
		},
		streamSimple(model, context, options) {
			return stream(runtime, modelForAcpStream(model, models), context, options);
		},
	};
	return { provider, runtime };
}

function savedGoogleLogin(marker: string): string {
	if (!isGoogleLoginMarker(marker) || !hasSavedGoogleLogin()) {
		throw new AntigravityAcpError("auth", "No saved Google login for this Pi profile. Run /login antigravity-acp.");
	}
	return marker;
}

function fresh(checkedAt: number | undefined): boolean {
	if (typeof checkedAt !== "number") return false;
	const age = Date.now() - checkedAt;
	return age >= 0 && age < CATALOG_FRESH_MS;
}

function stream(
	runtime: AntigravityRuntime,
	model: Model<"antigravity-acp">,
	context: TranscriptContext,
	options: ApiStreamOptions<"antigravity-acp"> | SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
	return runtime.stream(model, context, options as SimpleStreamOptions | undefined).stream;
}
