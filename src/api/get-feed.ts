import type { LexRouter } from '@atproto/lex-server'
import type { Logger } from 'pino'

import type { OptionalServiceAuth } from '../auth/service-auth.js'
import type { HydratedFeedReader } from '../hydration/service.js'
import type { GetHydratedFeedOutput } from '../hydration/types.js'
import getFeed, { $output } from '../lexicons/org/hypercerts/feed/getFeed.js'
import { registerFeedProcedure } from './feed-procedure.js'

/** Registers the public view-only hydrated feed procedure on a LexRouter instance. */
export const registerGetFeed = (
  router: LexRouter,
  feedService: HydratedFeedReader,
  logger: Logger,
  auth?: OptionalServiceAuth,
): void => {
  registerFeedProcedure({
    router,
    method: getFeed,
    logger,
    auth,
    execute: (input) => feedService.getFeed(input),
    parseOutput: (output: GetHydratedFeedOutput) =>
      $output.schema.$parse(output),
    errorLog: 'hydrated feed generation failed',
  })
}
