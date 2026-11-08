import { writeFileSync } from 'fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { format } from 'prettier';
import ts from 'typescript';
import { BASICS_FILENAME, sourceFile } from './constants';

const PRETTIER_OPTIONS = {
  parser: 'typescript' as const,
  singleQuote: true,
  semi: true,
  trailingComma: 'all' as const,
  arrowParens: 'always' as const,
  endOfLine: 'lf' as const,
  printWidth: 120,
};

/** Print a list of TS AST nodes to source text. */
export function printNodes(nodes: ts.Node[]): string {
  const nodeArr = ts.factory.createNodeArray(nodes);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  return printer.printList(ts.ListFormat.MultiLine, nodeArr, sourceFile);
}

export async function formatTypescript(code: string): Promise<string> {
  return format(code, PRETTIER_OPTIONS);
}

/**
 * Write generated TypeScript for one module file.
 */
export async function writeInterfaceFile(
  outDir: string,
  fileName: string,
  nodes: ts.Node[],
  options: { silent?: boolean } = {},
): Promise<void> {
  const prettified = await formatTypescript(printNodes(nodes));
  const target = join(outDir, `${fileName}.ts`);
  if (!options.silent) {
    console.log(chalk.greenBright(`Save to ${target}`));
  }
  writeFileSync(target, prettified, { encoding: 'utf-8' });
}

/** Write the shared `basics.ts` builtins module. */
export async function writeBasicsFile(
  outDir: string,
  builtInTypes: ts.Node[],
  options: { silent?: boolean } = {},
): Promise<void> {
  await writeInterfaceFile(outDir, BASICS_FILENAME, builtInTypes, options);
}

export function formatComment(str: string): string {
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
