import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Region bounding boxes for earthquake search [south, west, north, east]
const REGION_BOXES = {
  'middle east':    [20, 30, 42, 65],
  'pacific ring':   [-60, 100, 60, -60],
  'mediterranean':  [30, -10, 48, 40],
  'south asia':     [5, 60, 40, 100],
  'east asia':      [20, 95, 50, 150],
  'central america': [5, -95, 20, -75],
  'europe':         [35, -10, 72, 45],
};

const server = new McpServer({
  name: 'usgs-earthquake',
  version: '1.0.0',
});

server.registerTool('earthquake_recent', {
  description: 'Get recent M4.5+ earthquakes from the last 24 hours',
  inputSchema: {},
}, async () => {
  const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=4.5&orderby=time&limit=20';
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`USGS API returned ${resp.status}`);
  const data = await resp.json();
  const features = (data?.features || []).map(f => ({
    magnitude: f.properties?.mag,
    place: f.properties?.place,
    depth: f.geometry?.coordinates?.[2],
    time: new Date(f.properties?.time).toISOString(),
    coordinates: [f.geometry?.coordinates?.[1], f.geometry?.coordinates?.[0]],
    id: f.id,
    url: f.properties?.url,
  }));
  return {
    content: [{ type: 'text', text: JSON.stringify({ features }) }],
    structuredContent: { features },
  };
});

server.registerTool('earthquake_search', {
  description: 'Search USGS earthquakes by region, magnitude, and time window',
  inputSchema: {
    region: z.string().optional().describe('Region name (e.g., "middle east", "pacific ring")'),
    minmagnitude: z.string().optional().default('4.5').describe('Minimum magnitude'),
    days_back: z.string().optional().default('7').describe('Number of days to look back'),
  },
}, async ({ region, minmagnitude, days_back }) => {
  const endtime = new Date().toISOString();
  const starttime = new Date(Date.now() - Number(days_back || 7) * 86400000).toISOString();
  let url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=${minmagnitude || '4.5'}&starttime=${starttime}&endtime=${endtime}&orderby=time&limit=20`;

  const box = region ? REGION_BOXES[region.toLowerCase()] : null;
  if (box) {
    url += `&minlatitude=${box[0]}&minlongitude=${box[1]}&maxlatitude=${box[2]}&maxlongitude=${box[3]}`;
  }

  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`USGS API returned ${resp.status}`);
  const data = await resp.json();
  const features = (data?.features || []).map(f => ({
    magnitude: f.properties?.mag,
    place: f.properties?.place,
    depth: f.geometry?.coordinates?.[2],
    time: new Date(f.properties?.time).toISOString(),
    coordinates: [f.geometry?.coordinates?.[1], f.geometry?.coordinates?.[0]],
    id: f.id,
    url: f.properties?.url,
  }));
  return {
    content: [{ type: 'text', text: JSON.stringify({ features }) }],
    structuredContent: { features },
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
