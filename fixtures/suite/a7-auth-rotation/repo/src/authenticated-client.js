import { shouldRetryAuthentication } from './retry-policy.js';

export class AuthenticatedClient {
  constructor({ tokens, transport }) {
    this.tokens = tokens;
    this.transport = transport;
  }

  async get(path) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.tokens.get();
      try {
        return await this.transport({ path, headers: { authorization: 'Bearer ' + token } });
      } catch (error) {
        if (!shouldRetryAuthentication(error, attempt)) throw error;
        this.tokens.invalidate();
      }
    }
  }
}
