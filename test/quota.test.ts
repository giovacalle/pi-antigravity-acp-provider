import { describe, expect, it } from "vitest";
import { quotaExhaustion } from "../src/acp/quota.js";

const now = Date.UTC(2026, 9, 30, 12, 0);
const notice = (reset = "") => `Usage Limit Reached\n\nYou have reached your current quota for this period.${reset}`;

describe("quotaExhaustion", () => {
	it("adds a relative reset to now", () => {
		expect(quotaExhaustion(notice(" Your limit will reset in 4 days, 23 hours."), now))
			.toEqual({ resetAt: new Date(now + 119 * 3_600_000).toISOString() });
		expect(quotaExhaustion(notice(" Your limit will reset in 1 hour."), now))
			.toEqual({ resetAt: new Date(now + 3_600_000).toISOString() });
		expect(quotaExhaustion(notice(" Your limit will reset in 2 minutes, 1 second."), now))
			.toEqual({ resetAt: new Date(now + 121_000).toISOString() });
	});

	it("parses an absolute UTC reset", () => {
		expect(quotaExhaustion(notice(" Your limit will reset on Oct 2, 2026 14:00 UTC."), now))
			.toEqual({ resetAt: "2026-10-02T14:00:00.000Z" });
	});

	it("matches the notice without a reset sentence", () => {
		expect(quotaExhaustion(notice(), now)).toEqual({});
		expect(quotaExhaustion(`\n${notice()}\n`, now)).toEqual({});
	});

	it("ignores other text", () => {
		expect(quotaExhaustion("Hello", now)).toBeUndefined();
		expect(quotaExhaustion("Usage Limit Reached", now)).toBeUndefined();
		expect(quotaExhaustion(`${notice()} Anything else.`, now)).toBeUndefined();
		expect(quotaExhaustion(notice(" Your limit will reset in soon."), now)).toBeUndefined();
	});
});
