import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const packageDir = resolve(import.meta.dirname, "..");
const env = await createSmokeEnvironment();
try {
	const { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager } =
		await import("@earendil-works/pi-coding-agent");
	const { fauxAssistantMessage, InMemoryCredentialStore, InMemoryModelsStore, Type } = await import("@earendil-works/pi-ai");
	const { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE } = await import("../src/context-management/messages");
	const { CONFIG_PATH } = await import("../src/config");
	assert(CONFIG_PATH.startsWith(env.agentDir), "Never read the real user config");
	const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
	await mkdir(join(env.agentDir, "extensions/pi-openai-toolkit"), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify({ schemaVersion: 2,
		defaults: {
			context: { mode: "remote-windows", remoteWindows: { leaveManagedMode: "compact" } },
			reasoning: { effortOverride: true }, webSearch: { route: "standalone-alpha" },
			imageGeneration: { enabled: true }, autoMode: { available: true, reviewerModel: "scope/gpt-6-astra" },
		}, models: { "scope/gpt-6-astra": { compatibility: { transport: "codex-gateway" } } },
	}));
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	const baseUrl = "https://scope-smoke.invalid/v1";
	for (const provider of ["scope", "native"]) modelRuntime.registerProvider(provider, {
		api: "openai-responses", apiKey: "synthetic-key", baseUrl,
		models: [{ id: "gpt-6-astra", name: "Scope smoke", reasoning: true, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 512 }],
	});
	const listed = modelRuntime.getModel("scope", "gpt-6-astra")!;
	const unlisted = modelRuntime.getModel("native", "gpt-6-astra")!;
	const settingsManager = SettingsManager.inMemory({ transport: "sse", retry: { enabled: false },
		compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 1024 } }, { projectTrusted: true });
	const thirdParty = defineTool({ name: "web_search", label: "Local search", description: "Third-party local search",
		parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "local" }], details: {} }) });
	const requests: Array<{ body: any; headers: Record<string, string> }> = [];
	const deniedFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		const request = new Request(input, init);
		if (request.url !== `${baseUrl}/responses` || request.method !== "POST") return deniedFetch(input, init);
		requests.push({ body: await request.json(), headers: Object.fromEntries(request.headers.entries()) });
		const item = { type: "message", id: "msg_scope", role: "assistant", status: "completed",
			content: [{ type: "output_text", text: "SYNTHETIC-REPLY", annotations: [] }] };
		const events = [
			{ type: "response.created", response: { id: "resp_scope", status: "in_progress", output: [] } },
			{ type: "response.output_item.added", output_index: 0, item },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: "resp_scope", status: "completed", output: [item],
				usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
		];
		return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
			{ headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	async function create(withToolkit: boolean, sm: InstanceType<typeof SessionManager>, model = listed) {
		const contexts: unknown[] = [];
		const loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager,
			additionalExtensionPaths: withToolkit ? manifest.pi.extensions.map((file: string) => join(packageDir, file)) : [],
			noExtensions: !withToolkit, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
			systemPromptOverride: () => "Scope test: respond deterministically.",
			extensionFactories: [(pi) => { pi.on("context", (event) => { contexts.push(structuredClone(event.messages)); }); }],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime, model,
			settingsManager, resourceLoader: loader, sessionManager: sm, customTools: [thirdParty] });
		await session.bindExtensions({ mode: "json", onError: (error) => { throw new Error(error.message); } });
		return { session, contexts };
	}
	const sm = SessionManager.inMemory(env.cwd);
	for (let i = 0; i < 3; i++) {
		sm.appendMessage({ role: "user", content: `OLD-HISTORY-${i}-${"x".repeat(600)}`, timestamp: i * 2 });
		sm.appendMessage(fauxAssistantMessage("old reply", { timestamp: i * 2 + 1 }));
	}
	const toolkit = await create(true, sm);
	try {
		assert(toolkit.session.getActiveToolNames().includes("new_context"));
		assert(toolkit.session.getActiveToolNames().includes("web_run"));
		assert(toolkit.session.getActiveToolNames().includes("openai_generate_image"));
		assert(!toolkit.session.getActiveToolNames().includes("web_search"));
		await toolkit.session.prompt("Listed request.");
		assert.equal(toolkit.session.messages.at(-1)?.role, "assistant");
		assert.equal((toolkit.session.messages.at(-1) as any).stopReason, "stop");
		assert.equal(requests.length, 1);
		assert(requests[0].headers["x-codex-affinity-scope"]);
		assert(requests[0].body.tools.some((tool: any) => tool.name === "web_run"));
		const initialWindow = requests[0].headers["x-codex-window-id"];
		let beforeCompactLeaf: string;
		let compactLeaf: string;
		let nativeView: typeof toolkit.session.messages;
		const beforeSwitch = requests.length;
		await toolkit.session.setModel(unlisted);
		assert.equal(requests.length, beforeSwitch, "switch must not compact or contact the backend");
		const snapshot = structuredClone(sm.getEntries());
		const bareSm = SessionManager.inMemory(env.cwd, { id: sm.getSessionId() }, snapshot);
		const bare = await create(false, bareSm, unlisted);
		try {
			assert.deepEqual(toolkit.session.getActiveToolNames().sort(), bare.session.getActiveToolNames().sort());
			assert(toolkit.session.getActiveToolNames().includes("web_search"));
			assert(!toolkit.session.getActiveToolNames().includes("web_run"));
			const compareNativeRequests = async (run: (session: typeof bare.session) => Promise<unknown>, expectedRequests = 1) => {
				const first = requests.length;
				await run(toolkit.session);
				const middle = requests.length;
				await run(bare.session);
				assert.equal(middle - first, expectedRequests, "native requests only, no Toolkit fallback/retry");
				assert.equal(requests.length - middle, expectedRequests);
				const normalize = (value: unknown): unknown => {
					if (Array.isArray(value)) return value.map(normalize);
					if (!value || typeof value !== "object") return value;
					return Object.fromEntries(Object.entries(value).filter(([key]) => !["timestamp", "x-client-request-id", "session_id", "prompt_cache_key"].includes(key))
						.map(([key, child]) => [key, normalize(child)]));
				};
				assert.deepEqual(normalize(requests.slice(first, middle)), normalize(requests.slice(middle)));
				assert(!requests[first].headers["x-codex-affinity-scope"]);
				assert(!JSON.stringify(requests[first].body).includes('"encrypted_content"'));
			};
			await compareNativeRequests((session) => session.prompt("Unlisted native request."));
			for (let i = 0; i < 3; i++) {
				await compareNativeRequests((session) => session.prompt(`Native request ${i}: ${"native work ".repeat(500)}`));
			}
			// End with a short complete turn so both a user and assistant survive.
			await compareNativeRequests((session) => session.prompt("KEEP-NATIVE-USER"));
			beforeCompactLeaf = sm.getLeafId()!;
			// The actual context seen by the later observer matches bare Pi's projection.
			const stripTime = (value: unknown) => JSON.parse(JSON.stringify(value, (key, child) => key === "timestamp" ? undefined : child));
			assert.deepEqual(stripTime(toolkit.contexts.at(-1)), stripTime(bare.contexts.at(-1)));
			await compareNativeRequests((session) => session.compact("Summarize native history."));
			compactLeaf = sm.getLeafId()!;
			nativeView = structuredClone(sm.buildSessionContext().messages);
			assert(!nativeView.some((message) => message.role === "custom" && message.customType === CODEX_CONTEXT_WINDOW_MESSAGE_TYPE));
			assert(nativeView.some((message) => message.role === "compactionSummary"));
			assert(nativeView.some((message) => message.role === "user"));
			assert(nativeView.some((message) => message.role === "assistant"));
			assert.equal(sm.getEntries().filter((entry) => entry.type === "compaction").length, 1);
			assert.equal((sm.getEntries().find((entry) => entry.type === "compaction") as any).fromHook, false);
			assert.deepEqual(sm.getEntries().slice(0, snapshot.length), snapshot, "opt-out must preserve persisted history");
		} finally { bare.session.dispose(); }
		const beforeReentry = requests.length;
		await toolkit.session.setModel(listed);
		assert.equal(requests.length, beforeReentry);
		assert(toolkit.session.getActiveToolNames().includes("new_context"));
		assert(toolkit.session.getActiveToolNames().includes("web_run"));
		const assertListedRequest = async (session: typeof toolkit.session, prompt: string, expectedWindow?: string) => {
			const count = requests.length;
			await session.prompt(prompt);
			assert.equal(requests.length, count + 1);
			assert.equal((session.messages.at(-1) as any).stopReason, "stop");
			const request = requests.at(-1)!;
			const window = request.headers["x-codex-window-id"];
			assert(window);
			assert.equal(window, request.body.client_metadata["x-codex-window-id"]);
			assert.equal(request.headers["x-codex-turn-metadata"], request.body.client_metadata["x-codex-turn-metadata"]);
			if (expectedWindow) assert.equal(window, expectedWindow);
			return window;
		};
		const reentryWindow = await assertListedRequest(toolkit.session, "Listed request after native compaction.");
		assert.notEqual(reentryWindow, initialWindow);
		const postReentryLeaf = sm.getLeafId()!;
		const projected = toolkit.contexts.at(-1) as typeof toolkit.session.messages;
		for (const message of nativeView!) {
			if (["compactionSummary", "user", "assistant"].includes(message.role)) {
				assert(projected.some((actual) => JSON.stringify(actual) === JSON.stringify(message)), `preserve native ${message.role}`);
			}
		}
		const encoded = JSON.stringify(requests.at(-1)!.body.input);
		assert(encoded.includes("KEEP-NATIVE-USER"));
		assert(encoded.includes("SYNTHETIC-REPLY"));
		assert(!encoded.includes("OLD-HISTORY-0"));

		// Restart from persisted entries on the same branch, then send a real request.
		const restartedSm = SessionManager.inMemory(env.cwd, { id: sm.getSessionId() }, structuredClone(sm.getBranch()));
		const restarted = await create(true, restartedSm);
		try {
			const markerCount = restartedSm.getBranch().filter((entry) => entry.type === "custom_message").length;
			await assertListedRequest(restarted.session, "Restarted listed request.", reentryWindow);
			assert.equal(restartedSm.getBranch().filter((entry) => entry.type === "custom_message").length, markerCount);
			assert(JSON.stringify(restarted.contexts.at(-1)).includes("KEEP-NATIVE-USER"));
		} finally { restarted.session.dispose(); }
		await toolkit.session.navigateTree(beforeCompactLeaf!, { summarize: false });
		await assertListedRequest(toolkit.session, "Pre-native-compaction branch request.", initialWindow);
		await toolkit.session.navigateTree(postReentryLeaf, { summarize: false });
		await assertListedRequest(toolkit.session, "Post-reentry branch request.", reentryWindow);
		await toolkit.session.navigateTree(compactLeaf!, { summarize: false });
		await assertListedRequest(toolkit.session, "Compacted branch before reentry marker.", reentryWindow);
		assert(JSON.stringify(toolkit.contexts.at(-1)).includes("KEEP-NATIVE-USER"));
		env.assertNoNetwork();
	} finally { toolkit.session.dispose(); }
	process.stdout.write("OK\n");
} finally { await env.dispose(); }
