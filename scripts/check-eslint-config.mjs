import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const eslint = new ESLint({ cwd: repositoryRoot })

const lintMessages = async (filePath, code) => {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(repositoryRoot, filePath),
  })
  assert.ok(result, `ESLint returned no result for ${filePath}`)
  return result.messages
}

const assertRuleCount = async (filePath, code, ruleId, expectedCount) => {
  const messages = await lintMessages(filePath, code)
  const actualCount = messages.filter(
    (message) => message.ruleId === ruleId,
  ).length
  assert.equal(
    actualCount,
    expectedCount,
    `${filePath} should report ${expectedCount} ${ruleId} diagnostic(s), got ${actualCount}: ${messages
      .map((message) => `${message.ruleId ?? 'parser'}: ${message.message}`)
      .join('; ')}`,
  )
}

await assertRuleCount(
  'src/feed/query.ts',
  "import pg from 'pg'\nvoid pg",
  'no-restricted-imports',
  1,
)
await assertRuleCount(
  'src/feed/query.ts',
  "import type { Pool } from 'pg'\nvoid (0 as unknown as Pool)",
  'no-restricted-imports',
  0,
)
await assertRuleCount(
  'src/database.ts',
  "import pg from 'pg'\nvoid pg",
  'no-restricted-imports',
  0,
)
await assertRuleCount(
  'test/feed.integration.test.ts',
  "import pg from 'pg'\nvoid pg",
  'no-restricted-imports',
  0,
)
await assertRuleCount(
  'test/query.unit.test.ts',
  "import pg from 'pg'\nvoid pg",
  'no-restricted-imports',
  1,
)
await assertRuleCount(
  'src/server.ts',
  "import client from 'prom-client'\nvoid client",
  'no-restricted-imports',
  1,
)
await assertRuleCount(
  'src/metrics.ts',
  "import client from 'prom-client'\nvoid client",
  'no-restricted-imports',
  0,
)
await assertRuleCount(
  'src/hydration/service.ts',
  "import type { FeedService } from '../feed/service.js'\nvoid (0 as unknown as FeedService)",
  'no-restricted-imports',
  1,
)
await assertRuleCount(
  'src/hydration/service.ts',
  "import { handler } from '../api/get-feed.js'\nvoid handler",
  'no-restricted-imports',
  1,
)
await assertRuleCount(
  'src/feed/query.ts',
  "import { helper } from '../api/get-feed.js'\nvoid helper",
  'no-restricted-imports',
  0,
)
await assertRuleCount(
  'test/app.unit.test.ts',
  "describe.only('focused', () => { it('runs', () => {}) })",
  'vitest/no-focused-tests',
  1,
)
await assertRuleCount(
  'test/app.unit.test.ts',
  "describe('suite', () => { it.skip('disabled', () => {}) })",
  'vitest/no-disabled-tests',
  1,
)

for (const ignoredPath of [
  'src/lexicons/generated.ts',
  'dist/generated.js',
  'coverage/generated.ts',
  'node_modules/generated.js',
]) {
  assert.equal(
    await eslint.isPathIgnored(path.join(repositoryRoot, ignoredPath)),
    true,
    `${ignoredPath} should remain outside the lint set`,
  )
}

console.log(
  'ESLint config guards passed: import boundaries, test focus/skip, generated ignores.',
)
