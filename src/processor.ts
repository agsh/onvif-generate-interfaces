import { readFileSync, writeFileSync } from 'fs';
import { Parser } from 'xml2js';
import ts, { TypeNode } from 'typescript';
import { glob } from 'glob';
import chalk from 'chalk';
import * as path from 'node:path';

const BASICS_FILENAME = 'basics';

const sourceFile = ts.createSourceFile(
  'soap-types.ts', // the output file name
  '', // the text of the source code, not needed for our purposes
  ts.ScriptTarget.Latest, // the target language version for the output file
  false,
  ts.ScriptKind.TS, // output script kind. options include JS, TS, JSX, TSX and others
);

// used for adding `export` directive to generated type
const exportModifier = ts.factory.createModifiersFromModifierFlags(
  ts.ModifierFlags.Export,
);

const generateBuiltIns = (): [ts.Node[], Links] => {
  const types = {
    AnyURI     : 'string',
    FilterType : 'any',
    NCName     : 'string',
  };
  const builtInTypeNodes: ts.Node[] = [
    ts.factory.createIdentifier('/* eslint-disable import/export, no-tabs */'),
    ...Object.entries(types).map(([name, typeName]) => ts.factory.createTypeAliasDeclaration(
      exportModifier,
      name,
      undefined,
      ts.factory.createTypeReferenceNode(typeName),
    )),
  ];
  const builtInLinks: Links = new Map(
    Object.entries(types).map(([name]) => ([
      name,
      { name : BASICS_FILENAME },
    ])),
  );
  return ([builtInTypeNodes, builtInLinks]);
};

function dataTypes(xsdType?: string): string {
  if (!xsdType) {
    return 'any';
  }
  // const type = xsdType.slice(3);
  switch (xsdType) {
    case 'xs:double': return 'number';
    case 'xs:float': return 'number';
    case 'xs:int': return 'number';
    case 'xs:integer': return 'number';
    case 'xs:short': return 'number';
    case 'xs:signedInt': return 'number';
    case 'xs:unsignedInt': return 'number';
    case 'xs:unsignedShort': return 'number';
    case 'xs:dateTime': return 'Date';
    case 'xs:token': return 'string';
    case 'xs:anyURI': return 'AnyURI';
    case 'xs:anyType': return 'any';
    case 'xs:hexBinary': return 'any';
    case 'xs:base64Binary': return 'any';
    case 'xs:duration': return 'any';
    case 'wsnt:FilterType': return 'any';
    case 'wsnt:NotificationMessageHolderType': return 'any';
    case 'soapenv:Envelope': return 'any';
    case 'soapenv:Fault': return 'any';
    case 'xs:anySimpleType': return 'any';
    case 'xs:QName': return 'any';
    case 'wsnt:TopicExpressionType': return 'any';
    case 'wsnt:QueryExpressionType': return 'any';
    case 'xs:positiveInteger': return 'PositiveInteger';
    case 'xs:nonNegativeInteger': return 'number';
    case 'tt:Object': return 'OnvifObject';
    case 'xs:time': return 'Time';
    default: return xsdType.slice(xsdType.indexOf(':') + 1);
  }
}

function cleanName(name: string): string {
  if (name === 'Object') {
    return 'OnvifObject';
  }
  return name.replace(/[-.]/g, '');
}

function camelCase(name: string): string {
  const secondLetter = name.charAt(1);
  if (secondLetter && secondLetter.toUpperCase() !== secondLetter) {
    name = name.charAt(0).toLowerCase() + name.slice(1);
  }
  if (/[-.]/g.test(name)) {
    name = `'${name}'`;
  }
  return name;
}

interface ISimpleType {
  meta: {
    name: string;
  };
  'xs:annotation': {
    'xs:documentation': string[];
  }[];
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

interface IComplexType {
  meta: {
    name: string;
  };
  'xs:complexContent': {
    'xs:extension': {
      meta: {
        base: string;
      };
      'xs:sequence': any[];
    }[];
  }[];
  'xs:attribute'?: {
    meta : {
      name: string;
      type: string;
      use: 'required' | 'optional';
    };
  }[];
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
    'xs:any'?: any;
  }[];
  'xs:annotation'?: {
    'xs:documentation': string[];
  }[];
}

interface IElement {
  meta: {
    name: string;
  };
  'xs:complexType': IComplexType[];
}

interface ISchemaDefinition {
  'xs:simpleType': ISimpleType[];
  'xs:complexType': IComplexType[];
  'xs:element': IElement[];
}

interface ProcessorConstructor {
  filePath: string;
  nodes: ts.Node[];
  links: Links;
}

type Links = Map<string, IType>

/**
 * Common class to process xml-files
 */
export class Processor {
  public readonly filePath: string;
  public readonly nodes: ts.Node[] = [];
  protected schema?: ISchemaDefinition;
  public readonly fileName: string;
  private links: Links;
  public readonly declaredTypes: Set<string> = new Set();
  public readonly usedTypes: Set<string> = new Set();
  constructor({
    filePath,
    links,
  }: ProcessorConstructor) {
    this.filePath = filePath;
    this.links = links;
    console.log(chalk.whiteBright(JSON.stringify(path.parse(this.filePath), null, '\t')));
    this.fileName = path.parse(this.filePath).name;
  }

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
   * @param links
   */
  suffix(links: Links) {
    const imports: Map<string, string[]> = new Map();
    for (const type of this.usedTypes.difference(this.declaredTypes)) {
      console.log(links.get(type));
      console.log(type, links.get(type)?.name);
    }
    const importNode = ts.factory.createImportDeclaration(
      undefined,
      ts.factory.createImportClause(
        false,
        undefined,
        ts.factory.createNamedImports([
          ts.factory.createImportSpecifier(
            false,
            undefined,
            ts.factory.createIdentifier('text'),
          ),
        ]),
      ),
      ts.factory.createStringLiteral('moduleSpec', true),
    );
    this.nodes.unshift(importNode);
    // this.writeInterface();
  }

  /**
   * @deprecated
   */
  async main(): Promise<ts.Node[]> {
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
    this.writeInterface();
    return this.nodes;
  }

  writeInterface() {
    const nodeArr = ts.factory.createNodeArray(this.nodes);

    // printer for writing the AST to a file as code
    const printer = ts.createPrinter({ newLine : ts.NewLineKind.LineFeed });
    const result = printer.printList(
      ts.ListFormat.MultiLine,
      nodeArr,
      sourceFile,
    );

    // write the code to file
    console.log(chalk.yellow(`Save to ./utils/interfaces/${this.fileName}.d.ts`));
    writeFileSync(`./utils/interfaces/${this.fileName}.ts`, result, { encoding : 'utf-8' });
  }

  async processXML() {
    const xsdData = readFileSync(this.filePath, { encoding : 'utf-8' })
      .replace(/<xs:documentation>([\s\S]*?)<\/xs:documentation>/g, (_, b) => `<xs:documentation><![CDATA[${b.replace(/(\s)+\n/, '\n')}]]></xs:documentation>`);

    const xmlParser = new Parser({
      attrkey : 'meta',
    });

    return xmlParser.parseStringPromise(xsdData);
  }

  async process() {
    throw new Error('Not implemented');
  }

  createAnnotationIfExists(attribute: any, node: any) {
    if (attribute['xs:annotation']) {
      return ts.addSyntheticLeadingComment(
        node,
        ts.SyntaxKind.MultiLineCommentTrivia,
        `* ${attribute['xs:annotation']?.[0]['xs:documentation'][0]} `,
        true,
      );
    }
    return node;
  }

  addNode(name: string, node: ts.Node) {
    if (this.links.has(name)) {
      console.log(chalk.magentaBright(`${name} in ${this.links.get(name)!.name} already exists`));
    }
    this.declaredTypes.add(name);
    this.links.set(name, {
      name : this.fileName,
    });
    this.nodes.push(node);
  }

  generateSimpleTypeInterface(simpleType: ISimpleType) {
    const name = cleanName(simpleType.meta.name);

    // TODO type?

    const interfaceSymbol = ts.factory.createIdentifier(name);
    if (simpleType['xs:restriction']) {
      /** RESTRICTIONS */
      if (simpleType['xs:restriction'][0]['xs:enumeration']) {
        this.addNode(
          name,
          this.createAnnotationIfExists(
            simpleType,
            ts.factory.createTypeAliasDeclaration(
              exportModifier,
              interfaceSymbol, // interface name
              undefined,
              ts.factory.createUnionTypeNode(simpleType['xs:restriction'][0]['xs:enumeration']
                .map((enumValue) => ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(enumValue.meta.value, true)))),
            ),
          ),
        );
      } else {
        this.addNode(
          name,
          this.createAnnotationIfExists(
            simpleType,
            ts.factory.createTypeAliasDeclaration(
              exportModifier,
              interfaceSymbol,
              undefined,
              ts.factory.createTypeReferenceNode(dataTypes(simpleType['xs:restriction'][0].meta.base)),
            ),
          ),
        );
      }
    } else if (simpleType['xs:list']) {
      /** LISTS */
      this.addNode(
        name,
        this.createAnnotationIfExists(
          simpleType,
          ts.factory.createTypeAliasDeclaration(
            exportModifier,
            interfaceSymbol,
            undefined,
            ts.factory.createArrayTypeNode(ts.factory.createTypeReferenceNode(dataTypes(simpleType['xs:list'][0].meta.itemType))),
          ),
        ),
      );
    }
  }

  createProperty(attribute: any) {
    const typeName = cleanName(dataTypes(attribute.meta.type));
    let type: TypeNode = ts.factory.createTypeReferenceNode(typeName);
    /** REFS FOR XMIME */
    if (!attribute.meta.name && attribute.meta.ref) {
      attribute.meta.name = attribute.meta.ref.slice(6);
    }
    /** ARRAYS */
    if (attribute.meta.maxOccurs === 'unbounded') {
      type = ts.factory.createArrayTypeNode(type);
    }
    const property = ts.factory.createPropertySignature(
      undefined,
      camelCase(attribute.meta.name),
      attribute.meta.use !== 'required' ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : undefined,
      type,
    );
    if (typeName.charAt(0) === typeName.charAt(0).toUpperCase()) {
      this.usedTypes.add(typeName);
    }
    console.log(chalk.yellow(`> ${attribute.meta.name} ${cleanName(dataTypes(attribute.meta.type))}`));
    return this.createAnnotationIfExists(attribute, property);
  }

  generateElementType(element: IElement) {
    if (element['xs:complexType'] && typeof element['xs:complexType'][0] === 'object') {
      element['xs:complexType'][0].meta = {
        name : element.meta.name,
      };
      this.generateComplexTypeInterface(element['xs:complexType'][0]);
    }
    // TODO method descriptions?
    // element.meta
    // console.log(`> ${element.meta.name}`);
  }

  generateComplexTypeInterface(complexType: IComplexType) {
    const { name } = complexType.meta;
    const interfaceSymbol = ts.factory.createIdentifier(cleanName(name));

    let members: ts.TypeElement[] = [];
    let heritage;

    /** Complex Content */
    if (Array.isArray(complexType['xs:complexContent'])) {
      const name = complexType['xs:complexContent'][0]['xs:extension'][0].meta.base;
      const heritageName = name.slice(name.indexOf(':') + 1);
      heritage = extendInterface(heritageName);
      if (complexType['xs:sequence']) {
        throw new Error('complexType[\'xs:sequence\'] in complexContent: complexType.meta.name');
      }
      complexType['xs:sequence'] = complexType['xs:complexContent'][0]['xs:extension'][0]['xs:sequence'];
    }

    if (complexType['xs:attribute']) {
      members = members.concat(
        complexType['xs:attribute'].map((attribute) => this.createProperty(attribute)),
      );
    }
    if (complexType['xs:sequence']) {
      if (!Array.isArray(complexType['xs:sequence'][0]['xs:element'])) {
        /** TODO Any */
        // if (complexType['xs:sequence'][0]['xs:any']) {
        //   members.push(
        //     ts.factory.createPropertySignature(
        //       undefined,
        //       '[key: string]',
        //       undefined,
        //       ts.factory.createTypeReferenceNode('any'),
        //     ),
        //   );
        // }

        // console.log(complexType);
        // console.log('--------------');
        // return ts.factory.createPropertySignature(
        //   undefined,
        //   complexType.meta.name,
        //   ts.factory.createToken(ts.SyntaxKind.QuestionToken),
        //   ts.factory.createTypeReferenceNode('any'),
        // );
      } else {
        members = members.concat(
          members = complexType['xs:sequence'][0]['xs:element'].map((attribute) => {
            // console.log(attribute.meta.name);
            /** TODO complex type inside complex type */
            if (attribute['xs:complexType']) {
              attribute['xs:complexType'][0].meta = { name : attribute.meta.name };
              this.generateComplexTypeInterface(attribute['xs:complexType'][0]);
              attribute.meta.type = `tt:${attribute.meta.name}`;
            }
            const cl = this.createProperty(attribute);
            return cl;
          }),
        );
      }
    }

    const node = ts.factory.createInterfaceDeclaration(
      exportModifier, // modifiers
      interfaceSymbol, // interface name
      undefined, // no generic type parameters
      heritage,
      members,
    );
    this.addNode(
      name,
      this.createAnnotationIfExists(complexType, node),
    );
  }
}

function extendInterface(interfaceName?: string) {
  if (interfaceName) {
    return [ts.factory.createHeritageClause(
      ts.SyntaxKind.ExtendsKeyword,
      [ts.factory.createExpressionWithTypeArguments(ts.factory.createIdentifier(interfaceName), [])],
    )];
  }
  return undefined;
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

class InterfaceProcessor {
  private nodes: ts.Node[] = [];
  private links: Links = new Map();
  async start(sourcesPath: string, outPath: string) {
    const [builtInTypes, builtInLinks] = generateBuiltIns();
    this.nodes = builtInTypes;
    this.links = builtInLinks;

    const processors = [];

    const xsds = await glob(path.join(sourcesPath, '/**/*.xsd'));
    console.log(path.join(sourcesPath, '/**/*.xsd'));
    for (const xsd of xsds) {
      console.log(chalk.greenBright(`processing ${xsd}`));
      const proc = new ProcessorXSD({
        filePath : xsd,
        nodes    : this.nodes,
        links    : this.links,
      });
      processors.push(proc);
      const procNodes = await proc.prefix();
      this.nodes = this.nodes.concat(procNodes);
    }

    const wsdls = await glob(path.join(sourcesPath, '/**/*.wsdl'));
    for (const wdsl of wsdls) {
      console.log(chalk.greenBright(`processing ${wdsl}`));
      const proc = new ProcessorWSDL({
        filePath : wdsl,
        nodes    : this.nodes,
        links    : this.links,
      });
      processors.push(proc);
      const procNodes = await proc.prefix();
      this.nodes = this.nodes.concat(procNodes);
    }

    for (const proc of processors) {
      proc.suffix(this.links);
      console.log('');
      console.log('------------------------------');
      console.log('');
    }

    // const proc = new ProcessorWSDL({
    //   filePath : '../specs/wsdl/ver20/ptz/wsdl/ptz.wsdl',
    //   nodes    : this.nodes,
    //   types    : this.types,
    //   links    : this.links,
    // });
    // await proc.main();

    const nodeArr = ts.factory.createNodeArray(this.nodes);
    const printer = ts.createPrinter({ newLine : ts.NewLineKind.LineFeed });
    const result = printer.printList(
      ts.ListFormat.MultiLine,
      nodeArr,
      sourceFile,
    );

    // write the code to file
    // writeFileSync(path.join(outPath, `${BASICS_FILENAME}.ts`), result, { encoding : 'utf-8' });

    // console.log(chalk.greenBright([...this.links.entries()]));
  }
}

//

const [_a, _b, sources, out] = process.argv;
if (out !== undefined) {
  console.log('m');
  (new InterfaceProcessor()).start(sources, out).catch(console.error);
} else {
  console.log(`Usage: processor.ts <source> <output>
  <source> - ONVIF specs source directory
  <output> - generated interfaces output directory
  Example: processor.ts "../specs/wsdl/ver20" "./onvif/interfaces"`);
  process.exit(1);
}
