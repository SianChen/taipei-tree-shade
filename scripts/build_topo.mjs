// Convert the slimmed village GeoJSON to TopoJSON: shared borders are stored once and coordinates
// are quantized (1e5 steps across Taipei, about 0.3 m), which halves the gzipped download.
// Usage: node scripts/build_topo.mjs <in.geojson> <out.topo.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { topology } from 'topojson-server';

const [input, output] = process.argv.slice(2);
const villages = JSON.parse(readFileSync(input, 'utf8'));
writeFileSync(output, JSON.stringify(topology({ villages }, 1e5)));
