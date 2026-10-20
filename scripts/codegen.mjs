import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const hypercertsPackageRoot = dirname(
  require.resolve('@hypercerts-org/lexicon/package.json'),
)
const lexPackageRoot = dirname(dirname(require.resolve('@atproto/lex')))
const stagingRoot = await mkdtemp(join(tmpdir(), 'hypercerts-feed-lexicons-'))
const stagedLexicons = join(stagingRoot, 'lexicons')

try {
  await cp(join(repositoryRoot, 'lexicons'), stagedLexicons, {
    recursive: true,
  })

  // lex build resolves refs from one directory. Stage only the exact published
  // Hypercerts definitions referenced by the feed wire contract.
  const hypercertsDefs = JSON.parse(
    await readFile(
      join(hypercertsPackageRoot, 'lexicons/org/hypercerts/defs.json'),
      'utf8',
    ),
  )
  const requiredHypercertDefs = ['uri', 'smallBlob', 'smallImage', 'largeImage']
  if (
    hypercertsDefs.lexicon !== 1 ||
    hypercertsDefs.id !== 'org.hypercerts.defs' ||
    requiredHypercertDefs.some(
      (name) => hypercertsDefs.defs?.[name] === undefined,
    )
  ) {
    throw new Error(
      'The installed @hypercerts-org/lexicon package does not expose the org.hypercerts.defs image and blob definitions required by the feed contract; verify the pinned package version before regenerating feed schemas.',
    )
  }
  const destination = join(stagedLexicons, 'org/hypercerts/defs.json')
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(
    destination,
    `${JSON.stringify(
      {
        lexicon: hypercertsDefs.lexicon,
        id: hypercertsDefs.id,
        defs: Object.fromEntries(
          requiredHypercertDefs.map((name) => [
            name,
            hypercertsDefs.defs[name],
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  )

  execFileSync(
    process.execPath,
    [
      join(lexPackageRoot, 'bin', 'lex'),
      'build',
      '--lexicons',
      stagedLexicons,
      '--out',
      join(repositoryRoot, 'src/lexicons'),
      '--clear',
      '--indexFile',
    ],
    { stdio: 'inherit' },
  )
  execFileSync(
    process.execPath,
    [join(repositoryRoot, 'scripts/fix-generated-feed-defs.mjs')],
    { stdio: 'inherit' },
  )
} finally {
  await rm(stagingRoot, { recursive: true, force: true })
}
