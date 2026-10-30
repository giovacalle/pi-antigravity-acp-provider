import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseUsageQuota } from "../src/acp/usage-quota.js";

const reply = fs.readFileSync(new URL("./fixtures/usage-reply.md", import.meta.url), "utf8");
const now = 1_800_000_000_000;
const unavailable = (line: string) =>
	`### Session Usage\n- **Session total:** data not available yet\n\n### Quota Limits\n${line}`;

describe("parseUsageQuota", () => {
	it("reads every group from the server's /usage reply", () => {
		expect(parseUsageQuota(reply, now)).toEqual({
			at: now,
			groups: [
				{
					displayName: "Gemini Models",
					buckets: [
						{ window: "weekly", remainingFraction: 0.81, resetTime: "2026-10-30T22:21:00.000Z" },
						{ window: "5h", remainingFraction: 0.98, resetTime: "2026-10-30T04:10:00.000Z" },
					],
				},
				{
					displayName: "Claude and GPT models",
					buckets: [
						{ window: "weekly", remainingFraction: 0.98, resetTime: "2026-11-04T13:43:00.000Z" },
						{ window: "5h", remainingFraction: 1, resetTime: "2026-10-30T06:54:00.000Z" },
					],
				},
				{
					displayName: "Gemini 4 Argon",
					buckets: [{ window: "weekly", remainingFraction: 0, resetTime: "2026-11-03T09:13:00.000Z" }],
				},
			],
		});
	});

	it("keeps a group without active limits and buckets without a reset", () => {
		const text = unavailable(
			"- **Gemini Models**\n  - **Daily Cap:** 50% remaining\n- **Other**\n  - No active bucket limits",
		);
		expect(parseUsageQuota(text, now)).toEqual({
			at: now,
			groups: [
				{ displayName: "Gemini Models", buckets: [{ window: "Daily Cap", remainingFraction: 0.5 }] },
				{ displayName: "Other", buckets: [] },
			],
		});
	});

	it("rejects replies without quota groups", () => {
		expect(() => parseUsageQuota(unavailable("- Unable to retrieve quota status (backend unavailable)"), now))
			.toThrow("Unable to retrieve quota status (backend unavailable)");
		expect(() => parseUsageQuota(unavailable("- Not applicable for current authentication method."), now))
			.toThrow("Not applicable for current authentication method.");
		expect(() => parseUsageQuota("Hello", now)).toThrow("no quota groups");
	});
});
