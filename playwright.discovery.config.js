export default {
	testDir: 'src/tests/e2e',
	testMatch: 'recipe-discovery.spec.js',
	workers: 1,
	fullyParallel: false,
	use: {
		baseURL: 'http://127.0.0.1:4173',
		browserName: 'chromium',
		channel: process.env.PLAYWRIGHT_CHANNEL || undefined
	}
}
