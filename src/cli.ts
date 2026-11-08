import { lstatSync } from 'fs';
import { mkdirSync } from 'node:fs';
import { InterfaceProcessor } from './generate';

const [, , sources, out] = process.argv;

if (out !== undefined && lstatSync(sources).isDirectory()) {
  mkdirSync(out, { recursive: true });
  new InterfaceProcessor().start(sources, out).catch(console.error);
} else {
  console.log(`Usage: cli.ts <source> <output>
  <source> - ONVIF specs source directory
  <output> - generated interfaces output directory
  Example: cli.ts "../specs/wsdl/ver20" "./onvif/interfaces"`);
  process.exit(1);
}
