// The cache in local workerd, deployed by Alchemy the way a consumer stack declares it. Nothing
// here touches a Cloudflare account.
import { expect } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Test from "@alchemy.run/test/Bun"
import * as Alchemy from "alchemy"
import * as State from "alchemy/State"
import { Effect, Redacted } from "effect"

import { teamToken } from "../src/index.ts"
import Cache, { options } from "./fixtures/cache.ts"

const providers = Cloudflare.providers()
const state = Alchemy.localState()
const stage = `turbo-cache-${crypto.randomUUID().slice(0, 8)}`
const Stack = Alchemy.Stack(
	"TurboCacheTest",
	{ providers, state },
	Effect.gen(function* () {
		const cache = yield* Cache
		const alpha = yield* teamToken(options, "alpha")
		const beta = yield* teamToken(options, "beta")
		return { url: cache.url.as<string>(), alpha: alpha.text, beta: beta.text }
	}),
)
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
	providers,
	state,
	dev: true,
	stage,
})
const deployed = beforeAll(deploy(Stack), { timeout: 180_000 })
afterAll(destroy(Stack), { timeout: 60_000 })

const MAC = "turbo 2.11.10 1.89.0 macos aarch64"
const LINUX = "turbo 2.11.10 1.89.0 linux x86_64"

const call = (
	origin: string,
	path: string,
	init: {
		method?: string
		token?: string
		agent?: string
		body?: BodyInit
		duration?: number
	} = {},
) =>
	Effect.promise(() =>
		fetch(new URL(path, origin), {
			method: init.method ?? "GET",
			headers: {
				...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
				...(init.agent === undefined ? {} : { "user-agent": init.agent }),
				"x-artifact-duration": String(init.duration ?? 0),
				"x-artifact-tag": "signature",
			},
			...(init.body === undefined ? {} : { body: init.body }),
		}),
	)

const tokens = Effect.map(deployed, (out) => ({
	origin: out.url,
	alpha: Redacted.value(out.alpha),
	beta: Redacted.value(out.beta),
}))

test(
	"an artifact round-trips with its metadata, and HEAD and the batch query agree",
	Effect.gen(function* () {
		const { origin, alpha } = yield* tokens
		const bytes = crypto.getRandomValues(new Uint8Array(4096))
		const put = yield* call(origin, "/v8/artifacts/roundtrip?slug=alpha", {
			method: "PUT",
			token: alpha,
			agent: MAC,
			body: bytes,
			duration: 1234,
		})
		expect(put.status).toBe(200)
		const get = yield* call(origin, "/v8/artifacts/roundtrip?slug=alpha", {
			token: alpha,
			agent: MAC,
		})
		expect(get.status).toBe(200)
		expect(new Uint8Array(yield* Effect.promise(() => get.arrayBuffer()))).toEqual(bytes)
		expect(get.headers.get("x-artifact-duration")).toBe("1234")
		expect(get.headers.get("x-artifact-tag")).toBe("signature")
		const head = yield* call(origin, "/v8/artifacts/roundtrip?slug=alpha", {
			method: "HEAD",
			token: alpha,
			agent: MAC,
		})
		expect(head.status).toBe(200)
		expect(head.headers.get("content-length")).toBe("4096")
		const query = yield* call(origin, "/v8/artifacts?slug=alpha", {
			method: "POST",
			token: alpha,
			agent: MAC,
			body: JSON.stringify({ hashes: ["roundtrip", "absent"] }),
		})
		expect(yield* Effect.promise(() => query.json())).toEqual({
			roundtrip: { size: 4096, taskDurationMs: 1234 },
			absent: null,
		})
	}),
)

test(
	"each platform has its own artifacts, so a native build never replays on another OS",
	Effect.gen(function* () {
		const { origin, alpha } = yield* tokens
		const path = "/v8/artifacts/platform?slug=alpha"
		yield* call(origin, path, { method: "PUT", token: alpha, agent: MAC, body: "mac" })
		expect((yield* call(origin, path, { token: alpha, agent: LINUX })).status).toBe(404)
		yield* call(origin, path, { method: "PUT", token: alpha, agent: LINUX, body: "linux" })
		const mac = yield* call(origin, path, { token: alpha, agent: MAC })
		expect(yield* Effect.promise(() => mac.text())).toBe("mac")
		for (const agent of [
			undefined,
			"curl/8.7.1",
			"turbo 2.11.10",
			"turbo 2.11.10 1.89.0 mac/os arm64",
		]) {
			expect(
				(yield* call(origin, path, { token: alpha, ...(agent === undefined ? {} : { agent }) }))
					.status,
			).toBe(400)
		}
	}),
)

test(
	"a token reaches only its own team, and authentication comes before anything else",
	Effect.gen(function* () {
		const { origin, alpha, beta } = yield* tokens
		yield* call(origin, "/v8/artifacts/team?slug=alpha", {
			method: "PUT",
			token: alpha,
			agent: MAC,
			body: "a",
		})
		expect(
			(yield* call(origin, "/v8/artifacts/team?slug=beta", { token: beta, agent: MAC })).status,
		).toBe(404)
		for (const [method, path] of [
			["GET", "/v8/artifacts/team"],
			["HEAD", "/v8/artifacts/team"],
			["PUT", "/v8/artifacts/team"],
			["GET", "/v8/artifacts/status"],
			["POST", "/v8/artifacts/events"],
			["POST", "/v8/artifacts"],
		] as const) {
			expect((yield* call(origin, `${path}?slug=alpha`, { method, agent: MAC })).status).toBe(401)
			expect(
				(yield* call(origin, `${path}?slug=alpha`, { method, token: "wrong", agent: MAC })).status,
			).toBe(401)
			expect(
				(yield* call(origin, `${path}?slug=alpha`, { method, token: beta, agent: MAC })).status,
			).toBe(403)
			expect(
				(yield* call(origin, `${path}?slug=gamma`, { method, token: alpha, agent: MAC })).status,
			).toBe(403)
		}
		for (const query of ["", "?slug=alpha&slug=alpha", "?slug=alpha&teamId=x", "?slug=bad.slug"]) {
			expect(
				(yield* call(origin, `/v8/artifacts/team${query}`, { token: alpha, agent: MAC })).status,
			).toBe(403)
		}
		for (const path of [
			"/",
			"/v8/artifacts/status/",
			"/v8/artifacts/bad.hash",
			"/v8/artifacts/a%2Fb",
		]) {
			expect((yield* call(origin, `${path}?slug=alpha`, { token: alpha, agent: MAC })).status).toBe(
				404,
			)
		}
		const status = yield* call(origin, "/v8/artifacts/status?slug=alpha", { token: alpha })
		expect(yield* Effect.promise(() => status.json())).toEqual({ status: "enabled" })
	}),
)

test(
	"turbo gets a remote hit with an empty local cache",
	Effect.gen(function* () {
		const { origin, alpha } = yield* tokens
		const directory = mkdtempSync(join(tmpdir(), "turbo-cache-"))
		try {
			writeFileSync(
				join(directory, "package.json"),
				JSON.stringify({
					name: "fixture",
					private: true,
					packageManager: "bun@1.4.4",
					scripts: { build: "bun build.ts" },
				}),
			)
			writeFileSync(
				join(directory, "bun.lock"),
				JSON.stringify({
					lockfileVersion: 1,
					workspaces: { "": { name: "fixture" } },
					packages: {},
				}),
			)
			writeFileSync(
				join(directory, "turbo.json"),
				JSON.stringify({ tasks: { build: { inputs: ["build.ts"], outputs: ["out.txt"] } } }),
			)
			writeFileSync(join(directory, "build.ts"), `await Bun.write("out.txt", "built")\n`)
			const turbo = new URL("../node_modules/turbo/bin/turbo", import.meta.url).pathname
			const run = (cache: string) => {
				const result = Bun.spawnSync(
					[turbo, "run", "build", "--cache-dir", join(directory, cache), "--summarize"],
					{
						cwd: directory,
						env: {
							...process.env,
							TURBO_API: origin,
							TURBO_TEAM: "alpha",
							TURBO_TOKEN: alpha,
							TURBO_CACHE: "local:rw,remote:rw",
							TURBO_TELEMETRY_DISABLED: "1",
						},
					},
				)
				return result.stdout.toString() + result.stderr.toString()
			}
			expect(run("first")).toContain("0 cached, 1 total")
			rmSync(join(directory, "out.txt"))
			expect(run("second")).toContain("1 cached, 1 total")
			expect(readFileSync(join(directory, "out.txt"), "utf8")).toBe("built")
			const summaries = readdirSync(join(directory, ".turbo", "runs")).map((file) =>
				readFileSync(join(directory, ".turbo", "runs", file), "utf8"),
			)
			expect(summaries.some((text) => text.includes(`"source": "REMOTE"`))).toBe(true)
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	}),
	{ timeout: 120_000 },
)

test(
	"resource ids stay where consumers' state already has them",
	Effect.gen(function* () {
		yield* deployed
		const store = yield* Effect.flatten(State.State).pipe(Effect.provide(state))
		const fqns = yield* store.list({ stack: "TurboCacheTest", stage })
		expect(fqns.toSorted()).toEqual([
			"TurboCache",
			"TurboCacheBucket",
			"TurboCacheToken-alpha",
			"TurboCacheToken-beta",
		])
	}),
)
