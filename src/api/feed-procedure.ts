import type {
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

import { applyAuthenticatedViewer } from '../auth/input.js'
import type {
  OptionalServiceAuth,
  ServiceAuthCredentials,
} from '../auth/service-auth.js'
import { FeedError, FeedErrorCode } from '../feed/errors.js'
import type { GetFeedSkeletonInput } from '../feed/types.js'

type JsonProcedure = Procedure<
  NsidString,
  ParamsSchema,
  Payload<'application/json', Schema<LexValue>>,
  Payload<'application/json', Schema<LexValue>>,
  readonly string[] | undefined
>

type FeedProcedureOutputParser<Output> = (
  output: Output,
) => InferMethodOutputBody<JsonProcedure>

interface RegisterFeedProcedureOptions<Output> {
  readonly router: LexRouter
  readonly method: Main<JsonProcedure>
  readonly logger: Logger
  readonly auth: OptionalServiceAuth | undefined
  readonly execute: (input: GetFeedSkeletonInput) => Promise<Output>
  readonly parseOutput: FeedProcedureOutputParser<Output>
  readonly errorLog: string
}

/** Registers a feed procedure with shared viewer binding, output validation, and error handling. */
export const registerFeedProcedure = <Output>({
  router,
  method,
  logger,
  auth,
  execute,
  parseOutput,
  errorLog,
}: RegisterFeedProcedureOptions<Output>): void => {
  const handler = async (
    input: GetFeedSkeletonInput,
    credentials: ServiceAuthCredentials | undefined,
  ) => {
    try {
      const output = await execute(applyAuthenticatedViewer(input, credentials))
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

  if (auth === undefined) {
    const unauthenticatedHandler: LexRouterMethodHandler<
      JsonProcedure,
      void
    > = async ({ input }) =>
      handler(
        (input as unknown as { body: GetFeedSkeletonInput }).body,
        undefined,
      )
    router.add(method, unauthenticatedHandler)
  } else {
    const authenticatedHandler: LexRouterMethodHandler<
      JsonProcedure,
      ServiceAuthCredentials | undefined
    > = async ({ input, credentials }) =>
      handler(
        (input as unknown as { body: GetFeedSkeletonInput }).body,
        credentials,
      )
    router.add(method, { auth, handler: authenticatedHandler })
  }
}
