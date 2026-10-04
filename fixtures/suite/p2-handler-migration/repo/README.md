# Local HTTP-style application
src/router.mjs is the stable async response ABI. Handlers still use the v1 callback ABI.
Each handler owns a domain and can migrate without touching another handler.
The src/domains adapters and runtime are local examples; services in tests are injected.
No HTTP listener or network is needed: src/server.mjs dispatches plain objects.
Run npm test without installing dependencies. Add separate tests per handler.
