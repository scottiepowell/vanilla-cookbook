const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function localAuthFixtureGuard(env = process.env) {
	const reasons = []
	if (env.NODE_ENV === 'production') reasons.push('production_mode')
	if (env.RUN_LOCAL_DEV_AUTH_FIXTURE !== '1') reasons.push('fixture_disabled')
	if (env.LOCAL_DEV_AUTH_FIXTURE_APPROVED !== '1') reasons.push('approval_required')
	if (env.SYNTHETIC_AUTH_FIXTURE !== '1') reasons.push('synthetic_fixture_required')
	if (env.GITHUB_ACTIONS === 'true' || env.CI === 'true' || env.AWS_REGION || env.CLOUDFLARE_TUNNEL_TOKEN) reasons.push('deployment_or_ci_context')
	if (!/^local\/vanilla-cookbook-adapter:0034c$/.test(env.VANILLA_COOKBOOK_IMAGE || '')) reasons.push('approved_custom_image_required')
	try {
		const target = new URL(env.COOKBOOK_TARGET_URL || 'http://127.0.0.1:3000/')
		if (target.protocol !== 'http:' || !LOOPBACK_HOSTS.has(target.hostname)) reasons.push('loopback_target_required')
	} catch {
		reasons.push('loopback_target_required')
	}
	return { allowed: reasons.length === 0, reasons }
}
