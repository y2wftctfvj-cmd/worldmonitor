import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_KEY = process.env.DATALASTIC_API_KEY || '';
const BASE_URL = 'https://api.datalastic.com/api/v0';

function formatVessel(v) {
  return {
    mmsi: v.mmsi || '',
    name: v.name || v.vessel_name || '',
    type: v.type || v.vessel_type || '',
    flag: v.flag || v.country || '',
    latitude: v.lat || v.latitude || null,
    longitude: v.lon || v.longitude || null,
    speed: v.speed || null,
    heading: v.heading || null,
    destination: v.destination || '',
  };
}

function noKeyResponse(toolName) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ vessels: [], message: `DATALASTIC_API_KEY not set. ${toolName} requires a free API key from datalastic.com` }) }],
    structuredContent: { vessels: [], message: `DATALASTIC_API_KEY not set. ${toolName} requires a free API key from datalastic.com` },
  };
}

const server = new McpServer({
  name: 'maritime',
  version: '1.0.0',
});

server.registerTool('maritime_vessels', {
  description: 'Find vessels in a geographic bounding box',
  inputSchema: {
    lamin: z.string().describe('Minimum latitude'),
    lomin: z.string().describe('Minimum longitude'),
    lamax: z.string().describe('Maximum latitude'),
    lomax: z.string().describe('Maximum longitude'),
  },
}, async ({ lamin, lomin, lamax, lomax }) => {
  if (!API_KEY) return noKeyResponse('maritime_vessels');

  const url = `${BASE_URL}/vessel_find?api-key=${API_KEY}&lat_min=${lamin}&lat_max=${lamax}&lon_min=${lomin}&lon_max=${lomax}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`Datalastic API returned ${resp.status}`);
  const data = await resp.json();
  const vessels = (data?.data || []).map(formatVessel);

  return {
    content: [{ type: 'text', text: JSON.stringify({ vessels }) }],
    structuredContent: { vessels },
  };
});

server.registerTool('maritime_port_activity', {
  description: 'Get vessel activity for a named port',
  inputSchema: {
    port_name: z.string().describe('Port name (e.g., "Strait of Hormuz", "Port of Shanghai")'),
  },
}, async ({ port_name }) => {
  if (!API_KEY) return noKeyResponse('maritime_port_activity');

  const url = `${BASE_URL}/vessel_find?api-key=${API_KEY}&keyword=${encodeURIComponent(port_name)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`Datalastic API returned ${resp.status}`);
  const data = await resp.json();
  const vessels = (data?.data || []).map(formatVessel);

  return {
    content: [{ type: 'text', text: JSON.stringify({ vessels, port: port_name }) }],
    structuredContent: { vessels, port: port_name },
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
