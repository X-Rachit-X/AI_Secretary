/**
 * The one error type the API layer understands.
 *
 * Agents and services throw `AppError` when the user should see the reason
 * (out of credits, rate limited, Google not connected). Anything else that
 * escapes is treated as a bug and reported as a generic 500, so internal
 * details never leak into a chat bubble.
 */
export class AppError extends Error {
  readonly status: number;
  readonly title: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    title: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.title = title;
    this.details = details;
  }

  static unauthorized(message = "Please sign in again.") {
    return new AppError(401, "Not signed in", message);
  }

  static notConnected(service = "Google") {
    return new AppError(
      428,
      `${service} not connected`,
      `Connect your ${service} account from the sidebar before using this.`,
    );
  }

  static insufficientCredits(needed: number, have: number) {
    return new AppError(
      402,
      "Out of credits",
      `This action needs ${needed} credits and you have ${have}.`,
      { needed, have },
    );
  }

  static rateLimited(agent: string, limit: number, retryAfterSeconds: number) {
    return new AppError(
      429,
      "Slow down",
      `You hit the ${agent} limit of ${limit} per minute. Try again in ${retryAfterSeconds}s.`,
      { agent, limit, retryAfterSeconds },
    );
  }

  static badRequest(message: string) {
    return new AppError(400, "Invalid request", message);
  }

  static notFound(what = "Resource") {
    return new AppError(404, "Not found", `${what} not found.`);
  }
}

/** Shape sent to the browser for any failed request. */
export function toErrorBody(error: unknown) {
  if (error instanceof AppError) {
    return {
      success: false as const,
      title: error.title,
      message: error.message,
      ...(error.details ?? {}),
    };
  }

  return {
    success: false as const,
    title: "Something went wrong",
    message: error instanceof Error ? error.message : "Unexpected server error.",
  };
}

export function statusOf(error: unknown): number {
  return error instanceof AppError ? error.status : 500;
}
