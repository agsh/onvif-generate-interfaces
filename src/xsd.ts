import { Processor } from './processor';
import { ISchemaDefinition } from './schema-types';

/** Process a standalone `.xsd` schema file. */
export class ProcessorXSD extends Processor {
  async process() {
    this.schema = (await this.processXML())['xs:schema'] as ISchemaDefinition;
  }
}
