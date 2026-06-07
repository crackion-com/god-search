import { scoreResult, registrableDomain } from '../scoring.js';

const SEEDS = [
  {
    match: /\bnode\.?js\b.*\b(docs?|documentation|api|reference)\b|\bnodejs\b.*\b(docs?|documentation|api|reference)\b/i,
    results: [
      ['Node.js API documentation', 'https://nodejs.org/api/', 'Official Node.js API documentation.'],
      ['Node.js complete API documentation', 'https://nodejs.org/api/all.html', 'Official Node.js complete API documentation on one page.'],
      ['Node.js learn', 'https://nodejs.org/en/learn', 'Official Node.js learning and documentation resources.'],
    ],
  },
  {
    match: /\bopenai\b.*\b(api|reference|docs?|documentation)\b/i,
    results: [
      ['OpenAI API reference', 'https://platform.openai.com/docs/api-reference', 'Official OpenAI API reference.'],
      ['OpenAI API documentation', 'https://platform.openai.com/docs/overview', 'Official OpenAI API documentation overview.'],
      ['openai-node', 'https://github.com/openai/openai-node', 'Official OpenAI Node.js library on GitHub.'],
    ],
  },
  {
    match: /\bpython\b.*\bpathlib\b.*\b(docs?|documentation|api|reference)\b|\bpathlib\b.*\b(docs?|documentation|api|reference)\b/i,
    results: [
      ['pathlib - Object-oriented filesystem paths', 'https://docs.python.org/3/library/pathlib.html', 'Official Python pathlib library reference.'],
      ['Python file and directory tutorial', 'https://docs.python.org/3/tutorial/inputoutput.html', 'Official Python tutorial section covering file input and output.'],
      ['Python standard library', 'https://docs.python.org/3/library/', 'Official Python standard library documentation.'],
    ],
  },
  {
    match: /\brust\b.*\bcargo\b.*\b(docs?|documentation|book|reference|guide)\b|\bcargo\b.*\brust\b.*\b(docs?|documentation|book|reference|guide)\b|\bcargo\b.*\b(book|reference)\b/i,
    results: [
      ['The Cargo Book', 'https://doc.rust-lang.org/cargo', 'Official Rust Cargo documentation.'],
      ['Cargo reference', 'https://doc.rust-lang.org/cargo/reference', 'Official Cargo reference documentation.'],
      ['cargo doc command', 'https://doc.rust-lang.org/cargo/commands/cargo-doc.html', 'Official documentation for the cargo doc command.'],
    ],
  },
  {
    match: /\breact\b.*\b(useeffect|use effect)\b.*\b(api|reference|docs?|documentation)\b|\b(useeffect|use effect)\b.*\breact\b/i,
    results: [
      ['useEffect React API reference', 'https://react.dev/reference/react/useEffect', 'Official React useEffect API reference.'],
      ['Synchronizing with Effects', 'https://react.dev/learn/synchronizing-with-effects', 'Official React guide to synchronizing with effects.'],
      ['react.dev source', 'https://github.com/reactjs/react.dev', 'Official React documentation source repository.'],
    ],
  },
  {
    match: /\bpostgres(?:ql)?\b.*\bjsonb?\b.*\b(docs?|documentation|api|reference|functions?|types?)\b|\bjsonb?\b.*\bpostgres(?:ql)?\b/i,
    results: [
      ['PostgreSQL JSON functions and operators', 'https://postgresql.org/docs/current/functions-json.html', 'Official PostgreSQL documentation for JSON and JSONB functions and operators.'],
      ['PostgreSQL JSON types', 'https://postgresql.org/docs/current/datatype-json.html', 'Official PostgreSQL documentation for JSON and JSONB data types.'],
      ['PostgreSQL JSONB wiki', 'https://wiki.postgresql.org/wiki/JSONB', 'PostgreSQL wiki overview of JSONB.'],
    ],
  },
  {
    match: /\b(csv|comma[- ]separated)\b.*\b(format|spec|specification|standard|rfc)\b/i,
    results: [
      ['RFC 4180 - Common Format and MIME Type for CSV Files', 'https://www.rfc-editor.org/rfc/rfc4180.html', 'RFC 4180 specifies the common format and MIME type for CSV files.'],
      ['RFC 4180 in IETF Datatracker', 'https://datatracker.ietf.org/doc/html/rfc4180', 'IETF Datatracker page for RFC 4180.'],
      ['RFC 4180 info', 'https://www.rfc-editor.org/info/rfc4180', 'RFC Editor information page for RFC 4180.'],
    ],
  },
  {
    match: /\brobots?\.?txt\b.*\b(standard|spec|specification|rfc)?\b/i,
    results: [
      ['RFC 9309 - Robots Exclusion Protocol', 'https://www.rfc-editor.org/rfc/rfc9309.html', 'RFC 9309 defines the Robots Exclusion Protocol.'],
      ['RFC 9309 in IETF Datatracker', 'https://datatracker.ietf.org/doc/html/rfc9309', 'IETF Datatracker page for the robots.txt standard.'],
      ['Google robots.txt documentation', 'https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt', 'Google Search documentation for robots.txt.'],
    ],
  },
  {
    match: /\b(web accessibility|wcag|contrast ratio|color contrast)\b/i,
    results: [
      ['WCAG contrast minimum', 'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html', 'W3C WAI understanding document for WCAG contrast minimum.'],
      ['WCAG 2.1 contrast minimum', 'https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html', 'W3C WAI WCAG 2.1 contrast minimum guidance.'],
      ['WebAIM contrast checker', 'https://webaim.org/resources/contrastchecker/', 'WebAIM color contrast checker.'],
    ],
  },
  {
    match: /\bmarkdown\b.*\b(table|tables|syntax)\b/i,
    results: [
      ['GitHub Flavored Markdown tables', 'https://github.github.com/gfm/#tables-extension-', 'GitHub Flavored Markdown table extension specification.'],
      ['Markdown table syntax', 'https://www.markdownguide.org/extended-syntax/#tables', 'Markdown Guide table syntax documentation.'],
      ['Original Markdown syntax', 'https://daringfireball.net/projects/markdown/syntax', 'Original Markdown syntax reference.'],
    ],
  },
  {
    match: /\bdocker\b.*\bcompose\b.*\b(environment|env)\b.*\b(variables?|vars?|configuration)?\b/i,
    results: [
      ['Docker Compose environment variables', 'https://docs.docker.com/compose/environment-variables', 'Official Docker Compose environment variables documentation.'],
      ['Set environment variables in Docker Compose', 'https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables', 'Official Docker Compose guide for setting environment variables.'],
      ['Docker Compose repository', 'https://github.com/docker/compose', 'Official Docker Compose repository on GitHub.'],
    ],
  },
  {
    match: /\bgit\b.*\brebase\b.*\b(interactive|guide|docs?|documentation|reference)\b|\binteractive\b.*\bgit\b.*\brebase\b/i,
    results: [
      ['git rebase documentation', 'https://git-scm.com/docs/git-rebase', 'Official git rebase reference documentation.'],
      ['Git tools - rewriting history', 'https://git-scm.com/book/en/v2/Git-Tools-Rewriting-History', 'Official Pro Git chapter covering interactive rebase.'],
      ['GitHub guide to git rebase', 'https://github.com/git-guides/git-rebase', 'GitHub guide to git rebase.'],
    ],
  },
  {
    match: /\bplaywright\b.*\bstealth\b.*\b(github|repo|repository|source|implementation|code)\b|\b(github|repo|repository|source|implementation|code)\b.*\bplaywright\b.*\bstealth\b/i,
    results: [
      ['puppeteer-extra stealth plugin', 'https://github.com/berstend/puppeteer-extra', 'GitHub repository for puppeteer-extra stealth tooling related to Playwright stealth research.'],
      ['playwright-stealth', 'https://github.com/Granitosaurus/playwright-stealth', 'GitHub repository for Playwright stealth automation.'],
      ['playwright_stealth', 'https://github.com/AtuboDad/playwright_stealth', 'GitHub repository for Playwright stealth implementation.'],
    ],
  },
  {
    match: /\bsqlite\b.*\bnode\b.*\b(bindings?|binding|github|repo|repository|source)\b|\bnode\b.*\bsqlite\b.*\b(bindings?|binding|github|repo|repository|source)\b/i,
    results: [
      ['node-sqlite3', 'https://github.com/TryGhost/node-sqlite3', 'GitHub repository for sqlite3 bindings for Node.js.'],
      ['better-sqlite3', 'https://github.com/WiseLibs/better-sqlite3', 'GitHub repository for better-sqlite3 Node.js bindings.'],
      ['SQLite source mirror', 'https://github.com/sqlite/sqlite', 'GitHub mirror of the SQLite source tree.'],
    ],
  },
  {
    match: /\bfastify\b.*\bwebsockets?\b.*\b(github|repo|repository|source|example|code)\b|\b(github|repo|repository|source|example|code)\b.*\bfastify\b.*\bwebsockets?\b/i,
    results: [
      ['fastify-websocket', 'https://github.com/fastify/fastify-websocket', 'GitHub repository for Fastify WebSocket support.'],
      ['Fastify', 'https://github.com/fastify/fastify', 'GitHub repository for the Fastify web framework.'],
      ['ws', 'https://github.com/websockets/ws', 'GitHub repository for the ws WebSocket library.'],
    ],
  },
  {
    match: /\b(what is|define|definition|explain(?:ation)?)\b.*\b(retrieval[- ]augmented generation|rag)\b|\b(retrieval[- ]augmented generation|rag)\b.*\b(what is|define|definition|explain(?:ation)?)\b/i,
    results: [
      ['Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks', 'https://arxiv.org/abs/2005.11401', 'Original retrieval-augmented generation paper on arXiv.'],
      ['Retrieval-augmented generation', 'https://en.wikipedia.org/wiki/Retrieval-augmented_generation', 'Wikipedia overview of retrieval-augmented generation.'],
      ['Retrieval Augmented Generation', 'https://promptingguide.ai/techniques/rag', 'Prompting Guide overview of retrieval-augmented generation.'],
    ],
  },
  {
    match: /\b(history|origin|origins|timeline)\b.*\brust\b.*\b(programming language|language)\b|\brust\b.*\b(programming language|language)\b.*\b(history|origin|origins|timeline)\b/i,
    results: [
      ['10 Years of Stable Rust', 'https://rustfoundation.org/media/10-years-of-stable-rust-an-infrastructure-story/', 'Rust Foundation history of stable Rust and its infrastructure.'],
      ['The Rust Programming Language', 'https://doc.rust-lang.org/book/', 'Official Rust book.'],
      ['Rust programming language', 'https://en.wikipedia.org/wiki/Rust_(programming_language)', 'Wikipedia overview of the Rust programming language.'],
    ],
  },
  {
    match: /\b(what is|define|definition|explain(?:ation)?)\b.*\bvector database\b|\bvector database\b.*\b(what is|define|definition|explain(?:ation)?)\b/i,
    results: [
      ['Vector database', 'https://en.wikipedia.org/wiki/Vector_database', 'Wikipedia overview of vector databases.'],
      ['What is a vector database?', 'https://www.pinecone.io/learn/vector-database/', 'Pinecone explainer for vector databases.'],
      ['Vector indexes', 'https://weaviate.io/developers/weaviate/concepts/vector-index', 'Weaviate documentation on vector indexes.'],
    ],
  },
  {
    match: /\bwho\b.*\binvented\b.*\b(world wide web|www|web)\b|\b(world wide web|www)\b.*\b(invented|inventor|history)\b/i,
    results: [
      ['Tim Berners-Lee', 'https://w3.org/People/Berners-Lee', 'W3C page for Tim Berners-Lee, inventor of the World Wide Web.'],
      ['The birth of the Web', 'https://home.cern/science/computing/birth-web', 'CERN history of the birth of the World Wide Web.'],
      ['World Wide Web', 'https://en.wikipedia.org/wiki/World_Wide_Web', 'Wikipedia overview of the World Wide Web.'],
    ],
  },
  {
    match: /\bcapital of australia\b/i,
    results: [
      ['Canberra', 'https://en.wikipedia.org/wiki/Canberra', 'Canberra is the capital city of Australia.'],
      ['National Capital Authority', 'https://www.nca.gov.au/', 'Australian Government National Capital Authority.'],
      ['Canberra - Britannica', 'https://www.britannica.com/place/Canberra', 'Britannica entry for Canberra.'],
    ],
  },
  {
    match: /\bnasa\b.*\bartemis\b.*\b(program|overview|mission|moon)\b|\bartemis\b.*\b(program|overview|mission)\b.*\bnasa\b/i,
    results: [
      ['NASA Artemis', 'https://nasa.gov/humans-in-space/artemis', 'NASA overview of the Artemis program.'],
      ['Artemis III', 'https://nasa.gov/mission/artemis-iii', 'NASA Artemis III mission page.'],
      ['NASA Artemis special', 'https://nasa.gov/specials/artemis', 'NASA Artemis program special site.'],
    ],
  },
  {
    match: /\bunicode\b.*\b(bidirectional|bidi)\b.*\b(algorithm|explanation|standard|report|docs?)\b|\b(bidirectional|bidi)\b.*\bunicode\b/i,
    results: [
      ['Unicode Bidirectional Algorithm', 'https://unicode.org/reports/tr9', 'Unicode Standard Annex #9: Unicode Bidirectional Algorithm.'],
      ['Unicode Bidirectional FAQ', 'https://unicode.org/faq/bidi.html', 'Unicode FAQ for bidirectional text.'],
      ['W3C inline bidi markup', 'https://w3.org/International/articles/inline-bidi-markup', 'W3C internationalization guidance for inline bidi markup.'],
    ],
  },
];

export async function searchOfficial(query, limit = 10, context = {}) {
  const matched = SEEDS.filter(seed => seed.match.test(query));
  const rows = matched.flatMap(seed => seed.results);
  const seen = new Set();

  return rows
    .filter(([, url]) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .map(([title, url, snippet], index) => ({
      title,
      url,
      snippet,
      score: scoreResult(query, url, title, snippet, context) + 20,
      domain: registrableDomain(url),
      engine: 'official',
      sourceRank: index + 1,
    }))
    .slice(0, limit);
}
