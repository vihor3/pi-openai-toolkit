import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import registerContext from "./extension-runtime";
import { registerWebSearchExtension } from "./web-search/extension";
import { registerImageGenerationExtension } from "./image-generation/extension";
import { registerCodexAstraExtension } from "./codex-astra/extension";
import { v2Fixture } from "./config/test-helpers";
import { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE } from "./context-management/messages";
import { CodexContextWindowManager } from "./context-management/window-manager";
import { clearRequestContextCache, getCompactionRequestExtras, rememberRequestContext } from "./request-context-cache";
import { createNativeCompactionDetails } from "./types";

const listed = { provider: "openai-codex", id: "gpt-6-astra", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", contextWindow: 100_000 };
const ownedNames = ["new_context", "get_context_remaining", "history", "notes", "web_run", "openai_generate_image"];

function harness(localActive = true) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const tools: any[] = [];
	let active = ["read", ...(localActive ? ["web_search"] : [])];
	const sm = SessionManager.inMemory("/synthetic-project");
	sm.appendMessage({ role: "user", content: "retired user history", timestamp: 1 });
	const marker = sm.appendCustomMessageEntry(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, "retained window marker", true, {
		protocol: 1, id: "marker", sessionId: sm.getSessionId(), contextManagement: {
			protocol: 1, kind: "window", firstWindowId: "w1", currentWindowId: "w2", windowNumber: 1, trimPreviousWindow: true,
		},
	});
	sm.appendMessage(fauxAssistantMessage("retained assistant history"));
	const counts = { auth: 0, network: 0, compact: 0, abort: 0 };
	const ctx: any = {
		model: listed, hasUI: false, cwd: "/synthetic-project", mode: "json", sessionManager: sm,
		ui: { notify() {} }, getContextUsage: () => undefined, getSystemPrompt: () => "base",
		abort: () => { counts.abort++; }, compact: () => { counts.compact++; },
		modelRegistry: { getApiKeyAndHeaders: async () => {
			counts.auth++; return { ok: true, apiKey: "synthetic", headers: { "chatgpt-account-id": "synthetic" }, baseUrl: listed.baseUrl };
		} },
	};
	const pi: any = {
		on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {}, registerTool(tool: any) { tools.push(tool); active.push(tool.name); },
		getAllTools: () => tools, getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
		sendMessage() { throw new Error("Existing window must not be replaced"); },
	};
	const raw: any = { models: { "openai-codex/gpt-6-astra": {} }, defaults: {
		reasoning: { effortOverride: true }, context: { mode: "remote-windows", remoteWindows: { leaveManagedMode: "compact" } },
		webSearch: { route: "standalone-alpha" }, imageGeneration: { enabled: true },
	} };
	const loadConfig = () => v2Fixture(raw);
	const manager = new CodexContextWindowManager();
	registerContext(pi, { loadConfig, contextWindows: manager,
		remoteCompact: async () => { counts.network++; throw new Error("unexpected remote request"); },
		nativeFallback: async () => { counts.network++; throw new Error("unexpected fallback"); },
	});
	registerWebSearchExtension(pi, loadConfig, async () => { counts.network++; throw new Error("unexpected search"); });
	registerImageGenerationExtension(pi, loadConfig, async () => { counts.network++; throw new Error("unexpected image"); });
	registerCodexAstraExtension(pi, loadConfig);
	const fire = async (name: string, event: any = {}) => {
		let result: any;
		for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx) ?? result;
		return result;
	};
	const prepare = () => fire("session_before_compact", { signal: new AbortController().signal, reason: "manual", branchEntries: sm.getBranch(),
		preparation: { firstKeptEntryId: marker, tokensBefore: 100, messagesToSummarize: [], turnPrefixMessages: [] } });
	return { ctx, sm, tools, raw, counts, fire, prepare, active: () => active, manager };
}

for (const api of ["openai-responses", "openai-codex-responses", "openai-completions", "anthropic-messages"]) {
	for (const localActive of [true, false]) {
		test(`listed -> unlisted -> listed preserves native history and tool state (${api}, local=${localActive})`, async () => {
			const h = harness(localActive);
			await h.fire("session_start");
			expect(h.active()).toEqual(["read", ...ownedNames]);
			const proposal = await h.prepare();
			expect(proposal.compaction).toBeDefined();
			expect(h.manager.hasPendingTrim()).toBe(true);
			const before = JSON.stringify(h.sm.getEntries());
			const counts = { ...h.counts };
			const next = { ...listed, provider: "unlisted", api };
			await h.fire("model_select", { model: next }); // ctx still points at the old model during dispatch.
			h.ctx.model = next;
			expect(h.active()).toEqual(["read", ...(localActive ? ["web_search"] : [])]);
			expect(await h.fire("before_agent_start", { systemPrompt: "native base" })).toBeUndefined();
			const messages = h.sm.buildSessionContext().messages;
			expect(await h.fire("context", { messages })).toBeUndefined();
			expect(messages.some((message) => message.role === "custom")).toBe(true);
			// Deliberately malformed payload: irrelevant feature policies must not inspect it.
			const payload = { input: [], tools: "opaque-native-provider-data", include: 42 };
			expect(await h.fire("before_provider_request", { payload })).toBeUndefined();
			const headers = { authorization: "native", "x-custom": "retained" };
			await h.fire("before_provider_headers", { headers });
			expect(headers).toEqual({ authorization: "native", "x-custom": "retained" });
			const message = fauxAssistantMessage("native assistant");
			expect(await h.fire("message_end", { message })).toBeUndefined();
			expect(await h.prepare()).toBeUndefined();
			await h.fire("agent_settled");
			expect(await h.fire("tool_call", { toolName: "web_search" })).toBeUndefined();
			expect(await h.fire("tool_call", { toolName: "web_run" })).toMatchObject({ block: true });
			for (const tool of h.tools) {
				const params = tool.name === "web_run" ? { search_query: [{ q: "fixture" }] }
					: tool.name === "openai_generate_image" ? { prompt: "fixture" } : {};
				await expect(tool.execute("stale", params, undefined, undefined, h.ctx)).rejects.toThrow();
			}
			expect(h.counts).toEqual(counts);
			expect(JSON.stringify(h.sm.getEntries())).toBe(before);
			expect(h.manager.hasPendingTrim()).toBe(true);
			await h.fire("model_select", { model: listed });
			h.ctx.model = listed;
			expect(h.active()).toEqual(["read", ...ownedNames]);
			expect(await h.prepare()).toEqual(proposal);
		});
	}
}

test("unlisted request leaves an old opaque checkpoint and Pi's retained history unchanged", async () => {
	const h = harness();
	const kept = h.sm.appendMessage({ role: "user", content: "retained user", timestamp: 10 });
	h.sm.appendCompaction("native-visible summary", kept, 100, createNativeCompactionDetails({
		provider: listed.provider, api: listed.api, model: listed.id, baseUrl: listed.baseUrl,
		compactedWindow: [{ type: "compaction", encrypted_content: "opaque-history" }],
	}));
	h.ctx.model = { ...listed, provider: "other" };
	await h.fire("session_start");
	const before = JSON.stringify(h.sm.getEntries());
	const messages = h.sm.buildSessionContext().messages;
	expect(await h.fire("context", { messages })).toBeUndefined();
	expect(messages.some((message) => message.role === "compactionSummary")).toBe(true);
	const payload = { model: listed.id, input: [{ role: "user", content: "native-visible summary" }] };
	expect(await h.fire("before_provider_request", { payload })).toBeUndefined();
	expect(JSON.stringify(h.sm.getEntries())).toBe(before);
	expect(h.counts).toEqual({ auth: 0, network: 0, compact: 0, abort: 0 });
});

test("leaving explicit scope clears cached compaction request fields", async () => {
	const h = harness();
	const identity = { provider: listed.provider, model: listed.id, api: listed.api, baseUrl: listed.baseUrl };
	rememberRequestContext({ model: listed.id, input: [], tools: [{ type: "function", name: "stale" }] }, identity);
	expect(getCompactionRequestExtras(identity)).toBeDefined();
	await h.fire("model_select", { model: { ...listed, provider: "other" } });
	expect(getCompactionRequestExtras(identity)).toBeUndefined();
	clearRequestContextCache();
});
