import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../src/config.js'

const { poolConstructor } = vi.hoisted(() => ({
  poolConstructor: vi.fn(),
}))

vi.mock('pg', () => ({
  Pool: class {
    constructor(config: unknown) {
      poolConstructor(config)
    }

    on(): this {
      return this
    }
  },
}))

import { Database } from '../src/database.js'

describe('Database', () => {
  it('keeps one connection warm and drains excess idle connections', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://feed:secret@localhost:5432/indexer',
      SERVICE_DID: 'did:web:feed.example',
      DATABASE_MAX_CONNECTIONS: '5',
      DATABASE_IDLE_TIMEOUT_MS: '120000',
    })

    new Database(config, pino({ enabled: false }))

    expect(poolConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        max: 5,
        min: 1,
        idleTimeoutMillis: 120_000,
      }),
    )
  })

  it('opens read-only sessions with JIT off, which only slows the feed statement down', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://feed:secret@localhost:5432/indexer',
      SERVICE_DID: 'did:web:feed.example',
    })

    new Database(config, pino({ enabled: false }))

    for (const setting of ['default_transaction_read_only=on', 'jit=off']) {
      expect(poolConstructor).toHaveBeenLastCalledWith(
        expect.objectContaining({
          options: expect.stringContaining(`-c ${setting}`) as unknown,
        }),
      )
    }
  })
})
