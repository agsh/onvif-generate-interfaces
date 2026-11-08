import { readFileSync } from 'fs';
import { Parser } from 'xml2js';
import { ISchemaDefinition } from './schema-types';

/**
 * Read an XSD/WSDL file, wrap documentation in CDATA for xml2js, and parse.
 */
export async function parseXmlFile(filePath: string): Promise<ISchemaDefinition> {
  const xsdData = readFileSync(filePath, { encoding: 'utf-8' }).replace(
    /<xs:documentation>([\s\S]*?)<\/xs:documentation>/g,
    (_, b: string) => `<xs:documentation><![CDATA[${b.replace(/(\s)+\n/, '\n')}]]></xs:documentation>`,
  );

  const xmlParser = new Parser({
    attrkey: 'meta',
  });

  return xmlParser.parseStringPromise(xsdData) as Promise<ISchemaDefinition>;
}
