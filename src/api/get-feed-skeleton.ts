import type { LexRouter } from '@atproto/lex-server'
import type { Logger } from 'pino'

import type { OptionalServiceAuth } from '../auth/service-auth.js'
import type { FeedSkeletonReader } from '../feed/service.js'
import type { GetFeedSkeletonOutput } from '../feed/types.js'
import getFeedSkeleton, {
  $output,
} from '../lexicons/app/gainforest/feed/getFeedSkeleton.js'
import { registerFeedProcedure } from './feed-procedure.js'

/** Registers the public generic feed-skeleton procedure on a LexRouter instance. */
export const registerGetFeedSkeleton = (
  router: LexRouter,
  feedService: FeedSkeletonReader,
  logger: Logger,
  auth?: OptionalServiceAuth,
): void => {
  registerFeedProcedure({
    router,
    method: getFeedSkeleton,
    logger,
    auth,
    execute: (input) => feedService.getFeedSkeleton(input),
    parseOutput: (output: GetFeedSkeletonOutput) =>
      $output.schema.$parse(output),
    errorLog: 'feed skeleton generation failed',
  })
}
