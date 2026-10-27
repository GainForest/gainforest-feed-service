import type {
  InferMethodInputBody,
  InferMethodOutputBody,
  LexValue,
  Main,
  NsidString,
  ParamsSchema,
  Payload,
  Procedure,
  Schema,
} from '@atproto/lex-schema'
import {
  LexServerError,
  type LexRouter,
  type LexRouterMethodHandler,
} from '@atproto/lex-server'
import type { Logger } from 'pino'

import type { $input as feedInput } from '../lexicons/app/gainforest/feed/getFeedSkeleton.defs.js'
import type { OptionalServiceAuth } from '../auth/service-auth.js'
import { FeedError, FeedErrorCode } from '../feed/errors.js'
import type { FeedRequest } from '../feed/types.js'

type JsonProcedure = Procedure<
  NsidString,
  ParamsSchema,
  typeof feedInput,
  Payload<'application/json', Schema<LexValue>>
>

type FeedProcedureInput = InferMethodInputBody<JsonProcedure>

type FeedProcedureOutputParser<Output> = (
  output: Output,
) => InferMethodOutputBody<JsonProcedure>

const toFeedInput = (input: FeedProcedureInput): FeedRequest => ({
  feedId: input.feedId,
  ...(input.params === undefined ? {} : { params: input.params }),
  ...(input.limit === undefined ? {} : { limit: input.limit }),
  ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
})

interface RegisterFeedProcedureOptions<Output> {
  readonly router: LexRouter
  readonly method: Main<JsonProcedure>
  readonly logger: Logger
  readonly auth: OptionalServiceAuth | undefined
  readonly execute: (input: FeedRequest) => Promise<Output>
  readonly parseOutput: FeedProcedureOutputParser<Output>
  readonly errorLog: string
}

/** Registers a feed procedure with shared output validation and error handling. */
export const registerFeedProcedure = <Output>({
  router,
  method,
  logger,
  auth,
  execute,
  parseOutput,
  errorLog,
}: RegisterFeedProcedureOptions<Output>): void => {
  const handler = async (input: FeedProcedureInput) => {
    try {
      const output = await execute(toFeedInput(input))
      return { body: parseOutput(output) }
    } catch (cause) {
      if (cause instanceof FeedError) {
        throw new LexServerError(
          cause.status,
          { error: cause.code, message: cause.message },
          undefined,
          { cause },
        )
      }

      logger.error({ err: cause }, errorLog)
      throw new LexServerError(
        500,
        {
          error: FeedErrorCode.InternalError,
          message:
            'Feed generation failed because of an internal service error; retry the request, then contact the operator if it continues.',
        },
        undefined,
        { cause },
      )
    }
  }

  // The router verifies a supplied token before the handler runs, so an invalid
  // one is a 401 and never an anonymous request. The verified caller is not read
  // here: the activity feed gives every caller the same page for the same request.
  const methodHandler: LexRouterMethodHandler<JsonProcedure> = async ({
    input,
  }) => handler(input.body)
  if (auth === undefined) {
    router.add(method, methodHandler)
  } else {
    router.add(method, { auth, handler: methodHandler })
  }
}
