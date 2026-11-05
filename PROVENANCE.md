# Provenance

The request handler in `src/protocol.ts` and the shape of `test/cache.test.ts` come from [joelhooks/alchemy-turbo-cache](https://github.com/joelhooks/alchemy-turbo-cache) at `a51a7ba` (MIT): authentication before storage, one token per team compared with `crypto.subtle.timingSafeEqual`, strict slug and hash segments, streamed bodies, and the real-Turbo remote-hit test. That package was itself extracted from [joelhooks/rat-stack](https://github.com/joelhooks/rat-stack).

Changes here: artifacts are keyed by the OS and CPU architecture turbo reports in its User-Agent, the Worker and its declarations take the resource ids the original per-repository caches already used, only the bucket is retained, tests run under `bun test`, and `@austinm911/turbo-cache/github` sets a repository's Actions variables and secret from the stack instead of piping the token through a CLI.

Turbo's API behavior was checked against [vercel/turborepo v2.11.9](https://github.com/vercel/turborepo/blob/v2.11.9/crates/turborepo-api-client/src/lib.rs), including `build_user_agent`.
