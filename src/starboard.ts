import {logger} from './log.js';
import type {FluxerApi} from './api.js';
import type {Config} from './config.js';
import type {StarredStore} from './store.js';
import type {
	Channel,
	EmbedInput,
	Message,
	MessageReactionAddData,
	ReactionEmoji,
	Snowflake,
} from './types.js';
import {GUILD_TEXT, GUILD_VOICE} from './types.js';

const DEBOUNCE_MS = 1_000;
const NOT_FOUND_LOG_INTERVAL_MS = 5 * 60_000;

interface PendingCheck {
	guildId: Snowflake;
	channelId: Snowflake;
	timer: NodeJS.Timeout;
}

/**
 * Starboard brain: watches star reactions, counts them against the threshold,
 * and posts an embed with a jump link into the configured Starboard channel.
 */
export class Starboard {
	private readonly channelsByGuild = new Map<Snowflake, Map<Snowflake, Channel>>();
	private readonly pending = new Map<Snowflake, PendingCheck>();
	private readonly notFoundLoggedAt = new Map<Snowflake, number>();
	private botUserId: Snowflake | null = null;

	constructor(
		private readonly config: Config,
		private readonly api: FluxerApi,
		private readonly store: StarredStore,
		private readonly media: {mediaBase?: string; staticCdnBase?: string},
	) {}

	setBotUserId(id: Snowflake): void {
		this.botUserId = id;
	}

	// -- Guild/channel cache --------------------------------------------------

	onGuildCreate(guildId: Snowflake, channels: Channel[] | undefined): void {
		if (channels === undefined) return;
		const map = new Map<Snowflake, Channel>();
		for (const channel of channels) map.set(channel.id, channel);
		this.channelsByGuild.set(guildId, map);
		logger.info(`Cached ${map.size} channels for guild ${guildId}`);
	}

	onGuildDelete(guildId: Snowflake): void {
		this.channelsByGuild.delete(guildId);
		this.notFoundLoggedAt.delete(guildId);
	}

	onChannelUpdate(channel: Channel): void {
		const guildId = channel.guild_id;
		if (guildId === undefined) return;
		this.guildChannels(guildId).set(channel.id, channel);
	}

	onChannelDelete(channel: Channel): void {
		const guildId = channel.guild_id;
		if (guildId === undefined) return;
		this.guildChannels(guildId).delete(channel.id);
	}

	private guildChannels(guildId: Snowflake): Map<Snowflake, Channel> {
		let map = this.channelsByGuild.get(guildId);
		if (map === undefined) {
			map = new Map<Snowflake, Channel>();
			this.channelsByGuild.set(guildId, map);
		}
		return map;
	}

	/** The configured value is either a channel name or a literal channel ID. */
	private matchesStarboardChannel(channel: Channel): boolean {
		const wanted = this.config.starboardChannel;
		if (/^\d+$/.test(wanted)) return channel.id === wanted;
		// Text-bearing guild channel types only.
		if (channel.type !== GUILD_TEXT && channel.type !== GUILD_VOICE) return false;
		return (channel.name ?? '').toLowerCase() === wanted;
	}

	/** Resolve the starboard channel, refreshing the guild cache over HTTP once if needed. */
	private async resolveStarboardChannel(guildId: Snowflake): Promise<Channel | null> {
		let channel = this.findStarboardInCache(guildId);
		if (channel !== null) return channel;

		try {
			const channels = await this.api.listGuildChannels(guildId);
			const map = new Map<Snowflake, Channel>();
			for (const c of channels) map.set(c.id, c);
			this.channelsByGuild.set(guildId, map);
			channel = this.findStarboardInCache(guildId);
		} catch (error) {
			logger.warn(`Failed to list channels for guild ${guildId}: ${(error as Error).message}`);
			return null;
		}
		return channel;
	}

	private findStarboardInCache(guildId: Snowflake): Channel | null {
		const map = this.channelsByGuild.get(guildId);
		if (map === undefined) return null;
		for (const channel of map.values()) {
			if (this.matchesStarboardChannel(channel)) return channel;
		}
		return null;
	}

	private async channelName(guildId: Snowflake, channelId: Snowflake): Promise<string> {
		const cached = this.channelsByGuild.get(guildId)?.get(channelId);
		if (cached?.name !== undefined) return cached.name;
		try {
			const channels = await this.api.listGuildChannels(guildId);
			const map = new Map<Snowflake, Channel>();
			for (const c of channels) map.set(c.id, c);
			this.channelsByGuild.set(guildId, map);
			return map.get(channelId)?.name ?? 'unknown';
		} catch {
			return 'unknown';
		}
	}

	// -- Reactions ------------------------------------------------------------

	private isStarEmoji(emoji: ReactionEmoji): boolean {
		const wanted = this.config.starEmoji;
		if (wanted.includes(':')) {
			const [name, id] = wanted.split(':');
			return emoji.id === id && emoji.name === name;
		}
		return emoji.id === undefined && emoji.name === wanted;
	}

	onReactionAdd(data: MessageReactionAddData): void {
		if (data.guild_id === undefined) return; // DMs have no starboard
		if (this.botUserId !== null && data.user_id === this.botUserId) return;
		if (!this.isStarEmoji(data.emoji)) return;

		// Coalesce near-simultaneous stars on the same message so the fetched
		// reaction count sees all of them before the threshold check.
		const existing = this.pending.get(data.message_id);
		if (existing !== undefined) return;

		const guildId = data.guild_id;
		const channelId = data.channel_id;
		const timer = setTimeout(() => {
			this.pending.delete(data.message_id);
			void this.checkMessage(guildId, channelId, data.message_id);
		}, DEBOUNCE_MS);
		timer.unref?.();
		this.pending.set(data.message_id, {guildId, channelId, timer});
	}

	private async checkMessage(
		guildId: Snowflake,
		channelId: Snowflake,
		messageId: Snowflake,
	): Promise<void> {
		try {
			if (this.store.has(messageId)) {
				logger.debug(`Message ${messageId} is already on the starboard`);
				return;
			}

			const starboardChannel = await this.resolveStarboardChannel(guildId);
			if (starboardChannel === null) {
				this.logNotFound(guildId);
				return;
			}
			if (channelId === starboardChannel.id) return; // never star the starboard itself

			let message: Message;
			try {
				message = await this.api.getChannelMessage(channelId, messageId);
			} catch (error) {
				const status = (error as {status?: number}).status;
				if (status === 404) {
					logger.debug(`Message ${messageId} is gone; ignoring`);
				} else {
					logger.warn(`Failed to fetch message ${messageId}: ${(error as Error).message}`);
				}
				return;
			}

			const stars = this.countStars(message);
			if (stars < this.config.threshold) {
				logger.debug(
					`Message ${messageId} has ${stars}/${this.config.threshold} stars; not yet`,
				);
				return;
			}

			const channelName = await this.channelName(guildId, channelId);
			const posted = await this.api.createMessage(
				starboardChannel.id,
				this.buildBody(message, guildId, channelName, stars),
			);

			this.store.set(messageId, {
				starboardMessageId: posted.id,
				guildId,
				recordedAt: new Date().toISOString(),
			});
			logger.info(
				`Starred message ${messageId} from #${channelName} (${stars} stars) -> starboard post ${posted.id}`,
			);
		} catch (error) {
			logger.error(`Failed to process message ${messageId}`, error);
		}
	}

	private countStars(message: Message): number {
		for (const reaction of message.reactions ?? []) {
			if (this.isStarEmoji(reaction.emoji)) return reaction.count;
		}
		return 0;
	}

	private logNotFound(guildId: Snowflake): void {
		const now = Date.now();
		const last = this.notFoundLoggedAt.get(guildId) ?? 0;
		if (now - last < NOT_FOUND_LOG_INTERVAL_MS) return;
		this.notFoundLoggedAt.set(guildId, now);
		logger.warn(
			`No starboard channel found in guild ${guildId} (looked for "${this.config.starboardChannel}"); ` +
				'stars in this guild are ignored until one exists',
		);
	}

	// -- Post building --------------------------------------------------------

	private jumpLink(guildId: Snowflake, message: Message): string {
		return `${this.config.webAppBaseUrl}/channels/${guildId}/${message.channel_id}/${message.id}`;
	}

	private avatarUrl(author: Message['author']): string | undefined {
		if (author.avatar) {
			const hash = author.avatar.startsWith('a_') ? author.avatar.slice(2) : author.avatar;
			const base = this.media.mediaBase ?? `${this.config.webAppBaseUrl}/media`;
			return `${base}/avatars/${author.id}/${hash}.webp`;
		}
		// Default avatar assets live on the static CDN, indexed by user ID % 6.
		const base = this.media.staticCdnBase ?? this.config.webAppBaseUrl;
		const index = Number(BigInt(author.id) % 6n);
		return `${base}/avatars/${index}.png`;
	}

	private buildBody(
		message: Message,
		guildId: Snowflake,
		channelName: string,
		stars: number,
	): {content: string; embeds: EmbedInput[]; allowed_mentions: {parse: string[]}} {
		const link = this.jumpLink(guildId, message);
		const emoji = this.config.starEmoji.includes(':')
			? `<:${this.config.starEmoji}>`
			: this.config.starEmoji;
		const content = `${emoji} ${stars} | #${channelName}\n[Jump to message](${link})`;

		const embed: EmbedInput = {
			url: link,
			timestamp: message.timestamp,
			color: 0xff_ac_33,
			author: {
				name: message.author.global_name ?? message.author.username,
				icon_url: this.avatarUrl(message.author),
			},
			description: this.buildDescription(message),
			footer: {text: `Message ID ${message.id}`},
		};

		const image = (message.attachments ?? []).find(
			(attachment) =>
				attachment.url !== null &&
				attachment.url !== undefined &&
				attachment.content_type.startsWith('image/'),
		);
		if (image?.url) embed.image = {url: image.url};

		return {content, embeds: [embed], allowed_mentions: {parse: []}};
	}

	private buildDescription(message: Message): string {
		const parts: string[] = [];
		const content = message.content.trim();
		parts.push(content === '' ? '*[no text]*' : content);

		const nonImageAttachments = (message.attachments ?? []).filter(
			(attachment) => !attachment.content_type.startsWith('image/'),
		);
		for (const attachment of nonImageAttachments.slice(0, 5)) {
			if (attachment.url) parts.push(`- [${attachment.filename}](${attachment.url})`);
		}

		let description = parts.join('\n');
		if (description.length > 4_096) {
			description = `${description.slice(0, 4_090)}\n[…]`;
		}
		return description;
	}
}
