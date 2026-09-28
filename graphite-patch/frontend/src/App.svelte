<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { createAutomationBridge } from "/src/automation-bridge";
	import Editor from "/src/components/Editor.svelte";
	import { createSubscriptionsRouter } from "/src/subscriptions-router";
	import type { MessageName, SubscriptionsRouter } from "/src/subscriptions-router";
	import { loadDemoArtwork } from "/src/utility-functions/network";
	import { operatingSystem } from "/src/utility-functions/platform";
	import { initWasm } from "/src/utility-functions/wasm-loader";
	import { EditorWrapper, receiveNativeMessage } from "/wrapper/pkg/graphite_wasm_wrapper";
	import type { FrontendMessage } from "/wrapper/pkg/graphite_wasm_wrapper";

	let subscriptions: SubscriptionsRouter | undefined = undefined;
	let editor: EditorWrapper | undefined = undefined;
	// Automation bridge for MCP/AI clients; inert unless enabled with a token (see automation-bridge.ts)
	const automationBridge = createAutomationBridge();

	onMount(async () => {
		// Initialize the editor wrapper
		const wrapper = await initWasm();
		for (const [name, f] of Object.entries(wrapper)) {
			if (name.startsWith("__node_registry")) f();
		}
		window.imageCanvases = {};
		window.receiveNativeMessage = receiveNativeMessage;

		// Create the editor and subscriptions router
		const randomSeed = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
		subscriptions = createSubscriptionsRouter();
		editor = await EditorWrapper.create(operatingSystem(), randomSeed, (messageType: MessageName, messageData: FrontendMessage) => {
			// The bridge observes every message and swallows only an export it initiated (so it is not downloaded twice)
			if (automationBridge.intercept(messageType, messageData)) return;
			subscriptions?.handleFrontendMessage(messageType, messageData);
		});
		automationBridge.attach(editor);

		await loadDemoArtwork(editor);
	});

	onDestroy(() => {
		automationBridge.destroy();
		editor?.free();
	});
</script>

{#if subscriptions !== undefined && editor !== undefined}
	<Editor {subscriptions} {editor} />
{/if}
