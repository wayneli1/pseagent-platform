# Third-Party Notices

## LLM Wiki

- Project: `llm_wiki`
- Repository: https://github.com/nashsu/llm_wiki
- Recorded reference revision: `e8bdec6e81e65a25c9862638515f3edb4f59bd1f`
- License: GNU General Public License v3.0

The PSEAgent design references LLM Wiki's agent loop, search, page-reading and citation boundaries. No upstream application source is vendored in the initial platform commit. Any later adapted implementation must retain the applicable GPL-3.0 notices and comply with the license in `LICENSE`.

## Lunkr MCP protocol reference

- Project: `lunkr-mcp`
- Source: user-provided export `lunkr-mcp-export-20260226_163948.zip`
- License marker: MIT

The direct Lunkr integration uses the export as a protocol reference for authentication,
session exchange, HTTPS APIs and Socket.IO framing. It implements only the minimum
private-message client required by PSEAgent and does not vendor the MCP server, API
catalog, command-line binary or generated build output.
