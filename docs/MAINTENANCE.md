# Maintenance policy

## Supported versions

- Pi 1.3.x; both Pi development packages are pinned together to 1.3.0.
- Node.js 22.19.0 and 24 are checked in CI. Node declarations track the 24.x line.
- ACP SDK 1.8.0 / stable protocol 1 (not experimental ACP v2). Both stable configuration selectors and older official Antigravity model APIs are supported and validated.
- Host-provided Pi packages remain wildcard peers and are not bundled, following Pi's package contract. The README's compatibility statement defines tested support.

## Dependency updates

Dependabot runs weekly for npm and GitHub Actions. Pi updates are grouped to avoid mismatched `pi-ai` / `pi-coding-agent` versions. Compatible minor/patch updates are grouped; major updates require individual review.

Before merging, require the Node 22.19.0 and 24 checks: typecheck, tests, pack dry run, an isolated packed-install smoke test, and full `npm audit --audit-level=moderate`. Audit findings describe dependency advisories, not proof that the provider exposes every affected code path. Do not use `npm audit fix --force` as a substitute for compatibility work.

TypeScript 7.0.2 is supported. The multiprocess session-store tests bundle the actual implementation with explicitly declared esbuild, avoiding removed compiler APIs while retaining independent process lock contention. Node 26 declarations are intentionally excluded until that runtime is supported.

## Profiles

`PI_CODING_AGENT_DIR` selects provider configuration and saved ACP bindings. Initial configuration migration copies only permission/update settings, preserves the source, and never overwrites an existing target. Sessions are not migrated. Antigravity's own credentials and managed runtime are still shared; a Pi profile is not an Antigravity account sandbox.

## Release checklist

1. Merge changes only after both CI checks pass on the current main base.
2. Bump `package.json` and the lockfile together, update release notes, and merge the release PR.
3. Re-run checks, packed install, and full audit from a clean install. Exercise npm 12 packaging as well as the bundled npm CLI.
4. Create an annotated `v<version>` tag on that exact main commit and push it. The existing publish workflow uses npm trusted publishing/OIDC; do not introduce a long-lived npm token.
5. Verify the publish workflow, npm version, and GitHub release. Authenticated prompt/cancellation qualification is opt-in and must be explicitly requested; PR CI does not use real Google credentials.

## Protected runtime publication

The `main CI` ruleset requires a PR, an up-to-date base, successful `Check (22.19.0)` and `Check (24)` jobs from GitHub Actions, linear history, and no force pushes or deletion. No actor bypasses these rules. The older disabled `gitrules` ruleset remains unchanged.

The daily updater publishes only `runtime-manifest.json` on a unique automation branch. It opens a PR, refreshes its base, explicitly dispatches `ci.yml`, verifies both real CI jobs on that exact head, and squash-merges through normal protection. Bot-token PR workflows are held for approval under GitHub's current policy. A separate dispatch-only CI reporting job therefore records each actual validation job's result and URL on the exact tested commit; missing/failed jobs are never reported as successful. Failed checks leave the signed PR open for inspection; no fabricated passes or direct main pushes are used.

Repository Actions settings must allow GitHub Actions to create PRs. Default token permissions and validation-job tokens remain read-only. Only the updater grants `contents`, `pull-requests`, and `actions` write permissions; the dispatch-only reporting job has `statuses: write` and read access to Actions metadata. It never approves reviews and needs no PAT, installed app bypass, or auto-merge exemption. Signing keys are removed from runner temporary storage after signing.

Validate the bot path without new artifact downloads or a signing key:

```bash
gh workflow run update-runtime-manifest.yml -f publication_test=true
```

This changes only whitespace around the existing valid signed catalog, dispatches both checks, then closes the PR without changing main. To verify the complete protected merge path, also pass `-f merge_publication_test=true`; only whitespace changes, never the signature payload or approved runtime releases.
