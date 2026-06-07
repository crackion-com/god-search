---
name: god-search
description: Multi-engine web search for AI agents — Google, Bing, DDG, Brave, Reddit, GitHub, Stack Overflow, Hacker News, npm, Wikipedia via CloakBrowser and public JSON APIs. MCP, HTTP, and CLI. Brave is challenge-prone and opt-in for merged search.
version: 1.1.1
author: crackion
license: MIT
metadata:
  hermes:
    tags: [search, web, research, universal, cli]
---

**Install as agent skill (one-time):**
```bash
cp SKILL.md .claude/rules/god-search.md
# or
mkdir -p .cursor/skills && cp SKILL.md .cursor/skills/god-search.md
```

# god-search

Compact web search for AI agents. Supports MCP, HTTP, and CLI. Warm persistent browser. 9 no-key engine integrations available, plus Brave as opt-in.

## For AI Agents — Use This

A daemon runs permanently at `http://127.0.0.1:3847`. Call it via bash for low overhead, or use MCP when the host agent prefers typed tools.

**Search:**
```bash
curl -s http://127.0.0.1:3847/search -H 'Content-Type: application/json' \
  -d '{"query":"...","limit":5}'
```

**Extract full page text (CLI — works without daemon):**
```bash
god-search extract https://...
```

**Extract via daemon (preferred — warm browser):**
```bash
curl -s http://127.0.0.1:3847/extract -H 'Content-Type: application/json' \
  -d '{"url":"https://..."}'
```

**CLI (cold, no daemon needed):**
```bash
god-search "query" --limit 5
god-search "query" --limit 5 --settled
god-search "query" --limit 5 --fields=title,url,snippet
```

**If daemon is down:**
```bash
systemctl --user start god-search
```

**Health / contract:**
```bash
curl -s http://127.0.0.1:3847/health
curl -s http://127.0.0.1:3847/openapi.json
```

## Output (compact JSON, clean snippets)

```json
{"query":"...","results":[{"title":"...","url":"...","snippet":"...","score":16,"engines":["ddg"],"rank":1}],"total":5}
```

Fields: `title` (≤120 chars), `url`, `snippet` (≤300 chars, HTML-decoded, enforced), `score`, `engines`, `rank`

## Engines

| Engine | Method | Notes |
|--------|--------|-------|
| DDG | CloakBrowser | General web results |
| Brave | CloakBrowser or Brave Search API | Good for technical queries. In `auto` mode, use the official API when `BRAVE_SEARCH_API_KEY` is present |
| Bing | CloakBrowser | High coverage |
| Google | CloakBrowser | Broad search coverage, CAPTCHA-prone |
| Reddit | JSON API | Community discussions |
| GitHub | JSON API | Code repositories |
| Stack Overflow | JSON API | Debugging and developer Q&A |
| Hacker News | JSON API | Technical discussions and launch/news context |
| npm | JSON API | JavaScript package discovery |
| Wikipedia | JSON API | Factual definitions |

Enable Brave in merged search only if you explicitly want it:
```bash
GOD_SEARCH_ENABLE_BRAVE=true
```

Prefer Brave API mode if you want to avoid bot-detection issues:
```bash
BRAVE_SEARCH_API_KEY=...
GOD_SEARCH_BRAVE_MODE=auto
```

## Performance

- First request: JSON API engines can complete before browser-backed engines
- Repeated requests: cache can reuse recent merged results
- Cold start: includes browser launch when the daemon or browser is not already warm

## Scoring

- Official domain/host prefix (docs.*, developer.*) → +5
- Official path (/docs, /api, /reference) → +4
- Cross-engine appearance (2/3/4+ engines) → +4/+8/+12
- Low-signal hosts (medium.com, dev.to) → -5
- Domain diversity: max 2 results per domain

## MCP (opt-in only)

Only if your environment requires typed tool discovery:
```json
{"mcpServers":{"god-search":{"command":"node","args":["/path/to/index.js","mcp"]}}}
```

Exposed MCP tools:
- `god_search`
- `god_extract`
- `god_health`

## Hermes

Use this through Hermes MCP, not through Hermes `web.backend`.

```yaml
mcp_servers:
  god_search:
    command: "node"
    args: ["/absolute/path/to/index.js", "mcp"]
    tools:
      include: [god_search, god_extract, god_health]
```
