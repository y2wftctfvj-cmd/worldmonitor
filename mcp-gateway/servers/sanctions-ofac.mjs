import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// In-memory SDN cache for CSV fallback
let sdnCache = null;
let sdnCacheTime = 0;
const SDN_CACHE_TTL = 3600_000; // 1 hour

async function searchOfacApi(query, program) {
  const params = new URLSearchParams({ name: query, score: '80' });
  if (program) params.set('program', program);
  const url = `https://sanctionslist.ofac.treas.gov/api/search?${params}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return null;
  const data = await resp.json();
  return (data?.results || data?.matches || []).map(item => ({
    name: item.name || item.entityName || '',
    type: item.type || item.entityType || 'Unknown',
    program: item.program || item.programs?.join(', ') || '',
    aliases: item.aliases || item.akaList?.map(a => a.name) || [],
    id: item.id || item.uid || '',
  }));
}

async function searchSdnCsv(query) {
  const now = Date.now();
  // Refresh cache if stale
  if (!sdnCache || now - sdnCacheTime > SDN_CACHE_TTL) {
    try {
      const resp = await fetch('https://www.treasury.gov/ofac/downloads/sdn.csv', {
        signal: AbortSignal.timeout(15000),
      });
      if (resp.ok) {
        sdnCache = await resp.text();
        sdnCacheTime = now;
      }
    } catch {
      // Keep stale cache if download fails
    }
  }
  if (!sdnCache) return [];

  const queryLower = query.toLowerCase();
  const lines = sdnCache.split('\n');
  const matches = [];

  for (const line of lines) {
    if (line.toLowerCase().includes(queryLower)) {
      const parts = line.split(',').map(p => p.replace(/^"|"$/g, '').trim());
      if (parts.length >= 4) {
        matches.push({
          name: parts[1] || parts[0] || '',
          type: parts[2] || 'Unknown',
          program: parts[3] || '',
          aliases: [],
          id: parts[0] || '',
        });
      }
      if (matches.length >= 20) break;
    }
  }
  return matches;
}

const server = new McpServer({
  name: 'sanctions-ofac',
  version: '1.0.0',
});

server.registerTool('sanctions_search', {
  description: 'Search the OFAC SDN sanctions list by entity name',
  inputSchema: {
    query: z.string().describe('Name to search for'),
    program: z.string().optional().describe('Sanctions program filter (e.g., "IRAN", "SDGT")'),
  },
}, async ({ query, program }) => {
  // Try the JSON API first, fall back to CSV search
  let results = await searchOfacApi(query, program);
  if (results === null) {
    results = await searchSdnCsv(query);
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ results }) }],
    structuredContent: { results },
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
