import assert from "node:assert/strict";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const env = await createSmokeEnvironment();
try {
	const { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager } =
		await import("@earendil-works/pi-coding-agent");
	const { InMemoryCredentialStore, InMemoryModelsStore, Type } = await import("@earendil-works/pi-ai");
	const { default: registerContext } = await import("../src/extension-runtime");
	const { registerImageGenerationExtension } = await import("../src/image-generation/extension");
	const { v2Fixture } = await import("../src/config/test-helpers");
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	for (const provider of ["listed", "native"]) modelRuntime.registerProvider(provider, {
		api: "openai-responses", apiKey: "synthetic", baseUrl: "https://ownership.invalid/v1",
		models: [{ id: "chat", name: "Ownership smoke", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 512 }],
	});
	const listed = modelRuntime.getModel("listed", "chat")!;
	const native = modelRuntime.getModel("native", "chat")!;
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } }, { projectTrusted: true });
	const loadConfig = () => v2Fixture({ models: { "listed/chat": {
		context: { mode: "remote-windows" }, compatibility: { transport: "codex-gateway" }, imageGeneration: { enabled: true },
	} } });
	const foreignTool = (name: string) => defineTool({ name, label: name, description: `Foreign ${name}`,
		parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "foreign" }], details: {} }) });
	for (const scenario of ["sdk-startup", "dynamic-replacement"] as const) {
		for (const active of [true, false]) {
			let foreignPi: import("@earendil-works/pi-coding-agent").ExtensionAPI;
			const loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
				extensionFactories: [
					(pi) => {
						foreignPi = pi;
						pi.on("session_start", () => {
							if (!active && scenario === "sdk-startup") pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "openai_generate_image"));
						});
					},
					(pi) => registerContext(pi, { loadConfig }),
					(pi) => registerImageGenerationExtension(pi, loadConfig),
				],
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const image = foreignTool("openai_generate_image");
			const { session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime,
				model: scenario === "sdk-startup" ? native : listed, settingsManager, resourceLoader: loader,
				sessionManager: SessionManager.inMemory(env.cwd), customTools: scenario === "sdk-startup" ? [image] : [] });
			try {
				await session.bindExtensions({ mode: "json", onError: (error) => { throw new Error(error.message); } });
				const names = scenario === "sdk-startup" ? [image.name] : [image.name, "history"];
				if (scenario === "dynamic-replacement") {
					assert(session.getActiveToolNames().includes("history"), "verify Toolkit activation first");
					for (const name of names) foreignPi!.registerTool(foreignTool(name));
					const current = session.getActiveToolNames();
					foreignPi!.setActiveTools(active ? [...new Set([...current, ...names])] : current.filter((name) => !names.includes(name)));
				}
				const assertForeign = () => {
					for (const name of names) {
						assert.equal(session.getAllTools().find((tool) => tool.name === name)?.description, `Foreign ${name}`);
						assert.equal(session.getActiveToolNames().includes(name), active, `${scenario}: preserve ${name} active=${active}`);
					}
				};
				assertForeign();
				for (const model of [native, listed, native, listed]) {
					await session.setModel(model);
					assertForeign();
				}
				if (scenario === "dynamic-replacement") {
					assert(!session.getActiveToolNames().includes("new_context"), "a replaced context catalog must not be reactivated");
					await session.prompt("The conflicted managed request must fail closed.");
					const result = session.messages.at(-1) as any;
					assert(["aborted", "error"].includes(result.stopReason));
					assert.match(result.errorMessage ?? "", /abort|codex-context-unavailable/i);
				}
			} finally { session.dispose(); }
		}
	}
	env.assertNoNetwork();
	process.stdout.write("OK\n");
} finally { await env.dispose(); }
