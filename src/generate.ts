import { join } from 'node:path';
import chalk from 'chalk';
import { glob } from 'glob';
import { generateBuiltIns } from './map-types';
import { GeneratorOverrides, onvifOverrides } from './overrides';
import { Links } from './schema-types';
import { writeBasicsFile } from './write';
import { ProcessorWSDL } from './wsdl';
import { ProcessorXSD } from './xsd';

export interface InterfaceProcessorOptions {
  overrides?: GeneratorOverrides;
  /** Suppress progress logs (used by snapshot tests). */
  silent?: boolean;
}

/**
 * Orchestrates XSD → WSDL processing, import linking, and writing `.ts` modules.
 */
export class InterfaceProcessor {
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
    this.links = builtInLinks;

    const processors = [];

    const xsds = await glob(join(sourcesPath, '/**/*.xsd'));
    for (const xsd of xsds) {
      this.log(chalk.greenBright(`processing ${xsd}`));
      const proc = new ProcessorXSD({
        filePath: xsd,
        links: this.links,
        overrides: this.overrides,
      });
      processors.push(proc);
      await proc.prefix();
    }

    const wsdls = await glob(join(sourcesPath, '/**/*.wsdl'));
    for (const wsdl of wsdls) {
      this.log(chalk.greenBright(`processing ${wsdl}`));
      const proc = new ProcessorWSDL({
        filePath: wsdl,
        links: this.links,
        overrides: this.overrides,
      });
      processors.push(proc);
      await proc.prefix();
    }

    for (const proc of processors.reverse()) {
      proc.suffix(this.links);
      await proc.writeInterface(outPath, { silent: this.silent });
    }

    await writeBasicsFile(outPath, builtInTypes, { silent: this.silent });
    this.log('Done!');
  }
}
