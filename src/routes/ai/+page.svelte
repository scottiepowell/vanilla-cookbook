<script>
	import { goto } from '$app/navigation'
	import { aiDraftToRecipe, aiDraftValidationErrors, canSaveAiDraft } from '$lib/aiRecipeDraft.js'
	import Button from '$lib/components/ui/Button.svelte'
	import Card from '$lib/components/ui/Card.svelte'
	import Input from '$lib/components/ui/Form/Input.svelte'
	import Textarea from '$lib/components/ui/Form/Textarea.svelte'
	import { createRecipe } from '$lib/utils/crud.js'
	import {
		cleanAiPrompt,
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
	let maxRetries = $state(5)
	let pendingReplacement = $state('')
	let saving = $state(false)
	let editingDraft = $state(false)
	let { data } = $props()
	let draftErrors = $derived(aiDraftValidationErrors(draft))

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
		maxRetries = 5
		pendingReplacement = ''
		editingDraft = false
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
		maxRetries = Number.isInteger(result.maxRetries) ? result.maxRetries : 5
		messages = [...messages, { role: 'assistant', text: result.assistantMessage }]
		pendingReplacement = result.replacementSuggested
			? proposedReplacementIdea(messages.at(-2)?.text || '')
			: ''
		editingDraft = false
	}

	function updateDraftField(field, value) {
		draft = { ...draft, [field]: value }
	}

	function updateIngredient(index, field, value) {
		draft = {
			...draft,
			ingredients: draft.ingredients.map((item, itemIndex) =>
				itemIndex === index ? { ...item, [field]: value } : item
			)
		}
	}

	function addIngredient() {
		draft = {
			...draft,
			ingredients: [...draft.ingredients, { quantity: '', unit: '', name: '', note: '' }]
		}
	}

	function removeIngredient(index) {
		if (draft.ingredients.length <= 1) return
		draft = {
			...draft,
			ingredients: draft.ingredients.filter((_, itemIndex) => itemIndex !== index)
		}
	}

	function updateInstruction(index, value) {
		draft = {
			...draft,
			instructions: draft.instructions.map((item, itemIndex) =>
				itemIndex === index ? { ...item, step: index + 1, text: value } : item
			)
		}
	}

	function addInstruction() {
		draft = {
			...draft,
			instructions: [...draft.instructions, { step: draft.instructions.length + 1, text: '' }]
		}
	}

	function removeInstruction(index) {
		if (draft.instructions.length <= 1) return
		draft = {
			...draft,
			instructions: draft.instructions
				.filter((_, itemIndex) => itemIndex !== index)
				.map((item, itemIndex) => ({ ...item, step: itemIndex + 1 }))
		}
	}

	async function sendPrompt(override = null) {
		const text = cleanAiPrompt(override ?? prompt)
		if (loading) return
		if (!text) {
			error = chatId
				? 'Enter a recipe change before sending.'
				: 'Enter a recipe idea before sending.'
			return
		}

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
				maxRetries = Number.isInteger(result.maxRetries) ? result.maxRetries : 5
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

	async function saveRecipe() {
		if (!canSaveAiDraft(draft) || saving || loading) return
		saving = true
		error = ''
		try {
			const recipe = aiDraftToRecipe(draft, {
				sourceNote: source,
				isPublic: data.userPublicRecipes
			})
			const formData = new FormData()
			formData.append('recipe', JSON.stringify(recipe))
			const result = await createRecipe(formData)
			if (!result.success) {
				error = result.error || 'Cookbook could not save this recipe.'
				return
			}
			await discardCurrentChat()
			await goto(`/recipe/${result.data.uid}/view/`)
		} catch (saveError) {
			error = saveError?.message || 'Cookbook could not save this recipe.'
		} finally {
			saving = false
		}
	}
</script>

<svelte:head><title>AI Recipe Chat</title></svelte:head>

<div class="mx-auto flex max-w-4xl flex-col gap-5">
	<div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
		<div>
			<p class="text-sm font-semibold uppercase tracking-[0.18em] text-primary">Cookbook AI</p>
			<h1 class="mt-2 text-3xl font-bold">Add a recipe</h1>
			<p class="mt-2 text-base-content/70">
				Build a draft with AI, then refine ingredients, servings, methods, or instructions. Each
				recipe allows up to ten changes and nothing is saved automatically.
			</p>
		</div>
		<a href="/recipe/new" class="btn btn-outline btn-primary shrink-0">Manual entry</a>
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
					<div class="flex flex-wrap items-start justify-between gap-3">
						<div>
							<p class="text-xs font-semibold uppercase tracking-wide text-primary">
								Review before saving
							</p>
						</div>
						<Button onclick={() => (editingDraft = !editingDraft)} style="outline">
							{editingDraft ? 'Done editing' : 'Edit draft'}
						</Button>
					</div>

					{#if editingDraft}
						<div class="grid gap-3 sm:grid-cols-2">
							<Input
								label="Recipe title"
								value={draft.title || ''}
								required={true}
								oninput={(event) => updateDraftField('title', event.target.value)}
							/>
							<Input
								label="Servings"
								type="number"
								value={String(draft.servings || '')}
								required={true}
								oninput={(event) => updateDraftField('servings', Number(event.target.value))}
							/>
						</div>
						<Textarea
							label="Description"
							rows={3}
							value={draft.description || ''}
							oninput={(event) => updateDraftField('description', event.target.value)}
						/>
					{:else}
						<div>
							<h2 class="mt-1 text-2xl font-bold">{draft.title}</h2>
							{#if draft.description}<p class="mt-2 text-base-content/70">
									{draft.description}
								</p>{/if}
							{#if draft.servings}<p class="mt-2 text-sm">Serves {draft.servings}</p>{/if}
						</div>
					{/if}

					<details open class="disclosure rounded-lg border border-base-300 p-3">
						<summary class="cursor-pointer font-semibold"
							>Ingredients ({draft.ingredients.length})</summary
						>
						{#if editingDraft}
							<div class="mt-3 flex flex-col gap-3">
								{#each draft.ingredients as ingredient, index}
									<div class="rounded-lg bg-base-200 p-3">
										<div class="grid gap-2 sm:grid-cols-[1fr_1fr_2fr]">
											<Input
												label="Quantity"
												value={ingredient.quantity || ''}
												oninput={(event) => updateIngredient(index, 'quantity', event.target.value)}
											/>
											<Input
												label="Unit"
												value={ingredient.unit || ''}
												oninput={(event) => updateIngredient(index, 'unit', event.target.value)}
											/>
											<Input
												label="Ingredient"
												value={ingredient.name || ''}
												required={true}
												oninput={(event) => updateIngredient(index, 'name', event.target.value)}
											/>
										</div>
										<div class="mt-2 flex items-end gap-2">
											<Input
												label="Note"
												value={ingredient.note || ''}
												oninput={(event) => updateIngredient(index, 'note', event.target.value)}
											/>
											<Button
												style="outline"
												disabled={draft.ingredients.length <= 1}
												onclick={() => removeIngredient(index)}>Remove</Button
											>
										</div>
									</div>
								{/each}
								<Button style="outline" onclick={addIngredient}>Add ingredient</Button>
							</div>
						{:else}
							<ul class="mt-3 list-disc space-y-1 pl-5">
								{#each draft.ingredients as ingredient}
									<li>
										{[ingredient.quantity, ingredient.unit, ingredient.name, ingredient.note]
											.filter(Boolean)
											.join(' ')}
									</li>
								{/each}
							</ul>
						{/if}
					</details>

					<details open class="disclosure rounded-lg border border-base-300 p-3">
						<summary class="cursor-pointer font-semibold"
							>Instructions ({draft.instructions.length})</summary
						>
						{#if editingDraft}
							<div class="mt-3 flex flex-col gap-3">
								{#each draft.instructions as instruction, index}
									<div class="flex items-end gap-2">
										<Textarea
											label={`Step ${index + 1}`}
											rows={3}
											value={instruction.text || ''}
											required={true}
											oninput={(event) => updateInstruction(index, event.target.value)}
										/>
										<Button
											style="outline"
											disabled={draft.instructions.length <= 1}
											onclick={() => removeInstruction(index)}>Remove</Button
										>
									</div>
								{/each}
								<Button style="outline" onclick={addInstruction}>Add instruction</Button>
							</div>
						{:else}
							<ol class="mt-3 list-decimal space-y-2 pl-5">
								{#each draft.instructions as instruction}<li>{instruction.text}</li>{/each}
							</ol>
						{/if}
					</details>

					{#if draftErrors.length}
						<div class="alert alert-warning" role="status">
							<ul class="list-disc pl-5">
								{#each draftErrors as validationError}<li>{validationError}</li>{/each}
							</ul>
						</div>
					{/if}
				</div>
			</details>
		</Card>
		<div class="flex flex-wrap items-center justify-end gap-3">
			<p class="mr-auto text-sm text-base-content/60">
				Saving creates a recipe in your Cookbook. You can edit it afterward.
			</p>
			<Button
				onclick={saveRecipe}
				disabled={saving || loading || !canSaveAiDraft(draft)}
				loading={saving}
			>
				{saving ? 'Saving recipe…' : 'Save to Cookbook'}
			</Button>
		</div>
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
							!cleanAiPrompt(prompt) ||
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
