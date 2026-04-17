---
name: god-search
description: Free unlimited universal web search — Google, Bing, DDG, Brave, Reddit, GitHub, Wikipedia via CloakBrowser stealth scraping and public JSON APIs. No API keys, no rate limits, works forever.
version: 1.0.15
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

Token-optimized web search for AI agents. CLI-first. Warm persistent browser. Compact JSON. 7 engines.

## For AI Agents — Use This

A daemon runs permanently at `http://127.0.0.1:3847`. Call it via bash — zero MCP schema tax.

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
god-search "query" --limit 5 --fields=title,url,snippet
```

**If daemon is down:**
```bash
systemctl --user start god-search
```

## Output (compact JSON, clean snippets)

```json
{"query":"...","results":[{"title":"...","url":"...","snippet":"...","score":16,"engines":["ddg"],"rank":1}],"total":5}
```

Fields: `title` (≤120 chars), `url`, `snippet` (≤300 chars, HTML-decoded, enforced), `score`, `engines`, `rank`

## Engines

| Engine | Method | Notes |
|--------|--------|-------|
| DDG | CloakBrowser | Fast, no consent |
| Brave | CloakBrowser | Good for technical queries |
| Bing | CloakBrowser | High coverage |
| Google | CloakBrowser | Best quality, CAPTCHA-prone |
| Reddit | JSON API | Community discussions |
| GitHub | JSON API | Code repositories |
| Wikipedia | JSON API | Factual definitions |

## Performance

- First request: ~2s (API engines — reddit/github/wikipedia complete fast)
- Second request: <10ms (cache hit — all 7 engines included, cross-engine boosted)
- Cold start: +3–5s (browser launch on top of first request)

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
