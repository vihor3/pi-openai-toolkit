import {
	DEFAULT_TOOLKIT_CONFIG,
	DEFAULT_AUTO_MODE_CONFIG,
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_IMAGE_GENERATION_MODEL,
	type AutoModeConfig,
	type LeaveManagedModePolicy,
	type NativeFallbackConfig,
	type RemoteV2ContextSource,
} from "../types";

export type ConfigFeature = "reasoning" | "context" | "webSearch" | "imageGeneration" | "autoMode" | "compatibility" | "diagnostics";
export type SearchRoute = "unmanaged" | "local" | "hosted" | "standalone-alpha";
export type DiagnosticsConfig = {
	level: "error" | "warn" | "info" | "debug";
	notifyOnLoad: boolean;
	captureRequests: boolean;
	/** Captures compact responses, not ordinary conversation responses. */
	captureResponses: boolean;
	redactSensitiveData: boolean;
	artifactRoot: string;
};
export type ContextPolicy = {
	mode: "pi" | "remote-compaction" | "remote-windows";
	remoteCompaction: {
		model: string | null;
		inputSource: RemoteV2ContextSource;
		allowContinuityBreak: boolean;
		apis: string[];
	};
	nativeFallback: Omit<NativeFallbackConfig, "model"> & { model: string | null };
	remoteWindows: {
		leaveManagedMode: LeaveManagedModePolicy;
		reminderThresholdPercent: number;
	};
};
export type AutoModePolicy = Omit<AutoModeConfig, "enabled" | "models" | "reviewerModel" | "classifier"> & {
	available: boolean;
	reviewerModel: string | null;
	classifier: Omit<AutoModeConfig["classifier"], "model"> & { model: string | null };
};
export type EffectiveToolkitPolicy = {
	reasoning: { effortOverride: boolean };
	context: ContextPolicy;
	webSearch: { route: SearchRoute };
	imageGeneration: { enabled: boolean; defaultModel: string; allowedModels: string[] };
	autoMode: AutoModePolicy;
	compatibility: { transport: "standard" | "codex-gateway" };
	diagnostics: DiagnosticsConfig;
};
export type ConfigOrigin = {
	kind: "builtin" | "defaults" | "model" | "legacy" | "inactive";
	path?: string;
	source?: string;
};
export type ConfigIssue = {
	severity: "error" | "warning";
	/** Controlled code; do not include raw input values in messages. */
	code: string;
	path: string;
	feature: ConfigFeature | "document";
	/** Issues for a different model do not invalidate the selected model. */
	modelKey?: string;
};
export type ToolkitScope = "active" | "inactive" | "unknown";

export type ResolvedToolkitPolicy = {
	/** Unknown scope must fail closed; only known inactive scope permits native passthrough. */
	scope: ToolkitScope;
	policy: EffectiveToolkitPolicy;
	origins: Record<string, ConfigOrigin>;
	issues: ConfigIssue[];
	invalidFeatures: ConfigFeature[];
};
export type ConfigDocumentSnapshot = {
	format: "legacy" | "v2" | "missing" | "invalid";
	configPath: string;
	/** In-memory only; never render arbitrary raw configuration values. */
	raw?: unknown;
	issues: ConfigIssue[];
};
export const CONFIG_FEATURES: readonly ConfigFeature[] = [
	"reasoning", "context", "webSearch", "imageGeneration", "autoMode", "compatibility", "diagnostics",
];

/** Apply native-Pi effective switches while retaining templates/references for inspection. */
export function applyInactivePolicy(policy: EffectiveToolkitPolicy, origins: Record<string, ConfigOrigin>): void {
	policy.reasoning.effortOverride = false;
	policy.context.mode = "pi";
	policy.context.nativeFallback.enabled = false;
	policy.webSearch.route = "unmanaged";
	policy.imageGeneration.enabled = false;
	policy.autoMode.available = false;
	policy.autoMode.classifier.enabled = false;
	policy.compatibility.transport = "standard";
	policy.diagnostics.notifyOnLoad = false;
	policy.diagnostics.captureRequests = false;
	policy.diagnostics.captureResponses = false;
	for (const leaf of ["reasoning.effortOverride", "context.mode", "context.nativeFallback.enabled", "webSearch.route",
		"imageGeneration.enabled", "autoMode.available", "autoMode.classifier.enabled", "compatibility.transport",
		"diagnostics.notifyOnLoad", "diagnostics.captureRequests", "diagnostics.captureResponses"]) {
		origins[leaf] = { kind: "inactive" };
	}
}

/** Independent per-operation defaults for explicitly activated models. */
export function createPolicyDefaults(): EffectiveToolkitPolicy {
	const context = DEFAULT_COMPACTION_CONFIG;
	const auto = structuredClone(DEFAULT_AUTO_MODE_CONFIG);
	const { enabled: _enabled, models: _models, reviewerModel, classifier, ...autoOptions } = auto;
	return {
		reasoning: { effortOverride: DEFAULT_TOOLKIT_CONFIG.reasoning_effort_override },
		context: {
			mode: "remote-compaction",
			remoteCompaction: {
				model: null,
				inputSource: context.remoteV2ContextSource,
				allowContinuityBreak: context.allowCompactionContinuityBreak,
				apis: [...context.responsesApis],
			},
			nativeFallback: { ...context.nativeFallback, model: null },
			remoteWindows: {
				leaveManagedMode: context.leaveManagedMode,
				reminderThresholdPercent: context.contextReminderThresholdPercent,
			},
		},
		webSearch: { route: "unmanaged" },
		imageGeneration: {
			enabled: false,
			defaultModel: DEFAULT_IMAGE_GENERATION_MODEL,
			allowedModels: [DEFAULT_IMAGE_GENERATION_MODEL],
		},
		autoMode: {
			...autoOptions,
			available: false,
			reviewerModel: reviewerModel ?? null,
			classifier: { ...classifier, model: classifier.model ?? null },
		},
		compatibility: { transport: "standard" },
		diagnostics: {
			level: "info",
			notifyOnLoad: context.notifyOnLoad,
			captureRequests: context.logProviderPayloads,
			captureResponses: context.logCompactResponses,
			redactSensitiveData: context.redactSensitiveData,
			artifactRoot: context.artifactRoot,
		},
	};
}
