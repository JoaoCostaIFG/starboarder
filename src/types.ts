/** Fluxer snowflakes are decimal strings. */
export type Snowflake = string;

/** Minimal shape of the partial user object embedded in messages. */
export interface PartialUser {
	id: Snowflake;
	username: string;
	discriminator: string;
	global_name?: string | null;
	avatar?: string | null;
	bot?: boolean;
}

export const GUILD_TEXT = 0;
export const GUILD_VOICE = 2;

/** Minimal channel object. */
export interface Channel {
	id: Snowflake;
	type: number;
	guild_id?: Snowflake;
	name?: string;
}

export interface ReactionEmoji {
	name: string;
	id?: Snowflake;
	animated?: boolean;
}

export interface Reaction {
	emoji: ReactionEmoji;
	count: number;
	me?: boolean;
}

export interface MessageAttachment {
	id: Snowflake;
	filename: string;
	content_type: string;
	size: number;
	url?: string | null;
	proxy_url?: string | null;
	width?: number;
	height?: number;
}

/** Minimal message object. */
export interface Message {
	id: Snowflake;
	channel_id: Snowflake;
	author: PartialUser;
	type: number;
	content: string;
	timestamp: string;
	reactions?: Reaction[];
	attachments: MessageAttachment[];
}

/** Rich embed input for Create message. */
export interface EmbedInput {
	url?: string;
	title?: string;
	color?: number;
	timestamp?: string;
	description?: string;
	author?: {name: string; url?: string; icon_url?: string};
	image?: {url: string; description?: string};
	thumbnail?: {url: string; description?: string};
	footer?: {text: string; icon_url?: string};
	fields?: {name: string; value: string; inline?: boolean}[];
}

export interface CreateMessageBody {
	content?: string;
	embeds?: EmbedInput[];
	allowed_mentions?: {parse?: string[]; users?: string[]; roles?: string[]};
}

// ---------------------------------------------------------------------------
// Gateway wire types

export interface GatewayPayload {
	op: number;
	d?: unknown;
	s?: number;
	t?: string;
}

export interface HelloData {
	heartbeat_interval: number;
}

export interface IdentifyData {
	token: string;
	properties: {os: string; browser: string; device: string};
	ignored_events?: string[];
}

export interface ResumeData {
	token: string;
	session_id: string;
	seq: number;
}

export interface ReadyData {
	session_id: string;
	user: PartialUser & {flags: number};
	guilds: {id: Snowflake; unavailable: boolean}[];
}

export interface GuildReadyData {
	id: Snowflake;
	channels?: Channel[];
	unavailable?: boolean;
}

export interface MessageReactionAddData {
	user_id: Snowflake;
	channel_id: Snowflake;
	message_id: Snowflake;
	emoji: ReactionEmoji;
	guild_id?: Snowflake;
}
