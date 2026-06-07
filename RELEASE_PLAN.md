# god-search Release Plan

Last updated: 2026-05-30

This file is the current implementation and release checklist for `god-search`.
It separates what is already completed from what is still required before calling the project fully public-ready or making a public "best free/no-key agent search sidecar" claim.

## Current Status

- Project state: private beta / strong public beta candidate
- Core value: working free/no-key agent search sidecar
- MCP / HTTP / CLI surfaces: working
- Merged ranking quality: significantly improved
- Public-release polish: not finished
- Main remaining risk: browser-engine resilience under real-world load
- Public positioning target: best free/no-key agent search sidecar
- Claim status: not proven yet; current benchmarks are useful but shallow

## Public Positioning Rules

Allowed today:

- `god-search` is a local, agent-native search and extraction sidecar.
- It works without required API keys by default.
- It exposes CLI, HTTP, and MCP surfaces for agent workflows.
- It has optional provider keys for better quota or reliability.
- It reports degraded public-engine behavior instead of hiding it.

Not allowed until proven:

- Do not claim "best" without deeper blind-pooled judging and repeated live runs.
- Do not claim "unlimited" because public engines can rate-limit, challenge, or change.
- Do not imply paid providers are beaten globally from the current shallow qrels.
- Do not hide that browser-engine resilience and authenticated provider paths are still release risks.

## Verified On Laptop

- [x] `npm test` passes
- [x] Current test result: `16 passed, 0 failed`
- [x] HTTP daemon works end-to-end
- [x] MCP module loads correctly
- [x] OpenAPI route works
- [x] Search route works
- [x] Extract route works
- [x] Settled merged docs queries now rank official sources much better

## Completed

### Repo Setup

- [x] Original project was copied into a separate work area:
  `Dev/projects/god-search-gpt`
- [x] `graphify-out` was reviewed for structural context before major changes

### Runtime Configuration

- [x] Added centralized runtime config in [src/config.js](./src/config.js)
- [x] Added shared runtime state in [src/runtime.js](./src/runtime.js)
- [x] Added env-driven tuning for:
  - host / port
  - cache TTL / size
  - fast-path timing
  - browser concurrency
  - extract timeout / size

### HTTP / MCP / Agent Interfaces

- [x] Hardened HTTP daemon in [src/http.js](./src/http.js)
- [x] Added richer `/health` response
- [x] Added `/openapi.json`
- [x] Added OpenAPI generator in [src/openapi.js](./src/openapi.js)
- [x] Hardened MCP server in [src/mcp.js](./src/mcp.js)
- [x] Added MCP `god_health` tool
- [x] Clarified Hermes integration path:
  use MCP, not Hermes `web.backend`

### Search / Merge Quality

- [x] Added stable shared `engineStats` schema
- [x] Fixed cached/background updates so they preserve the same shape
- [x] Added query intent detection:
  - docs
  - code
  - discussion
  - factual
  - general
- [x] Added intent-aware engine ordering
- [x] Added quality-aware fast-path behavior
- [x] Added intent-aware ranking adjustments
- [x] Added `awaitBackground` mode for settled-quality callers and tests

### Cache / Browser Observability

- [x] Added cache metrics in [src/cache.js](./src/cache.js)
- [x] Added browser status metrics in [src/browser.js](./src/browser.js)
- [x] Added runtime counters for search / extract / health

### Documentation / Service Behavior

- [x] Updated [README.md](./README.md)
- [x] Updated [SKILL.md](./SKILL.md)
- [x] Updated [god-search.service](./god-search.service)
- [x] Added optional environment-file support to the sample service
- [x] Rewrote docs so Hermes / agent usage is clearer

### Brave Handling

- [x] Investigated Brave in live headed CloakBrowser sessions
- [x] Confirmed Brave scrape failures are caused by upstream captcha gates, not selector bugs
- [x] Added explicit Brave challenge detection
- [x] Changed default merged search behavior so Brave is disabled by default
- [x] Added optional Brave API mode in [src/engines/brave.js](./src/engines/brave.js)
- [x] Added Brave modes:
  - `auto`
  - `api`
  - `scrape`
- [x] Added Brave API env support:
  - `BRAVE_SEARCH_API_KEY`
  - `GOD_SEARCH_BRAVE_MODE`
  - `GOD_SEARCH_BRAVE_COUNTRY`
  - `GOD_SEARCH_BRAVE_SEARCH_LANG`

## Completed But Still Needs More Validation

- [x] Brave Search API integration is implemented
- [ ] Brave Search API path is not yet live-verified with a real API key

## Still Left

### 0. Public Claim Proof

- [ ] Expand `benchmark/runs/latest/blind-judging-pool.jsonl` into deeper judged qrels
- [ ] Rerun live benchmarks against the expanded qrels
- [ ] Repeat live runs enough to separate one-off provider variance from stable quality
- [ ] Decide whether the data supports "best free/no-key agent search sidecar"; if not, keep the softer sidecar positioning
- [ ] Publish benchmark limitations beside any public metric table

Why this matters:
- The public target is strong, but current benchmark coverage is too shallow to prove it
- Honest positioning is part of the product, not just a documentation concern

### 1. Browser Engine Resilience

- [ ] Improve browser process isolation under mixed concurrent workloads
- [ ] Add retry policy for transient browser/page failures
- [ ] Add clearer per-engine circuit-breaker behavior
- [ ] Reduce noisy browser disconnect / relaunch side effects
- [ ] Decide whether Bing / Google / DDG should each get stronger failure backoff

Why this matters:
- This is the biggest remaining reliability risk in the project
- The merged experience is only as strong as the browser-backed engines staying healthy

### 2. Authenticated Provider Support

- [ ] Add optional `GITHUB_TOKEN` support
- [ ] Prefer authenticated GitHub requests when token is available
- [ ] Consider authenticated Reddit mode
- [ ] Document “public mode” vs “authenticated mode” clearly

Why this matters:
- Unauthenticated GitHub hits practical rate limits quickly
- Public beta users will notice degradation under repeated use

### 3. Better Degradation Reporting

- [ ] Add clearer degraded-mode metadata beyond `partial: true`
- [ ] Surface whether a query is:
  - fast-path partial
  - settled
  - degraded due to failed engines
  - degraded due to challenged engines
- [ ] Consider adding a `quality` or `degradation_reason` field

Why this matters:
- API consumers need to know whether to trust the first answer or retry later

### 4. More Test Coverage

- [ ] Add repeated merged-query regression tests
- [ ] Add cached/background consistency tests
- [ ] Add HTTP contract tests
- [ ] Add MCP tool tests
- [ ] Add tests for challenge-prone engines
- [ ] Add tests for authenticated GitHub / Brave API mode when credentials exist
- [ ] Add tests for degradation metadata

Why this matters:
- The original suite was too weak and missed real runtime issues
- Public confidence needs stronger regression coverage

### 5. CI / Release Engineering

- [ ] Add CI workflow
- [ ] Run tests automatically on push / PR
- [ ] Add lint / static validation stage
- [ ] Add package sanity check in CI
- [ ] Add release checklist / changelog discipline

Why this matters:
- A public repo should not rely on manual local testing only

### 6. Public Repo Polish

- [ ] Add CONTRIBUTING guide
- [ ] Add issue templates
- [ ] Add PR template
- [ ] Add clearer public roadmap section
- [ ] Remove any remaining overstated marketing language
- [ ] Make versioning and release notes more disciplined

Why this matters:
- “World-class” is not just runtime quality
- It includes clarity, contributor experience, and trust

## Known Product Decisions

- [x] Hermes should use this through MCP, not as native `web.backend`
- [x] Brave scraping is treated as challenge-prone and non-core
- [x] Brave is opt-in by default for merged search
- [x] Official documentation / official domains should outrank mirrors and forum noise for docs-style queries
- [x] Settled results are more important than shallow fast-path speed for quality-sensitive tests
- [x] "Best free/no-key agent search sidecar" is a target claim, not current copy, until the benchmark proof is stronger
- [x] "Unlimited" is not an acceptable claim because public-engine constraints are real

## Release Gates

These are the minimum gates before calling the repo fully public-ready.

- [x] Core search / extract / daemon flow works
- [x] MCP / HTTP / CLI are all usable
- [x] Merged docs-query ranking is materially improved
- [x] Stable `engineStats` schema exists
- [ ] Expanded benchmark qrels support any "best" claim
- [ ] Browser-engine resilience is strong enough under repeated mixed workloads
- [ ] Authenticated GitHub support exists
- [ ] Degradation reporting is clean and explicit
- [ ] Expanded regression coverage exists
- [ ] CI exists
- [ ] Public repo polish is complete

## Recommended Next Order

- [ ] Expand blind-pooled qrels and rerun live benchmarks
- [ ] Add degradation / quality metadata
- [ ] Add `GITHUB_TOKEN` support
- [ ] Add browser retry / isolation hardening
- [ ] Add cached/background consistency tests
- [ ] Add CI
- [ ] Final public-doc cleanup

## Short Honest Verdict

- [x] The project is real and useful
- [x] The agent integration story is now strong
- [x] The merged ranking is much better than the original baseline
- [x] The free/no-key sidecar positioning is credible enough to pursue publicly
- [ ] The "best free/no-key agent search sidecar" claim is not proven yet
- [ ] It should not be described as unlimited
- [ ] It is not yet at the “world can be proud of it” finish line
- [ ] The last major engineering gap is reliability and release discipline, not basic capability
