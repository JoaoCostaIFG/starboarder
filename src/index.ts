import 'dotenv/config';
import {FluxerApi} from './api.js';
import {loadConfig} from './config.js';
import {discoverEndpoints} from './discovery.js';
import {GatewayClient} from './gateway.js';
import {logger} from './log.js';
import {Starboard} from './starboard.js';
import {StarredStore} from './store.js';
import type {Channel, GuildReadyData, MessageReactionAddData, Snowflake} from './types.js';

async function main(): Promise<void> {
	const config = loadConfig();
	logger.info(
		`Starting starboarder: star=${config.starEmoji} threshold=${config.threshold} ` +
			`channel="${config.starboardChannel}"`,
	);

	const endpoints = await discoverEndpoints({
		instanceUrl: config.instanceUrl,
		apiUrl: config.apiUrl,
		gatewayUrl: config.gatewayUrl,
	});
	logger.info(`API ${endpoints.api}; gateway ${endpoints.gateway}`);

	const api = new FluxerApi(endpoints.api, config.botToken);
	const store = new StarredStore(`${config.dataDir}/starred.json`);
	await store.load();

	const starboard = new Starboard(config, api, store, {
		mediaBase: endpoints.media,
		staticCdnBase: endpoints.staticCdn,
	});

	const gateway = new GatewayClient(endpoints.gateway, config.botToken);
	gateway.on('ready', (user) => {
		starboard.setBotUserId(user.id);
	});

	const shutdown = (reason: string) => {
		logger.info(`Shutting down (${reason})`);
		gateway.stop();
		void store.flush().finally(() => process.exit(process.exitCode ?? 0));
	};

	gateway.on('fatal', (error) => {
		logger.error(`Unrecoverable gateway error: ${error.message}`);
		process.exitCode = 1;
		shutdown('fatal gateway error');
	});

	gateway.on('dispatch', (t, d) => {
		switch (t) {
			case 'GUILD_CREATE': {
				const guild = d as GuildReadyData;
				starboard.onGuildCreate(guild.id, guild.channels);
				break;
			}
			case 'GUILD_DELETE': {
				const guild = d as {id: Snowflake};
				starboard.onGuildDelete(guild.id);
				break;
			}
			case 'CHANNEL_CREATE':
			case 'CHANNEL_UPDATE':
				starboard.onChannelUpdate(d as Channel);
				break;
			case 'CHANNEL_DELETE':
				starboard.onChannelDelete(d as Channel);
				break;
			case 'MESSAGE_REACTION_ADD':
				starboard.onReactionAdd(d as MessageReactionAddData);
				break;
			default:
				break;
		}
	});

	gateway.start();

	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
	logger.error('Fatal startup error', error);
	process.exit(1);
});
