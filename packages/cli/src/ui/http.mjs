// Small HTTP helpers shared by the UI server modules. Node 20+, no dependencies.

export const MAX_BODY = 1024 * 1024;

// Thrown by handlers and checks; the server turns it into { error: { code, message, details? } }.
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

export function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  const error = {
    code: err instanceof HttpError ? err.code : 'internal',
    message: err instanceof HttpError ? err.message : 'Internal error',
  };
  if (err instanceof HttpError && err.details !== undefined) error.details = err.details;
  if (res.headersSent) return void res.end();
  sendJson(res, status, { error });
}

// Reads at most MAX_BODY bytes. Over the cap the rest is read and thrown away (so the client gets its
// response instead of a reset), then it rejects with 413.
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new HttpError(413, 'too-large', 'Request body is larger than 1 MB'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

export function parseJsonBody(buf) {
  if (buf.length === 0) return undefined;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad-request', 'Request body is not valid JSON');
  }
}
