/**
 * xml2js shapes for ONVIF XSD / WSDL type sections (`attrkey: 'meta'`).
 */

export interface IAttribute {
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

/** Single XSD facet node (`<xs:maxLength value="64"/>`, etc.). */
export interface IFacet {
  meta: {
    value: string;
  };
}

/** Facets we surface as `@xsd …` JSDoc on generated aliases. */
export type RestrictionFacets = {
  'xs:length'?: IFacet[];
  'xs:minLength'?: IFacet[];
  'xs:maxLength'?: IFacet[];
  'xs:pattern'?: IFacet[];
  'xs:minInclusive'?: IFacet[];
  'xs:maxInclusive'?: IFacet[];
  'xs:minExclusive'?: IFacet[];
  'xs:maxExclusive'?: IFacet[];
  'xs:totalDigits'?: IFacet[];
  'xs:fractionDigits'?: IFacet[];
  'xs:whiteSpace'?: IFacet[];
};

export interface IRestriction extends RestrictionFacets {
  meta: {
    base: string;
  };
  'xs:enumeration'?: {
    meta: {
      value: string;
    };
  }[];
}

export interface ISimpleType extends IAttribute {
  'xs:restriction': IRestriction[];
  'xs:list': {
    meta: {
      itemType: string;
    };
  }[];
  /** `<xs:union memberTypes="a b"/>` and/or nested anonymous simpleTypes */
  'xs:union'?: {
    meta?: {
      memberTypes?: string;
    };
    'xs:simpleType'?: ISimpleType[];
  }[];
}

/** Element particle as produced by xml2js (sequence / choice / all children). */
export interface IElementParticle extends IAttribute {
  meta: IAttribute['meta'] & {
    name?: string;
    type?: string;
    use?: 'required' | 'optional';
  };
  'xs:complexType'?: IComplexType[];
  'xs:annotation'?: {
    'xs:documentation': string[];
  }[];
}

export interface IAnyParticle {
  meta: {
    namespace?: string;
    processContents?: string;
    minOccurs?: string;
    maxOccurs?: string;
  };
  'xs:annotation'?: {
    'xs:documentation': string[];
  }[];
}

export interface IChoice {
  meta?: {
    minOccurs?: string;
    maxOccurs?: string;
  };
  'xs:element'?: IElementParticle[];
  'xs:group'?: IGroupRef[];
  'xs:any'?: IAnyParticle[];
}

/** Shared particle container for sequence / all / group bodies. */
export interface IParticleContainer {
  'xs:element'?: IElementParticle[];
  'xs:choice'?: IChoice[];
  'xs:sequence'?: ISequence[];
  'xs:all'?: IAll[];
  'xs:group'?: IGroupRef[];
  'xs:any'?: IAnyParticle[];
}

export interface ISequence extends IParticleContainer {}

/** xs:all — unordered; XSD 1.0 allows only elements (we still accept the shared shape). */
export interface IAll extends IParticleContainer {}

export interface IGroupRef {
  meta: {
    name?: string;
    ref?: string;
    minOccurs?: string;
    maxOccurs?: string;
  };
  'xs:sequence'?: ISequence[];
  'xs:choice'?: IChoice[];
  'xs:all'?: IAll[];
}

export interface IAttributeGroup {
  meta: {
    name?: string;
    ref?: string;
  };
  'xs:attribute'?: IAttribute[];
  'xs:attributeGroup'?: IAttributeGroup[];
  'xs:anyAttribute'?: IAnyParticle[];
}

export interface ISimpleContent {
  'xs:extension'?: {
    meta: {
      base: string;
    };
    'xs:attribute'?: IAttribute[];
    'xs:attributeGroup'?: IAttributeGroup[];
    'xs:anyAttribute'?: IAnyParticle[];
  }[];
  'xs:restriction'?: {
    meta: {
      base: string;
    };
    'xs:attribute'?: IAttribute[];
    'xs:attributeGroup'?: IAttributeGroup[];
    'xs:anyAttribute'?: IAnyParticle[];
  }[];
}

export interface IComplexType extends IAttribute {
  'xs:complexContent': {
    'xs:extension': {
      meta: {
        base: string;
      };
      'xs:sequence'?: ISequence[];
      'xs:choice'?: IChoice[];
      'xs:all'?: IAll[];
      'xs:group'?: IGroupRef[];
      'xs:attribute'?: IAttribute[];
      'xs:attributeGroup'?: IAttributeGroup[];
      'xs:anyAttribute'?: IAnyParticle[];
    }[];
  }[];
  'xs:simpleContent'?: ISimpleContent[];
  'xs:attribute'?: IAttribute[];
  'xs:attributeGroup'?: IAttributeGroup[];
  'xs:anyAttribute'?: IAnyParticle[];
  'xs:sequence'?: ISequence[];
  'xs:all'?: IAll[];
  'xs:group'?: IGroupRef[];
  /** Top-level choice (e.g. VideoAnalyticsStream, SerialData) */
  'xs:choice'?: IChoice[];
}

export interface IElement {
  meta: {
    name: string;
    type?: string;
    use: 'required' | 'optional';
  };
  'xs:complexType': IComplexType[];
}

export interface ISchemaDefinition {
  'xs:schema': never;
  'wsdl:definitions': { 'wsdl:types': { 'xs:schema': never }[] };
  'xs:simpleType': ISimpleType[];
  'xs:complexType': IComplexType[];
  'xs:element': IElement[];
  'xs:group'?: IGroupRef[];
  'xs:attributeGroup'?: IAttributeGroup[];
}

export interface IType {
  name?: string;
}

/**
 * Maps generated type name → owning module file name (without `.ts`).
 * First registration wins for cross-file imports; later modules may still
 * export the same local name (e.g. many `Capabilities` interfaces).
 */
export type Links = Map<string, IType>;

/** Namespaces we treat as open extension points → index signatures. */
export const EXTENSION_ANY_NAMESPACES = new Set(['##any', '##other', '##targetNamespace']);

export function isExtensionAnyNamespace(namespace?: string): boolean {
  // Only explicit open-content tokens. Bare xs:anyAttribute (XSD default ##any) is
  // omitted on purpose — emitting index signatures there breaks structural assignability
  // across the ONVIF surface (e.g. IPAddress ↛ NetworkHost).
  return !!namespace && EXTENSION_ANY_NAMESPACES.has(namespace);
}
