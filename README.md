# god-search

> Free unlimited universal web search. No API keys. No rate limits. Works forever.

[![npm version](https://img.shields.io/npm/v/god-search)](https://www.npmjs.com/package/god-search)
[![npm downloads](https://img.shields.io/npm/dm/god-search)](https://www.npmjs.com/package/god-search)
[![license](https://img.shields.io/npm/l/god-search)](./LICENSE)

7 engines in parallel — Google, Bing, DuckDuckGo, Brave, Reddit, GitHub, Wikipedia.  
Returns ranked, deduplicated, clean JSON. Fast-path fires when 4/7 engines complete (~1s warm).

---

## Install

```bash
# npm
npm install -g god-search

# pnpm
pnpm add -g god-search

# bun
bun install --global god-search

# no install — run directly
npx god-search "your query"
bunx god-search "your query"
```

---

## Quick Start

```bash
god-search "rust async runtime"
```

```json
{"query":"rust async runtime","results":[{"title":"Tokio","url":"https://tokio.rs","snippet":"Tokio is an asynchronous runtime for Rust...","score":21,"engines":["ddg","brave","google"],"rank":1}],"total":10}
```

---

## Usage

### CLI

```bash
# Search
god-search "query"
god-search "query" --limit 5
god-search "query" --fields=title,url,score
god-search "query" --verbose

# Extract full page text
god-search extract https://tokio.rs
```

### HTTP Daemon (best for AI agents)

Start once, browser stays warm across all calls:

```bash
god-search serve
# listening on http://127.0.0.1:3847
```

```bash
# Search
curl -s http://127.0.0.1:3847/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"rust async runtime","limit":5}'

# Extract
curl -s http://127.0.0.1:3847/extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://tokio.rs"}'

# Health
curl -s http://127.0.0.1:3847/health
```

### Auto-start on login (systemd)

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
| `god-search "query"` | Search, returns compact JSON |
| `god-search "query" --limit N` | Limit result count (default 10) |
| `god-search "query" --fields=title,url,snippet,score` | Return only specified fields |
| `god-search "query" --verbose` | Include engine stats + elapsed time |
| `god-search extract <url>` | Extract full clean text from URL |
| `god-search serve` | Start HTTP daemon on port 3847 |
| `god-search mcp` | Start MCP stdio server |

---

## AI Agents (Claude Code, Cursor, OpenCode)

god-search is CLI-first — **zero MCP schema tax**, ~80–150 tokens per call.

The daemon keeps the browser warm. Use `curl` from any agent with a bash tool:

```bash
# Add to your project as an agent skill
cp node_modules/god-search/SKILL.md .claude/rules/god-search.md
```

Benchmark vs MCP browser tools: **~80 tokens/call vs 1,500+**

---

## Output Format

```json
{
  "query": "...",
  "results": [
    {
      "title": "...",
      "url": "https://...",
      "snippet": "...",
      "score": 21,
      "engines": ["ddg", "brave"],
      "rank": 1
    }
  ],
  "total": 10
}
```

Fields: `--fields=title,url,snippet,score,engines,rank`

---

## Engines

| Engine | Type | Notes |
|---|---|---|
| DuckDuckGo | CloakBrowser | Fast, no consent banners |
| Brave | CloakBrowser | Strong for technical queries |
| Bing | CloakBrowser | High coverage |
| Google | CloakBrowser | Best quality, CAPTCHA-prone |
| Reddit | JSON API | Community discussions |
| GitHub | JSON API | Code repositories |
| Wikipedia | JSON API | Factual definitions |

---

## How It Works

- All 7 engines fire in parallel
- **Fast-path**: returns when 4/7 engines complete or 2000ms elapses (~1s warm)
- Remaining engines finish in background, update cache silently
- **Cross-engine boost**: same URL from 2/3/4+ engines → +4/+8/+12 score
- **Domain diversity**: max 2 results per domain
- **LRU-TTL cache**: 256 entries, 10min TTL — repeat queries are instant
- **Browser isolation**: `withBrowserPage()` serializes CloakBrowser calls, prevents crashes

---

## MCP (opt-in)

```json
{
  "mcpServers": {
    "god-search": {
      "command": "node",
      "args": ["/path/to/god-search/index.js", "mcp"]
    }
  }
}
```

---

## License

MIT © [crackion](https://github.com/crackion-com)
