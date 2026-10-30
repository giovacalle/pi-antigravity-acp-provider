const SUBCOMMANDS = [
	{ name: "setup", description: "Install the runtime and sign in" },
	{ name: "doctor", description: "Inspect runtime, authentication, and sessions", options: ["--verbose"] },
	{ name: "quota", description: "Show quota and token usage" },
	{ name: "models", description: "Discover the model catalog again" },
	{ name: "update", description: "Install the latest signed runtime" },
	{ name: "updates", description: "Configure runtime updates", options: ["automatic", "notify", "manual"] },
	{ name: "logout", description: "Clear this Pi profile's Google login and ACP sessions" },
	{ name: "permissions", description: "Configure permission mode", options: ["default", "auto-edit", "yolo"] },
	{ name: "tool-activity", description: "Configure tool progress display", options: ["off", "compact", "full"] },
] as const;

export function completeAntigravityArguments(prefix: string) {
	const input = prefix.trimStart();
	if (!/\s/u.test(input)) {
		const matches = SUBCOMMANDS.filter(({ name }) => name.startsWith(input))
			.map(({ name, description }) => ({ value: name, label: name, description }));
		return matches.length ? matches : null;
	}
	const match = /^(\S+)\s+([^\s]*)$/u.exec(input);
	if (!match) return null;
	const command = SUBCOMMANDS.find(({ name }) => name === match[1]);
	if (!command || !("options" in command)) return null;
	// Pi replaces the whole argument prefix, not just the last word.
	const matches = command.options.filter((option) => option.startsWith(match[2]!))
		.map((option) => ({ value: `${command.name} ${option}`, label: option }));
	return matches.length ? matches : null;
}
