import { lstatSync, readFileSync, writeFileSync } from 'fs';
import { Parser } from 'xml2js';
import ts, { TypeNode } from 'typescript';
import { glob } from 'glob';
import chalk from 'chalk';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { format } from 'prettier';
import {
  applySuppressImports,
  emptyOverrides,
  fieldUseOverride,
  GeneratorOverrides,
  onvifOverrides,
  renameType,
  resolveOutputFileName,
  shouldSkipElement,
} from './overrides';

const BASICS_FILENAME = 'basics';

const sourceFile = ts.createSourceFile(
  'source.ts', // the output file name
  '', // the text of the source code, not needed for our purposes
  ts.ScriptTarget.Latest, // the target language version for the output file
  false,
  ts.ScriptKind.TS, // output script kind. options include JS, TS, JSX, TSX and others
);

// used for adding `export` directive to generated type
const exportModifier = ts.factory.createModifiersFromModifierFlags(ts.ModifierFlags.Export);

/** Native TS / utility names that must not be imported from generated modules. */
const NATIVE_TYPES = new Set(['Date', 'Buffer', 'Promise', 'Array', 'Record', 'Map', 'Set']);

const generateBuiltIns = (): [ts.Node[], Links] => {
  // Aliases for XSD builtins that are referenced by name from dataTypes().
  // PositiveInteger lives here (not only in types.xsd) so files that map
  // xs:positiveInteger → PositiveInteger always resolve an import target.
  // NOTE: do NOT add Time — tt:Time is a real complex type (hour/minute/second).
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
};

/** True when a type name should be tracked for cross-file imports. */
function needsImport(typeName: string): boolean {
  if (!typeName || NATIVE_TYPES.has(typeName)) {
    return false;
  }
  // primitives / keywords from dataTypes()
  if (typeName === typeName.toLowerCase()) {
    return false;
  }
  return true;
}

function dataTypes(xsdType?: string): string {
  if (!xsdType) {
    return 'unknown';
  }
  // const type = xsdType.slice(3);
  switch (xsdType) {
    case 'xs:double':
      return 'number';
    case 'xs:float':
      return 'number';
    case 'xs:int':
      return 'number';
    case 'xs:integer':
      return 'number';
    case 'xs:short':
      return 'number';
    case 'xs:signedInt':
      return 'number';
    case 'xs:unsignedInt':
      return 'number';
    case 'xs:unsignedShort':
      return 'number';
    case 'xs:dateTime':
      return 'Date';
    case 'xs:token':
      return 'string';
    case 'xs:anyURI':
      return 'AnyURI';
    case 'xs:anyType':
      return 'unknown';
    case 'xs:hexBinary':
      return 'unknown';
    case 'xs:base64Binary':
      return 'unknown';
    case 'xs:duration':
      return 'Duration';
    // case 'wsnt:FilterType':
    //   return 'unknown';
    case 'wsnt:NotificationMessageHolderType':
      return 'unknown';
    case 'soapenv:Envelope':
      return 'unknown';
    case 'soapenv:Fault':
      return 'unknown';
    case 'xs:anySimpleType':
      return 'unknown';
    case 'xs:QName':
      return 'unknown';
    case 'wsnt:TopicExpressionType':
      return 'unknown';
    case 'wsnt:QueryExpressionType':
      return 'unknown';
    case 'wsnt:AbsoluteOrRelativeTimeType':
      return 'unknown';
    case 'wsa:EndpointReferenceType':
      return 'unknown';
    case 'mpqf:MpegQueryType':
      return 'unknown';
    case 'xs:positiveInteger':
      return 'PositiveInteger';
    case 'xs:nonNegativeInteger':
      return 'number';
    case 'tt:Object':
      return 'unknown';
    case 'xs:time':
      // Must not map to `Time`: tt:Time is an ONVIF complex type { hour, minute, second }.
      return 'string';
    default:
      return xsdType.slice(xsdType.indexOf(':') + 1);
  }
}

function cleanName(name: string, overrides: GeneratorOverrides = emptyOverrides): string {
  const renamed = renameType(name, overrides);
  return renamed.replace(/[-.]/g, '');
}

function camelCase(name: string): string {
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
interface IAttribute {
  meta: {
    type?: string;
    name?: string;
    ref?: string;
    maxOccurs?: string;
    minOccurs?: string;
    use?: 'required' | 'optional';
    namespace?: string;
    processContents?: string;
  };
  'xs:annotation'?: {
    'xs:documentation': string[];
  }[];
}

interface ISimpleType extends IAttribute {
  'xs:restriction': {
    meta: {
      base: string;
    };
    'xs:enumeration'?: {
      meta: {
        value: string;
      };
    }[];
  }[];
  'xs:list': {
    meta: {
      itemType: string;
    };
  }[];
}

interface IComplexType extends IAttribute {
  'xs:complexContent': {
    'xs:extension': {
      meta: {
        base: string;
      };
      'xs:sequence': never[];
      'xs:attribute': never[];
    }[];
  }[];
  'xs:attribute'?: IAttribute[];
  'xs:sequence'?: {
    'xs:element': {
      meta: {
        name: string;
        type: string;
        use: 'required' | 'optional';
      };
      'xs:complexType'?: IComplexType[];
      'xs:annotation': {
        'xs:documentation': string[];
      }[];
    }[];
    'xs:any'?: {
      meta: {
        namespace: string;
        processContents: string;
      };
      'xs:annotation': {
        'xs:documentation': string[];
      }[];
    }[];
  }[];
}

interface IElement {
  meta: {
    name: string;
    type?: string;
    use: 'required' | 'optional';
  };
  'xs:complexType': IComplexType[];
}

interface ISchemaDefinition {
  'xs:schema': never;
  'wsdl:definitions': { 'wsdl:types': { 'xs:schema': never }[] };
  'xs:simpleType': ISimpleType[];
  'xs:complexType': IComplexType[];
  'xs:element': IElement[];
}

interface ProcessorConstructor {
  filePath: string;
  nodes: ts.Node[];
  links: Links;
  overrides?: GeneratorOverrides;
}

type Links = Map<string, IType>;

function formatComment(str: string) {
  const strs = str
    .split('\n')
    .filter((a) => a.trim() !== '')
    .map((a) => a.trim().replace(/<[^>]*>/g, ''));
  if (strs.length === 0) {
    return '';
  }
  if (strs.length === 1) {
    return `* ${strs[0]} `;
  }
  const [first, ...others] = strs;
  return `*\n * ${first}\n${others.map((a) => ` * ${a}`).join('\n')}\n `;
}

/**
 * Common class to process xml-files
 */
export abstract class Processor {
  public readonly filePath: string;

  public readonly nodes: ts.Node[] = [];

  protected schema?: ISchemaDefinition;

  public readonly fileName: string;

  private links: Links;

  public readonly declaredTypes: Set<string> = new Set();

  public readonly usedTypes: Set<string> = new Set();

  protected readonly overrides: GeneratorOverrides;

  constructor({ filePath, links, overrides }: ProcessorConstructor) {
    this.filePath = filePath;
    this.links = links;
    this.overrides = overrides ?? emptyOverrides;
    this.fileName = resolveOutputFileName(this.filePath, this.overrides);
  }

  protected clean(name: string): string {
    return cleanName(name, this.overrides);
  }

  abstract process(): Promise<void>;

  /**
   * Process the xml-file, generates all interface nodes and adds them to exportNodes
   * Adds interfaces to link map-property of the constructor
   * Generates usedTypes and declareTypes properties
   */
  async prefix(): Promise<ts.Node[]> {
    await this.process();
    if (this.schema?.['xs:simpleType']) {
      this.schema['xs:simpleType'].forEach((simpleType) => this.generateSimpleTypeInterface(simpleType));
    }
    if (this.schema?.['xs:complexType']) {
      this.schema['xs:complexType'].forEach((complexType) => this.generateComplexTypeInterface(complexType));
    }
    if (this.schema?.['xs:element']) {
      this.schema['xs:element'].forEach((element) => this.generateElementType(element));
    }
    return this.nodes;
  }

  /**
   * Generate imports for all used types in the file using links map
   */
  suffix(links: Links) {
    const imports: Record<string, string[]> = {};
    const typesToImport = this.usedTypes.difference(this.declaredTypes);
    applySuppressImports(this.filePath, this.fileName, typesToImport, this.overrides);
    for (const type of typesToImport) {
      const fileName = links.get(type)?.name;
      if (!fileName) {
        console.warn(chalk.yellow(`Type ${type} not found in links`));
      } else if (imports[fileName]) {
        imports[fileName].push(type);
      } else {
        imports[fileName] = [type];
      }
    }
    const importNodes = Object.entries(imports).map(([fileName, types]) =>
      ts.factory.createImportDeclaration(
        undefined,
        ts.factory.createImportClause(
          false,
          undefined,
          ts.factory.createNamedImports(
            types.map((type) => ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier(type))),
          ),
        ),
        ts.factory.createStringLiteral(`./${fileName}`, true),
      ),
    );
    this.nodes.unshift(...importNodes, ts.factory.createIdentifier('\n'));
  }

  /**
   * Generate interface file at given path
   */
  async writeInterface(path: string, options: { silent?: boolean } = {}) {
    const nodeArr = ts.factory.createNodeArray(this.nodes);

    // printer for writing the AST to a file as code
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const result = printer.printList(ts.ListFormat.MultiLine, nodeArr, sourceFile);

    const prettifiedResult = await format(result, {
      parser: 'typescript',
      singleQuote: true,
      semi: true,
      trailingComma: 'all',
      arrowParens: 'always',
      endOfLine: 'lf',
      printWidth: 120,
    });

    // write the code to file
    if (!options.silent) {
      console.log(chalk.greenBright(`Save to ${join(path, `${this.fileName}.ts`)}`));
    }
    writeFileSync(join(path, `${this.fileName}.ts`), prettifiedResult, { encoding: 'utf-8' });
  }

  async processXML() {
    const xsdData = readFileSync(this.filePath, { encoding: 'utf-8' }).replace(
      /<xs:documentation>([\s\S]*?)<\/xs:documentation>/g,
      (_, b: string) => `<xs:documentation><![CDATA[${b.replace(/(\s)+\n/, '\n')}]]></xs:documentation>`,
    );

    const xmlParser = new Parser({
      attrkey: 'meta',
    });

    return xmlParser.parseStringPromise(xsdData) as Promise<ISchemaDefinition>;
  }

  static createAnnotationIfExists(attribute: IAttribute, node: ts.Node) {
    if (attribute['xs:annotation']) {
      const annotation =
        typeof attribute['xs:annotation']?.[0] === 'string'
          ? // For these annotations
            // <xs:annotation>
            //   All hardware types specified are related to network devices supporting ONVIF specification.
            // </xs:annotation>
            attribute['xs:annotation']?.[0]
          : // For these annotations
            // <xs:annotation>
            // 	 <xs:documentation>Multiple sensors device.</xs:documentation>
            // </xs:annotation>
            attribute['xs:annotation']?.[0]['xs:documentation'][0];
      return ts.addSyntheticLeadingComment(node, ts.SyntaxKind.MultiLineCommentTrivia, formatComment(annotation), true);
    }
    return node;
  }

  addNode(name: string, node: ts.Node) {
    if (this.links.has(name)) {
      const owner = this.links.get(name)!.name;
      // Only suppress redeclaration for true builtins from basics
      // (e.g. PositiveInteger). Service-local names like Capabilities are
      // intentionally repeated across WSDLs and must still be emitted here.
      if (owner === BASICS_FILENAME && this.fileName !== BASICS_FILENAME) {
        return;
      }
      // First registration wins for import resolution; later files still export.
    } else {
      this.links.set(name, {
        name: this.fileName,
      });
    }
    if (this.declaredTypes.has(name)) {
      console.log(chalk.magentaBright(`${name} in ${this.links.get(name)!.name} already declared`));
      return;
    }
    this.declaredTypes.add(name);
    this.nodes.push(node);
  }

  /** Record a referenced type so suffix() can emit the right import. */
  trackUsedType(typeName: string) {
    if (needsImport(typeName)) {
      this.usedTypes.add(typeName);
    }
  }

  /**
   * Index signatures for xs:any namespace="##any" extension points.
   * Key kinds come from overrides (`extensionIndexKeyTypes`).
   */
  createExtensionIndexSignatures(anyNode: IAttribute): ts.TypeElement[] {
    const unknownType = ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    const keyKinds = this.overrides.extensionIndexKeyTypes ?? emptyOverrides.extensionIndexKeyTypes;
    const makeIndex = (keyType: ts.KeywordTypeNode) =>
      ts.factory.createIndexSignature(
        undefined,
        [
          ts.factory.createParameterDeclaration(
            undefined,
            undefined,
            ts.factory.createIdentifier('key'),
            undefined,
            keyType,
          ),
        ],
        unknownType,
      );

    return keyKinds.map((kind, index) => {
      const keyType =
        kind === 'symbol'
          ? ts.factory.createKeywordTypeNode(ts.SyntaxKind.SymbolKeyword)
          : ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
      const signature = makeIndex(keyType);
      // Attach xs:annotation only to the first signature
      return (
        index === 0 ? Processor.createAnnotationIfExists(anyNode, signature) : signature
      ) as ts.TypeElement;
    });
  }

  generateSimpleTypeInterface(simpleType: ISimpleType) {
    const name = this.clean(simpleType.meta.name!);

    // TODO type?

    const interfaceSymbol = ts.factory.createIdentifier(name);
    if (simpleType['xs:restriction']) {
      /** RESTRICTIONS */
      if (simpleType['xs:restriction'][0]['xs:enumeration']) {
        this.addNode(
          name,
          Processor.createAnnotationIfExists(
            simpleType,
            ts.factory.createTypeAliasDeclaration(
              exportModifier,
              interfaceSymbol, // interface name
              undefined,
              ts.factory.createUnionTypeNode(
                simpleType['xs:restriction'][0]['xs:enumeration'].map((enumValue) =>
                  ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(enumValue.meta.value, true)),
                ),
              ),
            ),
          ),
        );
      } else {
        const typeName = this.clean(dataTypes(simpleType['xs:restriction'][0].meta.base));
        this.trackUsedType(typeName);
        this.addNode(
          name,
          Processor.createAnnotationIfExists(
            simpleType,
            ts.factory.createTypeAliasDeclaration(
              exportModifier,
              interfaceSymbol,
              undefined,
              ts.factory.createTypeReferenceNode(typeName),
            ),
          ),
        );
      }
    } else if (simpleType['xs:list']) {
      /** LISTS */
      const itemTypeName = this.clean(dataTypes(simpleType['xs:list'][0].meta.itemType));
      this.trackUsedType(itemTypeName);
      this.addNode(
        name,
        Processor.createAnnotationIfExists(
          simpleType,
          ts.factory.createTypeAliasDeclaration(
            exportModifier,
            interfaceSymbol,
            undefined,
            ts.factory.createArrayTypeNode(ts.factory.createTypeReferenceNode(itemTypeName)),
          ),
        ),
      );
    }
  }

  createProperty(attribute: IAttribute) {
    const typeName = this.clean(dataTypes(attribute.meta.type));
    let type: TypeNode = ts.factory.createTypeReferenceNode(typeName);
    /** REFS FOR XMIME */
    if (!attribute.meta.name && attribute.meta.ref) {
      attribute.meta.name = attribute.meta.ref.split(':')[1];
    }
    /** ARRAYS */
    if (attribute.meta.maxOccurs === 'unbounded') {
      type = ts.factory.createArrayTypeNode(type);
    }

    const useOverride = fieldUseOverride(this.fileName, attribute.meta.name, this.overrides);
    const effectiveUse = useOverride ?? attribute.meta.use;

    const property = ts.factory.createPropertySignature(
      undefined,
      camelCase(attribute.meta.name!),
      (effectiveUse === 'required' ||
        attribute.meta.minOccurs === '1' ||
        (!attribute.meta.minOccurs && !attribute.meta.maxOccurs)) &&
        effectiveUse !== 'optional'
        ? undefined
        : ts.factory.createToken(ts.SyntaxKind.QuestionToken),
      type,
    );
    this.trackUsedType(typeName);
    return Processor.createAnnotationIfExists(attribute, property);
  }

  generateElementType(element: IElement) {
    if (element['xs:complexType'] && typeof element['xs:complexType'][0] === 'object') {
      element['xs:complexType'][0].meta = {
        name: element.meta.name,
        use: 'optional',
      };
      this.generateComplexTypeInterface(element['xs:complexType'][0]);
    } else {
      if (element['xs:complexType'] && typeof element['xs:complexType'][0] === 'string') {
        // Empty complex types in WSDL, e.g.
        // <xs:element name="ModifyAnalyticsModulesResponse"><xs:complexType/></xs:element>
        element.meta.type = '';
      }
      if (element.meta.type !== undefined) {
        if (shouldSkipElement(this.fileName, element.meta.name, element.meta.type, this.overrides)) {
          return;
        }
        const name = this.clean(element.meta.name);
        const extendsName = this.clean(element.meta.type);
        const heritageName = this.clean(extendsName.slice(extendsName.indexOf(':') + 1));
        if (name === heritageName) {
          // type inherits itself
          return;
        }
        const heritage = this.extendInterface(heritageName);
        const node = ts.factory.createInterfaceDeclaration(
          exportModifier, // modifiers
          ts.factory.createIdentifier(name), // interface name
          undefined, // no generic type parameters
          heritage,
          [],
        );
        this.addNode(name, Processor.createAnnotationIfExists(element, node));
      }
    }
  }

  generateComplexTypeInterface(complexType: IComplexType) {
    const { name } = complexType.meta;
    const interfaceSymbol = ts.factory.createIdentifier(this.clean(name!));

    let members: ts.Node[] = [];
    let heritage;

    /** Complex Content */
    if (Array.isArray(complexType['xs:complexContent'])) {
      const extendsName = complexType['xs:complexContent'][0]['xs:extension'][0].meta.base;
      const heritageName = this.clean(extendsName.slice(extendsName.indexOf(':') + 1));
      if (name === heritageName) {
        // type inherits itself
        return;
      }
      heritage = this.extendInterface(heritageName);
      if (complexType['xs:sequence']) {
        throw new Error(`complexType['xs:sequence'] in complexContent: ${name}`);
      }
      complexType['xs:sequence'] = complexType['xs:complexContent'][0]['xs:extension'][0]['xs:sequence'];
      if (complexType['xs:complexContent'][0]['xs:extension'][0]['xs:attribute']) {
        complexType['xs:attribute'] = complexType['xs:complexContent'][0]['xs:extension'][0]['xs:attribute'];
      }
    }

    if (complexType['xs:attribute']) {
      members = members.concat(complexType['xs:attribute'].map((attribute) => {
        if (attribute.meta.use !== 'required') { // by default attributes are optional
          attribute.meta.use = 'optional';
        }
        return this.createProperty(attribute);
      }));
    }
    if (complexType['xs:sequence']) {
      const sequence = complexType['xs:sequence'][0];
      if (Array.isArray(sequence['xs:element'])) {
        members = members.concat(
          sequence['xs:element'].map((attribute) => {
            /** TODO complex type inside complex type */
            if (attribute['xs:complexType']) {
              attribute['xs:complexType'][0].meta = { name: attribute.meta.name, use: 'optional' };
              this.generateComplexTypeInterface(attribute['xs:complexType'][0]);
              attribute.meta.type = `tt:${attribute.meta.name}`;
            }
            return this.createProperty(attribute);
          }),
        );
      }
      // cover xs:any ##any extension points (key kinds from overrides)
      if (sequence['xs:any'] && sequence['xs:any'][0].meta.namespace === '##any') {
        members.push(...this.createExtensionIndexSignatures(sequence['xs:any'][0]));
      }
    }

    const node = ts.factory.createInterfaceDeclaration(
      exportModifier, // modifiers
      interfaceSymbol, // interface name
      undefined, // no generic type parameters
      heritage,
      members as ts.TypeElement[],
    );
    this.addNode(name!, Processor.createAnnotationIfExists(complexType, node));
  }

  extendInterface(interfaceName?: string) {
    if (interfaceName) {
      this.trackUsedType(interfaceName);
      return [
        ts.factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [
          ts.factory.createExpressionWithTypeArguments(ts.factory.createIdentifier(interfaceName), []),
        ]),
      ];
    }
    return undefined;
  }
}

class ProcessorXSD extends Processor {
  async process() {
    this.schema = (await this.processXML())['xs:schema'] as ISchemaDefinition;
  }
}

class ProcessorWSDL extends Processor {
  async process() {
    const xml = await this.processXML();
    const schemaDefinition = xml['wsdl:definitions']['wsdl:types']?.[0]['xs:schema']?.[0];
    this.schema = schemaDefinition as ISchemaDefinition;
  }
}

interface IType {
  name?: string;
}

export interface InterfaceProcessorOptions {
  overrides?: GeneratorOverrides;
  /** Suppress progress logs (used by snapshot tests). */
  silent?: boolean;
}

export class InterfaceProcessor {
  private nodes: ts.Node[] = [];

  private links: Links = new Map();

  private readonly overrides: GeneratorOverrides;

  private readonly silent: boolean;

  constructor(options: InterfaceProcessorOptions = {}) {
    this.overrides = options.overrides ?? onvifOverrides;
    this.silent = options.silent ?? false;
  }

  private log(message: string) {
    if (!this.silent) {
      console.log(message);
    }
  }

  async start(sourcesPath: string, outPath: string) {
    const [builtInTypes, builtInLinks] = generateBuiltIns();
    this.nodes = builtInTypes;
    this.links = builtInLinks;

    const processors = [];

    const xsds = await glob(join(sourcesPath, '/**/*.xsd'));
    for (const xsd of xsds) {
      this.log(chalk.greenBright(`processing ${xsd}`));
      const proc = new ProcessorXSD({
        filePath: xsd,
        nodes: this.nodes,
        links: this.links,
        overrides: this.overrides,
      });
      processors.push(proc);
      const procNodes = await proc.prefix();
      this.nodes = this.nodes.concat(procNodes);
    }

    const wsdls = await glob(join(sourcesPath, '/**/*.wsdl'));
    for (const wdsl of wsdls) {
      this.log(chalk.greenBright(`processing ${wdsl}`));
      const proc = new ProcessorWSDL({
        filePath: wdsl,
        nodes: this.nodes,
        links: this.links,
        overrides: this.overrides,
      });
      processors.push(proc);
      const procNodes = await proc.prefix();
      this.nodes = this.nodes.concat(procNodes);
    }

    for (const proc of processors.reverse()) {
      proc.suffix(this.links);
      await proc.writeInterface(outPath, { silent: this.silent });
    }

    const nodeArr = ts.factory.createNodeArray(builtInTypes);
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const result = printer.printList(ts.ListFormat.MultiLine, nodeArr, sourceFile);

    writeFileSync(join(outPath, `${BASICS_FILENAME}.ts`), result, { encoding: 'utf-8' });
    this.log('Done!');
  }
}

function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  const [, , sources, out] = process.argv;
  if (out !== undefined && lstatSync(sources).isDirectory()) {
    mkdirSync(out, { recursive: true });
    new InterfaceProcessor().start(sources, out).catch(console.error);
  } else {
    console.log(`Usage: processor.ts <source> <output>
  <source> - ONVIF specs source directory
  <output> - generated interfaces output directory
  Example: processor.ts "../specs/wsdl/ver20" "./onvif/interfaces"`);
    process.exit(1);
  }
}
