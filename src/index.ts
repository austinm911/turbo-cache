import * as Cloudflare from "@alchemy.run/cloudflare"
import { Random } from "alchemy"
import { retain } from "alchemy/RemovalPolicy"
import { Stage } from "alchemy/Stage"
import { Effect } from "effect"
import { identity } from "effect/Function"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"

import { artifactHandler } from "./protocol.ts"

export interface TurboCacheOptions {
	/** `import.meta.url` of the module whose default export is this cache. Alchemy loads that module in the Worker. */
	readonly main: string
	/** Team slugs (`TURBO_TEAM`). Each gets its own token, which reads and writes only that team's artifacts. */
	readonly teams: readonly [string, ...string[]]
	/** Logical id of the Worker, and the prefix of the bucket and token ids. */
	readonly id?: string
	/** Days an artifact lives after upload. Reads do not extend it. */
	readonly retentionDays?: number
	/** Stages whose bucket survives a destroy or rename. */
	readonly retainStages?: readonly string[]
}

const defaults = { id: "TurboCache", retentionDays: 14, retainStages: ["ci", "prod"] }

/** The `Alchemy.Random` holding a team's token. The stack can yield it too, to hand the token to CI. */
export const teamToken = (options: Pick<TurboCacheOptions, "id" | "teams">, team: string) =>
	Random(`${options.id ?? defaults.id}Token-${team}`)

/**
 * A Turbo remote cache: a Worker on workers.dev in front of an R2 bucket whose artifacts expire
 * `retentionDays` after upload. Default-export it from the module `main` names.
 */
export const TurboCache = (options: TurboCacheOptions) => {
	const id = options.id ?? defaults.id
	const retainStages = options.retainStages ?? defaults.retainStages
	const retainInStage =
		globalThis.__ALCHEMY_RUNTIME__ === true
			? identity
			: retain(Stage.pipe(Effect.map((stage) => retainStages.includes(stage))))

	const bucket = Cloudflare.R2.Bucket(`${id}Bucket`, {
		lifecycleRules: [
			{
				id: "expire",
				enabled: true,
				deleteObjectsTransition: {
					condition: {
						type: "Age",
						maxAge: (options.retentionDays ?? defaults.retentionDays) * 86_400,
					},
				},
			},
		],
	}).pipe(retainInStage)

	return Cloudflare.Worker(
		id,
		{ main: options.main, compatibility: { date: "2026-05-28", flags: ["nodejs_compat"] } },
		Effect.gen(function* () {
			const storage = yield* (yield* Cloudflare.R2.ReadWriteBucket)(yield* bucket)
			const credentials = yield* Effect.forEach(options.teams, (team) =>
				Effect.gen(function* () {
					const token = yield* teamToken(options, team)
					return { team, token: yield* token.text }
				}),
			)
			const handle = artifactHandler(storage, credentials)
			return {
				fetch: Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					const response = yield* handle(yield* HttpServerRequest.toWeb(request))
					return HttpServerResponse.fromWeb(response)
				}).pipe(Effect.orDie),
			}
		}).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
	)
}

export type { TeamCredential } from "./protocol.ts"
export { artifactHandler, platformOf } from "./protocol.ts"
