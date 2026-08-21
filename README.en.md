# dsh-model-router

Unified ModelID routing for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): one logical model id backed by multiple providers' equivalent models, with first-token failover + cooldown, a three-tier purpose split, per-tier reasoning effort, and a settings-page management panel.

中文说明见 [README.md](README.md)。

## Overview

Name several `provider/model` candidates under a single logical **ModelID**; callers keep using one model name while the plugin routes to healthy candidates.

- **First-token failover**: pre-first-token failures (rate limit / quota / auth / network / unknown model / empty response) switch to the next candidate; the failed one enters a cooldown window; per-step switch count is capped.
- **Health-aware ranking**: each candidate keeps a sliding-window success/failure count; stable successes move up, frequent failures move down (per-candidate ✓/✗ chips in the panel). Toggle off in one click.
- **Three tiers** (Claude Haiku / Sonnet / Opus style): `tier1` light (compaction / session title), `tier2` standard (main chat), `tier3` powerful (heavy tasks); auto-selected by `purpose`, downgrades when a slot is empty; per-session manual tier (persisted).
- **Reasoning effort**: each candidate may set `reasoningEffort` (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`); validated against the model catalog on save.
- **Panel & live status**: Settings → 模型路由 admin card + live routing status in the chat input toolbar.
- **Session safety**: registers a custom session event type (sessions containing route events resume fine); sanitizes historical `replayState` across provider/model switches (prevents `INVALID_REPLAY_STATE`); strips thinking wrapper tags at the stream level (supports tags split across chunks).

## Compatibility

- DeepSeek Harness `0.1.0-rc.x` (verified on `0.1.0-rc.8`); deps declared as `peerDependencies` (cordis ≥4, dsh-* on the `0.1.0-rc` line).
- Node.js ≥ 22; React 18/19 (client).
- Last verified: 2026-08-20.

## Install / Uninstall

Standard Profile Bundle install (since 1.0.0):

```sh
dsh plugin --profile web add dsh-model-router        # from npm (after publish)
dsh plugin --profile web add ./dsh-model-router-1.1.0.tgz   # or local tarball
dsh plugin --profile web remove dsh-model-router              # uninstall
```

## Quick start

1. Install (above).
2. Open **Settings → 模型路由**, add a unified ModelID (e.g. `deepseek-v4-flash`) and configure `tier1/2/3` candidates, save.
3. In the chat window pick the plan; the plugin routes + fails over automatically.

Minimal config (`model-router` section):

```yaml
model-router:
  enabled: true
  cooldownMs: 300000
  maxSwitchesPerStep: 3
  routes:
    deepseek-v4-flash:
      tier1: [ { provider: opencode-go, model: mimo-v2.5, reasoningEffort: low } ]
      tier2: [ { provider: volcengine, model: deepseek-v4-flash }, { provider: opencode-go, model: deepseek-v4-flash } ]
      tier3: [ { provider: opencode-go, model: deepseek-v4-pro, reasoningEffort: high } ]
  # legacy: simple → tier1, complex → tier2
```

## Configuration

| Key | Default | Notes |
|---|---|---|
| enabled | true | master switch; false → all passthrough |
| cooldownMs | 300000 | failure cooldown in ms |
| maxSwitchesPerStep | 3 | max candidate switches per step (1-10) |
| healthRanking | true | health-aware ranking: reorder chains by sliding-window success/failure |
| healthWindowSize | 8 | sliding-window size per candidate (3-30) |
| routes | {} | ModelID → { tier1/2/3: [candidate] } |
| manualTiers | {} | sessionId → manual tier (persisted) |

Panel API (same-origin `webServer`):

| Method | Path | Description |
|---|---|---|
| GET | `/api/model-router/state` | config + catalog + efforts + cooldowns + history + stats + per-candidate health |
| POST | `/api/model-router/save` | save config (validates model existence + effort) |
| POST | `/api/model-router/cooldowns/clear` | clear all cooldowns |
| POST | `/api/model-router/tier` | set / clear session manual tier |

## Permissions & data

- **Network**: no outbound calls; only reuses the host `llm` service (your provider catalog) and same-origin local panel APIs.
- **Files/data**: no workspace file access, no telemetry; runtime state (cooldowns/history/stats) is in-memory; manual tiers persist to host settings.
- **Credentials**: never touches API keys; credentials live with each provider.

## Troubleshooting

- No 模型路由 card in Settings → `dsh ≥ 0.1.0-rc.6` and installed as a bundle (`dsh --profile web --dump-config | grep model-router`).
- "candidate not in catalog" → check the model id spelling, or re-save to refresh the catalog.
- All candidates failing / constant switching → inspect `/api/model-router/state` `cooldowns`/`history`; usually quota/rate-limit, wait or clear.
- Sessions fail at step 1 → historical cross-provider `replayState` pollution; 1.0.0 sanitizes it on next request (self-healing).
- Change tier → use the pro / normal / lite buttons in the chat window plan menu (persisted).

## Development

```sh
npm test                 # unit tests (node:test, zero deps)
node test-model-reasoning.mjs   # reasoning-effort probe (needs provider keys)
npm test && npm pack --dry-run  # pre-publish gate
```

- Pure logic in `lib/core.mjs` (testable, no dsh deps); `lib/index.js` wires it (llm/stream hook, panel API, settings); `lib/client.js` is the web UI.
- Compliance/tooling: `node <dsh-plugin-developer>/scripts/check.mjs .` and `node <dsh-plugin-developer>/scripts/test.mjs .`.

## License

MIT. Report security issues privately through the repository.
