import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {logger} from './log.js';
import type {Snowflake} from './types.js';

export interface StarredEntry {
	/** The starboard post that was created for the source message. */
	starboardMessageId: Snowflake;
	/** Guild the source message belongs to. */
	guildId: Snowflake;
	/** When the entry was recorded (ISO 8601). */
	recordedAt: string;
}

interface StoreFile {
	starred: Record<Snowflake, StarredEntry>;
}

/**
 * Persistent map of source message ID -> starboard entry.
 *
 * Survives restarts so the bot never posts the same message twice. Backed by a
 * JSON file with atomic replace-on-write and debounced flushes.
 */
export class StarredStore {
	private readonly entries = new Map<Snowflake, StarredEntry>();
	private flushTimer: NodeJS.Timeout | undefined;
	private writing = Promise.resolve();

	constructor(private readonly filePath: string) {}

	async load(): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(this.filePath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				logger.info(`Store file ${this.filePath} does not exist yet; starting empty`);
				return;
			}
			throw error;
		}
		try {
			const parsed = JSON.parse(raw) as StoreFile;
			for (const [id, entry] of Object.entries(parsed.starred ?? {})) {
				this.entries.set(id, entry);
			}
			logger.info(`Loaded ${this.entries.size} starred entries from ${this.filePath}`);
		} catch (error) {
			throw new Error(`Store file ${this.filePath} is corrupt: ${(error as Error).message}`);
		}
	}

	has(messageId: Snowflake): boolean {
		return this.entries.has(messageId);
	}

	get(messageId: Snowflake): StarredEntry | undefined {
		return this.entries.get(messageId);
	}

	set(messageId: Snowflake, entry: StarredEntry): void {
		this.entries.set(messageId, entry);
		this.scheduleFlush();
	}

	/** Flush pending writes immediately (used on shutdown). */
	async flush(): Promise<void> {
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		await this.writing;
		await this.write();
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== undefined) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.writing = this.writing.then(() => this.write()).catch((error: unknown) => {
				logger.error('Failed to persist store', error);
			});
		}, 500);
		this.flushTimer.unref?.();
	}

	private async write(): Promise<void> {
		const file: StoreFile = {starred: Object.fromEntries(this.entries)};
		const tmpPath = `${this.filePath}.tmp`;
		try {
			await mkdir(dirname(this.filePath), {recursive: true});
			await writeFile(tmpPath, JSON.stringify(file, null, '\t'), 'utf8');
			await rename(tmpPath, this.filePath);
		} catch (error) {
			logger.error(`Failed to write store file ${this.filePath}`, error);
		}
	}
}
