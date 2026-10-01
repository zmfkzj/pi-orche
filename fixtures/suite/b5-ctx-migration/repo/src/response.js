/** Send a JSON response once, preserving a consistent wire format. */
export function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

export function error(res, status, message) {
  json(res, status, { error: message });
}
