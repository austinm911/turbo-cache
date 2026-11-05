# turbo-cache

A [Turbo](https://turborepo.dev) remote cache on a Cloudflare Worker in front of an R2 bucket, declared with [Alchemy](https://alchemy.run) and Effect. Each repository deploys its own instance on its own account.

- Artifacts expire `retentionDays` (14) after upload, through an R2 lifecycle rule.
- Each team slug gets its own token, which reads and writes only that team's artifacts.
- Artifacts are kept apart by the OS and CPU architecture turbo reports in its User-Agent. Turbo's task hash covers neither, so without this a native build from one platform would replay on another. No client or CI configuration is involved.
- Only the turbo CLI is served. Other clients get a 400.

## Install

```sh
bun add github:austinm911/turbo-cache#<commit>
```

It ships TypeScript sources. Peer dependencies: `effect`, `alchemy`, `@alchemy.run/cloudflare`, and `@alchemy.run/github` for the GitHub helper.

## Declare it

The Worker module has to default-export the cache, because Alchemy loads `main` inside the Worker:

```ts
// infra/turbo-cache.ts
import { TurboCache, type TurboCacheOptions } from "@austinm911/turbo-cache"

export const options = {
	main: import.meta.url,
	teams: ["my-repo"],
} as const satisfies TurboCacheOptions

export default TurboCache(options)
```

Then yield it in the stage that owns CI infrastructure, and hand CI its settings:

```ts
import { GitHubTurboEnv } from "@austinm911/turbo-cache/github"

import TurboCache, { options } from "./infra/turbo-cache.ts"

const cache = yield * TurboCache
yield * GitHubTurboEnv({ cache, options, owner: "my-org", repository: "my-repo" })
```

`GitHubTurboEnv` sets the `TURBO_API` and `TURBO_TEAM` Actions variables and the `TURBO_TOKEN` secret. Without GitHub, yield `teamToken(options, team)` and deliver `token.text` however your CI takes secrets.

Options: `id` (default `TurboCache`) names the Worker and prefixes `<id>Bucket` and `<id>Token-<team>`. `retainStages` (default `["ci", "prod"]`) lists the stages whose bucket survives a destroy or rename.

## CI

```yaml
env:
  TURBO_API: ${{ vars.TURBO_API }}
  TURBO_TEAM: ${{ vars.TURBO_TEAM }}
  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
  TURBO_CACHE: local:,remote:rw
```

`local:,remote:rw` skips `.turbo/cache`, which an ephemeral runner would never read again. Without a token, or with the Worker unreachable, turbo still runs every task, uncached.

## Local runs

Set the same four variables in the shell, for example through fnox, so every checkout and worktree shares builds. Read the token from the stack's state:

```sh
bun alchemy state cat <stack>/<stage>/TurboCacheToken-<team> --no-input --log-level none \
  | sed -n '/^{/,$p' | jq -r '.attr.text.__redacted__'
```

## Develop

`bun run check` formats, typechecks and runs the tests in local workerd, including a real turbo binary getting a remote hit with an empty local cache. See [PROVENANCE.md](PROVENANCE.md) for credits.
