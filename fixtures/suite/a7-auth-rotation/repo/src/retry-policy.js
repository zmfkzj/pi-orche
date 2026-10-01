export function shouldRetryAuthentication(error, attempt) {
  return error?.status === 401 && attempt === 0;
}
