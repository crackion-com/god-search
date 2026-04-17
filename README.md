# god-search

Free unlimited universal web search. No API keys. No rate limits. Works forever.

7 engines: Google, Bing, DuckDuckGo, Brave, Reddit, GitHub, Wikipedia — powered by [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) stealth scraping + public JSON APIs.

## Install

```bash
git clone https://github.com/crackion-com/god-search
cd god-search
npm install
```

## Usage

### HTTP Daemon (recommended for AI agents)

```bash
node index.js serve
# daemon runs at http://127.0.0.1:3847
```

```bash
# Search
curl -s http://127.0.0.1:3847/search -H 'Content-Type: application/json' \
  -d '{"query":"rust async runtime","limit":5}'

# Extract full page text
curl -s http://127.0.0.1:3847/extract -H 'Content-Type: application/json' \
  -d '{"url":"https://doc.rust-lang.org/"}'

# Health
curl -s http://127.0.0.1:3847/health
```

### CLI

```bash
node index.js "rust async runtime"
node index.js "rust async runtime" --limit 5
node index.js "rust async runtime" --fields=title,url,score
node index.js extract https://doc.rust-lang.org/
```

### Auto-start (systemd)

```bash
cp god-search.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now god-search
```

## AI Agents

god-search is CLI-first — no MCP schema tax, ~80–150 tokens per search call.

See [SKILL.md](./SKILL.md) for agent-optimized usage patterns (Claude Code, Cursor, OpenCode).

```bash
# Add to your project
cp SKILL.md .claude/rules/god-search.md
```

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

## How it works

- All 7 engines run in parallel
- Fast-path: returns when 4/7 engines complete (typically ~1s warm)
- Remaining engines finish in background and update cache
- LRU-TTL cache: 256 entries, 10min TTL
- Browser engines serialize via `withBrowserPage()` to prevent CloakBrowser crashes
- Cross-engine boost: same URL from 2/3/4+ engines → +4/+8/+12 score

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

## License

MIT
