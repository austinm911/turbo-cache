import { TurboCache, type TurboCacheOptions } from "../../src/index.js"

export const options = {
	main: import.meta.url,
	teams: ["alpha", "beta"],
} as const satisfies TurboCacheOptions

export default TurboCache(options)
