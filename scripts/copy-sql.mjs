import { mkdir, copyFile } from 'node:fs/promises'

const statements = ['feed-query.sql', 'following-query.sql']

await mkdir(new URL('../dist/feed/', import.meta.url), { recursive: true })
for (const statement of statements) {
  await copyFile(
    new URL(`../src/feed/${statement}`, import.meta.url),
    new URL(`../dist/feed/${statement}`, import.meta.url),
  )
}
