import { z } from "zod";

/** Version 1 binds ordinary message acceptance to the thread the sender saw.
 * It is an in-process acknowledgement, not a durable dispatch receipt. */
export const MESSAGE_SEND_VERSION = 1;

export interface MessageThreadInput {
  text?: unknown;
  expectedThreadId?: unknown;
}

const threadIdSchema = z.string().min(1).max(128).regex(/^[\w-]+$/);

export class MessageThreadError extends Error {
  readonly status: 400 | 409;

  constructor(status: 400 | 409, message: string) {
    super(message);
    this.name = "MessageThreadError";
    this.status = status;
  }
}

/** Call after reading the body and looking up the current bot/room, before
 * appending, queuing or starting a turn. Older clients may omit the guard. */
export function requireMessageThread(body: MessageThreadInput, currentThreadId: string): string {
  if (!Object.hasOwn(body, "expectedThreadId")) return currentThreadId;
  const expected = threadIdSchema.safeParse(body.expectedThreadId);
  if (!expected.success) {
    throw new MessageThreadError(400, "A valid expectedThreadId is required when provided.");
  }
  if (expected.data !== currentThreadId) {
    throw new MessageThreadError(409, "This conversation has changed. Reopen it and review your draft before sending.");
  }
  return currentThreadId;
}
