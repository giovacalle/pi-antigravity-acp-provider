import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	DEFAULT_CONFIG_PATH,
	LEGACY_GEMINI_CONFIG_PATH,
	loadConfig,
	resolveConfigPath,
	resolveConfigRoot,
	resolvePiAgentDir,
	savePermissionMode,
	saveRuntimeUpdateMode,
	saveToolActivityMode,
	isToolActivityMode,
} from "../src/config.js";

const directories: string[] = [];
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	vi.restoreAllMocks();
	if (originalPiCodingAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
	}
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("permission configuration", () => {
	it("defaults to yolo and persists an explicit safer mode", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-config-"));
		directories.push(directory);
		const file = path.join(directory, "nested", "config.json");
		expect(loadConfig(file)).toEqual({ permissions: "yolo", runtimeUpdates: "automatic", toolActivity: "compact", nativeWorkflows: false, nativeTools: "all" });
		saveRuntimeUpdateMode("notify", file);
		savePermissionMode("auto_edit", file);
		saveToolActivityMode("off", file);
		expect(loadConfig(file)).toEqual({ permissions: "auto_edit", runtimeUpdates: "notify", toolActivity: "off", nativeWorkflows: false, nativeTools: "all" });
	});

	it("requires an explicit native workflow opt-in and preserves it when saving other settings", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-workflows-"));
		directories.push(directory);
		const file = path.join(directory, "config.json");
		for (const value of [undefined, false, "true", 1, null]) {
			fs.writeFileSync(file, JSON.stringify({ nativeWorkflows: value }));
			expect(loadConfig(file).nativeWorkflows).toBe(false);
		}
		fs.writeFileSync(file, JSON.stringify({ nativeWorkflows: true }));
		savePermissionMode("default", file);
		saveRuntimeUpdateMode("manual", file);
		saveToolActivityMode("off", file);
		expect(loadConfig(file).nativeWorkflows).toBe(true);
	});

	it("validates and persists toolActivity modes while defaulting invalid values to compact", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-tool-activity-"));
		directories.push(directory);
		const file = path.join(directory, "config.json");

		expect(isToolActivityMode("off")).toBe(true);
		expect(isToolActivityMode("compact")).toBe(true);
		expect(isToolActivityMode("full")).toBe(true);
		expect(isToolActivityMode("verbose")).toBe(false);

		fs.writeFileSync(file, JSON.stringify({ permissions: "yolo", runtimeUpdates: "automatic", toolActivity: "bogus" }));
		expect(loadConfig(file).toolActivity).toBe("compact");

		saveToolActivityMode("full", file);
		expect(loadConfig(file).toolActivity).toBe("full");
		saveToolActivityMode("compact", file);
		expect(loadConfig(file).toolActivity).toBe("compact");
	});

	it("resolves default agent directory and config paths when PI_CODING_AGENT_DIR is unset", () => {
		delete process.env.PI_CODING_AGENT_DIR;
		const defaultAgentDir = path.join(os.homedir(), ".pi", "agent");
		expect(resolvePiAgentDir()).toBe(defaultAgentDir);
		expect(resolveConfigRoot()).toBe(path.join(defaultAgentDir, "antigravity-acp-provider"));
		expect(resolveConfigPath()).toBe(path.join(defaultAgentDir, "antigravity-acp-provider", "config.json"));
		expect(DEFAULT_CONFIG_PATH).toBe(path.join(defaultAgentDir, "antigravity-acp-provider", "config.json"));
		expect(LEGACY_GEMINI_CONFIG_PATH).toBe(path.join(defaultAgentDir, "gemini-acp-provider", "config.json"));
	});

	it("respects PI_CODING_AGENT_DIR environment variable", () => {
		// Never inherit a developer's real permission configuration in this test.
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-home-"));
		directories.push(fakeHome);
		vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
		const customAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-agent-"));
		directories.push(customAgentDir);
		process.env.PI_CODING_AGENT_DIR = customAgentDir;

		expect(resolvePiAgentDir()).toBe(customAgentDir);
		expect(resolveConfigRoot()).toBe(path.join(customAgentDir, "antigravity-acp-provider"));
		expect(resolveConfigPath()).toBe(path.join(customAgentDir, "antigravity-acp-provider", "config.json"));

		expect(loadConfig()).toEqual({ permissions: "yolo", runtimeUpdates: "automatic", toolActivity: "compact", nativeWorkflows: false, nativeTools: "all" });
		savePermissionMode("default");
		expect(loadConfig()).toEqual({ permissions: "default", runtimeUpdates: "automatic", toolActivity: "compact", nativeWorkflows: false, nativeTools: "all" });

		const configFile = path.join(customAgentDir, "antigravity-acp-provider", "config.json");
		expect(fs.existsSync(configFile)).toBe(true);
	});

	it("expands tilde in PI_CODING_AGENT_DIR", () => {
		process.env.PI_CODING_AGENT_DIR = "~/test-agent-dir";
		expect(resolvePiAgentDir()).toBe(path.join(os.homedir(), "test-agent-dir"));

		process.env.PI_CODING_AGENT_DIR = "~";
		expect(resolvePiAgentDir()).toBe(os.homedir());
	});

	it("falls back to default when PI_CODING_AGENT_DIR is empty or whitespace", () => {
		const defaultAgentDir = path.join(os.homedir(), ".pi", "agent");

		process.env.PI_CODING_AGENT_DIR = "";
		expect(resolvePiAgentDir()).toBe(defaultAgentDir);

		process.env.PI_CODING_AGENT_DIR = "   ";
		expect(resolvePiAgentDir()).toBe(defaultAgentDir);
	});

	it("migrates legacy gemini-acp-provider configuration from default agent directory", () => {
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fake-gemini-home-"));
		directories.push(fakeHome);
		vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
		delete process.env.PI_CODING_AGENT_DIR;

		const legacyDir = path.join(fakeHome, ".pi", "agent", "gemini-acp-provider");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(
			path.join(legacyDir, "config.json"),
			JSON.stringify({ permissions: "auto_edit", runtimeUpdates: "manual" }),
		);

		expect(loadConfig()).toEqual({ permissions: "auto_edit", runtimeUpdates: "manual", toolActivity: "compact", nativeWorkflows: false, nativeTools: "all" });
		const targetFile = path.join(fakeHome, ".pi", "agent", "antigravity-acp-provider", "config.json");
		expect(fs.existsSync(targetFile)).toBe(true);
	});

	it("migrates configuration from default Pi agent directory when PI_CODING_AGENT_DIR is custom", () => {
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fake-home-"));
		directories.push(fakeHome);
		vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

		const defaultAntigravityDir = path.join(fakeHome, ".pi", "agent", "antigravity-acp-provider");
		fs.mkdirSync(defaultAntigravityDir, { recursive: true });
		fs.writeFileSync(
			path.join(defaultAntigravityDir, "config.json"),
			JSON.stringify({ permissions: "auto_edit", runtimeUpdates: "notify" }),
		);

		const customAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-agent-migrate-"));
		directories.push(customAgentDir);
		process.env.PI_CODING_AGENT_DIR = customAgentDir;

		expect(loadConfig()).toEqual({ permissions: "auto_edit", runtimeUpdates: "notify", toolActivity: "compact", nativeWorkflows: false, nativeTools: "all" });
		const targetFile = path.join(customAgentDir, "antigravity-acp-provider", "config.json");
		expect(fs.existsSync(targetFile)).toBe(true);
		expect(fs.readFileSync(path.join(defaultAntigravityDir, "config.json"), "utf8")).toBe(
			JSON.stringify({ permissions: "auto_edit", runtimeUpdates: "notify" }),
		);
		if (process.platform !== "win32") expect(fs.statSync(targetFile).mode & 0o777).toBe(0o600);
	});

	it("reads the native tool filter, where invalid values allow all native tools", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-config-"));
		directories.push(directory);
		const file = path.join(directory, "config.json");
		expect(loadConfig(file).nativeTools).toBe("all");
		fs.writeFileSync(file, JSON.stringify({ nativeTools: "none" }));
		expect(loadConfig(file).nativeTools).toBe("none");
		fs.writeFileSync(file, JSON.stringify({ nativeTools: ["run_command"] }));
		expect(loadConfig(file).nativeTools).toEqual(["run_command"]);
		saveRuntimeUpdateMode("manual", file);
		expect(loadConfig(file).nativeTools).toEqual(["run_command"]);
		for (const invalid of ["some", [1], [""], {}]) {
			fs.writeFileSync(file, JSON.stringify({ nativeTools: invalid }));
			expect(loadConfig(file).nativeTools).toBe("all");
		}
	});

	it("does not overwrite an existing custom profile or copy saved sessions", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-migration-"));
		directories.push(root);
		vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "home"));
		const source = path.join(root, "home", ".pi", "agent", "antigravity-acp-provider");
		fs.mkdirSync(source, { recursive: true });
		fs.writeFileSync(path.join(source, "config.json"), JSON.stringify({ permissions: "yolo", runtimeUpdates: "automatic" }));
		fs.writeFileSync(path.join(source, "sessions.json"), "[]");
		process.env.PI_CODING_AGENT_DIR = path.join(root, "custom");
		const target = resolveConfigPath();
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const existing = JSON.stringify({ permissions: "default", runtimeUpdates: "manual" });
		fs.writeFileSync(target, existing);
		expect(loadConfig()).toEqual({ permissions: "default", runtimeUpdates: "manual", toolActivity: "compact", nativeWorkflows: false, nativeTools: "all" });
		expect(fs.readFileSync(target, "utf8")).toBe(existing);
		fs.unlinkSync(target);
		expect(loadConfig()).toEqual({ permissions: "yolo", runtimeUpdates: "automatic", toolActivity: "compact", nativeWorkflows: false, nativeTools: "all" });
		expect(fs.existsSync(path.join(path.dirname(target), "sessions.json"))).toBe(false);
		expect(fs.existsSync(path.join(source, "sessions.json"))).toBe(true);
	});
});
