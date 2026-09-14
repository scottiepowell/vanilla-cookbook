<script>
	import Card from '$lib/components/ui/Card.svelte'
	import Textarea from '$lib/components/ui/Form/Textarea.svelte'
	import Button from '$lib/components/ui/Button.svelte'
	let ingredients = $state('')
	let loading = $state(false)
	let result = $state(null)
	let message = $state('')
	async function search() {
		if (loading || !ingredients.trim()) return
		loading = true
		result = null
		message = ''
		try {
			const response = await fetch('/api/recipe/discover', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ingredients })
			})
			const body = await response.json()
			if (!response.ok) throw new Error(body.message || 'Recipe search is unavailable.')
			result = body
		} catch (error) {
			message = error.message || 'Recipe search is unavailable.'
		} finally {
			loading = false
		}
	}
</script>

<Card>
	<h2 class="text-lg font-semibold">Find recipes by ingredients</h2>
	<p>Search your Cookbook and public recipes using your ingredients together.</p>
	<form
		onsubmit={(event) => {
			event.preventDefault()
			search()
		}}
		class="space-y-3"
	>
		<Textarea
			id="discovery-ingredients"
			label="Ingredients to use"
			bind:value={ingredients}
			placeholder="carrots, lettuce, onions"
		/>
		<Button type="submit" disabled={loading || !ingredients.trim()}
			>{loading ? 'Searching…' : 'Find recipes'}</Button
		>
	</form>
	<div aria-live="polite">
		{#if message}<p class="mt-3">{message}</p>{/if}
		{#if result}
			<p class="mt-3 text-sm">
				Matches use ingredient names. You may need other ingredients; check the full recipe.
			</p>
			{#each [{ title: 'From your Cookbook', items: result.cookbook, external: false }, { title: 'From public recipe websites', items: result.publicRecipes, external: true }] as group}
				<h3 class="mt-4 font-semibold">{group.title}</h3>
				{#if group.external}
					<p class="text-sm">A small catalog of {result.catalogCount} reviewed recipe links.</p>
				{/if}
				{#if group.external && result.publicStatus !== 'ok'}
					<p>Public recipe links are temporarily unavailable. Cookbook matches are shown above.</p>
				{:else if !group.items.length}
					<p>No matching recipes found here. Try fewer or different ingredients.</p>
				{:else}
					<ul class="space-y-3 mt-2">
						{#each group.items as recipe}
							<li>
								<a
									class="link font-medium"
									href={recipe.url}
									target={group.external ? '_blank' : undefined}
									rel={group.external ? 'noopener noreferrer' : undefined}>{recipe.name}</a
								>
								{#if group.external}<span> — {recipe.source}</span>{/if}
								<p class="text-sm">
									{recipe.match === 'all' ? 'All entered ingredients found' : 'Partial match'}: {recipe.matched.join(
										', '
									)}
								</p>
								{#if recipe.missing.length}<p class="text-sm">
										Not matched: {recipe.missing.join(', ')}
									</p>{/if}
							</li>
						{/each}
					</ul>
				{/if}
			{/each}
			{#if result.truncated}<p>Search covered the first 5,000 visible Cookbook recipes.</p>{/if}
		{/if}
	</div>
</Card>
