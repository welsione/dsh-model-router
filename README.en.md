# dsh-model-router

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-model-router: one logical ModelID over multiple providers, pro / normal / lite tier chains with automatic failover">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/DSH-0.1.0--rc.8-4D6BFE" alt="DSH 0.1.0-rc.8">
  <img src="https://img.shields.io/npm/v/@welsione%2Fdsh-model-router" alt="npm version">
  <img src="https://img.shields.io/npm/dm/@welsione%2Fdsh-model-router" alt="npm downloads">
  <img src="https://img.shields.io/badge/license-MIT-6E7781" alt="MIT">
  <img src="https://img.shields.io/badge/Node-%3E%3D22-2AB67B" alt="Node &gt;=22">
</p>

> One logical **ModelID** backed by multiple providers' equivalent models — first-token failover with cooldown, health-aware ranking, three-tier purpose split, per-candidate reasoning effort. The settings panel **auto-saves every change**.
>
> 📦 Published on npm: [`@welsione/dsh-model-router`](https://www.npmjs.com/package/@welsione/dsh-model-router)

中文说明见 [README.md](README.md)。

```sh
dsh plugin --profile web add @welsione/dsh-model-router
```

## Overview

| Capability | One line |
|---|---|
| Auto failover | Pre-first-token failures (rate limit / quota / auth / network / unknown model / empty response) switch to the next candidate; the failed one enters cooldown |
| Health-aware ranking | Sliding-window success/failure counts reorder chains — stable successes up, frequent failures down; toggle off in one click |
| Three tiers | `tier1` light · `tier2` standard · `tier3` powerful, auto-selected by `purpose` with downgrade; per-session manual tier |
| Reasoning effort | Per-candidate `reasoningEffort`, prechecked with a real request at save time — only host-accepted levels allowed |
| Tier names | Per-plan custom tier display names (`routes.<id>.tierNames`), click-to-rename colored capsules, synced to the chat plan menu |
| Management panel | Built-in 模型路由 card in DSH Settings with auto-save; live routing status in the chat toolbar |
| Session safety | Recoverable route events, automatic `replayState` sanitization across providers |

## Compatibility

- DSH `0.1.0-rc.x` (verified on `0.1.0-rc.8`) · Node.js ≥ 22 (React 18/19) · Last verified 2026-08-22.

## Install / Uninstall

Published on npm as `@welsione/dsh-model-router`; `dsh plugin add` pulls it from npm automatically:

```sh
dsh plugin --profile web add @welsione/dsh-model-router    # install
dsh plugin --profile web remove @welsione/dsh-model-router  # uninstall
```

> npm unreachable? Fall back to the GitHub source: `dsh plugin --profile web add github:welsione/dsh-model-router`.

After install, a 模型路由 card appears in Settings; the chat model picker becomes a plan picker with tier switching. See [docs/usage.md](docs/usage.md).

## Quick start

Open **Settings → 模型路由**, add a unified ModelID (e.g. `deepseek-v4-flash`) and configure `tier1/2/3` candidates — **any change auto-saves instantly**. Minimal config and full examples: [docs/usage.md](docs/usage.md#快速开始).

## Configuration

Visual editing for `enabled / cooldownMs / maxSwitchesPerStep / healthRanking / reasoningEffortsFallback / routes` (including per-plan `tierNames`). Full config table, `llm-pi-ai` capability write-back and panel API: [docs/usage.md](docs/usage.md#配置).

## Permissions & data

No outbound calls, no workspace file access, no telemetry, no API-key handling; runtime state is in-memory, manual tiers persist to host settings.

## Troubleshooting

Missing 模型路由 card / candidate not in catalog / auto-save failed / constant switching / session stuck at step 1 → quick checklist: [docs/usage.md](docs/usage.md#故障排查).

## Development

```sh
npm test                 # unit tests (node:test, zero deps)
npm test && npm pack --dry-run   # pre-publish gate
```

Pure logic in `lib/core.mjs` + wiring in `lib/index.js` + Web UI in `lib/client.js`; compliance evidence: [docs/self-check.md](docs/self-check.md).

### Publishing a new version (auto-publish to npm)

Push a `v<version>` tag and the GitHub Action ([npm-publish.yml](.github/workflows/npm-publish.yml)) verifies the tag matches `package.json` version, then runs `npm publish`:

```sh
npm version patch   # bump version (patch/minor/major, update CHANGELOG)
git push && git push --tags
```

Publishing requires the repo's `NPM_TOKEN` secret (an Automation token for the `welsione` npm account).

## License

MIT. Report security issues privately through the repository.