import chalk from 'chalk';
import ts, { TypeNode } from 'typescript';
import { BASICS_FILENAME, exportModifier } from './constants';
import { camelCase, cleanName, needsImport, resolveTypeRef } from './map-types';
import {
  applySuppressImports,
  emptyOverrides,
  fieldUseOverride,
  GeneratorOverrides,
  resolveOutputFileName,
  shouldSkipElement,
} from './overrides';
import {
  IAnyParticle,
  IAttribute,
  IChoice,
  IComplexType,
  IElement,
  ISchemaDefinition,
  ISequence,
  ISimpleType,
  Links,
} from './schema-types';
import { formatComment, writeInterfaceFile } from './write';
import { parseXmlFile } from './xml';

export interface ProcessorConstructor {
  filePath: string;
  links: Links;
  overrides?: GeneratorOverrides;
}

/**
 * Common class to process xml-files into TypeScript AST nodes.
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

  async writeInterface(path: string, options: { silent?: boolean } = {}) {
    await writeInterfaceFile(path, this.fileName, this.nodes, options);
  }

  async processXML() {
    return parseXmlFile(this.filePath);
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
              interfaceSymbol,
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
        const typeName = resolveTypeRef(simpleType['xs:restriction'][0].meta.base, this.overrides);
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
      const itemTypeName = resolveTypeRef(simpleType['xs:list'][0].meta.itemType, this.overrides);
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

  /**
   * Normalize ref/name on an element or attribute particle.
   * `ref="wsnt:NotificationMessage"` → property name from the QName local part.
   * Type is left unset for foreign refs (wsnt/xmime/…) → `unknown`; those schemas
   * are not generated. Same-schema refs that carry an explicit `type=` are unchanged.
   */
  normalizeParticle(attribute: IAttribute): void {
    if (attribute.meta.ref && !attribute.meta.name) {
      attribute.meta.name = attribute.meta.ref.includes(':')
        ? attribute.meta.ref.slice(attribute.meta.ref.indexOf(':') + 1)
        : attribute.meta.ref;
    }
  }

  createProperty(
    attribute: IAttribute,
    options: { forceOptional?: boolean; forceArray?: boolean } = {},
  ) {
    this.normalizeParticle(attribute);
    const typeName = resolveTypeRef(attribute.meta.type, this.overrides);
    let type: TypeNode = ts.factory.createTypeReferenceNode(typeName);
    /** ARRAYS */
    if (attribute.meta.maxOccurs === 'unbounded' || options.forceArray) {
      type = ts.factory.createArrayTypeNode(type);
    }

    const useOverride = fieldUseOverride(this.fileName, attribute.meta.name, this.overrides);
    const effectiveUse = options.forceOptional ? 'optional' : (useOverride ?? attribute.meta.use);

    const property = ts.factory.createPropertySignature(
      undefined,
      camelCase(attribute.meta.name!),
      (effectiveUse === 'required' ||
        attribute.meta.minOccurs === '1' ||
        (!attribute.meta.minOccurs && !attribute.meta.maxOccurs && !options.forceOptional)) &&
        effectiveUse !== 'optional'
        ? undefined
        : ts.factory.createToken(ts.SyntaxKind.QuestionToken),
      type,
    );
    this.trackUsedType(typeName);
    return Processor.createAnnotationIfExists(attribute, property);
  }

  /** Emit members for an xs:choice — all branches optional; unbounded choice → arrays. */
  appendChoiceMembers(choice: IChoice, members: ts.Node[]) {
    const unbounded = choice.meta?.maxOccurs === 'unbounded';
    if (Array.isArray(choice['xs:element'])) {
      for (const element of choice['xs:element']) {
        if (element['xs:complexType']) {
          element['xs:complexType'][0].meta = { name: element.meta.name, use: 'optional' };
          this.generateComplexTypeInterface(element['xs:complexType'][0]);
          element.meta.type = element.meta.name;
        }
        members.push(
          this.createProperty(element, {
            forceOptional: true,
            forceArray: unbounded && element.meta.maxOccurs !== '1',
          }),
        );
      }
    }
    if (choice['xs:any']?.[0]?.meta.namespace === '##any') {
      members.push(...this.createExtensionIndexSignatures(choice['xs:any'][0]));
    }
  }

  appendAnyMembers(anyParticles: IAnyParticle[] | undefined, members: ts.Node[]) {
    if (anyParticles?.[0]?.meta.namespace === '##any') {
      members.push(...this.createExtensionIndexSignatures(anyParticles[0]));
    }
  }

  /** Walk sequence particles: elements, nested choices, xs:any. */
  appendSequenceMembers(sequence: ISequence, members: ts.Node[]) {
    if (Array.isArray(sequence['xs:element'])) {
      for (const attribute of sequence['xs:element']) {
        if (attribute['xs:complexType']) {
          attribute['xs:complexType'][0].meta = { name: attribute.meta.name, use: 'optional' };
          this.generateComplexTypeInterface(attribute['xs:complexType'][0]);
          attribute.meta.type = attribute.meta.name;
        }
        members.push(this.createProperty(attribute));
      }
    }
    if (Array.isArray(sequence['xs:choice'])) {
      for (const choice of sequence['xs:choice']) {
        this.appendChoiceMembers(choice, members);
      }
    }
    this.appendAnyMembers(sequence['xs:any'], members);
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
        // Empty <xs:complexType/> → empty interface, no heritage
        if (element.meta.type === '') {
          this.addNode(
            name,
            Processor.createAnnotationIfExists(
              element,
              ts.factory.createInterfaceDeclaration(
                exportModifier,
                ts.factory.createIdentifier(name),
                undefined,
                undefined,
                [],
              ),
            ),
          );
          return;
        }
        const heritageName = resolveTypeRef(element.meta.type, this.overrides);
        if (name === heritageName) {
          // type inherits itself
          return;
        }
        const heritage = this.extendInterface(heritageName);
        const node = ts.factory.createInterfaceDeclaration(
          exportModifier,
          ts.factory.createIdentifier(name),
          undefined,
          heritage,
          [],
        );
        this.addNode(name, Processor.createAnnotationIfExists(element, node));
      }
    }
  }

  generateComplexTypeInterface(complexType: IComplexType) {
    const rawName = complexType.meta.name!;
    const name = this.clean(rawName);
    const interfaceSymbol = ts.factory.createIdentifier(name);

    let members: ts.Node[] = [];
    let heritage;

    /** Complex Content */
    if (Array.isArray(complexType['xs:complexContent'])) {
      const extendsName = complexType['xs:complexContent'][0]['xs:extension'][0].meta.base;
      const heritageName = resolveTypeRef(extendsName, this.overrides);
      if (name === heritageName) {
        // type inherits itself
        return;
      }
      heritage = this.extendInterface(heritageName);
      if (complexType['xs:sequence'] || complexType['xs:choice']) {
        throw new Error(`complexType has sequence/choice alongside complexContent: ${name}`);
      }
      const extension = complexType['xs:complexContent'][0]['xs:extension'][0];
      complexType['xs:sequence'] = extension['xs:sequence'];
      complexType['xs:choice'] = extension['xs:choice'];
      if (extension['xs:attribute']) {
        complexType['xs:attribute'] = extension['xs:attribute'];
      }
    }

    if (complexType['xs:attribute']) {
      members = members.concat(
        complexType['xs:attribute'].map((attribute) => {
          if (attribute.meta.use !== 'required') {
            // by default attributes are optional
            attribute.meta.use = 'optional';
          }
          return this.createProperty(attribute);
        }),
      );
    }

    // Top-level choice (SerialData, VideoAnalyticsStream, …)
    if (Array.isArray(complexType['xs:choice'])) {
      for (const choice of complexType['xs:choice']) {
        this.appendChoiceMembers(choice, members);
      }
    }

    if (complexType['xs:sequence']) {
      this.appendSequenceMembers(complexType['xs:sequence'][0], members);
    }

    const node = ts.factory.createInterfaceDeclaration(
      exportModifier,
      interfaceSymbol,
      undefined,
      heritage,
      members as ts.TypeElement[],
    );
    this.addNode(name, Processor.createAnnotationIfExists(complexType, node));
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
