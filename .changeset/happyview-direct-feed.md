---
"@hypercerts/hypercerts-feed-service": major
---

Read feed records, labels, and Certified profiles directly from HappyView PostgreSQL. Feed timestamps use valid record `createdAt` with `indexed_at` fallback; organization quality uses HappyView's current positive label projection. Remove the Hyperboard kind and legacy handle/Bluesky identity fallbacks.
