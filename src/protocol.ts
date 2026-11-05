import type { R2Object } from "@alchemy.run/cloudflare/R2/BucketTypes"
import type { ReadWriteBucketClient } from "@alchemy.run/cloudflare/R2/ReadWriteBucket"
import { Data, Effect, Option, Predicate, Redacted, Schema } from "effect"

export interface TeamCredential {
	readonly team: string
	readonly token: Effect.Effect<Redacted.Redacted>
}

export type Storage = Pick<ReadWriteBucketClient, "get" | "head" | "put">

type Route = Data.TaggedEnum<{
	Status: {}
	Events: {}
	Query: {}
	Artifact: { readonly hash: string }
	Missing: {}
}>
const Route = Data.taggedEnum<Route>()

type NativeComparison = (a: ArrayBuffer, b: ArrayBuffer) => boolean
const NativeCrypto = Schema.Struct({
	timingSafeEqual: Schema.declare<NativeComparison>((input: unknown): input is NativeComparison =>
		Predicate.isFunction(input),
	),
})

const Segment = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/u))
const isSegment = Schema.is(Segment)
const ArtifactQuery = Schema.Struct({ hashes: Schema.Array(Segment) })

const noStore = { "cache-control": "no-store" }

const refusal = (status: number) => new Response(null, { headers: noStore, status })

const failure = (status: number, code: string, message: string) =>
	Response.json({ error: { code, message } }, { headers: noStore, status })

const forbidden = () =>
	failure(
		403,
		"forbidden",
		"The token does not authorize this team. Each token belongs to one team slug. Fix: set TURBO_TEAM to the team the token was issued for.",
	)

const unknownClient = () =>
	failure(
		400,
		"unknown_client",
		"The request did not come from the turbo CLI. Artifacts are stored per platform, read from turbo's User-Agent. Fix: reach the cache through turbo.",
	)

// Turbo's task hash covers neither the OS nor the CPU architecture, so an artifact holding native
// output built on one platform would replay on another. Turbo names both in its User-Agent
// (`turbo <version> <rustc> <os> <arch>`), so the cache keeps each platform's artifacts apart
// without any client configuration.
export const platformOf = (request: Request): Option.Option<string> => {
	const words = (request.headers.get("user-agent") ?? "").split(" ")
	const [client, os, arch] = [words[0], words.at(-2), words.at(-1)]
	return client === "turbo" &&
		words.length >= 5 &&
		os !== undefined &&
		arch !== undefined &&
		/^[a-z0-9_]+$/u.test(os) &&
		/^[a-z0-9_]+$/u.test(arch)
		? Option.some(`${os}-${arch}`)
		: Option.none()
}

const routeOf = (request: Request): Route => {
	const { pathname } = new URL(request.url)
	const method = request.method
	if (pathname === "/v8/artifacts/status")
		return method === "GET" ? Route.Status() : Route.Missing()
	if (pathname === "/v8/artifacts/events")
		return method === "POST" ? Route.Events() : Route.Missing()
	if (pathname === "/v8/artifacts") return method === "POST" ? Route.Query() : Route.Missing()
	const hash = /^\/v8\/artifacts\/(?<hash>[a-zA-Z0-9_-]+)$/u.exec(pathname)?.groups?.["hash"]
	return hash !== undefined && ["GET", "HEAD", "PUT"].includes(method)
		? Route.Artifact({ hash })
		: Route.Missing()
}

const digest = (value: string) =>
	Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))

// Every configured token is digested and compared, with no early return, so the time taken says
// nothing about which token, or how much of one, matched.
const authenticate = Effect.fn("TurboCache.authenticate")(function* (
	request: Request,
	credentials: readonly TeamCredential[],
) {
	const bearer = /^Bearer (?<token>.+)$/u.exec(request.headers.get("authorization") ?? "")
		?.groups?.["token"]
	const native = yield* Schema.decodeUnknownEffect(NativeCrypto)(crypto.subtle).pipe(Effect.orDie)
	const presented = yield* digest(bearer ?? "")
	const matches = yield* Effect.forEach(credentials, ({ team, token }) =>
		token.pipe(
			Effect.flatMap((value) => digest(Redacted.value(value))),
			Effect.map((expected) => ({
				team,
				matches: native.timingSafeEqual.call(crypto.subtle, expected, presented),
			})),
		),
	)
	return bearer === undefined
		? Option.none<string>()
		: Option.fromNullishOr(matches.find((candidate) => candidate.matches)?.team)
})

const artifactResponse = (hit: R2Object, body: ReadableStream | null) => {
	const headers = new Headers({
		...noStore,
		"content-length": String(hit.size),
		"content-type": "application/octet-stream",
		"x-artifact-duration": hit.customMetadata?.["duration"] ?? "0",
	})
	const tag = hit.customMetadata?.["tag"]
	if (tag !== undefined) headers.set("x-artifact-tag", tag)
	return new Response(body, { headers })
}

const queryArtifacts = Effect.fn("TurboCache.query")(function* (
	request: Request,
	storage: Storage,
	prefix: string,
) {
	const query = yield* Effect.tryPromise(() => request.json()).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(ArtifactQuery)),
		Effect.option,
	)
	if (Option.isNone(query)) return refusal(400)
	const hits = yield* Effect.forEach(query.value.hashes, (hash) =>
		storage.head(`${prefix}/${hash}`).pipe(
			Effect.map(
				(hit) =>
					[
						hash,
						hit === null
							? null
							: {
									size: hit.size,
									taskDurationMs: Number(hit.customMetadata?.["duration"] ?? "0"),
								},
					] as const,
			),
		),
	)
	return Response.json(Object.fromEntries(hits), { headers: noStore })
})

const putArtifact = Effect.fn("TurboCache.put")(function* (
	request: Request,
	storage: Storage,
	key: string,
) {
	const length = request.headers.get("content-length")
	const duration = request.headers.get("x-artifact-duration") ?? "0"
	const tag = request.headers.get("x-artifact-tag")
	if (length === null || !/^\d+$/u.test(length) || !/^\d+$/u.test(duration)) return refusal(400)
	yield* storage.put(key, request.body, {
		customMetadata: tag === null ? { duration } : { duration, tag },
		httpMetadata: { contentType: "application/octet-stream" },
	})
	return refusal(200)
})

const readArtifact = Effect.fn("TurboCache.read")(function* (
	request: Request,
	storage: Storage,
	key: string,
) {
	if (request.method === "HEAD") {
		const hit = yield* storage.head(key)
		return hit === null ? refusal(404) : artifactResponse(hit, null)
	}
	const hit = yield* storage.get(key)
	return hit === null ? refusal(404) : artifactResponse(hit, hit.readable ?? null)
})

// The parts of Turbo's remote cache API (https://turborepo.dev/docs/openapi) a self-hosted cache
// serves. Authentication runs before any storage access, and a token reaches only its own team.
// Artifacts are stored at `<team>/<os>-<arch>/<hash>`.
export const artifactHandler = (storage: Storage, credentials: readonly TeamCredential[]) =>
	Effect.fn("TurboCache.request")(function* (request: Request) {
		const route = routeOf(request)
		if (Route.$is("Missing")(route)) return refusal(404)
		const authorized = yield* authenticate(request, credentials)
		if (Option.isNone(authorized)) return refusal(401)
		const url = new URL(request.url)
		const slugs = url.searchParams.getAll("slug")
		const team = slugs[0]
		if (
			slugs.length !== 1 ||
			team === undefined ||
			!isSegment(team) ||
			team !== authorized.value ||
			url.searchParams.has("teamId")
		) {
			return forbidden()
		}
		const platform = platformOf(request)
		return yield* Route.$match(route, {
			Missing: () => Effect.succeed(refusal(404)),
			Status: () => Effect.succeed(Response.json({ status: "enabled" }, { headers: noStore })),
			Events: () => Effect.succeed(refusal(204)),
			Query: () =>
				Option.match(platform, {
					onNone: () => Effect.succeed(unknownClient()),
					onSome: (os) => queryArtifacts(request, storage, `${team}/${os}`),
				}),
			Artifact: ({ hash }) =>
				Option.match(platform, {
					onNone: () => Effect.succeed(unknownClient()),
					onSome: (os) =>
						request.method === "PUT"
							? putArtifact(request, storage, `${team}/${os}/${hash}`)
							: readArtifact(request, storage, `${team}/${os}/${hash}`),
				}),
		})
	})
