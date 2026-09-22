import { expect, test } from "bun:test";
import { assertConfigValid, resolveToolkitConfig } from "../config";
import { describeToolkitConfig } from "../config-command";
import { previewToolkitMigration } from "./migration";
import { v2Fixture } from "./test-helpers";
import { DEFAULT_TOOLKIT_CONFIG } from "../types";

const defaults = {
	reasoning: { effortOverride: true },
	context: { mode: "remote-windows", remoteCompaction: { model: "p/producer" } },
	webSearch: { route: "hosted" },
	imageGeneration: { enabled: true, defaultModel: "output", allowedModels: ["output"] },
	autoMode: { available: true, reviewerModel: "p/reviewer", classifier: { enabled: true, model: "p/classifier" } },
};

for (const api of ["openai-responses", "openai-codex-responses", "openai-completions", "anthropic-messages"]) {
	test(`exact V2 activation and defaults-only opt-out for ${api}`, () => {
		const loaded = v2Fixture({ defaults, models: { " p/chat ": {} } });
		const listed = resolveToolkitConfig(loaded, { provider: "p", id: "chat", api });
		expect(listed.scope).toBe("active");
		expect(listed.policy.context.mode).toBe("remote-windows");
		expect(listed.policy.imageGeneration.enabled).toBe(true);
		expect(listed.policy.autoMode.available).toBe(true);
		for (const [provider, id] of [["p", "Chat"], ["other", "chat"], ["p", "producer"], ["p", "reviewer"], ["p", "classifier"], ["p", "output"]]) {
			const unlisted = resolveToolkitConfig(loaded, { provider, id, api });
			expect(unlisted.scope).toBe("inactive");
			expect(unlisted.policy).toMatchObject({
				reasoning: { effortOverride: false }, context: { mode: "pi", nativeFallback: { enabled: false } },
				webSearch: { route: "unmanaged" }, imageGeneration: { enabled: false },
				autoMode: { available: false, classifier: { enabled: false } }, compatibility: { transport: "standard" },
			});
			expect(unlisted.config.compaction.enabled).toBe(false);
			expect(unlisted.config.imageGeneration.enabled).toBe(false);
			expect(unlisted.origins["context.mode"].kind).toBe("inactive");
			expect(describeToolkitConfig(unlisted)).toContain("native Pi; no Toolkit features");
		}
		expect(resolveToolkitConfig(v2Fixture({ defaults }), { provider: "p", id: "chat", api }).scope).toBe("inactive");
	});
}

test("unlisted scope tolerates irrelevant feature errors but unknown membership fails closed", () => {
	const model = { provider: "p", id: "chat" };
	for (const raw of [
		{ defaults: null },
		{ defaults: { autoMode: null, context: { typo: true }, imageGeneration: { enabled: "bad" } } },
		{ models: { "other/chat": null }, diagnostics: { captureRequests: "bad" } },
	]) {
		const result = resolveToolkitConfig(v2Fixture(raw), model);
		expect(result.scope).toBe("inactive");
		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.invalidFeatures).toEqual([]);
		expect(() => assertConfigValid(result, "autoMode", "context", "imageGeneration")).not.toThrow();
	}
	for (const raw of [{ models: null }, { models: [] }, { models: { "p/*": {} } }, { modles: { "p/chat": {} } }]) {
		const result = resolveToolkitConfig(v2Fixture(raw), model);
		expect(result.scope).toBe("unknown");
		expect(() => assertConfigValid(result, "autoMode")).toThrow();
	}
	for (const models of [{ "p/chat": null }, { "p/chat": {}, " p/chat ": {} }]) {
		const result = resolveToolkitConfig(v2Fixture({ models }), model);
		expect(result.scope).toBe("active");
		expect(() => assertConfigValid(result, "autoMode")).toThrow();
	}
	expect(resolveToolkitConfig(v2Fixture({ models: { "p/chat": {} } })).scope).toBe("unknown");
});

test("missing files are native while explicit legacy documents retain global compatibility", () => {
	const config = structuredClone(DEFAULT_TOOLKIT_CONFIG);
	const missing = resolveToolkitConfig({ config, warnings: [], document: { format: "missing", configPath: "/absent", issues: [] } }, { provider: "p", id: "chat" });
	expect(missing.scope).toBe("inactive");
	expect(missing.config.compaction.enabled).toBe(false);
	const legacy = resolveToolkitConfig({ config, warnings: [] }, { provider: "p", id: "chat" });
	expect(legacy.scope).toBe("active");
	expect(legacy.config.compaction.enabled).toBe(true);
});

test("migration preserves explicit keys equal to defaults and flags the change in reach", () => {
	const legacy = {
		...structuredClone(DEFAULT_TOOLKIT_CONFIG),
		webSearch: { enabled: true, models: [], defaultRoute: "local" as const, routes: { "p/empty": "local" as const } },
		autoMode: { ...structuredClone(DEFAULT_TOOLKIT_CONFIG.autoMode), enabled: false, models: ["p/dormant"] },
	};
	const preview = previewToolkitMigration({ config: legacy, warnings: [] });
	expect(preview.status).toBe("needs-review");
	expect(preview.candidate?.models).toEqual({ "p/empty": {}, "p/dormant": {} });
	expect(preview.reasons.join(" ")).toContain("Unlisted models become native Pi");
	const migrated = v2Fixture(preview.candidate!);
	expect(resolveToolkitConfig(migrated, { provider: "p", id: "empty" }).scope).toBe("active");
	expect(resolveToolkitConfig(migrated, { provider: "p", id: "other" }).scope).toBe("inactive");
});
