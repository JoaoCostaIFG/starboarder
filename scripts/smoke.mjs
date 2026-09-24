// Smoke test: runs the built bot against a mock Fluxer instance and asserts
// the full chain: discovery -> gateway IDENTIFY -> reaction -> threshold -> post.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {WebSocketServer} from 'ws';

const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (name, condition, extra) => {
	if (condition) {
		console.log(`  ok: ${name}`);
	} else {
		failures++;
		console.error(`  FAIL: ${name}`, extra ?? '');
	}
};

const state = {
	postedBodies: [],
	messageFetches: 0,
	botMessageFetches: 0,
};

const server = createServer((req, res) => {
	const send = (status, body) => {
		res.writeHead(status, {'Content-Type': 'application/json'});
		res.end(JSON.stringify(body));
	};

	if (req.url === '/.well-known/fluxer') {
		return send(200, {
			endpoints: {
				api_public: BASE,
				gateway: `ws://127.0.0.1:${PORT}/gateway`,
				media: `${BASE}/media`,
				static_cdn: BASE,
			},
		});
	}

	const auth = req.headers.authorization ?? '';
	if (!auth.startsWith('Bot ')) {
		return send(401, {code: 'INVALID_AUTH_TOKEN', message: 'no bot prefix'});
	}

	if (req.method === 'GET' && /^\/v1\/guilds\/100\/channels$/.test(req.url)) {
		return send(200, [
			{id: '200', type: 0, guild_id: '100', name: 'Starboard'},
			{id: '300', type: 0, guild_id: '100', name: 'general'},
		]);
	}

	if (req.method === 'GET' && req.url === '/v1/channels/300/messages/555') {
		state.messageFetches++;
		return send(200, {
			id: '555',
			channel_id: '300',
			author: {id: '42', username: 'aria', discriminator: '0042', global_name: 'Aria', avatar: 'abc123'},
			type: 0,
			content: 'you guys will not believe what the gateway said',
			timestamp: '2026-09-24T10:00:00.000Z',
			reactions: [{emoji: {name: '⭐'}, count: 2}],
			attachments: [
				{id: 'a1', filename: 'meme.png', content_type: 'image/png', size: 1, url: `${BASE}/media/meme.png`},
				{id: 'a2', filename: 'notes.txt', content_type: 'text/plain', size: 2, url: `${BASE}/media/notes.txt`},
			],
		});
	}

	if (req.method === 'GET' && req.url === '/v1/channels/300/messages/888') {
		// below-threshold message (1 star, threshold is 2)
		return send(200, {
			id: '888',
			channel_id: '300',
			author: {id: '42', username: 'aria', discriminator: '0042'},
			type: 0,
			content: 'not funny yet',
			timestamp: '2026-09-24T10:05:00.000Z',
			reactions: [{emoji: {name: '⭐'}, count: 1}],
			attachments: [],
		});
	}

	if (req.method === 'POST' && req.url === '/v1/channels/200/messages') {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			state.postedBodies.push(JSON.parse(raw));
			send(200, {id: `post${state.postedBodies.length}`, channel_id: '200', content: ''});
		});
		return;
	}

	send(404, {code: 'UNKNOWN_ROUTE', message: req.url});
});

const wss = new WebSocketServer({server, path: '/gateway'});
let identifyPayload = null;
let resumePayload = null;
let connections = 0;
let heartbeatAfterResume = false;

wss.on('connection', (ws) => {
	connections++;
	ws.send(JSON.stringify({op: 10, d: {heartbeat_interval: 2000}}));

	ws.on('message', (raw) => {
		const payload = JSON.parse(raw.toString());
		if (payload.op === 2) {
			identifyPayload = payload.d;
			ws.send(JSON.stringify({op: 0, t: 'READY', s: 1, d: {
				session_id: 'sess-1',
				user: {id: '9999', username: 'starboarder', discriminator: '0001', flags: 0},
				guilds: [{id: '100', unavailable: true}],
			}}));
			ws.send(JSON.stringify({op: 0, t: 'GUILD_CREATE', s: 2, d: {
				id: '100',
				channels: [
					{id: '200', type: 0, guild_id: '100', name: 'Starboard'},
					{id: '300', type: 0, guild_id: '100', name: 'general'},
				],
			}}));

			setTimeout(() => {
				// Below threshold (1 star).
				ws.send(JSON.stringify({op: 0, t: 'MESSAGE_REACTION_ADD', s: 3, d: {
					user_id: '7', channel_id: '300', message_id: '888', emoji: {name: '⭐'}, guild_id: '100',
				}}));
				// Crosses threshold (2 stars).
				ws.send(JSON.stringify({op: 0, t: 'MESSAGE_REACTION_ADD', s: 4, d: {
					user_id: '7', channel_id: '300', message_id: '555', emoji: {name: '⭐'}, guild_id: '100',
				}}));
				ws.send(JSON.stringify({op: 0, t: 'MESSAGE_REACTION_ADD', s: 5, d: {
					user_id: '8', channel_id: '300', message_id: '555', emoji: {name: '⭐'}, guild_id: '100',
				}}));
				// Bot's own reaction: must be ignored.
				ws.send(JSON.stringify({op: 0, t: 'MESSAGE_REACTION_ADD', s: 6, d: {
					user_id: '9999', channel_id: '300', message_id: '777', emoji: {name: '⭐'}, guild_id: '100',
				}}));
				// Wrong emoji: must be ignored.
				ws.send(JSON.stringify({op: 0, t: 'MESSAGE_REACTION_ADD', s: 7, d: {
					user_id: '7', channel_id: '300', message_id: '666', emoji: {name: '🔥'}, guild_id: '100',
				}}));
				// Star inside the starboard channel itself: must be ignored.
				ws.send(JSON.stringify({op: 0, t: 'MESSAGE_REACTION_ADD', s: 8, d: {
					user_id: '7', channel_id: '200', message_id: '556', emoji: {name: '⭐'}, guild_id: '100',
				}}));
			}, 300);
		}
		if (payload.op === 1) ws.send(JSON.stringify({op: 11}));
		if (payload.op === 6) {
			resumePayload = payload.d;
			heartbeatAfterResume = false;
			ws.send(JSON.stringify({op: 0, t: 'RESUMED', s: 8}));
		}
		if (payload.op === 1 && resumePayload !== null) heartbeatAfterResume = true;
	});
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`mock instance on ${BASE}`);
	const child = spawn('node', ['dist/index.js'], {
		cwd: new URL('..', import.meta.url).pathname,
		env: {
			...process.env,
			INSTANCE_URL: BASE,
			BOT_TOKEN: '1234567890.secretsecret',
			STARBOARD_CHANNEL_NAME: 'starboard', // case-insensitive vs 'Starboard'
			STAR_EMOJI: '⭐',
			THRESHOLD: '2',
			DATA_DIR: '/tmp/starboarder-smoke-data',
			LOG_LEVEL: 'debug',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	child.stdout.on('data', (d) => process.stdout.write(`[bot] ${d}`));
	child.stderr.on('data', (d) => process.stderr.write(`[bot] ${d}`));

	setTimeout(async () => {
		console.log('\n--- assertions ---');
		check('identified with raw token + properties + ignored_events',
			identifyPayload?.token === '1234567890.secretsecret' &&
			identifyPayload?.properties?.browser === 'starboarder' &&
			Array.isArray(identifyPayload?.ignored_events) &&
			identifyPayload.ignored_events.includes('TYPING_START') &&
			!identifyPayload.ignored_events.includes('MESSAGE_REACTION_ADD'),
			identifyPayload);

		check('exactly one starboard post', state.postedBodies.length === 1, state.postedBodies.length);
		const post = state.postedBodies[0];
		if (post) {
			check('content line + jump link',
				post.content === '⭐ 2 | #general\n[Jump to message](' + BASE + '/channels/100/300/555)',
				post.content);
			const embed = post.embeds?.[0];
			check('embed author name from global_name', embed?.author?.name === 'Aria', embed?.author);
			check('embed avatar uses discovered media endpoint',
				embed?.author?.icon_url === `${BASE}/media/avatars/42/abc123.webp`, embed?.author);
			check('embed description has content + non-image attachment link',
				embed?.description === 'you guys will not believe what the gateway said\n- [notes.txt](' + BASE + '/media/notes.txt)',
				embed?.description);
			check('embed image is the image attachment',
				embed?.image?.url === `${BASE}/media/meme.png`, embed?.image);
			check('embed url + timestamp + footer',
				embed?.url === `${BASE}/channels/100/300/555` &&
				embed?.timestamp === '2026-09-24T10:00:00.000Z' &&
				embed?.footer?.text === 'Message ID 555', embed);
			check('mentions suppressed', JSON.stringify(post.allowed_mentions) === '{"parse":[]}', post.allowed_mentions);
		}
		check('message below threshold not fetched/posted', state.messageFetches === 1, state.messageFetches);

		// -- Phase 2: forced disconnect -> reconnect -> RESUME -----------------
		console.log('\n--- resume test: dropping connection ---');
		for (const client of wss.clients) client.close(4000, 'Session drain requested; reconnect to continue');
		await new Promise((r) => setTimeout(r, 3500));

		check('reconnected once after the drop', connections === 2, connections);
		check('sent RESUME with the retained session and last sequence',
			resumePayload?.token === '1234567890.secretsecret' &&
			resumePayload?.session_id === 'sess-1' &&
			typeof resumePayload?.seq === 'number' && resumePayload.seq >= 8,
			resumePayload);
		check('heartbeats continue after resume', heartbeatAfterResume);

		const {readFile} = await import('node:fs/promises');
		const store = JSON.parse(await readFile('/tmp/starboarder-smoke-data/starred.json', 'utf8'));
		check('store recorded the starboard mapping',
			store.starred?.['555']?.starboardMessageId === 'post1' && store.starred?.['555']?.guildId === '100',
			JSON.stringify(store));

		child.kill('SIGTERM');
		await new Promise((r) => setTimeout(r, 500));
		wss.close();
		server.close();
		console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
		process.exit(failures === 0 ? 0 : 1);
	}, 3500);
});
