<script>
	import Button from '$lib/components/ui/Button.svelte'
	import Card from '$lib/components/ui/Card.svelte'
	import Textarea from '$lib/components/ui/Form/Textarea.svelte'

	let recipeText = $state('')
	let source = $state('')
	let loading = $state(false)
	let message = $state('')
	let draft = $state(null)
	let warnings = $state([])
	let grounding = $state(null)

	async function structureRecipe() {
		loading = true
		message = ''
		draft = null
		warnings = []
		grounding = null

		try {
			const response = await fetch('/api/ai/import-recipe', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text: recipeText, source })
			})
			const result = await response.json()
			if (!response.ok || result.status !== 'ok') {
				message = result.message || 'Cookbook AI could not structure this recipe.'
				return
			}
			draft = result.draft
			warnings = result.warnings || []
			grounding = result.grounding || null
			if (!draft) message = 'Cookbook AI needs more recipe detail before it can create a draft.'
		} catch {
			message = 'Cookbook AI is temporarily unavailable.'
		} finally {
			loading = false
		}
	}
</script>

<svelte:head>
	<title>AI Recipe Assistant</title>
</svelte:head>

<div class="mx-auto flex max-w-4xl flex-col gap-6">
	<div>
		<p class="text-sm font-semibold uppercase tracking-[0.18em] text-primary">Cookbook AI</p>
		<h1 class="mt-2 text-3xl font-bold">Structure a recipe with AI</h1>
		<p class="mt-2 text-base-content/70">
			Paste recipe notes or copied recipe text. The assistant creates a reviewable draft; it does
			not save anything automatically.
		</p>
	</div>

	<Card bordered={true}>
		<div class="flex flex-col gap-4">
			<Textarea
				label="Recipe text"
				placeholder="Paste ingredients, directions, servings, and any notes..."
				rows={12}
				bind:value={recipeText}
			/>
			<label class="form-control w-full">
				<span class="label-text mb-2">Source URL or note (optional)</span>
				<input class="input input-bordered w-full" bind:value={source} maxlength="500" />
			</label>
			<div class="card-actions justify-end">
				<Button onclick={structureRecipe} disabled={loading || !recipeText.trim()}>
					{loading ? 'Structuring recipe…' : 'Create AI draft'}
				</Button>
			</div>
		</div>
	</Card>

	{#if message}
		<div class="alert alert-warning" role="status">{message}</div>
	{/if}

	{#if draft}
		<Card bordered={true}>
			<div class="flex flex-col gap-5">
				<div>
					<p class="text-xs font-semibold uppercase tracking-wide text-primary">
						AI draft — review before saving
					</p>
					<h2 class="mt-1 text-2xl font-bold">{draft.title}</h2>
					{#if draft.description}<p class="mt-2 text-base-content/70">{draft.description}</p>{/if}
					{#if draft.servings}<p class="mt-2 text-sm">Serves {draft.servings}</p>{/if}
				</div>

				<div>
					<h3 class="text-lg font-semibold">Ingredients</h3>
					<ul class="mt-2 list-disc space-y-1 pl-5">
						{#each draft.ingredients || [] as ingredient}
							<li>
								{[ingredient.quantity, ingredient.unit, ingredient.name, ingredient.note]
									.filter(Boolean)
									.join(' ')}
							</li>
						{/each}
					</ul>
				</div>

				<div>
					<h3 class="text-lg font-semibold">Directions</h3>
					<ol class="mt-2 list-decimal space-y-2 pl-5">
						{#each draft.instructions || [] as instruction}
							<li>{instruction.text}</li>
						{/each}
					</ol>
				</div>

				{#if warnings.length}
					<div class="alert alert-info"><span>{warnings.join(' ')}</span></div>
				{/if}
			</div>
		</Card>
	{/if}

	{#if grounding}
		<Card bordered={true}>
			<div class="flex flex-col gap-3">
				<div>
					<p class="text-xs font-semibold uppercase tracking-wide text-primary">
						Local recipe grounding
					</p>
					<h2 class="mt-1 text-xl font-bold">
						{grounding.grounded
							? 'Grounded with local recipe examples'
							: 'Local recipe examples reviewed'}
					</h2>
					<p class="mt-2 text-sm text-base-content/70">
						{grounding.retrievedCount} examples found · {grounding.packedCount} used to help structure
						this draft.
					</p>
				</div>

				<div class="flex flex-wrap gap-2">
					{#if grounding.relevance}
						<span class="badge badge-outline">{grounding.relevance} relevance</span>
					{/if}
					{#if grounding.support}
						<span class="badge badge-outline">{grounding.support} support</span>
					{/if}
				</div>

				{#if grounding.examples?.length}
					<div>
						<h3 class="text-sm font-semibold">Examples consulted</h3>
						<ul class="mt-2 list-disc space-y-1 pl-5 text-sm">
							{#each grounding.examples as title}
								<li>{title}</li>
							{/each}
						</ul>
					</div>
				{/if}
			</div>
		</Card>
	{/if}
</div>
