import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'wikidata-entity',
  version: '1.0.0',
});

server.registerTool('entity_lookup', {
  description: 'Look up an entity via Wikidata and get a Wikipedia summary for context enrichment',
  inputSchema: {
    query: z.string().describe('Entity name to look up (person, organization, place, event)'),
    language: z.string().optional().default('en').describe('Language code (default: en)'),
  },
}, async ({ query, language }) => {
  const lang = language || 'en';

  // Step 1: Search Wikidata for the entity
  const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=${lang}&limit=1&format=json`;
  const searchResp = await fetch(searchUrl, { signal: AbortSignal.timeout(5000) });
  if (!searchResp.ok) throw new Error(`Wikidata search returned ${searchResp.status}`);
  const searchData = await searchResp.json();
  const entity = searchData?.search?.[0];

  if (!entity) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ found: false, query }) }],
      structuredContent: { found: false, query },
    };
  }

  // Step 2: Get Wikipedia summary for richer context
  let wikipediaSummary = '';
  try {
    const wikiUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(entity.label)}`;
    const wikiResp = await fetch(wikiUrl, { signal: AbortSignal.timeout(5000) });
    if (wikiResp.ok) {
      const wikiData = await wikiResp.json();
      wikipediaSummary = wikiData?.extract || '';
    }
  } catch {
    // Wikipedia summary is optional enrichment — don't fail the whole lookup
  }

  // Step 3: Get basic entity properties from Wikidata
  let properties = {};
  try {
    const entityUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entity.id}&props=claims&format=json`;
    const entityResp = await fetch(entityUrl, { signal: AbortSignal.timeout(5000) });
    if (entityResp.ok) {
      const entityData = await entityResp.json();
      const claims = entityData?.entities?.[entity.id]?.claims || {};
      // Extract key property IDs: P31 (instance of), P17 (country), P159 (HQ)
      const keyProps = { P31: 'instance_of', P17: 'country', P159: 'headquarters' };
      for (const [propId, label] of Object.entries(keyProps)) {
        const claim = claims[propId]?.[0]?.mainsnak?.datavalue?.value;
        if (claim?.id) properties[label] = claim.id;
        else if (claim) properties[label] = String(claim);
      }
    }
  } catch {
    // Property fetch is optional
  }

  const result = {
    found: true,
    wikidata_id: entity.id,
    label: entity.label || query,
    description: entity.description || '',
    type: entity.match?.type || 'item',
    wikipedia_summary: wikipediaSummary,
    properties,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
