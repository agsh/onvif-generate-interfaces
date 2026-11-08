import { Processor } from './processor';
import { ISchemaDefinition } from './schema-types';

/** Process the embedded `xs:schema` inside a `.wsdl` definitions document. */
export class ProcessorWSDL extends Processor {
  async process() {
    const xml = await this.processXML();
    const schemaDefinition = xml['wsdl:definitions']['wsdl:types']?.[0]['xs:schema']?.[0];
    this.schema = schemaDefinition as ISchemaDefinition;
  }
}
