import { test, expect } from '@playwright/test'

// Run against the disposable loopback container, never the public database.
test('signed-in ingredient search opens real saved and public recipe links', async ({ page }) => {
	test.setTimeout(120_000)
	page.setDefaultTimeout(15_000)
	await page.goto('/')
	await expect(page.getByRole('heading', { name: 'Welcome to Vanilla Cookbook' })).toBeVisible()
	if (
		await page.getByRole('link', { name: 'Create the first administrator' }).first().isVisible()
	) {
		await page.getByRole('link', { name: 'Create the first administrator' }).first().click()
		await page.getByLabel('Username', { exact: true }).fill('discovery_test')
		await page.getByLabel('Email', { exact: true }).fill('discovery@example.com')
		await page.getByLabel('Password', { exact: true }).fill('GeneratedTest42!')
		await page.getByLabel('Confirm Password', { exact: true }).fill('GeneratedTest42!')
		const samples = page.getByLabel('Add Sample Recipes')
		if (await samples.isChecked()) await samples.uncheck()
		await page.getByRole('button', { name: 'Create Admin' }).click()
	} else {
		await page.getByRole('link', { name: 'Log in to your cookbook' }).first().click()
		await page.getByRole('textbox', { name: 'Username or email' }).fill('discovery_test')
		await page.getByLabel('Password', { exact: true }).fill('GeneratedTest42!')
		await page.getByRole('button', { name: 'Login' }).click()
	}
	await expect(page.getByRole('link', { name: 'New Recipe' })).toBeVisible()
	const created = await page.request.post('/api/recipe', {
		headers: { origin: 'http://127.0.0.1:4173' },
		multipart: {
			recipe: JSON.stringify({
				name: 'Generated discovery salad',
				ingredients: '2 carrots\n1 lettuce\n1 onion',
				directions: 'Combine vegetables.',
				is_public: false
			})
		}
	})
	expect(created.ok()).toBeTruthy()
	await page.goto('/ai')
	await page
		.getByRole('textbox', { name: 'carrots, lettuce, onions' })
		.fill('carrots, lettuce, onions')
	await page.getByRole('button', { name: 'Find recipes', exact: true }).click()
	const saved = page.getByRole('link', { name: 'Generated discovery salad', exact: true }).first()
	await expect(saved).toBeVisible()
	await expect(
		page.getByText('All entered ingredients found:', { exact: false }).first()
	).toBeVisible()
	const publicLink = page.getByRole('link', { name: 'Spring Vegetable Salad', exact: true })
	await expect(publicLink).toHaveAttribute(
		'href',
		'https://www.foodnetwork.com/recipes/food-network-kitchen/spring-vegetable-salad-3364967'
	)
	await expect(page.getByText('A small catalog of 8 reviewed recipe links.')).toBeVisible()
	await expect(
		page.getByRole('link', { name: 'Carrot and Red Onion Salad', exact: true })
	).toHaveAttribute(
		'href',
		'https://www.foodnetwork.com/fnk/recipes/carrot-and-red-onion-salad-10034791'
	)
	await expect(page.getByText('Not matched: lettuce', { exact: true }).first()).toBeVisible()
	await saved.click()
	await expect(
		page.getByRole('heading', { name: 'Generated discovery salad', exact: true })
	).toBeVisible()
	await page.goto('/ai')
	await page.getByRole('textbox', { name: 'carrots, lettuce, onions' }).fill('xyzunmatchable')
	await page.getByRole('button', { name: 'Find recipes', exact: true }).click()
	await expect(
		page.getByText('No matching recipes found here. Try fewer or different ingredients.')
	).toHaveCount(2)
})
