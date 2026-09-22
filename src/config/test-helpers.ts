import { DEFAULT_TOOLKIT_CONFIG, type LoadedToolkitConfig } from "../types";

/** Explicit reader seam: no global-file access, auth, provider registry or network. */
export function v2Fixture(raw: Record<string, unknown>, listedModels: string[] = []): LoadedToolkitConfig {
	return {
		config: structuredClone(DEFAULT_TOOLKIT_CONFIG),
		source: "/fixture/config.json",
		warnings: [],
		document: { format: "v2", configPath: "/fixture/config.json", raw: { schemaVersion: 2, ...(listedModels.length ? { models: Object.fromEntries(listedModels.map((key) => [key, {}])) } : {}), ...raw }, issues: [] },
	};
}
