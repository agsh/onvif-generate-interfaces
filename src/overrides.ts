import { parse } from 'node:path';

/**
 * Library-specific patches applied on top of a pure XSD/WSDL → TypeScript core.
 * Keep ONVIF (or any consumer) quirks here — not inside Processor methods.
 */
export interface GeneratorOverrides {
  /**
   * Output module name for a source file (without `.ts`).
   * Default: basename of the path.
   */
  resolveFileName?: (filePath: string) => string;

  /**
   * Rename XSD local type/element names before emit
   * (e.g. `Object` → `OnvifObject` to avoid clashing with JS `Object`).
   */
  renameTypes?: Record<string, string>;

  /**
   * Force field optionality by XSD local name (and optional output file filter).
   */
  fields?: Array<{
    /** XSD attribute / element local name (before camelCase) */
    name: string;
    use: 'optional' | 'required';
    /** Limit to these generated file names; omit = all files */
    fileName?: string | string[];
  }>;

  /**
   * Skip emitting element→interface aliases that collide or are unused by the library.
   */
  skipElements?: Array<{
    fileName: string;
    name: string;
    /** When set, only skip if element.meta.type matches */
    type?: string;
  }>;

  /**
   * Drop types from the import list for matching source files
   * (e.g. keep native `Date` in event modules instead of importing a generated one).
   */
  suppressImports?: Array<{
    /** Substring match against the source file path */
    filePathIncludes?: string;
    /** Exact generated file name match */
    fileName?: string;
    types: string[];
  }>;

  /**
   * Index signature key kinds emitted for `xs:any namespace="##any"`.
   * ONVIF runtime uses `Symbol('any')` (`xsany`), so both string and symbol are needed.
   */
  extensionIndexKeyTypes?: Array<'string' | 'symbol'>;
}

const DEFAULT_EXTENSION_INDEX_KEYS: Array<'string' | 'symbol'> = ['string'];

/** Defaults when no overrides object is provided. */
export const emptyOverrides: Required<
  Pick<GeneratorOverrides, 'extensionIndexKeyTypes'>
> &
  GeneratorOverrides = {
  extensionIndexKeyTypes: DEFAULT_EXTENSION_INDEX_KEYS,
};

/**
 * Overrides for the `onvif` TypeScript library.
 * Document *why* each rule exists — they encode library API choices, not XSD.
 */
export const onvifOverrides: GeneratorOverrides = {
  resolveFileName(filePath) {
    const base = parse(filePath).name;
    // ver20 services are emitted as `*.2.ts` next to ver10 modules of the same basename
    return filePath.includes('ver2') ? `${base}.2` : base;
  },

  renameTypes: {
    // JS / DOM `Object` would shadow; keep ONVIF analytics object under a distinct name
    Object: 'OnvifObject',
  },

  fields: [
    {
      // Library fills profile from active source when the caller omits ProfileToken
      name: 'ProfileToken',
      use: 'optional',
    },
  ],

  skipElements: [
    {
      // Alias would collide with the real Capabilities shape used by device service
      fileName: 'devicemgmt',
      name: 'Capabilities',
      type: 'tds:DeviceServiceCapabilities',
    },
  ],

  suppressImports: [
    {
      // Event payloads use native JS Date from xs:dateTime — do not import a generated Date
      filePathIncludes: 'event',
      types: ['Date'],
    },
  ],

  extensionIndexKeyTypes: ['string', 'symbol'],
};

export function resolveOutputFileName(filePath: string, overrides: GeneratorOverrides): string {
  if (overrides.resolveFileName) {
    return overrides.resolveFileName(filePath);
  }
  return parse(filePath).name;
}

export function renameType(name: string, overrides: GeneratorOverrides): string {
  return overrides.renameTypes?.[name] ?? name;
}

export function shouldSkipElement(
  fileName: string,
  elementName: string,
  elementType: string | undefined,
  overrides: GeneratorOverrides,
): boolean {
  return (overrides.skipElements ?? []).some(
    (rule) =>
      rule.fileName === fileName &&
      rule.name === elementName &&
      (rule.type === undefined || rule.type === elementType),
  );
}

export function fieldUseOverride(
  fileName: string,
  fieldName: string | undefined,
  overrides: GeneratorOverrides,
): 'optional' | 'required' | undefined {
  if (!fieldName) {
    return undefined;
  }
  for (const rule of overrides.fields ?? []) {
    if (rule.name !== fieldName) {
      continue;
    }
    if (rule.fileName !== undefined) {
      const files = Array.isArray(rule.fileName) ? rule.fileName : [rule.fileName];
      if (!files.includes(fileName)) {
        continue;
      }
    }
    return rule.use;
  }
  return undefined;
}

export function applySuppressImports(
  filePath: string,
  fileName: string,
  typesToImport: Set<string>,
  overrides: GeneratorOverrides,
): void {
  for (const rule of overrides.suppressImports ?? []) {
    const pathOk = rule.filePathIncludes ? filePath.includes(rule.filePathIncludes) : true;
    const nameOk = rule.fileName ? rule.fileName === fileName : true;
    if (pathOk && nameOk) {
      for (const type of rule.types) {
        typesToImport.delete(type);
      }
    }
  }
}
