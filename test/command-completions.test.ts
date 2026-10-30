import { describe, expect, it } from "vitest";

import { completeAntigravityArguments } from "../extensions/command-completions.js";
import { isPermissionMode, isRuntimeUpdateMode, isToolActivityMode } from "../src/config.js";

describe("Antigravity command argument completion", () => {
	it("suggests canonical commands with descriptions, not redundant aliases", () => {
		const items = completeAntigravityArguments("")!;
		expect(items.map(({ value }) => value)).toEqual([
			"setup", "doctor", "quota", "models", "update", "updates", "logout", "permissions", "tool-activity",
		]);
		expect(items.every((item) => "description" in item && item.description)).toBe(true);
	});

	it("filters partial commands and normalizes leading whitespace", () => {
		expect(completeAntigravityArguments("up")?.map(({ value }) => value)).toEqual(["update", "updates"]);
		expect(completeAntigravityArguments("  quo")?.map(({ value }) => value)).toEqual(["quota"]);
	});

	it.each([
		["permissions ", ["permissions default", "permissions auto-edit", "permissions yolo"]],
		["tool-activity ", ["tool-activity off", "tool-activity compact", "tool-activity full"]],
		["updates ", ["updates automatic", "updates notify", "updates manual"]],
		["doctor ", ["doctor --verbose"]],
		["permissions a", ["permissions auto-edit"]],
		["tool-activity f", ["tool-activity full"]],
		["updates n", ["updates notify"]],
		["doctor --v", ["doctor --verbose"]],
		["  permissions   a", ["permissions auto-edit"]],
	])("completes %j with full replacement arguments", (prefix, expected) => {
		expect(completeAntigravityArguments(prefix)?.map(({ value }) => value)).toEqual(expected);
	});

	it("only offers settings accepted by the configuration validators", () => {
		for (const [command, validate] of [
			["permissions", (value: string) => isPermissionMode(value.replaceAll("-", "_"))],
			["updates", isRuntimeUpdateMode],
			["tool-activity", isToolActivityMode],
		] as const) {
			for (const { value } of completeAntigravityArguments(`${command} `)!) {
				expect(validate(value.split(" ")[1]!)).toBe(true);
			}
		}
	});

	it.each(["unknown", "unknown ", "setup ", "quota ", "update ", "status ", "permissions nope", "permissions yolo ", "doctor --verbose ", "doctor --verbose extra"])("returns null for unsupported input %j", (prefix) => {
		expect(completeAntigravityArguments(prefix)).toBeNull();
	});
});
