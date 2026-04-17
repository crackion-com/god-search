# god-search

> Free unlimited universal web search. No API keys. No rate limits. Works forever.

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
- **7 engines in parallel** — Google, Bing, DDG, Brave, Reddit, GitHub, Wikipedia
- **Fast** — API engines return in ~2s; browser engines finish in background, cache hit <10ms
- **Smart ranking** — cross-engine boost, domain diversity, official-source scoring
- **Agent-native** — CLI-first, ~80 tokens/call, zero MCP schema tax
- **Persistent browser** — daemon keeps CloakBrowser warm across all calls
- **Works forever** — no quotas, no rate limits, no billing

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

## HTTP Daemon (recommended for AI agents)

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

## AI Agents (Claude Code, Cursor, OpenCode)

god-search is built for agents. The HTTP daemon gives you a warm browser with zero per-call overhead.

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

---

## Engines

| Engine | Type | Best for |
|---|---|---|
| DuckDuckGo | CloakBrowser | Fast general results |
| Brave | CloakBrowser | Technical queries |
| Bing | CloakBrowser | Broad coverage |
| Google | CloakBrowser | Highest quality (CAPTCHA-prone) |
| Reddit | JSON API | Community discussions |
| GitHub | JSON API | Code & repositories |
| Wikipedia | JSON API | Definitions & facts |

---

## How It Works

```
query → 7 engines fire in parallel
         ├── Reddit ────┐
         ├── Wikipedia ─┤  fast (~1s): JSON API engines
         ├── GitHub ────┘  fast-path: 4/7 complete OR 2000ms — whichever first
         ├── DDG ───────── background: CloakBrowser, finish + update cache
         ├── Brave ──────── background: CloakBrowser, finish + update cache
         ├── Bing ───────── background: CloakBrowser, finish + update cache
         └── Google ──────── background: CloakBrowser, finish + update cache

results → cross-engine boost (+4/+8/+12 for shared URLs)
        → domain diversity (max 2 per domain)
        → score sort → return top N
```

- **LRU-TTL cache** — 256 entries, 10min TTL; 1st request gets API engines (~2s), 2nd gets all 7 engines (<10ms)
- **Browser isolation** — `withBrowserPage()` throttles to 2 concurrent CloakBrowser pages, prevents crashes
- **Auto-reconnect** — browser restarts automatically on disconnect

---

## MCP (opt-in)

For environments that require typed tool discovery:

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

---

## License

MIT © [crackion](https://github.com/crackion-com)
