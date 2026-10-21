import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const generatedRoot = fileURLToPath(new URL('../src/lexicons', import.meta.url))

// @atproto/lex emits explicit schema generics whose optional properties
// conflict with exactOptionalPropertyTypes. Inference preserves the same
// runtime schemas and generated public types without weakening app checks.
const explicitSimpleType = /l\.typedObject<([A-Za-z_$][A-Za-z0-9_$]*)>\(/g
const explicitRecordType =
  /l\.record<('[^']+'|"[^"]+"),\s*([A-Za-z_$][A-Za-z0-9_$]*)>\(/g

const definitionFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await definitionFiles(path)))
    else if (entry.name.endsWith('.defs.ts')) files.push(path)
  }
  return files
}

let files
try {
  files = await definitionFiles(generatedRoot)
} catch (cause) {
  if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
    throw new Error(
      `Expected generated Lexicon definitions under ${generatedRoot}, but lex build did not create them; run lex build with the repository's lexicons and output directory, then verify that path exists.`,
      { cause },
    )
  }
  throw new Error(
    `Failed to enumerate generated Lexicon definitions under ${generatedRoot}; check filesystem access and retry codegen.`,
    { cause },
  )
}

for (const file of files) {
  const source = await readFile(file, 'utf8')
  const rewritten = source
    .replace(explicitSimpleType, 'l.typedObject(')
    .replace(explicitRecordType, 'l.record(')
  if (
    rewritten.includes('l.typedObject<') ||
    rewritten.match(/l\.record<('[^']+'|"[^"]+"),/)
  ) {
    throw new Error(
      `Generated definitions at ${file} contain an unsupported schema generic; update the narrow @atproto/lex generated-definition workaround before continuing.`,
    )
  }
  if (rewritten !== source) await writeFile(file, rewritten)
}
