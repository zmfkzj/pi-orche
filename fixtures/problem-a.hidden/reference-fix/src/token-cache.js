import { systemClock } from './clock.js';

export class TokenCache {
  #current;
  #refreshing;

  constructor({ issueToken, clock = systemClock, expirySkewMs = 1000 }) {
    this.issueToken = issueToken;
    this.clock = clock;
    this.expirySkewMs = expirySkewMs;
  }

  async get() {
    if (this.#current && this.#current.expiresAt - this.expirySkewMs > this.clock.now()) {
      return this.#current.value;
    }
    if (!this.#refreshing) {
      this.#refreshing = this.issueToken().then(token => {
        this.#current = token;
        return token.value;
      }).finally(() => {
        this.#refreshing = undefined;
      });
    }
    return this.#refreshing;
  }

  invalidate(rejectedToken) {
    if (this.#current?.value === rejectedToken) {
      this.#current = undefined;
    }
  }
}
