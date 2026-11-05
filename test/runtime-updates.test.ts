import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	latestManifestRelease,
	readBundledRuntimeManifest,
	RUNTIME_MANIFEST_URL,
} from "../src/acp/runtime-manifest.js";
import {
	checkAntigravityAcpUpdate,
	platformKey,
	updateAntigravityAcpRuntime,
} from "../src/acp/setup.js";

const manifest = readBundledRuntimeManifest();
const approved = latestManifestRelease(manifest);
const platform = platformKey();
const asset = approved.platforms[platform]!;
const pendingVersion = "999.0.0";
const pendingArchive = "https://dl.google.com/agy-extensions/releases/pending-999.0.0.zip";
let home: string;
let root: string;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
	home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acp-runtime-updates-")));
	root = path.join(home, ".local", "opt", "agy-acp");
	vi.spyOn(os, "homedir").mockReturnValue(home);
	vi.stubEnv("HOME", home);
	vi.stubEnv("GEMINI_HOME", path.join(home, ".gemini"));
	vi.stubEnv("AGY_ACP_BIN", "");
	vi.stubEnv("PATH", "");
	fetchMock = vi.fn<typeof fetch>(async (url) => {
		if (url === RUNTIME_MANIFEST_URL) return Response.json(manifest);
		if (String(url).endsWith("/antigravity-acp/agent.json")) {
			return Response.json({
				version: pendingVersion,
				distribution: { binary: { [platform]: { archive: pendingArchive } } },
			});
		}
		if (url === asset.archive) return new Response("corrupt archive");
		throw new Error(`Unexpected download: ${String(url)}`);
	});
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	fs.rmSync(home, { recursive: true, force: true });
});

// Real signed metadata and installer paths, but no network or executable launches.
// Sparse files model an already verified release without allocating large payloads.
function seedRelease(directory: string, version = approved.version): string {
	fs.mkdirSync(directory, { recursive: true });
	for (const [name, bytes] of [[asset.binaryName, asset.binaryBytes], [asset.harnessName, asset.harnessBytes]] as const) {
		const file = path.join(directory, name);
		fs.closeSync(fs.openSync(file, "w", 0o755));
		fs.truncateSync(file, bytes);
	}
	fs.writeFileSync(path.join(directory, "install-integrity.json"), JSON.stringify({
		archive: asset.archive,
		archiveSha256: version === approved.version ? asset.archiveSha256 : "a".repeat(64),
		archiveBytes: asset.archiveBytes,
		binaryName: asset.binaryName,
		binaryBytes: asset.binaryBytes,
		harnessName: asset.harnessName,
		harnessBytes: asset.harnessBytes,
		version,
		platform,
		installedAt: new Date().toISOString(),
	}));
	return path.join(directory, asset.binaryName);
}

function archiveRequests(): string[] {
	return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("https://dl.google.com/"));
}

describe("explicit updates during signed catalog lag", () => {
	it("reports pending approval separately from an installable approved release", async () => {
		await expect(checkAntigravityAcpUpdate(true)).resolves.toMatchObject({
			latestVersion: pendingVersion,
			approvedVersion: approved.version,
			approvalPending: true,
			updateAvailable: true,
			managed: true,
		});
		expect(archiveRequests()).toEqual([]);
	});

	it.each([undefined, "1.0.0"])("activates an approved cached release with installed version %s", async (installedVersion) => {
		if (installedVersion) seedRelease(path.join(root, "current"), installedVersion);
		const binary = seedRelease(path.join(root, "versions", asset.archiveSha256));
		const progress = vi.fn();

		await expect(updateAntigravityAcpRuntime(progress)).resolves.toEqual({
			version: approved.version, changed: true, binary,
		});

		expect(progress).toHaveBeenCalledWith(expect.stringContaining(
			`${pendingVersion} is awaiting a signed runtime manifest; using approved release ${approved.version}`,
		));
		expect(fs.realpathSync(path.join(root, "current"))).toBe(path.dirname(binary));
		expect(archiveRequests()).toEqual([]);
	});

	it.each([approved.version, "998.0.0"])("retains an installed runtime at %s without downgrading", async (version) => {
		const binary = seedRelease(path.join(root, "current"), version);
		const before = JSON.parse(fs.readFileSync(path.join(root, "current", "install-integrity.json"), "utf8"));

		await expect(updateAntigravityAcpRuntime()).resolves.toEqual({ version, changed: false, binary });

		expect(JSON.parse(fs.readFileSync(path.join(root, "current", "install-integrity.json"), "utf8"))).toEqual(before);
		expect(archiveRequests()).toEqual([]);
	});

	it.each([undefined, "1.0.0"])("enforces signed download size without replacing installed version %s", async (installedVersion) => {
		const recordPath = path.join(root, "current", "install-integrity.json");
		if (installedVersion) seedRelease(path.join(root, "current"), installedVersion);
		const before = installedVersion ? fs.readFileSync(recordPath, "utf8") : undefined;

		await expect(updateAntigravityAcpRuntime()).rejects.toThrow("download size did not match its signed manifest");

		expect(archiveRequests()).toEqual([asset.archive]);
		if (before) expect(fs.readFileSync(recordPath, "utf8")).toBe(before);
		else expect(fs.existsSync(path.join(root, "current"))).toBe(false);
		expect(fs.readdirSync(path.join(root, "versions"))).toEqual([]);
	});

	it("rejects tampered remote metadata and falls back only to the signed bundled catalog", async () => {
		const tampered = structuredClone(manifest);
		latestManifestRelease(tampered).platforms[platform]!.archiveSha256 = "0".repeat(64);
		fetchMock.mockImplementationOnce(async () => Response.json(tampered));

		await expect(updateAntigravityAcpRuntime()).rejects.toThrow("download size did not match its signed manifest");
		expect(archiveRequests()).toEqual([asset.archive]);
		expect(fs.existsSync(path.join(root, "runtime-manifest-cache.json"))).toBe(false);
		expect(fs.existsSync(path.join(root, "current"))).toBe(false);
	});
});
