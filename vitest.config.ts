import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		globalSetup: ["test/support/isolate-home.ts"],
		testTimeout: 10_000,
	},
});
