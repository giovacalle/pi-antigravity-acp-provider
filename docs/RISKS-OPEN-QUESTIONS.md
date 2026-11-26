# Risks, open questions, and rejected approaches

## 1. Risk register

| ID | Risk | Likelihood / impact | Mitigation / release gate |
|---|---|---|---|
| RSK-01 | Gemini ACP startup or sequential prompts regress | Medium / High | exact pin, warm reuse, 10-turn contract test, timeout/kill, version rollback |
| RSK-02 | `session/load` loses memory or damages resumability | High current evidence / High | disabled by default; disposable canary; Pi reconstruction source of truth |
| RSK-03 | Pi and ACP both own history, causing duplicate tokens/context | High if naive / High | binding watermark/fingerprint; sentinel test; never full replay to warm session |
| RSK-04 | Pi-selected model differs from live Gemini model | High if preamble/flag only / High | set-session-model before prompt; effective model diagnostics; fail on mismatch |
| RSK-05 | Auto permission causes destructive action | Medium / Critical | user-visible broker; headless cancel; no first-allow heuristic; security blocker |
| RSK-06 | Completed Gemini tools are re-executed for Pi display | Medium / Critical | internal activity is non-executable; display replay clearly inert; tests |
| RSK-07 | Abort leaves Gemini process/request alive | Medium / High | generation-scoped cancel, deadline, group kill, reject-all, soak |
| RSK-08 | Bundled CLI size/native addons/startup harm install UX | High / Medium | disclose 98 MB direct artifact plus measured transitive total, clean Debian/Alpine probes, lazy launch, warm pool, benchmarks |
| RSK-09 | SDK and CLI ACP versions diverge | Medium / High | pin tested pair, adapter boundary, fixture diff, no auto-merge |
| RSK-10 | Auth ownership split confuses `/login`/`logout` | Medium / Medium | explicit marker/key design, verification, docs, no deletion of shared store |
| RSK-11 | API key leaks through diagnostics/frames | Low with controls / Critical | stdin only, no raw frame logs, redaction tests, secret scan |
| RSK-12 | Filesystem capability is mistaken for sandbox | High / High | disabled v1; threat docs; explicit native fallback caveat |
| RSK-13 | MCP/Pi tool bridge hides or duplicates tools | Medium / High | required before 1.0, authenticated bridge, collision policy, avoid `tools.core: []`, marketplace fixture test |
| RSK-14 | Global/project Gemini config or extensions alter behavior | Medium / High | respect trust, diagnostics, isolated test homes; don't mutate user config |
| RSK-15 | Multiple Pi sessions leak data in shared process | Medium / Critical | session-id routing, process-per-binding first, isolation tests |
| RSK-16 | Upstream stdout noise corrupts NDJSON | Medium historical / High | strict parser, bounded known-noise handling, kill/restart, version tests |
| RSK-17 | Dynamic catalog requires auth/network and disappears offline | High / Medium | fallback + persisted last-known-good; retain on refresh failure |
| RSK-18 | Model metadata (window/cost/reasoning) is inaccurate | Medium / Medium | conservative fallback, no invented rates, metadata map/versioning |
| RSK-19 | Marketplace package dependency conflicts | Medium / Medium | Pi peers `*`, packed install smoke, isolated module roots |
| RSK-20 | Package/supply-chain surface expands through full CLI | Medium / High | exact pin, lockfile, SBOM/license/audit, minimal package code, no downloader |
| RSK-21 | Antigravity's MCP client ends a Pi tool call after 180 s (`timed out after 3m0s`) whatever the tool's own `timeout`; the result reaches Pi only after the model moved on. ACP cannot raise it: `to_sdk_mcp_config` drops any timeout, and `_meta.antigravity` carries only `eagerMcpServers`, `mcpMaxOutputBytes` and `systemPrompt`. Whether MCP progress notifications extend it is unverified | High for long gates / Medium | the bridge lowers a `bash` `timeout` above 150 s to 150 s and prepends a note to the result; a call with no `timeout` is not capped; recheck on each runtime bump |

## 2. Open questions for Milestone 0

### OQ-01 — How should provider auth availability work?

Pi requires provider auth resolution to list available models. Can an ambient/keyless sentinel keep models visible while `/login` remains meaningful, or should a side-effect-free check recognize Gemini's selected auth config? Validate actual Pi model-picker/login behavior. Avoid reading token contents.

### OQ-02 — Does ACP Google authentication expose progress URLs?

Current Gemini code delegates to `refreshAuth`; determine whether the child opens a browser, emits enough ACP events, or expects terminal interaction. The login subprocess has piped stdio, so any hidden TTY prompt would hang. A live fresh-home probe is mandatory.

### OQ-03 — Which SDK version should the provider use?

Npm latest SDK 1.4.0 differs from CLI 0.58.0's exact 0.16.1 dependency. Test API and wire compatibility. Avoid allowing npm dedupe to replace Gemini CLI's internal SDK unexpectedly.

### OQ-04 — Is one process safe for multiple sessions/concurrent prompts?

Gemini manager stores multiple sessions, but process-wide config/auth/MCP and update routing may still race. Start isolated. Measure memory cost and test before multiplexing.

### OQ-05 — What is the minimum Pi version?

The plan relies on complete Provider auth and dynamic refresh APIs observed in 0.85.0. Find the first stable release carrying the exact interfaces and declare that; otherwise pin to 0.85+.

### OQ-06 — How does Pi expose and scope the permission tool?

Confirm selection/confirmation APIs, headless detection, and whether a tool can be active only for one provider continuation. If it cannot be private, exclude it from the MCP bridge and make all unmatched calls inert. If a tool cannot prompt, render offered choices and require an explicit textual/command continuation while still denying by default.

### OQ-07 — What provider data can persist in Pi session history?

If Pi offers custom entries or provider diagnostics, prefer them to a global session mapping. `streamSimple` currently only guarantees session id/context, so local metadata cache may be necessary for optional load.

### OQ-08 — How should model `auto` be represented?

Use ACP id exactly if possible. Determine whether Pi accepts slash/alias ids and whether auto-routing should advertise reasoning/image metadata. Record actual response model(s) from usage.

### OQ-09 — Can thinking level be controlled?

ACP model selection does not necessarily expose Pi-style `minimal`…`xhigh` effort. Do not map `options.reasoning` unless Gemini session config/mode offers a verified equivalent. `reasoning: true` may only mean thought blocks can occur.

### OQ-10 — How should setup errors stream?

Pi permits direct error before generation, but provider conformance may expect `start` first in some paths. Pick and test one policy consistent with built-ins.

### OQ-11 — What process environment should be inherited?

Stripping environment hardens Node injection but may break proxies, custom CAs, Google ADC/Vertex, locale, and Gemini home. Establish an allow/deny list and document it. At minimum inspect `NODE_OPTIONS`, `NODE_PATH`, and debug variables.

### OQ-12 — What user settings affect tools and permissions?

Gemini loads cwd/user settings and extensions. Confirm interaction with ACP modes, project trust, existing always-allow policy, and MCP servers. The provider should not promise prompts for actions Gemini settings already permit without confirmation.

## 3. Decisions currently deferred

- Cross-process `session/load` enablement.
- Expanded MCP parity beyond the 1.0 active-tool compatibility baseline.
- ACP filesystem proxy.
- Terminal proxy.
- Audio input.
- Rich custom Pi renderers/cards.
- Vertex/gateway login.
- Subscription-aware dollar cost.
- Multiple account rotation/failover.
- General ACP agent support.

Each remains deferred unless core provider acceptance reveals it is necessary.

## 4. Rejected approaches

### Require `gemini` on PATH

Rejected because it violates zero-special-setup, creates version drift, and makes support depend on shell/platform installation. Keep only an explicit diagnostic override.

### Download Gemini CLI on first run/postinstall

Rejected because runtime downloads are less reproducible/auditable and can fail behind proxies. npm dependency installation is the package mechanism.

### Import Gemini CLI internal modules

Rejected because private internals, global settings, React/CLI state, and build paths are not stable APIs. Child-process ACP is the intended boundary.

### Hand-roll the whole ACP protocol without need

Rejected because the official SDK exists and carries types/correlation. A thin custom framing layer is acceptable only if a documented SDK compatibility/limits issue is proven, and should still use official schema/types where possible.

### Replay complete Pi transcript on every turn

Rejected because a persistent ACP session already owns history; this duplicates context, cost, and instructions.

### Send only latest prompt forever

Rejected because process recovery, compaction, mixed providers, and Pi-side tools create context Gemini has not seen. Use bounded reconstruction/deltas.

### Trust `session/load` unconditionally

Rejected due to open memory/destructive regressions and history replay complexity. Pi context reconstruction is required regardless.

### Select model by putting its name in the prompt

Rejected because it does not control Gemini runtime. Use the ACP model method and verify effective state.

### Spawn a new CLI for every turn

Rejected due to cold-start cost, lost ACP history, and login/config initialization overhead. Keep warm bounded processes.

### Key sessions by cwd

Rejected because multiple conversations share directories and would leak history. Cwd is session metadata, not identity.

### Auto-select first permission “allow” option

Rejected as unsafe. “First” is not a security policy and option ordering is agent-controlled.

### Emit all Gemini tool updates as Pi tool calls

Rejected because Gemini executes its own loop; Pi would duplicate side effects. Only permission decisions and calls received through the Pi-tool MCP bridge intentionally execute via Pi.

### Disable Gemini core tools with `tools.core: []`

Rejected due to upstream report #28361 that it can suppress MCP tools too, and because mutating global user configuration violates focused/no-setup behavior. Any future collision solution uses tested targeted policies.

### Advertise ACP fs/terminal callbacks as a sandbox

Rejected because Gemini falls back to native fs for some paths and child shell/tools retain OS access. A real sandbox needs OS containment.

### Patch Pi to expose private UI/tool execution APIs

Rejected because marketplace compatibility and updates require public APIs only. Use no-patch tool-result round trips. If Pi cannot hide the provider's permission broker tool from other models, keep it inert without an exact pending broker record and document the visibility rather than patching the host.

### Estimate usage from response characters

Rejected because Gemini returns token metadata in current builds and estimates are misleading. Report actual values or unknown/zero.

### Merge search/research/account-pool features into the provider

Rejected to keep scope focused, auditable, and first-class. Independent Pi packages/tools can coexist through marketplace mechanisms.

## 5. Upstream watchlist

Review before each CLI bump:

- #24017 — sequential prompt response loss/merge.
- #27913 — load does not restore memory.
- #28693 and #28775 — same-minute/destructive load behavior.
- #26448 — filesystem structured ENOENT.
- #28361 — `tools.core`/MCP interaction.
- #22647 — stdout protocol pollution.
- #13913 — ACP subprocess hang.
- Gemini ACP docs/model method changes.
- ACP SDK stable v1 release/migration notes and v2 status.
- Pi Provider/auth/refresh/stream contract changes.

Issue status can change; tests, not issue labels, determine compatibility.
