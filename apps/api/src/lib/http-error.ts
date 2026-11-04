/** Thrown by services; the route error wrapper maps it to a JSON error response. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
