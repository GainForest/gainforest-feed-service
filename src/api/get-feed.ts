import type { LexRouter } from '@atproto/lex-server'
import type { Logger } from 'pino'

import type { OptionalServiceAuth } from '../auth/service-auth.js'
import type { FeedReader } from '../feed/service.js'
import type { GetFeedOutput } from '../feed/types.js'
import getFeed, { $output } from '../lexicons/app/gainforest/feed/getFeed.js'
import { registerFeedProcedure } from './feed-procedure.js'

/** Registers the public reference-and-metadata feed procedure on a LexRouter instance. */
export const registerGetFeed = (
  router: LexRouter,
  feedService: FeedReader,
  logger: Logger,
  auth?: OptionalServiceAuth,
): void => {
  registerFeedProcedure({
    router,
    method: getFeed,
    logger,
    auth,
    execute: (input) => feedService.getFeed(input),
    parseOutput: (output: GetFeedOutput) => $output.schema.$parse(output),
    errorLog: 'feed generation failed',
  })
}
