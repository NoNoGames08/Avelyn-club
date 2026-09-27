export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function json(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function fail(res, error) {
  if (error instanceof HttpError) {
    return json(res, error.status, { error: error.message, details: error.details });
  }
  console.error(error);
  return json(res, 500, { error: "Une erreur inattendue est survenue." });
}

export function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch { throw new HttpError(400, 'Corps de requête illisible.'); }
  }
  return {};
}

export function str(value, { max = 200 } = {}) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

export function require_(value, label) {
  const v = str(value);
  if (!v) throw new HttpError(400, `Champ manquant : ${label}.`);
  return v;
}
