#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "tistory-mcp",
  version: "0.0.1",
});

server.registerTool(
  "ping",
  {
    title: "Ping",
    description: "Health check — returns 'pong'.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: "pong" }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
