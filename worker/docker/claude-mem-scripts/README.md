# Vendored: claude-mem MCP server

This directory holds a pre-bundled copy of `mcp-server.cjs` from the
claude-mem plugin (single self-contained file). It's COPY'd into
`/opt/claude-mem/scripts/` inside the worker image so the agent's
`Options.mcpServers["mcp-search"]` can spawn it via stdio without
relying on a host-mounted plugin install.

To refresh from a newer claude-mem version:

```bash
cp ~/.claude/plugins/cache/thedotmack/claude-mem/<version>/scripts/mcp-server.cjs ./
```

Source repo: https://github.com/thedotmack/claude-mem
