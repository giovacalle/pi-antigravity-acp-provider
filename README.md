# pi-antigravity-acp-provider

A [Pi](https://github.com/earendil-works/pi) provider for **Google Antigravity** backed by its official ACP server.

## Features

- Registers `antigravity-acp/*` models with dynamic Shift+Tab reasoning effort selection for advertised tiers.
- Uses ACP protocol v1 over the official TypeScript SDK (`@agentclientprotocol/sdk`).
- Supports streaming, cancellation, usage/quota reporting, persisted session restoration, and cost estimation from reference catalog rates.
- Bridges compatible Pi tools over an authenticated loopback MCP server; `doctor`/`status` lists any omitted tools and reasons.
- Supports persisted `default`, `auto-edit`, and `yolo` permission modes (default: `yolo`) with a single-use, fail-closed Pi permission broker for prompting modes.
- Verifies managed ACP runtime installs and updates against an Ed25519-signed catalog (`automatic`, `notify`, or `manual` update modes).
- Supports interactive browser OAuth, automatic SSH/headless OAuth relay, and `GEMINI_API_KEY` authentication.

## Install & setup

Install from npm:

```bash
pi install npm:pi-antigravity-acp-provider
pi
```

Or run from source:

```bash
git clone https://github.com/zacbemis/pi-antigravity-acp-provider.git
cd pi-antigravity-acp-provider
npm install
pi --no-extensions -e ./extensions/index.ts
```

In Pi:

1. Run `/login`, choose **Sign in with an account**, then **Google Antigravity (ACP)** (or **Enter an API key** / set `GEMINI_API_KEY`).
2. Wait for the official ACP server download and extraction if not already installed (~850 MB unpacked on Linux).
3. Complete Google sign-in in the browser.
4. Run `/antigravity-acp setup` to verify auth and refresh discovered models.
5. Run `/model` to select an `antigravity-acp` model and press **Shift+Tab** to pick an advertised reasoning effort.

### Runtime discovery & environment

- **Binary order:** `AGY_ACP_BIN` → managed `~/.local/opt/agy-acp/current/` → `~/.local/bin/agy_acp_server.par` → `PATH` → automatic download from the official ACP registry (a global `agy` command is not required).
- **Proxies:** Loopback MCP traffic bypasses proxies. `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` are preserved. On macOS with no explicit proxy env, enabled system HTTP proxies are probed to avoid unsupported SOCKS auto-selection. Set `PI_ANTIGRAVITY_ACP_PROXY` to an HTTP/HTTPS URL to override child proxy settings without modifying the parent environment.
- **Node & TLS:** Standalone Pi builds need `node`/`nodejs` on `PATH` (or `NODE` set). `SSL_CERT_FILE` is preserved, falling back to `NIX_SSL_CERT_FILE` or a system CA bundle.

### Intel macOS setup caveat

Google's standalone Intel macOS (`darwin-x86_64`) ACP builds (including `1.5.2`) have an upstream Hardened Runtime/libffi startup hang where `initialize` never answers ([upstream #1393](https://github.com/google-antigravity/antigravity-cli/issues/1393)). A `SyntaxWarning` on stderr is unrelated, and retrying or raising timeouts will not fix an affected binary. This provider does not strip or replace Google's code signatures.

While awaiting a fixed standalone build, use the official `agy` CLI directly, or opt into an executable wrapper script via `AGY_ACP_BIN` (bare executable path, not a shell command):

```sh
#!/bin/sh
exec /absolute/path/to/agy acp "$@"
```

Then select `/antigravity-acp permissions default` (the host CLI may reject `yolo` and use different mode IDs). This wrapper is a best-effort workaround, **not full host CLI backend support**: sign in via `agy` itself; this provider's login/logout, credential preflight, and quota commands are not authoritative for that backend. Do not pass permission-bypass flags.

### SSH and headless Google login

Over SSH, or on Linux without `DISPLAY`/`WAYLAND_DISPLAY`, `/login` automatically switches to a manual loopback relay:

1. Pi prints the Google authorization URL.
2. Open it in a local browser and finish sign-in.
3. Copy the **complete final `127.0.0.1` redirect URL** from the browser address bar (the page itself may show a connection error).
4. Paste the URL into Pi. The provider validates host, port, path, and OAuth state and relays it to the server's loopback listener (no SSH port-forward needed).

Set `PI_ANTIGRAVITY_ACP_OAUTH_MODE=manual` or `browser` to override auto-detection. Manual relay is not supported on Windows.

### Credentials & switching Google accounts

Each Pi profile stores its Google token under `$PI_CODING_AGENT_DIR/antigravity-acp-provider/gemini/antigravity-acp/` (Pi's auth store holds only a non-secret marker). Credentials are isolated per profile and are not shared with `GEMINI_HOME`, macOS Keychain, or other Antigravity clients.

- **Switch accounts:** Close other Pi processes using the profile and run `/login antigravity-acp` (clears the profile's previous cached token and ACP bindings before sign-in).
- **Logout:** Run `/antigravity-acp logout` (or `account`) to immediately delete the profile's Google token and saved bindings, plus Pi's `/logout` to remove the auth marker or stored API key.

## Models & reasoning

- Models are discovered from the ACP server and cached in Pi's model store so newly advertised models remain selectable at startup before background refresh completes.
- Effort-qualified IDs are collapsed into one model entry per family; only advertised tiers are exposed via **Shift+Tab**.
- Listing a model does not guarantee account eligibility (e.g., some Gemini 4 models require AI Ultra or eligible Enterprise plans). If a model returns `Requested entity was not found`, verify access in the official Antigravity app/CLI and select another advertised model.

## Commands & configuration

Type `/antigravity-acp ` in Pi for subcommand and option tab-completion:

```text
/antigravity-acp setup
/antigravity-acp doctor [--verbose]
/antigravity-acp status
/antigravity-acp quota
/antigravity-acp update
/antigravity-acp updates [automatic|notify|manual]
/antigravity-acp logout | account
/antigravity-acp permissions [default|auto-edit|yolo]
/antigravity-acp tool-activity [off|compact|full]
```

Settings live in `$PI_CODING_AGENT_DIR/antigravity-acp-provider/config.json` (default `PI_CODING_AGENT_DIR`: `~/.pi/agent`):

- `permissions`: `yolo` (default), `auto_edit`, or `default`
- `runtimeUpdates`: `automatic` (default), `notify`, or `manual` — see [`docs/RUNTIME-UPDATES.md`](docs/RUNTIME-UPDATES.md)
- `toolActivity`: `compact` (default), `off`, or `full`
- `nativeWorkflows`: `false` (default) — disables Antigravity's `run_workflow` tool via session metadata so it does not generate `skills/system/run-workflow/SKILL.md` in your workspace (requires a runtime supporting `disabledTools`; see [upstream #1330](https://github.com/google-antigravity/antigravity-cli/issues/1330)). Set to `true` and restart Pi to enable it.

Saved ACP session bindings are stored beside `config.json` in `sessions.json`. Utility sessions (model discovery, quota, auth) run in `utility-cwd/` beside the config so they do not write into your workspace.

### Quota event API

Other Pi extensions can request the cached (60s) quota snapshot from the event bus:

```ts
pi.events.emit("antigravity-acp:quota:request", { reply: (result) => { /* { ok: true, quota } | { ok: false, error } */ } });
```

`AntigravityQuotaSnapshot` is exported from `extensions/index.ts`:
`{ at: number; groups: { displayName: string; buckets: { window: string; remainingFraction: number; resetTime?: string }[] }[] }`.

## Reliability & diagnostics

- **Early lifecycle & debug logs:** Valid requests emit Pi's `start` event before setup begins. Set `PI_ANTIGRAVITY_ACP_DEBUG=1` to write private, bounded JSONL phase/timing metadata logs under `$PI_CODING_AGENT_DIR/antigravity-acp-provider/debug/` (paths are listed in `status`/`doctor`). See [`docs/DIAGNOSTICS.md`](docs/DIAGNOSTICS.md).
- **Timeouts & recovery:** Prompts use inactivity watchdogs (10 minutes idle while streaming; 60 minutes while a tool or permission request is active; configurable via `promptIdleTimeoutMs` / `promptWorkIdleTimeoutMs`). Cancellation sends `session/cancel` with a 1.5s force-close grace period. Warm bindings default to capacity 4 and 5-minute idle expiry.
- **Rate limits & quota errors:** Account quota exhaustion and persistent HTTP 429 `RESOURCE_EXHAUSTED` retry loops (beyond 2 retries or 15s of announced retry delay) fail with a `quota` error starting with `Antigravity quota exceeded` so Pi does not auto-retry them.
- **Refused and over-long prompts:** After a quota error or Antigravity's plain-text context overflow reply (`The input token count exceeds the maximum number of tokens allowed (…)`), the ACP session and its saved record are discarded, so the next turn rebuilds from Pi history instead of appending the same request to the server-side session again. The overflow reply fails the turn as `Antigravity context overflow: …`, which Pi recognizes as a context overflow and compacts.
- **Slash commands in prompts:** Leading slashes (and `/plan`, `/usage`, `/logout`) are prefixed with an invisible `U+200B` so the ACP server passes them to the model as text rather than intercepting them.
- **System instructions:** Kept outside truncated history (256 KiB UTF-8 limit); mid-turn instruction changes complete the active prompt and force a fresh session on the next turn.

## Security boundary

This provider launches a full coding agent with your OS privileges. **The default `yolo` mode allows Antigravity-native commands and edits without confirmation.** Use `/antigravity-acp permissions default` for confirmation prompts.

- Disabling ACP filesystem/terminal client callbacks is **not a sandbox** for Antigravity-native tools.
- Pi hooks govern tools routed through the `pi_` MCP namespace; native tools are governed by Antigravity policy and ACP permission requests.
- New and restored sessions must advertise and confirm the requested mode. `auto-edit` negotiates `auto_edit` or an advertised `accept-edits` alias; unsupported modes (such as `yolo` on a host CLI exposing only `auto`/`plan`) fail closed with advertised mode names rather than silently falling back.
- Failed mode switches or unexpected mode-change notifications immediately close and invalidate the affected session.

## Compatibility

- **Node.js:** `>=22.19.0` (CI tests 22.19.0 and 24).
- **Pi & ACP:** Tested with Pi 1.5.x+, ACP SDK 2.8.0, and ACP protocol 1 (uses the full-v1 `/unstable` entrypoint for draft usage/lifecycle fields; does not enable experimental ACP v2).
- **Platforms:** Linux x64/ARM64 (glibc only; Alpine/musl is rejected), macOS ARM64/Intel (see [Intel macOS caveat](#intel-macos-setup-caveat)), and Windows x64/ARM64. Bundled signed catalog approves Antigravity ACP releases through `1.5.2`.

## Development

```bash
npm run check           # typecheck + unit tests
npm run test:packed     # isolated npm pack + install smoke test
npm run test:real-acp   # initialize installed Antigravity ACP server (opt-in)
npm run test:live       # real authenticated prompt (opt-in)
npm run test:qualify    # live cancel, restore, MCP, model, permission checks (opt-in)
npm audit --audit-level=moderate
```

See [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md) for release, CI, and runtime-catalog signing workflows.

## License

MIT
