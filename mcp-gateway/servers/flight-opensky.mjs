import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Rate limiter: OpenSky free tier allows 1 request per 10 seconds
let lastCallAt = 0;

// Hotspot bounding boxes [lamin, lomin, lamax, lomax]
const REGION_BOXES = {
  'middle east':      [20, 30, 42, 65],
  'taiwan strait':    [21, 115, 27, 125],
  'baltic':           [53, 12, 66, 30],
  'black sea':        [40, 27, 47, 42],
  'korean peninsula': [33, 124, 43, 132],
  'south china sea':  [5, 105, 25, 122],
};

// Military callsign prefixes for pattern detection
const MILITARY_PREFIXES = [
  'RCH', 'EVAC', 'JAKE', 'REACH', 'DOOM', 'VICE', 'BISON', 'GHOST',
  'KING', 'FURY', 'TOPCAT', 'HAVOC', 'BLADE', 'NOBLE', 'FORTE',
  'NATO', 'RAF', 'IAF', 'USAF', 'NAVY', 'ARMY',
];

async function rateLimitedFetch(url) {
  const now = Date.now();
  const elapsed = now - lastCallAt;
  if (elapsed < 10_000) {
    await new Promise(resolve => setTimeout(resolve, 10_000 - elapsed));
  }
  lastCallAt = Date.now();
  return fetch(url, { signal: AbortSignal.timeout(15000) });
}

function formatStates(states) {
  return (states || []).map(s => ({
    icao24: s[0],
    callsign: (s[1] || '').trim(),
    origin_country: s[2],
    latitude: s[6],
    longitude: s[5],
    altitude: s[7],
    velocity: s[9],
    on_ground: s[8],
  }));
}

const server = new McpServer({
  name: 'flight-opensky',
  version: '1.0.0',
});

server.registerTool('flights_region', {
  description: 'Get current aircraft positions in a geographic bounding box',
  inputSchema: {
    lamin: z.string().describe('Minimum latitude'),
    lomin: z.string().describe('Minimum longitude'),
    lamax: z.string().describe('Maximum latitude'),
    lomax: z.string().describe('Maximum longitude'),
  },
}, async ({ lamin, lomin, lamax, lomax }) => {
  const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
  const resp = await rateLimitedFetch(url);
  if (!resp.ok) throw new Error(`OpenSky API returned ${resp.status}`);
  const data = await resp.json();
  const flights = formatStates(data?.states);
  return {
    content: [{ type: 'text', text: JSON.stringify({ flights }) }],
    structuredContent: { flights },
  };
});

server.registerTool('flights_military', {
  description: 'Detect military aircraft in a hotspot region by callsign pattern matching',
  inputSchema: {
    region: z.string().optional().default('middle east').describe('Hotspot region name'),
  },
}, async ({ region }) => {
  const box = REGION_BOXES[(region || 'middle east').toLowerCase()];
  if (!box) {
    const available = Object.keys(REGION_BOXES).join(', ');
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Unknown region. Available: ${available}`, flights: [] }) }],
      structuredContent: { error: `Unknown region. Available: ${available}`, flights: [] },
    };
  }

  const url = `https://opensky-network.org/api/states/all?lamin=${box[0]}&lomin=${box[1]}&lamax=${box[2]}&lomax=${box[3]}`;
  const resp = await rateLimitedFetch(url);
  if (!resp.ok) throw new Error(`OpenSky API returned ${resp.status}`);
  const data = await resp.json();

  // Filter to military callsign patterns
  const allFlights = formatStates(data?.states);
  const military = allFlights.filter(f => {
    const cs = (f.callsign || '').toUpperCase();
    return MILITARY_PREFIXES.some(prefix => cs.startsWith(prefix));
  });

  return {
    content: [{ type: 'text', text: JSON.stringify({ flights: military, total_in_region: allFlights.length }) }],
    structuredContent: { flights: military, total_in_region: allFlights.length },
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
