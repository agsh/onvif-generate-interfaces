import { writeFileSync } from 'fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { format, resolveConfig } from 'prettier';
import ts from 'typescript';
import { BASICS_FILENAME, sourceFile } from './constants';

/** Package root (parent of `src/`) — where `.prettierrc` lives. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Print a list of TS AST nodes to source text. */
export function printNodes(nodes: ts.Node[]): string {
  const nodeArr = ts.factory.createNodeArray(nodes);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  return printer.printList(ts.ListFormat.MultiLine, nodeArr, sourceFile);
}

export async function formatTypescript(code: string): Promise<string> {
  const config = (await resolveConfig(join(PACKAGE_ROOT, 'package.json'))) ?? {};
  return format(code, { ...config, parser: 'typescript' });
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

/** Inner body of a JSDoc block (without the slash-star delimiters). */
export function formatCommentLines(lines: string[]): string {
  const strs = lines
    .flatMap((line) => line.split('\n'))
    .map((a) => a.trim().replace(/<[^>]*>/g, ''))
    .filter((a) => a !== '');
  if (strs.length === 0) {
    return '';
  }
  if (strs.length === 1) {
    return `* ${strs[0]} `;
  }
  return `*\n${strs.map((a) => ` * ${a}`).join('\n')}\n `;
}

export function formatComment(str: string): string {
  return formatCommentLines([str]);
}
