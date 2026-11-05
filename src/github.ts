import * as GitHub from "@alchemy.run/github"
import * as Output from "alchemy/Output"
import { Effect } from "effect"

import { teamToken, type TurboCacheOptions } from "./index.ts"

export interface GitHubTurboEnvOptions {
	/** The deployed cache, as `yield*` of the module that default-exports `TurboCache(...)` returns it. */
	readonly cache: { readonly url: Output.Output<string | undefined> }
	/** The options that cache was declared with. */
	readonly options: Pick<TurboCacheOptions, "id" | "teams">
	readonly owner: string
	readonly repository: string
	/** The team CI reads and writes. Defaults to the first of `options.teams`. */
	readonly team?: string
}

/**
 * Sets a repository's `TURBO_API` and `TURBO_TEAM` Actions variables and its `TURBO_TOKEN` secret,
 * so every workflow job reaches the cache with three lines of `env`. Nothing on the runner depends
 * on its platform: the cache keys artifacts by the OS and architecture turbo reports.
 */
export const GitHubTurboEnv = Effect.fn("TurboCache.GitHubTurboEnv")(function* (
	input: GitHubTurboEnvOptions,
) {
	const team = input.team ?? input.options.teams[0]
	const target = { owner: input.owner, repository: input.repository }
	const token = yield* teamToken(input.options, team)
	yield* GitHub.Variable("TurboApi", {
		...target,
		name: "TURBO_API",
		value: Output.map(input.cache.url, (url) => url ?? ""),
	})
	yield* GitHub.Variable("TurboTeam", { ...target, name: "TURBO_TEAM", value: team })
	yield* GitHub.Secret("TurboTokenSecret", { ...target, name: "TURBO_TOKEN", value: token.text })
})
