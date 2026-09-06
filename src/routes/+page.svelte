<script>
	import Carousel from '$lib/components/ui/Carousel.svelte'
	import CarouselItem from '$lib/components/ui/CarouselItem.svelte'
	import Card from '$lib/components/ui/Card.svelte'
	import RecipePhotoCard from '$lib/components/recipe/RecipePhotoCard.svelte'
	import { t } from '$lib/stores/locale.js'

	/** @type {{data: any}} */
	let { data } = $props()
	const { highlights, landing } = data

	const rows = $derived(
		highlights
			? [
					{ label: $t('home.recentlyAdded'), recipes: highlights.recentlyAdded },
					{ label: $t('home.recentlyCooked'), recipes: highlights.recentlyCooked },
					{ label: $t('home.mostCooked'), recipes: highlights.mostCooked },
					{ label: $t('home.favourites'), recipes: highlights.favourites },
					{ label: $t('home.randomPicks'), recipes: highlights.random }
				].filter((row) => row.recipes.length > 0)
			: []
	)
</script>

{#if landing}
	<section class="mx-auto flex min-h-[70vh] max-w-5xl flex-col justify-center gap-8 py-8">
		<div class="max-w-3xl">
			<p class="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-primary">
				{$t('home.landingEyebrow')}
			</p>
			<h1 class="text-4xl font-bold leading-tight sm:text-5xl">{$t('home.landingTitle')}</h1>
			<p class="mt-5 max-w-2xl text-lg text-base-content/70">
				{$t('home.landingDescription')}
			</p>
			<div class="mt-8 flex flex-col gap-3 sm:flex-row">
				<a href="/login" class="btn btn-primary btn-lg">{$t('home.loginExisting')}</a>
				{#if !landing.dbSeeded}
					<a href="/setup" class="btn btn-outline btn-lg">{$t('home.setupAdmin')}</a>
				{:else if landing.registrationAllowed}
					<a href="/register" class="btn btn-outline btn-lg">{$t('home.createAccount')}</a>
				{/if}
			</div>
		</div>

		<div class="grid gap-4 md:grid-cols-2">
			<Card bordered={true} class="h-full">
				<h2 class="card-title">{$t('home.memberCardTitle')}</h2>
				<p class="text-base-content/70">{$t('home.memberCardDescription')}</p>
				<div class="card-actions mt-4">
					<a href="/login" class="link link-primary font-semibold">{$t('home.loginExisting')}</a>
				</div>
			</Card>

			<Card bordered={true} class="h-full">
				<h2 class="card-title">
					{landing.dbSeeded ? $t('home.accountCardTitle') : $t('home.adminCardTitle')}
				</h2>
				<p class="text-base-content/70">
					{landing.dbSeeded ? $t('home.accountCardDescription') : $t('home.adminCardDescription')}
				</p>
				{#if !landing.dbSeeded}
					<div class="card-actions mt-4">
						<a href="/setup" class="link link-primary font-semibold">{$t('home.setupAdmin')}</a>
					</div>
				{:else if landing.registrationAllowed}
					<div class="card-actions mt-4">
						<a href="/register" class="link link-primary font-semibold"
							>{$t('home.createAccount')}</a
						>
					</div>
				{/if}
			</Card>
		</div>
	</section>
{:else if rows.length === 0}
	<div class="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-base-content/50">
		<p class="text-xl">{$t('home.empty')}</p>
		<a href="/ai" class="btn btn-primary">{$t('home.addFirst')}</a>
	</div>
{:else}
	<div class="flex flex-col gap-10">
		{#each rows as row (row.label)}
			<section>
				<h2 class="text-lg font-semibold mb-3">{row.label}</h2>
				<Carousel>
					{#each row.recipes as recipe (recipe.uid)}
						<CarouselItem>
							<RecipePhotoCard {recipe} />
						</CarouselItem>
					{/each}
				</Carousel>
			</section>
		{/each}
	</div>
{/if}
