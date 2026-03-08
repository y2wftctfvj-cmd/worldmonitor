import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'mcp-echo-server',
  version: '1.0.0',
});

server.registerTool('echo_tool', {
  description: 'Echo test payloads for gateway validation',
  inputSchema: {
    query: z.string().default(''),
  },
  outputSchema: {
    results: z.array(z.object({
      title: z.string(),
      url: z.string(),
    })),
  },
}, async ({ query }) => ({
  content: [{
    type: 'text',
    text: JSON.stringify({
      results: [{ title: `Echo ${query}`, url: `https://example.test/${encodeURIComponent(query)}` }],
    }),
  }],
  structuredContent: {
    results: [{ title: `Echo ${query}`, url: `https://example.test/${encodeURIComponent(query)}` }],
  },
}));

const transport = new StdioServerTransport();
await server.connect(transport);
