import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const lexPackageRoot = dirname(dirname(require.resolve('@atproto/lex')))

// The feed Lexicons reference no external definitions, so lex build can read
// the committed directory directly.
execFileSync(
  process.execPath,
  [
    join(lexPackageRoot, 'bin', 'lex'),
    'build',
    '--lexicons',
    join(repositoryRoot, 'lexicons'),
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
