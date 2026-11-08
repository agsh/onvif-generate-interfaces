import ts from 'typescript';
import { BASICS_FILENAME, exportModifier } from './constants';
import { emptyOverrides, GeneratorOverrides, renameType } from './overrides';
import { Links } from './schema-types';

/** Native TS / utility names that must not be imported from generated modules. */
export const NATIVE_TYPES = new Set(['Date', 'Buffer', 'Promise', 'Array', 'Record', 'Map', 'Set']);

/**
 * Explicit XSD → TS mappings (builtins / known foreign types).
 * Lexical string types (hex/base64/QName) map to `string` — that is what xml2js yields.
 * Open / foreign types we do not generate stay `unknown`.
 */
const BUILTIN_TYPES: Readonly<Record<string, string>> = {
  'xs:double': 'number',
  'xs:float': 'number',
  'xs:int': 'number',
  'xs:integer': 'number',
  'xs:short': 'number',
  'xs:signedInt': 'number',
  'xs:unsignedInt': 'number',
  'xs:unsignedShort': 'number',
  'xs:nonNegativeInteger': 'number',
  // Native JS Date — must NOT pass through renameTypes (tt:Date → OnvifDate)
  'xs:dateTime': 'Date',
  'xs:token': 'string',
  // xs:time must not map to tt:Time { hour, minute, second }
  'xs:time': 'string',
  'xs:hexBinary': 'string',
  'xs:base64Binary': 'string',
  'xs:QName': 'string',
  'xs:anyURI': 'AnyURI',
  'xs:duration': 'Duration',
  'xs:positiveInteger': 'PositiveInteger',
  'xs:anyType': 'unknown',
  'xs:anySimpleType': 'unknown',
  'wsnt:NotificationMessageHolderType': 'unknown',
  'wsnt:TopicExpressionType': 'unknown',
  'wsnt:QueryExpressionType': 'unknown',
  'wsnt:AbsoluteOrRelativeTimeType': 'unknown',
  'soapenv:Envelope': 'unknown',
  'soapenv:Fault': 'unknown',
  'wsa:EndpointReferenceType': 'unknown',
  'mpqf:MpegQueryType': 'unknown',
};

/**
 * Explicit XSD → TS mappings (builtins / known foreign types).
 * Returns `undefined` when the QName should be treated as a schema-local type name.
 */
export function mapBuiltin(xsdType: string): string | undefined {
  return BUILTIN_TYPES[xsdType];
}

export function dataTypes(xsdType?: string): string {
  if (!xsdType) {
    return 'unknown';
  }
  const builtin = mapBuiltin(xsdType);
  if (builtin !== undefined) {
    return builtin;
  }
  // Namespace-aware: strip only the prefix (`tt:Foo` → `Foo`)
  return xsdType.includes(':') ? xsdType.slice(xsdType.indexOf(':') + 1) : xsdType;
}

export function cleanName(name: string, overrides: GeneratorOverrides = emptyOverrides): string {
  const renamed = renameType(name, overrides);
  return renamed.replace(/[-.]/g, '');
}

/**
 * Resolve an XSD QName / builtin to the TypeScript type name used in generated code.
 * Builtin mappings (xs:dateTime → Date, …) are returned as-is.
 * Schema-local names get renameTypes (Object → OnvifObject, Date → OnvifDate).
 */
export function resolveTypeRef(xsdType: string | undefined, overrides: GeneratorOverrides): string {
  if (!xsdType) {
    return 'unknown';
  }
  const builtin = mapBuiltin(xsdType);
  if (builtin !== undefined) {
    return builtin;
  }
  const local = xsdType.includes(':') ? xsdType.slice(xsdType.indexOf(':') + 1) : xsdType;
  return cleanName(local, overrides);
}

export function camelCase(name: string): string {
  if (name.length === 1) {
    return name.toLowerCase();
  }
  const secondLetter = name.charAt(1);
  if (secondLetter && secondLetter.toUpperCase() !== secondLetter) {
    name = name.charAt(0).toLowerCase() + name.slice(1);
  }
  if (/[-.]/g.test(name)) {
    name = `'${name}'`;
  }
  return name;
}

/** True when a type name should be tracked for cross-file imports. */
export function needsImport(typeName: string): boolean {
  if (!typeName || NATIVE_TYPES.has(typeName)) {
    return false;
  }
  // primitives / keywords from dataTypes()
  if (typeName === typeName.toLowerCase()) {
    return false;
  }
  return true;
}

/** Built-in aliases written to `basics.ts` and registered in the links map. */
export function generateBuiltIns(): [ts.Node[], Links] {
  const types = {
    AnyURI: 'string',
    FilterType: 'any',
    NCName: 'string',
    Duration: 'string',
    PositiveInteger: 'number',
  };
  const builtInTypeNodes: ts.Node[] = [
    ...Object.entries(types).map(([name, typeName]) =>
      ts.factory.createTypeAliasDeclaration(
        exportModifier,
        name,
        undefined,
        ts.factory.createTypeReferenceNode(typeName),
      ),
    ),
  ];
  const builtInLinks: Links = new Map(Object.entries(types).map(([name]) => [name, { name: BASICS_FILENAME }]));
  return [builtInTypeNodes, builtInLinks];
}
