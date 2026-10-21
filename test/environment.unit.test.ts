import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadLocalEnvironment } from '../src/environment.js'

const variableName = 'HYPERCERTS_FEED_DOTENV_TEST'
const originalValue = process.env[variableName]
const directories: string[] = []

const createEnvFile = (value: string): string => {
  const directory = mkdtempSync(join(tmpdir(), 'hypercerts-feed-env-'))
  directories.push(directory)
  const path = join(directory, '.env')
  writeFileSync(path, `${variableName}=${value}\n`)
  return path
}

afterEach(() => {
  if (originalValue === undefined) {
    Reflect.deleteProperty(process.env, variableName)
  } else process.env[variableName] = originalValue
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('loadLocalEnvironment', () => {
  it('loads a local env file', () => {
    Reflect.deleteProperty(process.env, variableName)

    loadLocalEnvironment(createEnvFile('from-file'))

    expect(process.env[variableName]).toBe('from-file')
  })

  it('preserves values supplied by the process environment', () => {
    process.env[variableName] = 'from-process'

    loadLocalEnvironment(createEnvFile('from-file'))

    expect(process.env[variableName]).toBe('from-process')
  })
})
