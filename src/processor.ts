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
  IAll,
  IAnyParticle,
  IAttribute,
  IAttributeGroup,
  IChoice,
  IComplexType,
  IElement,
  IGroupRef,
  IParticleContainer,
  ISchemaDefinition,
  ISequence,
  ISimpleContent,
  ISimpleType,
  isExtensionAnyNamespace,
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

  /** Top-level xs:group definitions in the current schema (local name → definition). */
  private readonly groups = new Map<string, IGroupRef>();

  /** Top-level xs:attributeGroup definitions in the current schema. */
  private readonly attributeGroups = new Map<string, IAttributeGroup>();

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
    this.collectNamedGroups();
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

  /** Index top-level group / attributeGroup declarations for later ref expansion. */
  private collectNamedGroups() {
    this.groups.clear();
    this.attributeGroups.clear();
    for (const group of this.schema?.['xs:group'] ?? []) {
      if (group.meta?.name) {
        this.groups.set(group.meta.name, group);
      }
    }
    for (const ag of this.schema?.['xs:attributeGroup'] ?? []) {
      if (ag.meta?.name) {
        this.attributeGroups.set(ag.meta.name, ag);
      }
    }
  }

  private localNameFromRef(ref: string): string {
    return ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref;
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
          ? attribute['xs:annotation']?.[0]
          : attribute['xs:annotation']?.[0]['xs:documentation'][0];
      return ts.addSyntheticLeadingComment(node, ts.SyntaxKind.MultiLineCommentTrivia, formatComment(annotation), true);
    }
    return node;
  }

  /**
   * Register a generated declaration.
   *
   * Name-collision policy (intentional — do not "fix" with service prefixes):
   * - `links` is first-wins: the first file that defines `Capabilities` owns
   *   cross-file `import { Capabilities } from './…'`. Later services still
   *   `export interface Capabilities` locally; consumers import from the
   *   concrete module (`./ptz.2`, `./media`, …), so unprefixed names stay.
   * - Prefixes like `TdsCapabilities` / `TptzCapabilities` are a breaking API
   *   change for the onvif library and are deliberately not used.
   * - The only suppress-on-collision case is builtins owned by `basics`
   *   (e.g. PositiveInteger) — those must not be re-emitted by schemas.
   */
  addNode(name: string, node: ts.Node) {
    if (this.links.has(name)) {
      const owner = this.links.get(name)!.name;
      if (owner === BASICS_FILENAME && this.fileName !== BASICS_FILENAME) {
        return;
      }
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

  trackUsedType(typeName: string) {
    if (needsImport(typeName)) {
      this.usedTypes.add(typeName);
    }
  }

  /**
   * Index signatures for xs:any / xs:anyAttribute extension points
   * (`##any`, `##other`, `##targetNamespace`).
   */
  createExtensionIndexSignatures(anyNode: IAttribute | IAnyParticle): ts.TypeElement[] {
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
      return (
        index === 0 ? Processor.createAnnotationIfExists(anyNode as IAttribute, signature) : signature
      ) as ts.TypeElement;
    });
  }

  /** True if members already contain an index signature (avoid duplicates from multiple xs:any). */
  private hasIndexSignature(members: ts.Node[]): boolean {
    return members.some((m) => ts.isIndexSignatureDeclaration(m as ts.TypeElement));
  }

  generateSimpleTypeInterface(simpleType: ISimpleType) {
    const name = this.clean(simpleType.meta.name!);

    const interfaceSymbol = ts.factory.createIdentifier(name);
    if (simpleType['xs:restriction']) {
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
    } else if (simpleType['xs:union']) {
      this.generateUnionType(name, simpleType);
    }
  }

  /** `<xs:union memberTypes="…">` → TypeScript union type alias. */
  generateUnionType(name: string, simpleType: ISimpleType) {
    const union = simpleType['xs:union']![0];
    const parts: TypeNode[] = [];

    if (union.meta?.memberTypes) {
      for (const member of union.meta.memberTypes.trim().split(/\s+/).filter(Boolean)) {
        const typeName = resolveTypeRef(member, this.overrides);
        this.trackUsedType(typeName);
        parts.push(ts.factory.createTypeReferenceNode(typeName));
      }
    }

    // Nested anonymous simpleTypes inside the union
    for (const nested of union['xs:simpleType'] ?? []) {
      if (nested['xs:restriction']?.[0]?.['xs:enumeration']) {
        for (const enumValue of nested['xs:restriction'][0]['xs:enumeration']) {
          parts.push(ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(enumValue.meta.value, true)));
        }
      } else if (nested['xs:restriction']?.[0]?.meta.base) {
        const typeName = resolveTypeRef(nested['xs:restriction'][0].meta.base, this.overrides);
        this.trackUsedType(typeName);
        parts.push(ts.factory.createTypeReferenceNode(typeName));
      } else if (nested['xs:list']?.[0]?.meta.itemType) {
        const itemTypeName = resolveTypeRef(nested['xs:list'][0].meta.itemType, this.overrides);
        this.trackUsedType(itemTypeName);
        parts.push(ts.factory.createArrayTypeNode(ts.factory.createTypeReferenceNode(itemTypeName)));
      }
    }

    if (parts.length === 0) {
      parts.push(ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword));
    }

    this.addNode(
      name,
      Processor.createAnnotationIfExists(
        simpleType,
        ts.factory.createTypeAliasDeclaration(
          exportModifier,
          ts.factory.createIdentifier(name),
          undefined,
          parts.length === 1 ? parts[0] : ts.factory.createUnionTypeNode(parts),
        ),
      ),
    );
  }

  normalizeParticle(attribute: IAttribute): void {
    if (attribute.meta.ref && !attribute.meta.name) {
      attribute.meta.name = this.localNameFromRef(attribute.meta.ref);
    }
  }

  createProperty(
    attribute: IAttribute,
    options: { forceOptional?: boolean; forceArray?: boolean } = {},
  ) {
    this.normalizeParticle(attribute);
    const typeName = resolveTypeRef(attribute.meta.type, this.overrides);
    let type: TypeNode = ts.factory.createTypeReferenceNode(typeName);
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

  /** Simple-content character data property (`_` — xml2js / ONVIF SOAP convention). */
  createSimpleContentValueProperty(baseTypeName: string): ts.TypeElement {
    this.trackUsedType(baseTypeName);
    return ts.factory.createPropertySignature(
      undefined,
      '_',
      undefined,
      ts.factory.createTypeReferenceNode(baseTypeName),
    );
  }

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
    if (Array.isArray(choice['xs:group'])) {
      for (const group of choice['xs:group']) {
        this.appendGroupRef(group, members, { forceOptional: true, forceArray: unbounded });
      }
    }
    this.appendAnyMembers(choice['xs:any'], members);
  }

  appendAnyMembers(anyParticles: IAnyParticle[] | undefined, members: ts.Node[]) {
    if (this.hasIndexSignature(members)) {
      return;
    }
    const first = anyParticles?.find((a) => isExtensionAnyNamespace(a.meta?.namespace));
    if (first) {
      members.push(...this.createExtensionIndexSignatures(first));
    }
  }

  appendAttributeMembers(attributes: IAttribute[] | undefined, members: ts.Node[]) {
    if (!attributes) {
      return;
    }
    for (const attribute of attributes) {
      if (attribute.meta.use !== 'required') {
        attribute.meta.use = 'optional';
      }
      members.push(this.createProperty(attribute));
    }
  }

  appendAttributeGroupRefs(groups: IAttributeGroup[] | undefined, members: ts.Node[]) {
    if (!groups) {
      return;
    }
    for (const group of groups) {
      this.appendAttributeGroup(group, members);
    }
  }

  appendAttributeGroup(group: IAttributeGroup, members: ts.Node[]) {
    if (group.meta.ref) {
      const local = this.localNameFromRef(group.meta.ref);
      const resolved = this.attributeGroups.get(local);
      if (!resolved) {
        console.warn(chalk.yellow(`attributeGroup ${group.meta.ref} not found in ${this.fileName}`));
        return;
      }
      this.appendAttributeGroup(resolved, members);
      return;
    }
    this.appendAttributeMembers(group['xs:attribute'], members);
    this.appendAttributeGroupRefs(group['xs:attributeGroup'], members);
    this.appendAnyMembers(group['xs:anyAttribute'], members);
  }

  appendGroupRef(
    group: IGroupRef,
    members: ts.Node[],
    options: { forceOptional?: boolean; forceArray?: boolean } = {},
  ) {
    let body: IGroupRef | undefined = group;
    if (group.meta.ref) {
      const local = this.localNameFromRef(group.meta.ref);
      body = this.groups.get(local);
      if (!body) {
        console.warn(chalk.yellow(`group ${group.meta.ref} not found in ${this.fileName}`));
        return;
      }
    }
    if (body['xs:sequence']) {
      this.appendParticleContainer(body['xs:sequence'][0], members, options);
    }
    if (body['xs:choice']) {
      for (const choice of body['xs:choice']) {
        this.appendChoiceMembers(choice, members);
      }
    }
    if (body['xs:all']) {
      this.appendParticleContainer(body['xs:all'][0], members, options);
    }
  }

  /** Walk sequence / all particle containers. */
  appendParticleContainer(
    container: IParticleContainer,
    members: ts.Node[],
    options: { forceOptional?: boolean; forceArray?: boolean } = {},
  ) {
    if (Array.isArray(container['xs:element'])) {
      for (const attribute of container['xs:element']) {
        if (attribute['xs:complexType']) {
          attribute['xs:complexType'][0].meta = { name: attribute.meta.name, use: 'optional' };
          this.generateComplexTypeInterface(attribute['xs:complexType'][0]);
          attribute.meta.type = attribute.meta.name;
        }
        members.push(
          this.createProperty(attribute, {
            forceOptional: options.forceOptional,
            forceArray: options.forceArray,
          }),
        );
      }
    }
    if (Array.isArray(container['xs:choice'])) {
      for (const choice of container['xs:choice']) {
        this.appendChoiceMembers(choice, members);
      }
    }
    if (Array.isArray(container['xs:sequence'])) {
      for (const seq of container['xs:sequence']) {
        this.appendParticleContainer(seq, members, options);
      }
    }
    if (Array.isArray(container['xs:all'])) {
      for (const all of container['xs:all']) {
        this.appendParticleContainer(all, members, options);
      }
    }
    if (Array.isArray(container['xs:group'])) {
      for (const group of container['xs:group']) {
        this.appendGroupRef(group, members, options);
      }
    }
    this.appendAnyMembers(container['xs:any'], members);
  }

  appendSequenceMembers(sequence: ISequence, members: ts.Node[]) {
    this.appendParticleContainer(sequence, members);
  }

  appendAllMembers(all: IAll, members: ts.Node[]) {
    // xs:all is unordered; TypeScript cannot express order — same as sequence
    this.appendParticleContainer(all, members);
  }

  /**
   * Emit simpleContent.
   * - Named attributes → interface with `_` (xml2js text) + attrs (e.g. CertificateUsage).
   * - No named attributes (only anyAttribute / bare) → type alias to the base
   *   (e.g. OSDReference → ReferenceToken). Callers pass plain tokens; wrapping
   *   as `{ _: T }` would break assignability from `string`.
   * Returns true when the whole complexType was emitted as a type alias.
   */
  appendSimpleContent(name: string, simpleContent: ISimpleContent, members: ts.Node[]): boolean {
    const extension = simpleContent['xs:extension']?.[0];
    const restriction = simpleContent['xs:restriction']?.[0];
    const body = extension ?? restriction;
    if (!body) {
      return false;
    }
    const baseType = resolveTypeRef(body.meta.base, this.overrides);
    const hasNamedAttrs =
      (body['xs:attribute']?.length ?? 0) > 0 || (body['xs:attributeGroup']?.length ?? 0) > 0;
    if (!hasNamedAttrs) {
      this.trackUsedType(baseType);
      this.addNode(
        name,
        ts.factory.createTypeAliasDeclaration(
          exportModifier,
          ts.factory.createIdentifier(name),
          undefined,
          ts.factory.createTypeReferenceNode(baseType),
        ),
      );
      return true;
    }
    members.push(this.createSimpleContentValueProperty(baseType));
    this.appendAttributeMembers(body['xs:attribute'], members);
    this.appendAttributeGroupRefs(body['xs:attributeGroup'], members);
    this.appendAnyMembers(body['xs:anyAttribute'], members);
    return false;
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
        element.meta.type = '';
      }
      if (element.meta.type !== undefined) {
        if (shouldSkipElement(this.fileName, element.meta.name, element.meta.type, this.overrides)) {
          return;
        }
        const name = this.clean(element.meta.name);
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
        return;
      }
      heritage = this.extendInterface(heritageName);
      if (complexType['xs:sequence'] || complexType['xs:choice'] || complexType['xs:all'] || complexType['xs:group']) {
        throw new Error(`complexType has particles alongside complexContent: ${name}`);
      }
      const extension = complexType['xs:complexContent'][0]['xs:extension'][0];
      complexType['xs:sequence'] = extension['xs:sequence'];
      complexType['xs:choice'] = extension['xs:choice'];
      complexType['xs:all'] = extension['xs:all'];
      complexType['xs:group'] = extension['xs:group'];
      if (extension['xs:attribute']) {
        complexType['xs:attribute'] = extension['xs:attribute'];
      }
      if (extension['xs:attributeGroup']) {
        complexType['xs:attributeGroup'] = extension['xs:attributeGroup'];
      }
      if (extension['xs:anyAttribute']) {
        complexType['xs:anyAttribute'] = extension['xs:anyAttribute'];
      }
    }

    /** Simple Content (character data + attributes) */
    if (Array.isArray(complexType['xs:simpleContent'])) {
      if (this.appendSimpleContent(name, complexType['xs:simpleContent'][0], members)) {
        return;
      }
    }

    this.appendAttributeMembers(complexType['xs:attribute'], members);
    this.appendAttributeGroupRefs(complexType['xs:attributeGroup'], members);
    this.appendAnyMembers(complexType['xs:anyAttribute'], members);

    if (Array.isArray(complexType['xs:choice'])) {
      for (const choice of complexType['xs:choice']) {
        this.appendChoiceMembers(choice, members);
      }
    }

    if (complexType['xs:sequence']) {
      this.appendSequenceMembers(complexType['xs:sequence'][0], members);
    }

    if (complexType['xs:all']) {
      this.appendAllMembers(complexType['xs:all'][0], members);
    }

    if (Array.isArray(complexType['xs:group'])) {
      for (const group of complexType['xs:group']) {
        this.appendGroupRef(group, members);
      }
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
