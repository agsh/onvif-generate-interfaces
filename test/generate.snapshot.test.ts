/**
 * Golden / snapshot tests for the ONVIF interface generator.
 *
 * Flow:
 *  1. Run InterfaceProcessor over test/fixtures/specs (tiny hand-written XSD/WSDL).
 *  2. Compare every generated *.ts file to test/fixtures/golden/*.ts byte-for-byte.
 *
 * Update goldens after intentional generator changes:
 *   UPDATE_GOLDENS=1 npm test
 *
 * What the fixtures exercise (see comments inside each .xsd/.wsdl):
 *  - mini.xsd      — enums, lists, extension, xs:any, ProfileToken, Object→OnvifObject,
 *                    xs:choice / xs:all / xs:union / xs:simpleContent / group+attributeGroup,
 *                    ##other / ##targetNamespace
 *  - ptz.wsdl      — ver20 → ptz.2.ts naming, Capabilities, empty complexType
 *  - devicemgmt    — skipElements for Capabilities alias
 *  - event.wsdl    — suppressImports keeps native Date (no Date import)
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, before, after } from 'node:test';
import { InterfaceProcessor } from '../src/generate';
import { onvifOverrides } from '../src/overrides';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPECS_DIR = join(__dirname, 'fixtures/specs');
const GOLDEN_DIR = join(__dirname, 'fixtures/golden');
const UPDATE = process.env.UPDATE_GOLDENS === '1' || process.argv.includes('--update-goldens');

function listTsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort();
}

describe('generator golden snapshots', () => {
  let outDir: string;
  let generated: string[];

  before(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'onvif-gen-'));
    await new InterfaceProcessor({ overrides: onvifOverrides, silent: true }).start(SPECS_DIR, outDir);
    generated = listTsFiles(outDir);
  });

  after(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('emits the expected set of module files', () => {
    // Fixed set so renaming/dropping a module fails the suite loudly
    assert.deepEqual(generated, ['basics.ts', 'devicemgmt.ts', 'event.ts', 'mini.ts', 'ptz.2.ts']);
  });

  it('matches golden files (or updates them when UPDATE_GOLDENS=1)', () => {
    mkdirSync(GOLDEN_DIR, { recursive: true });

    if (UPDATE) {
      for (const stale of listTsFiles(GOLDEN_DIR)) {
        if (!generated.includes(stale)) {
          rmSync(join(GOLDEN_DIR, stale), { force: true });
        }
      }
      for (const file of generated) {
        writeFileSync(join(GOLDEN_DIR, file), readFileSync(join(outDir, file)));
      }
      // Still assert after update so the run is green and documents the new baseline
    }

    const goldens = listTsFiles(GOLDEN_DIR);
    assert.deepEqual(
      generated,
      goldens,
      `Generated files differ from golden set.\n` +
        `  generated: ${generated.join(', ')}\n` +
        `  golden:    ${goldens.join(', ')}\n` +
        `Re-run with UPDATE_GOLDENS=1 if the change is intentional.`,
    );

    const diffs: string[] = [];
    for (const file of generated) {
      const actual = readFileSync(join(outDir, file), 'utf8');
      const expected = readFileSync(join(GOLDEN_DIR, file), 'utf8');
      if (actual !== expected) {
        diffs.push(file);
      }
    }

    assert.equal(
      diffs.length,
      0,
      `Content drift in: ${diffs.join(', ')}\n` +
        `Inspect the temp output vs test/fixtures/golden, then UPDATE_GOLDENS=1 if intentional.`,
    );
  });

  it('applies onvifOverrides: ProfileToken optional, OnvifObject rename, no Date import in event', () => {
    const mini = readFileSync(join(outDir, 'mini.ts'), 'utf8');
    const event = readFileSync(join(outDir, 'event.ts'), 'utf8');
    const device = readFileSync(join(outDir, 'devicemgmt.ts'), 'utf8');
    const ptz = readFileSync(join(outDir, 'ptz.2.ts'), 'utf8');

    assert.match(mini, /profileToken\?:/);
    assert.match(mini, /export interface OnvifObject/);
    assert.doesNotMatch(mini, /export interface Object\b/);
    // tt:Object reference resolves via namespace strip + renameTypes
    assert.match(mini, /tracked\?: OnvifObject/);

    assert.match(mini, /\[key: string\]: unknown/);
    assert.match(mini, /\[key: symbol\]: unknown/);

    assert.doesNotMatch(event, /import\s*\{[^}]*\bDate\b/);
    assert.match(event, /utcTime:\s*Date/);

    // skipElements: Capabilities alias to DeviceServiceCapabilities must be absent;
    // DeviceServiceCapabilities itself remains.
    assert.match(device, /export interface DeviceServiceCapabilities/);
    assert.doesNotMatch(device, /export interface Capabilities\b/);

    assert.match(ptz, /export interface Capabilities/);
    assert.match(ptz, /profileToken\?:/);
  });

  it('maps xs:choice: optional branches, unbounded → arrays', () => {
    const mini = readFileSync(join(outDir, 'mini.ts'), 'utf8');

    // Top-level choice → exclusive optional fields
    assert.match(mini, /export interface SerialData \{[^}]*binary\?: string;[^}]*string\?: string;/s);

    // Unbounded choice in sequence → array fields + index signatures from xs:any
    // "PTZ" keeps leading capitals (second char is uppercase) → property name PTZ
    assert.match(mini, /export interface MetadataStream \{[^}]*PTZ\?: PTZStatus\[\];[^}]*event\?: string\[\];/s);

    // Exclusive choice + sibling xs:any
    assert.match(mini, /export interface PresetDetail \{[^}]*presetToken\?: ReferenceToken;[^}]*home\?: boolean;/s);
  });

  it('maps union, simpleContent, all, group/attributeGroup, ##other/##targetNamespace', () => {
    const mini = readFileSync(join(outDir, 'mini.ts'), 'utf8');

    assert.match(mini, /export type Direction = ExtendedDirection/);
    assert.match(mini, /export interface CertificateUsage \{[^}]*_: string;[^}]*critical: boolean;/s);
    assert.match(mini, /export interface UnorderedPair \{[^}]*left: string;[^}]*right\?: string;/s);
    assert.match(mini, /export interface NamedPoint \{[^}]*token: ReferenceToken;[^}]*x: number;[^}]*y: number;/s);
    assert.match(mini, /export interface FrameExtension \{[^}]*motionInCells\?: boolean;[^}]*\[key: string\]: unknown;/s);
    assert.match(mini, /export interface FrameExtension2 \{[^}]*\[key: string\]: unknown;/s);
  });
});
