# Agent instructions

A Turbo remote cache on Cloudflare Workers and R2, declared with Alchemy and Effect. Several repositories install it from a pinned commit, so a change here reaches them only when they bump the pin.

- This repository is public. Keep credentials, account ids, worker hostnames and private paths out of code, tests and docs.
- Authentication runs before any storage access, and a token reaches only its own team. Keep every guard covered by a test that fails when the guard breaks; plant the bug and revert it before trusting a new test.
- Artifacts are keyed `<team>/<os>-<arch>/<hash>`. Changing that layout empties every consumer's cache once.
- Resource ids (`<id>`, `<id>Bucket`, `<id>Token-<team>`) are consumers' state. Changing one replaces the resource and, for a token, every copy of it.
- `bun run check` formats, typechecks and runs the workerd tests. Tests never touch a Cloudflare account.
