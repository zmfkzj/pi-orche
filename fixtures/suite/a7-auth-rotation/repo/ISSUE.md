# Invoice sync intermittently fails under parallel load

Our invoice synchronizer works for individual accounts, but some multi-account batches fail with an identity-provider rate-limit error. The same accounts usually work when retried later or fetched one at a time. This started appearing after the upstream service began occasionally rejecting a still-unexpired credential during rotation.

The identity provider permits one replacement credential per batch, which should be sufficient. Our client retries authentication failures once; do not increase retry counts, serialize all account fetching, or swallow failed requests. Preserve parallel account fetching, expiry handling, and error propagation.

Investigate the code paths, possible independent causes, and the excerpt in `logs/production.log`. Reproduce deterministically, fix the underlying problem, and add a regression test. The existing suite is `node --test` (Node 24+, no dependencies).
