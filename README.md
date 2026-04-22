# god-search

<p align="center">
  <img src="https://raw.githubusercontent.com/crackion-com/god-search/main/assets/promo.png" alt="god-search — Unlimited. Universal. Forever." width="700">
</p>

> Cheap universal web search for AI agents. No required API keys by default. MCP, HTTP, and CLI.

[![npm version](https://img.shields.io/npm/v/god-search)](https://www.npmjs.com/package/god-search)
[![npm downloads](https://img.shields.io/npm/dm/god-search)](https://www.npmjs.com/package/god-search)
[![license](https://img.shields.io/npm/l/god-search)](./LICENSE)

```
$ god-search "rust async runtime" --limit 3

  ✓ ddg  ✓ brave  ✓ bing  ✓ google  ✓ reddit  ✓ github  ✓ wiki
  ⚡ 3/7 fast · 7/7 cached · <10ms

  #1  score=28  doc.rust-lang.org
      Async in Rust — official async/await guide

  #2  score=21  tokio.rs
      Tokio — An asynchronous runtime for Rust

  #3  score=18  rust-lang.github.io
      Asynchronous Programming in Rust — async book
```

---

## Why god-search

- **No API keys** — CloakBrowser stealth scraping + public JSON APIs
- **7 engines available** — Google, Bing, DDG, Brave, Reddit, GitHub, Wikipedia
- **Fast** — API engines return in ~2s; browser engines finish in background, cache hit <10ms
- **Smart ranking** — cross-engine boost, domain diversity, official-source scoring
- **Agent-native** — CLI-first, ~80 tokens/call, zero MCP schema tax
- **Persistent browser** — daemon keeps CloakBrowser warm across all calls
- **Honest degradation** — challenged engines fail cleanly instead of pretending they worked

---

## Requirements

- Node.js 18+
- Linux / macOS (CloakBrowser headless Chromium)

---

## Install

```bash
npm install -g god-search   # npm
pnpm add -g god-search      # pnpm
bun install --global god-search  # bun

# no install needed
npx god-search "your query"
bunx god-search "your query"
```

---

## Quick Start

```bash
god-search "rust async runtime"
```

```json
{
  "query": "rust async runtime",
  "results": [
    {
      "title": "Tokio",
      "url": "https://tokio.rs",
      "snippet": "Tokio is an asynchronous runtime for Rust...",
      "score": 21,
      "engines": ["ddg", "brave", "google"],
      "rank": 1
    }
  ],
  "total": 10
}
```

```bash
# Only the fields you need
god-search "rust async runtime" --limit 5 --fields=title,url,score

# Extract full page text
god-search extract https://tokio.rs
```

---

## HTTP Daemon

Start once — browser stays warm, all searches reuse it:

```bash
god-search serve
# ✓ listening on http://127.0.0.1:3847
```

```bash
# Search
curl -s http://127.0.0.1:3847/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"rust async runtime","limit":5}'

# Extract full page text
curl -s http://127.0.0.1:3847/extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://tokio.rs"}'

# Health check
curl -s http://127.0.0.1:3847/health

# OpenAPI contract
curl -s http://127.0.0.1:3847/openapi.json
```

### Auto-start on login

```bash
mkdir -p ~/.config/systemd/user
curl -sO https://raw.githubusercontent.com/crackion-com/god-search/main/god-search.service
mv god-search.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now god-search
```

---

## CLI Reference

| Command | Description |
|---|---|
| `god-search "query"` | Search — compact JSON to stdout |
| `god-search "query" --limit N` | Limit results (default: 10) |
| `god-search "query" --fields=title,url,score` | Return only specified fields |
| `god-search "query" --verbose` | Include engine stats + elapsed time |
| `god-search extract <url>` | Extract clean text from any URL |
| `god-search serve` | Start HTTP daemon on port 3847 |
| `god-search mcp` | Start MCP stdio server |

---

## Hermes

Use `god-search` with Hermes as an **MCP server**, not as `web.backend`.

```yaml
mcp_servers:
  god_search:
    command: "node"
    args: ["/absolute/path/to/god-search-gpt/index.js", "mcp"]
    tools:
      include: [god_search, god_extract, god_health]
```

Then enable the `mcp-god_search` toolset in Hermes and reload MCP.

Why this is the right integration:
- Hermes built-in `web.backend` only supports `firecrawl`, `parallel`, `tavily`, and `exa`
- `god-search` already exposes a clean MCP surface and a simple HTTP JSON contract
- this keeps `god-search` as a cheap sidecar instead of forcing Hermes core changes

---

## AI Agents (Codex, Claude Code, Cursor, OpenCode)

god-search is built for agents. There are now three supported integration modes:

- **MCP** for agents that want typed tools
- **HTTP** for agents that want a low-friction JSON API
- **CLI** for shell-driven agents and human debugging

The HTTP daemon gives you a warm browser with zero per-call overhead.

**~80 tokens/call vs 1,500+ for equivalent MCP browser tools.**

```bash
# Search
curl -s http://127.0.0.1:3847/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"anthropic claude api","limit":5}'

# Extract a page
curl -s http://127.0.0.1:3847/extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://docs.anthropic.com"}'
```

```bash
# Add god-search as an agent skill (one-time)
cp node_modules/god-search/SKILL.md .claude/rules/god-search.md
# or
cp node_modules/god-search/SKILL.md .cursor/skills/god-search.md
```

If daemon is down: `systemctl --user start god-search`

### MCP

```json
{
  "mcpServers": {
    "god-search": {
      "command": "god-search",
      "args": ["mcp"]
    }
  }
}
```

MCP tools:
- `god_search`
- `god_extract`
- `god_health`

### HTTP

HTTP routes:
- `GET /health`
- `GET /openapi.json`
- `POST /search`
- `POST /extract`

`/health` returns daemon, cache, browser, and runtime state.
`/openapi.json` exposes the machine-readable contract for HTTP clients.

---

## Engines

| Engine | Type | Best for |
|---|---|---|
| DuckDuckGo | CloakBrowser | Fast general results |
| Brave | CloakBrowser or Brave Search API | Technical queries. Challenge-prone in scrape mode, disabled by default in merged search |
| Bing | CloakBrowser | Broad coverage |
| Google | CloakBrowser | Highest quality (CAPTCHA-prone) |
| Reddit | JSON API | Community discussions |
| GitHub | JSON API | Code & repositories |
| Wikipedia | JSON API | Definitions & facts |

Brave is available but **not included in the default merged engine set** unless you explicitly enable it:

```bash
GOD_SEARCH_ENABLE_BRAVE=true
```

If you want Brave without bot-detection issues, set a Brave Search API key and let `auto` mode use the official API:

```bash
BRAVE_SEARCH_API_KEY=...
GOD_SEARCH_BRAVE_MODE=auto   # auto | api | scrape
```

When `BRAVE_SEARCH_API_KEY` is present, `auto` mode prefers:

```text
https://api.search.brave.com/res/v1/web/search
```

Source:
- Brave Search API docs: https://brave.com/search/api/

---

## How It Works

```
query → 6 engines fire in parallel (default — Brave disabled unless GOD_SEARCH_ENABLE_BRAVE=true)
         ├── Reddit ────┐
         ├── Wikipedia ─┤  fast (~1s): JSON API engines
         ├── GitHub ────┘  fast-path: quality-aware (intent + confidence + elapsed)
         ├── DDG ───────── background: CloakBrowser, finish + update cache
         ├── Bing ───────── background: CloakBrowser, finish + update cache
         └── Google ──────── background: CloakBrowser, finish + update cache

         [+ Brave]  opt-in: GOD_SEARCH_ENABLE_BRAVE=true (scrape) or BRAVE_SEARCH_API_KEY=... (API)

results → cross-engine boost (+4/+8/+12 for shared URLs)
        → domain diversity (max 2 per domain)
        → score sort → return top N
```

- **LRU-TTL cache** — 256 entries, 10min TTL; 1st request gets API engines (~2s), 2nd gets all active engines (<10ms)
- **Browser isolation** — `withBrowserPage()` throttles to 2 concurrent CloakBrowser pages, prevents crashes
- **Auto-reconnect** — browser restarts automatically on disconnect

---

## MCP (opt-in)
For environments that require typed tool discovery, use the MCP server above.

---

## Runtime Configuration

`god-search-gpt` can now be tuned without code edits:

```bash
GOD_SEARCH_HOST=127.0.0.1
GOD_SEARCH_PORT=3847
GOD_SEARCH_CACHE_TTL_MS=600000
GOD_SEARCH_CACHE_MAX_ENTRIES=256
GOD_SEARCH_FAST_PATH_MS=2000
GOD_SEARCH_FAST_PATH_MAX_MS=4500
GOD_SEARCH_FAST_PATH_POLL_MS=100
GOD_SEARCH_FAST_PATH_MIN_ENGINES=4
GOD_SEARCH_MAX_NAV=2
GOD_SEARCH_PREWARM_BROWSER=false
GOD_SEARCH_SEARCH_TIMEOUT_MS=10000
GOD_SEARCH_API_TIMEOUT_MS=8000
GOD_SEARCH_EXTRACT_TIMEOUT_MS=15000
GOD_SEARCH_MAX_CONTENT_CHARS=50000
GOD_SEARCH_MCP_HEALTH_TOOL=true
GOD_SEARCH_ENABLE_BRAVE=false
GOD_SEARCH_BRAVE_MODE=auto
BRAVE_SEARCH_API_KEY=
GOD_SEARCH_BRAVE_COUNTRY=us
GOD_SEARCH_BRAVE_SEARCH_LANG=en
```

The sample `god-search.service` now supports an optional environment file:

```bash
~/.config/god-search.env
```

---

## License

MIT © [crackion](https://github.com/crackion-com)
