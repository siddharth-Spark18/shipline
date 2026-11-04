import { Request, Response, NextFunction, RequestHandler } from 'express';
import { HttpError } from './http-error';

/** Wraps an async route so thrown HttpErrors become `{ error, code }` responses. */
export function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    });
  };
}
