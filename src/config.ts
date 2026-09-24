import {logger} from './log.js';

export interface Config {
	/** Public origin of the instance, e.g. https://chat.example.com */
	instanceUrl: string;
	botToken: string;
	/** Channel name (case-insensitive) or channel ID to post starboard entries in. */
	starboardChannel: string;
	/** Unicode emoji or "name:id" for a custom guild emoji. */
	starEmoji: string;
	/** Stars required before a message is posted. */
	threshold: number;
	/** Base URL for jump links (the URL humans open). */
	webAppBaseUrl: string;
	/** Optional direct API base override (skips discovery when paired with gatewayUrl). */
	apiUrl?: string;
	/** Optional direct Gateway WebSocket URL override. */
	gatewayUrl?: string;
	/** Directory for the persistent dedup store. */
	dataDir: string;
}

function env(name: string): string | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

/** Normalize an HTTP(S) origin (optionally with a path prefix), dropping any trailing slash. */
function parseHttpUrl(name: string, value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') {
			throw new Error(`unsupported protocol ${url.protocol}`);
		}
		return url.origin + (url.pathname.replace(/\/+$/, '') || '');
	} catch (error) {
		throw new Error(`${name} is not a valid HTTP(S) URL: ${value} (${(error as Error).message})`);
	}
}

/** Validate a ws(s):// URL, keeping scheme, host, port, and path. */
function parseWsUrl(name: string, value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
			throw new Error(`unsupported protocol ${url.protocol}`);
		}
		return url.toString().replace(/\/+$/, '');
	} catch (error) {
		throw new Error(`${name} is not a valid WebSocket URL: ${value} (${(error as Error).message})`);
	}
}

export function loadConfig(): Config {
	const instanceUrlRaw = env('INSTANCE_URL');
	const apiUrlRaw = env('API_URL');
	const gatewayUrlRaw = env('GATEWAY_URL');

	if (!instanceUrlRaw && !(apiUrlRaw && gatewayUrlRaw)) {
		throw new Error(
			'INSTANCE_URL is required (or set both API_URL and GATEWAY_URL for direct internal routing)',
		);
	}
	if (instanceUrlRaw && !(apiUrlRaw && gatewayUrlRaw) && (apiUrlRaw || gatewayUrlRaw)) {
		logger.warn(
			'Only one of API_URL/GATEWAY_URL is set; discovery overrides apply only when both are set',
		);
	}

	const instanceUrl = instanceUrlRaw ? parseHttpUrl('INSTANCE_URL', instanceUrlRaw) : '';

	const webAppBaseUrlRaw = env('WEB_APP_BASE_URL') ?? instanceUrlRaw;
	if (!webAppBaseUrlRaw) {
		throw new Error(
			'WEB_APP_BASE_URL is required when INSTANCE_URL is not set (jump links need a human-readable base URL)',
		);
	}

	const botToken = env('BOT_TOKEN');
	if (!botToken) throw new Error('BOT_TOKEN is required');
	if (!botToken.includes('.')) {
		logger.warn('BOT_TOKEN does not look like a bot token (expected "<application_id>.<secret>")');
	}

	const starEmoji = env('STAR_EMOJI') ?? '⭐';
	const thresholdRaw = env('THRESHOLD') ?? '1';
	const threshold = Number.parseInt(thresholdRaw, 10);
	if (!Number.isInteger(threshold) || threshold < 1) {
		throw new Error(`THRESHOLD must be a positive integer, got: ${thresholdRaw}`);
	}

	return {
		instanceUrl,
		botToken,
		starboardChannel: (env('STARBOARD_CHANNEL_NAME') ?? 'starboard').toLowerCase(),
		starEmoji,
		threshold,
		webAppBaseUrl: parseHttpUrl('WEB_APP_BASE_URL', webAppBaseUrlRaw),
		apiUrl: apiUrlRaw ? parseHttpUrl('API_URL', apiUrlRaw) : undefined,
		gatewayUrl: gatewayUrlRaw ? parseWsUrl('GATEWAY_URL', gatewayUrlRaw) : undefined,
		dataDir: env('DATA_DIR') ?? 'data',
	};
}
