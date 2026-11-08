import ts from 'typescript';

export const BASICS_FILENAME = 'basics';

/** Empty source file used only as a print context for the TS printer. */
export const sourceFile = ts.createSourceFile(
  'source.ts',
  '',
  ts.ScriptTarget.Latest,
  false,
  ts.ScriptKind.TS,
);

/** `export` modifier for generated declarations. */
export const exportModifier = ts.factory.createModifiersFromModifierFlags(ts.ModifierFlags.Export);
