<script>
	import Button from '$lib/components/ui/Button.svelte'
	import Card from '$lib/components/ui/Card.svelte'
	import Textarea from '$lib/components/ui/Form/Textarea.svelte'
	import {
		explicitNewRecipeRequest,
		proposedReplacementIdea,
		replacementConfirmationAnswer
	} from '$lib/aiRecipeChatIntent.js'

	let prompt = $state('')
	let source = $state('')
	let loading = $state(false)
	let error = $state('')
	let chatId = $state(null)
	let messages = $state([])
	let draft = $state(null)
	let grounding = $state(null)
	let changeCount = $state(0)
	let maxChanges = $state(10)
	let retryCount = $state(0)
	let maxRetries = $state(3)
	let pendingReplacement = $state('')

	function resetChat() {
		prompt = ''
		source = ''
		error = ''
		chatId = null
		messages = []
		draft = null
		grounding = null
		changeCount = 0
		maxChanges = 10
		retryCount = 0
		maxRetries = 3
		pendingReplacement = ''
	}

	async function discardCurrentChat() {
		if (!chatId) return
		try {
			await fetch(`/api/ai/recipe-chat/${chatId}`, { method: 'DELETE' })
		} catch {
			// Server state is bounded and expiring; a cleanup failure must not retain the browser draft.
		}
	}

	function applyResult(result) {
		chatId = result.chatId
		if (result.draft) draft = result.draft
		if (result.grounding) grounding = result.grounding
		changeCount = result.changeCount || 0
		maxChanges = result.maxChanges || 10
		retryCount = Number.isInteger(result.retryCount) ? result.retryCount : 0
		maxRetries = Number.isInteger(result.maxRetries) ? result.maxRetries : 3
		messages = [...messages, { role: 'assistant', text: result.assistantMessage }]
		pendingReplacement = result.replacementSuggested
			? proposedReplacementIdea(messages.at(-2)?.text || '')
			: ''
	}

	async function sendPrompt(override = null) {
		const text = (override ?? prompt).trim()
		if (!text || loading) return

		if (chatId && pendingReplacement) {
			const answer = replacementConfirmationAnswer(text)
			if (answer === 'confirm') {
				const idea = pendingReplacement
				resetChat()
				await sendPrompt(idea)
				return
			}
			if (answer === 'keep') {
				prompt = ''
				keepCurrentRecipe()
				return
			}
		}

		if (chatId) {
			const command = explicitNewRecipeRequest(text)
			if (command.explicit) {
				await discardCurrentChat()
				resetChat()
				if (command.idea) await sendPrompt(command.idea)
				else messages = [{ role: 'assistant', text: 'What new recipe would you like to make?' }]
				return
			}
		}

		const previousMessages = messages
		loading = true
		error = ''
		messages = [...messages, { role: 'user', text }]
		prompt = ''
		try {
			const starting = !chatId
			const endpoint = starting
				? '/api/ai/recipe-chat/start'
				: `/api/ai/recipe-chat/${chatId}/message`
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(starting ? { text, source } : { text })
			})
			const result = await response.json()
			if (!response.ok || result.status !== 'ok') {
				retryCount = Number.isInteger(result.retryCount) ? result.retryCount : 0
				maxRetries = Number.isInteger(result.maxRetries) ? result.maxRetries : 3
				messages = previousMessages
				prompt = text
				error = result.message || 'Cookbook AI could not continue this recipe.'
				return
			}
			applyResult(result)
		} catch {
			messages = previousMessages
			prompt = text
			error = 'Cookbook AI is temporarily unavailable.'
		} finally {
			loading = false
		}
	}

	async function startSuggestedRecipe() {
		const idea = pendingReplacement
		await discardCurrentChat()
		resetChat()
		await sendPrompt(idea)
	}

	function keepCurrentRecipe() {
		pendingReplacement = ''
		messages = [
			...messages,
			{ role: 'assistant', text: 'Okay, I kept the current recipe. What would you like to change?' }
		]
	}
</script>

<svelte:head><title>AI Recipe Chat</title></svelte:head>

<div class="mx-auto flex max-w-4xl flex-col gap-5">
	<div>
		<p class="text-sm font-semibold uppercase tracking-[0.18em] text-primary">Cookbook AI</p>
		<h1 class="mt-2 text-3xl font-bold">Build a recipe together</h1>
		<p class="mt-2 text-base-content/70">
			Start with an idea, then ask for ingredient, serving, method, or instruction changes. Each
			recipe allows up to ten changes and nothing is saved automatically.
		</p>
	</div>

	{#if messages.length}
		<div class="flex flex-col gap-3" aria-live="polite">
			{#each messages as item}
				<div class:ml-auto={item.role === 'user'} class="max-w-[85%]">
					<div
						class="rounded-2xl px-4 py-3 text-sm"
						class:bg-primary={item.role === 'user'}
						class:text-primary-content={item.role === 'user'}
						class:bg-base-200={item.role === 'assistant'}
					>
						{item.text}
					</div>
				</div>
			{/each}
		</div>
	{/if}

	{#if pendingReplacement}
		<div class="flex flex-wrap gap-3">
			<Button onclick={startSuggestedRecipe}>Start new recipe</Button>
			<Button onclick={keepCurrentRecipe} style="outline">Keep current recipe</Button>
		</div>
	{/if}

	{#if draft}
		<Card bordered={true}>
			<details open class="disclosure">
				<summary class="cursor-pointer text-xl font-bold">Recipe draft</summary>
				<div class="mt-4 flex flex-col gap-4">
					<div>
						<p class="text-xs font-semibold uppercase tracking-wide text-primary">
							Review before saving
						</p>
						<h2 class="mt-1 text-2xl font-bold">{draft.title}</h2>
						{#if draft.description}<p class="mt-2 text-base-content/70">{draft.description}</p>{/if}
						{#if draft.servings}<p class="mt-2 text-sm">Serves {draft.servings}</p>{/if}
					</div>

					<details open class="disclosure rounded-lg border border-base-300 p-3">
						<summary class="cursor-pointer font-semibold"
							>Ingredients ({draft.ingredients.length})</summary
						>
						<ul class="mt-3 list-disc space-y-1 pl-5">
							{#each draft.ingredients as ingredient}
								<li>
									{[ingredient.quantity, ingredient.unit, ingredient.name, ingredient.note]
										.filter(Boolean)
										.join(' ')}
								</li>
							{/each}
						</ul>
					</details>

					<details open class="disclosure rounded-lg border border-base-300 p-3">
						<summary class="cursor-pointer font-semibold"
							>Instructions ({draft.instructions.length})</summary
						>
						<ol class="mt-3 list-decimal space-y-2 pl-5">
							{#each draft.instructions as instruction}
								<li>{instruction.text}</li>
							{/each}
						</ol>
					</details>
				</div>
			</details>
		</Card>
	{/if}

	{#if grounding}
		<Card bordered={true}>
			<details class="disclosure">
				<summary class="cursor-pointer font-semibold">Local recipe grounding</summary>
				<div class="mt-3 text-sm text-base-content/70">
					<p>{grounding.retrievedCount} examples found · {grounding.packedCount} used.</p>
					<p class="mt-1">
						{grounding.relevance || 'unknown'} relevance · {grounding.support || 'unknown'} support
					</p>
					{#if grounding.examples?.length}
						<ul class="mt-2 list-disc pl-5">
							{#each grounding.examples as title}<li>{title}</li>{/each}
						</ul>
					{/if}
				</div>
			</details>
		</Card>
	{/if}

	<Card bordered={true}>
		<div class="flex flex-col gap-4">
			<Textarea
				label={pendingReplacement
					? 'Start a new recipe?'
					: chatId
						? 'Ask for a recipe change'
						: 'What recipe would you like to make?'}
				placeholder={pendingReplacement
					? 'Type yes, no, or describe the new recipe more clearly...'
					: chatId
						? 'Try: Add mushrooms, make it vegetarian, or serve six...'
						: 'Try: Green chile enchiladas with chicken...'}
				rows={chatId ? 4 : 8}
				bind:value={prompt}
			/>
			{#if !chatId}
				<label class="form-control w-full">
					<span class="label-text mb-2">Source URL or note (optional)</span>
					<input class="input input-bordered w-full" bind:value={source} maxlength="500" />
				</label>
			{/if}
			<div class="flex items-center justify-between gap-3">
				<div class="text-sm text-base-content/60">
					{#if chatId}
						<p>{changeCount} of {maxChanges} changes used</p>
						<p>{retryCount} of {maxRetries} bounded retries used for the latest request</p>
					{/if}
				</div>
				<div class="flex gap-2">
					{#if chatId}<Button onclick={resetChat} style="outline">Start over</Button>{/if}
					<Button
						onclick={() => sendPrompt()}
						disabled={loading ||
							!prompt.trim() ||
							(changeCount >= maxChanges && !pendingReplacement)}
					>
						{loading ? 'Thinking…' : chatId ? 'Send change' : 'Create recipe'}
					</Button>
				</div>
			</div>
		</div>
	</Card>

	{#if error}<div class="alert alert-warning" role="status">{error}</div>{/if}
</div>

<style>
	.disclosure > summary {
		list-style: none;
	}
	.disclosure > summary::-webkit-details-marker {
		display: none;
	}
	.disclosure > summary::after {
		float: right;
		content: '+';
		font-size: 1.25rem;
	}
	.disclosure[open] > summary::after {
		content: '−';
	}
</style>
