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

export interface ISimpleType extends IAttribute {
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

/** Element particle as produced by xml2js (sequence / choice children). */
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
    namespace: string;
    processContents: string;
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
  'xs:any'?: IAnyParticle[];
}

export interface ISequence {
  'xs:element'?: IElementParticle[];
  'xs:choice'?: IChoice[];
  'xs:any'?: IAnyParticle[];
}

export interface IComplexType extends IAttribute {
  'xs:complexContent': {
    'xs:extension': {
      meta: {
        base: string;
      };
      'xs:sequence'?: ISequence[];
      'xs:choice'?: IChoice[];
      'xs:attribute'?: IAttribute[];
    }[];
  }[];
  'xs:attribute'?: IAttribute[];
  'xs:sequence'?: ISequence[];
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
}

export interface IType {
  name?: string;
}

/** Maps generated type name → owning module file name (without `.ts`). */
export type Links = Map<string, IType>;
