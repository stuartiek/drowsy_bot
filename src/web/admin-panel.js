const { ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const crypto = require('crypto');

function createAdminPanel({ client, config, state, communityFeature }) {
    const sessions = new Map();
    let syncInProgress = false;

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatDuration(milliseconds) {
        if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0m';

        const totalMinutes = Math.floor(milliseconds / 60000);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    }

    function formatDateTime(value) {
        const timestamp = Date.parse(value ?? '');
        if (!Number.isFinite(timestamp)) return 'Unknown';

        return new Intl.DateTimeFormat('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        }).format(new Date(timestamp));
    }

    function parseCookies(cookieHeader) {
        const cookies = {};
        for (const segment of String(cookieHeader ?? '').split(';')) {
            const separatorIndex = segment.indexOf('=');
            if (separatorIndex < 0) continue;

            const name = segment.slice(0, separatorIndex).trim();
            const value = segment.slice(separatorIndex + 1).trim();
            if (!name) continue;
            cookies[name] = decodeURIComponent(value);
        }

        return cookies;
    }

    function createSession() {
        const token = crypto.randomBytes(24).toString('hex');
        const expiresAt = Date.now() + (config.ADMIN_PANEL_SESSION_HOURS * 60 * 60 * 1000);
        sessions.set(token, { expiresAt });
        return { token, expiresAt };
    }

    function getSession(request) {
        const cookies = parseCookies(request.headers.cookie);
        const token = cookies.drowsy_admin_session;
        if (!token) return null;

        const session = sessions.get(token);
        if (!session) return null;
        if (session.expiresAt <= Date.now()) {
            sessions.delete(token);
            return null;
        }

        return { token, ...session };
    }

    function destroySession(request) {
        const cookies = parseCookies(request.headers.cookie);
        const token = cookies.drowsy_admin_session;
        if (token) sessions.delete(token);
    }

    function sendHtml(response, statusCode, html, headers = {}) {
        response.writeHead(statusCode, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            ...headers,
        });
        response.end(html);
    }

    function sendJson(response, statusCode, payload, headers = {}) {
        response.writeHead(statusCode, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...headers,
        });
        response.end(JSON.stringify(payload));
    }

    function redirect(response, location, headers = {}) {
        response.writeHead(302, {
            Location: location,
            'Cache-Control': 'no-store',
            ...headers,
        });
        response.end();
    }

    function readRequestBody(request) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let totalLength = 0;

            request.on('data', chunk => {
                chunks.push(chunk);
                totalLength += chunk.length;
                if (totalLength > 10 * 1024 * 1024) {
                    reject(new Error('Request body too large'));
                    request.destroy();
                }
            });

            request.on('end', () => resolve(Buffer.concat(chunks)));
            request.on('error', reject);
        });
    }

    function parseFormBody(body) {
        return Object.fromEntries(new URLSearchParams(Buffer.isBuffer(body) ? body.toString('utf8') : String(body)).entries());
    }

    function isLoopbackRequest(request) {
        const address = request.socket?.remoteAddress;
        return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    }

    function isAuthorizedApiRequest(request) {
        if (!config.BOT_API_TOKEN) return false;

        const supplied = String(request.headers['x-bot-api-key'] ?? '')
            || String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!supplied) return false;

        const expected = Buffer.from(config.BOT_API_TOKEN, 'utf8');
        const actual = Buffer.from(supplied, 'utf8');
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    }

    function getBotStatus() {
        return {
            online: client.isReady(),
            botUser: client.user?.tag ?? null,
            guildCount: client.guilds.cache.size,
            uptimeSeconds: Math.floor(process.uptime()),
            lastReadyAt: client.readyAt?.toISOString() ?? null,
            latencyMs: Number.isFinite(client.ws?.ping) && client.ws.ping >= 0 ? client.ws.ping : null,
        };
    }

    function parseMultipartForm(request, bodyBuffer) {
        const contentType = String(request.headers['content-type'] ?? '');
        const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
        if (!match) {
            throw new Error('missing-boundary');
        }

        const boundary = Buffer.from(`--${match[1] ?? match[2]}`);
        const fields = {};
        const files = {};
        let cursor = 0;

        while (cursor < bodyBuffer.length) {
            const boundaryIndex = bodyBuffer.indexOf(boundary, cursor);
            if (boundaryIndex < 0) break;

            let partStart = boundaryIndex + boundary.length;
            if (bodyBuffer[partStart] === 45 && bodyBuffer[partStart + 1] === 45) break;
            if (bodyBuffer[partStart] === 13 && bodyBuffer[partStart + 1] === 10) {
                partStart += 2;
            }

            const headerEnd = bodyBuffer.indexOf(Buffer.from('\r\n\r\n'), partStart);
            if (headerEnd < 0) break;

            const headerText = bodyBuffer.slice(partStart, headerEnd).toString('utf8');
            const dataStart = headerEnd + 4;
            const nextBoundaryIndex = bodyBuffer.indexOf(boundary, dataStart);
            if (nextBoundaryIndex < 0) break;

            let dataEnd = nextBoundaryIndex - 2;
            if (dataEnd < dataStart) dataEnd = dataStart;
            const data = bodyBuffer.slice(dataStart, dataEnd);

            const nameMatch = /name="([^"]+)"/i.exec(headerText);
            if (!nameMatch) {
                cursor = nextBoundaryIndex;
                continue;
            }

            const fieldName = nameMatch[1];
            const fileNameMatch = /filename="([^"]*)"/i.exec(headerText);
            const contentTypeMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText);

            if (fileNameMatch && fileNameMatch[1]) {
                files[fieldName] = {
                    fileName: fileNameMatch[1],
                    contentType: contentTypeMatch?.[1]?.trim() ?? 'application/octet-stream',
                    buffer: data,
                };
            } else {
                fields[fieldName] = data.toString('utf8');
            }

            cursor = nextBoundaryIndex;
        }

        return { fields, files };
    }

    async function buildPanelState() {
        const guilds = [];

        for (const guild of client.guilds.cache.values()) {
            const channels = [...guild.channels.cache.values()];
            guilds.push({
                id: guild.id,
                name: guild.name,
                textChannels: channels
                    .filter(channel => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
                    .sort((left, right) => left.rawPosition - right.rawPosition)
                    .map(channel => ({ id: channel.id, name: channel.name })),
                stageChannels: channels
                    .filter(channel => channel.type === ChannelType.GuildStageVoice)
                    .sort((left, right) => left.rawPosition - right.rawPosition)
                    .map(channel => ({ id: channel.id, name: channel.name })),
                announcementColor: state.getGuildConfig(guild.id).announcementColor ?? null,
            });
        }

        const trackedStages = await Promise.all([...state.guildStageSessions.entries()].map(async ([guildId, session]) => {
            const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
            const stageChannel = session.targetVC && guild
                ? guild.channels.cache.get(session.targetVC) ?? await guild.channels.fetch(session.targetVC).catch(() => null)
                : null;
            const textChannels = guild
                ? [...guild.channels.cache.values()]
                    .filter(channel => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
                    .sort((left, right) => left.rawPosition - right.rawPosition)
                    .map(channel => ({ id: channel.id, name: channel.name }))
                : [];

            const queueMembers = await Promise.all((session.queue || []).map(async (userId) => {
                const member = guild ? (guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null)) : null;
                return {
                    id: userId,
                    name: member?.displayName ?? member?.user?.username ?? userId,
                    avatarUrl: member?.displayAvatarURL({ extension: 'png', size: 128 }) ?? null
                };
            }));

            let speakerMember = null;
            if (session.currentSpeaker && guild) {
                const member = guild.members.cache.get(session.currentSpeaker) ?? await guild.members.fetch(session.currentSpeaker).catch(() => null);
                speakerMember = {
                    id: session.currentSpeaker,
                    name: member?.displayName ?? member?.user?.username ?? session.currentSpeaker,
                    avatarUrl: member?.displayAvatarURL({ extension: 'png', size: 128 }) ?? null
                };
            }

            return {
                guildId,
                guildName: guild?.name ?? guildId,
                channelId: session.targetVC,
                channelName: stageChannel?.name ?? 'Unknown stage',
                startedAt: session.startedAt,
                runtimeText: session.startedAt ? formatDuration(Date.now() - Date.parse(session.startedAt)) : 'Unknown',
                performers: session.performerIds.size,
                songsSung: session.songsSung,
                peakAttendance: session.peakAttendance,
                audience: session.attendeeIds.size,
                currentSpeaker: session.currentSpeaker,
                currentSpeakerMember: speakerMember,
                acceptingJoins: session.acceptingJoins !== false,
                queue: session.queue || [],
                queueMembers,
                textChannels,
            };
        }));

        return {
            botReady: client.isReady(),
            botUser: client.user?.tag ?? 'Offline',
            guildCount: client.guilds.cache.size,
            guilds: guilds.sort((left, right) => left.name.localeCompare(right.name)),
            trackedStages,
            allowedInviteUsers: [...state.allowedInviteUsers].sort(),
            botSettings: state.getBotSettings(),
        };
    }

    function buildGuildOptions(guilds, selectedGuildId = '') {
        return guilds.map(guild => `<option value="${escapeHtml(guild.id)}"${guild.id === selectedGuildId ? ' selected' : ''}>${escapeHtml(guild.name)}</option>`).join('');
    }

    function buildChannelOptions(channels, selectedId = '') {
        return channels.map(channel => `<option value="${escapeHtml(channel.id)}"${channel.id === selectedId ? ' selected' : ''}>#${escapeHtml(channel.name)}</option>`).join('');
    }

    function normalizeMessageFetchLimit(value) {
        const parsed = Number.parseInt(String(value ?? ''), 10);
        if (!Number.isInteger(parsed)) return 25;
        return Math.max(1, Math.min(100, parsed));
    }

    async function readChannelMessagesPreview(guildId, channelId, limitValue) {
        if (!guildId || !channelId) {
            return {
                status: 'error',
                guildId: guildId ?? '',
                channelId: channelId ?? '',
                limit: normalizeMessageFetchLimit(limitValue),
                error: 'Select both a guild and a channel.',
                messages: [],
            };
        }

        const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) {
            return {
                status: 'error',
                guildId,
                channelId,
                limit: normalizeMessageFetchLimit(limitValue),
                error: 'That guild is not available to the bot.',
                messages: [],
            };
        }

        const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
            return {
                status: 'error',
                guildId,
                channelId,
                limit: normalizeMessageFetchLimit(limitValue),
                error: 'Choose a text or announcement channel.',
                messages: [],
            };
        }

        const limit = normalizeMessageFetchLimit(limitValue);
        const fetched = await channel.messages.fetch({ limit }).catch(() => null);
        if (!fetched) {
            return {
                status: 'error',
                guildId,
                guildName: guild.name,
                channelId,
                channelName: channel.name,
                limit,
                error: 'I could not read messages from that channel. Check bot permissions.',
                messages: [],
            };
        }

        const messages = [...fetched.values()]
            .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
            .map(message => {
                const content = String(message.content ?? '').trim();
                const attachmentCount = message.attachments?.size ?? 0;
                const embedCount = Array.isArray(message.embeds) ? message.embeds.length : 0;
                const details = [];

                if (attachmentCount > 0) details.push(`${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`);
                if (embedCount > 0) details.push(`${embedCount} embed${embedCount === 1 ? '' : 's'}`);

                return {
                    id: message.id,
                    author: message.author?.tag ?? message.author?.username ?? message.author?.id ?? 'Unknown user',
                    createdAt: new Date(message.createdTimestamp).toISOString(),
                    content: content || (details.length > 0 ? `[${details.join(', ')}]` : '[No text content]'),
                };
            });

        return {
            status: 'ok',
            guildId,
            guildName: guild.name,
            channelId,
            channelName: channel.name,
            limit,
            messages,
        };
    }

    function buildLoginHtml(errorMessage = '') {
        const safeError = errorMessage ? `<p class="notice notice--error">${escapeHtml(errorMessage)}</p>` : '';
        const passwordConfigured = Boolean(config.ADMIN_PANEL_PASSWORD);
        const disabledNotice = passwordConfigured
            ? ''
            : '<p class="notice notice--error">Set ADMIN_PANEL_PASSWORD in your environment before using the admin panel.</p>';

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DrowsyBot Admin</title>
<style>
:root{color-scheme:light;--sand:#f7efdf;--paper:#fffaf2;--ink:#24150b;--rust:#9e4d1c;--line:rgba(86,50,30,.15);--shadow:rgba(54,28,12,.16)}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top left,rgba(221,176,109,.28),transparent 28%),linear-gradient(135deg,#f2e6cf,#f8f2e8 45%,#efe4d0 100%);color:var(--ink);font-family:Georgia,"Times New Roman",serif}.card{width:min(440px,100%);padding:30px;border:1px solid var(--line);border-radius:24px;background:rgba(255,250,242,.94);box-shadow:0 24px 60px var(--shadow)}h1{margin:0 0 10px;font-size:34px}p{margin:0 0 16px;line-height:1.55}label{display:block;margin-bottom:8px;font-size:14px;letter-spacing:.08em;text-transform:uppercase}input{width:100%;padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:#fff;font:inherit}button{width:100%;margin-top:16px;padding:14px 16px;border:0;border-radius:999px;background:linear-gradient(135deg,var(--rust),#c36a30);color:#fff8ef;font:inherit;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}.notice{margin:0 0 16px;padding:12px 14px;border-radius:14px}.notice--error{background:rgba(176,42,42,.1);color:#7a1f1f}
</style>
</head>
<body>
<main class="card">
<h1>DrowsyBot Admin</h1>
<p>Sign in to manage stage tracking, announcements, and invite exceptions.</p>
${disabledNotice}
${safeError}
<form method="post" action="/admin/login">
<label for="password">Admin Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required ${passwordConfigured ? '' : 'disabled'}>
<button type="submit" ${passwordConfigured ? '' : 'disabled'}>Sign In</button>
</form>
</main>
</body>
</html>`;
    }

    function buildPanelHtml(panelState, flashMessage = '', channelViewer = null) {
        const trackedStageMarkup = panelState.trackedStages.length > 0
            ? panelState.trackedStages.map(stage => `
                <article class="list-card">
                    <div class="list-card__row">
                        <div>
                            <h3>${escapeHtml(stage.guildName)}</h3>
                            <p><strong>Stage:</strong> ${escapeHtml(stage.channelName)}</p>
                            <p><strong>Started:</strong> ${escapeHtml(formatDateTime(stage.startedAt))}</p>
                            <p><strong>Runtime:</strong> ${escapeHtml(stage.runtimeText)}</p>
                            <p><strong>Performers:</strong> ${stage.performers} | <strong>Songs:</strong> ${stage.songsSung} | <strong>Peak:</strong> ${stage.peakAttendance}</p>
                        </div>
                        <form method="post" action="/admin/stages/end">
                            <input type="hidden" name="guildId" value="${escapeHtml(stage.guildId)}">
                            <select name="textChannelId" required>${buildChannelOptions(stage.textChannels)}</select>
                            <button type="submit">End Tracking</button>
                        </form>
                    </div>
                </article>`).join('')
            : '<article class="list-card"><p>No stage events are being tracked right now.</p></article>';

        const stageControlMarkup = panelState.guilds.map(guild => `
            <article class="list-card">
                <h3>${escapeHtml(guild.name)}</h3>
                <form class="stack-form" method="post" action="/admin/stages/start">
                    <input type="hidden" name="guildId" value="${escapeHtml(guild.id)}">
                    <label>Stage Channel</label>
                    <select name="stageChannelId" required>${buildChannelOptions(guild.stageChannels)}</select>
                    <label>Response Channel</label>
                    <select name="textChannelId" required>${buildChannelOptions(guild.textChannels)}</select>
                    <button type="submit">Start Stage Tracking</button>
                </form>
            </article>`).join('');

        const inviteMarkup = panelState.allowedInviteUsers.length > 0
            ? panelState.allowedInviteUsers.map(userId => `
                <article class="list-card list-card__row">
                    <div>
                        <h3>${escapeHtml(userId)}</h3>
                        <p>Allowed to post Discord invite links.</p>
                    </div>
                    <form method="post" action="/admin/invites/remove">
                        <input type="hidden" name="userId" value="${escapeHtml(userId)}">
                        <button type="submit" class="button button--ghost">Remove</button>
                    </form>
                </article>`).join('')
            : '<article class="list-card"><p>No invite exceptions are saved.</p></article>';

        const announcementGuild = panelState.guilds[0] ?? null;
        const guildChannelMapJson = JSON.stringify(Object.fromEntries(
            panelState.guilds.map(guild => [guild.id, guild.textChannels])
        )).replace(/</g, '\\u003c');
        const viewerGuildId = channelViewer?.guildId && panelState.guilds.some(guild => guild.id === channelViewer.guildId)
            ? channelViewer.guildId
            : (panelState.guilds[0]?.id ?? '');
        const viewerGuild = panelState.guilds.find(guild => guild.id === viewerGuildId) ?? panelState.guilds[0] ?? null;
        const viewerChannelId = channelViewer?.channelId
            ?? viewerGuild?.textChannels[0]?.id
            ?? '';
        const viewerMessagesMarkup = channelViewer
            ? (channelViewer.messages?.length > 0
                ? channelViewer.messages.map(message => `<article class="list-card"><p><strong>${escapeHtml(message.author)}</strong> <span class="subtle">${escapeHtml(formatDateTime(message.createdAt))}</span></p><p>${escapeHtml(message.content)}</p></article>`).join('')
                : '<article class="list-card"><p>No messages were found for that channel in the selected range.</p></article>')
            : '';
        const viewerStatusMarkup = channelViewer?.error
            ? `<p class="notice notice--error">${escapeHtml(channelViewer.error)}</p>`
            : channelViewer
                ? `<p class="notice notice--success">Showing ${channelViewer.messages.length} message${channelViewer.messages.length === 1 ? '' : 's'} from #${escapeHtml(channelViewer.channelName ?? 'unknown-channel')} in ${escapeHtml(channelViewer.guildName ?? 'unknown guild')}.</p>`
                : '';
        const flashMarkup = flashMessage ? `<p class="notice notice--success">${escapeHtml(flashMessage)}</p>` : '';
        const messageViewerSection = `<section class="sections"><section class="section"><h2>Channel Messages</h2><p>Select a guild and text channel to read recent bot-visible messages.</p><form class="stack-form" method="post" action="/admin/messages/view"><label>Guild</label><select id="viewer-guild" name="guildId" required>${buildGuildOptions(panelState.guilds, viewerGuildId)}</select><label>Channel</label><select id="viewer-channel" name="channelId" required>${buildChannelOptions(viewerGuild?.textChannels ?? [], viewerChannelId)}</select><label>Message Limit</label><input name="limit" type="number" min="1" max="100" value="${escapeHtml(String(channelViewer?.limit ?? 25))}"><button type="submit">Load Messages</button></form>${viewerStatusMarkup}${viewerMessagesMarkup}</section><section class="section"><h2>Viewer Notes</h2><p>The panel reads message content using the bot account and only from channels it can access.</p><article class="list-card"><p>Use this to quickly check conversations and moderation context without opening Discord.</p></article></section></section>`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DrowsyBot Admin</title>
<style>
:root{color-scheme:light;--paper:#fcf7ef;--sand:#f0e2c7;--ink:#24150b;--muted:#71594a;--rust:#9f4b22;--teal:#1f6d64;--line:rgba(91,53,31,.14);--shadow:rgba(50,25,12,.12)}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top left,rgba(221,176,109,.22),transparent 24%),linear-gradient(135deg,#f6eddc,#fcf8f1 42%,#efe3cc 100%);color:var(--ink);font-family:Georgia,"Times New Roman",serif}.shell{width:min(1280px,calc(100vw - 32px));margin:20px auto 32px}.hero{display:flex;justify-content:space-between;align-items:end;gap:16px;margin-bottom:20px;padding:28px;border-radius:28px;background:linear-gradient(135deg,rgba(135,67,30,.95),rgba(48,91,83,.92));color:#fff8ef;box-shadow:0 24px 56px var(--shadow)}.hero h1{margin:0;font-size:clamp(34px,5vw,52px)}.hero p{margin:8px 0 0;color:rgba(255,248,239,.82)}button,.button{padding:12px 18px;border:0;border-radius:999px;background:linear-gradient(135deg,var(--rust),#c66d32);color:#fff8ef;font:inherit;cursor:pointer}.button--ghost{background:rgba(36,21,11,.08);color:var(--ink)}select,input,textarea{width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--line);font:inherit;background:#fff}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:18px}.stat{padding:20px;border-radius:22px;background:rgba(255,250,242,.96);border:1px solid var(--line);box-shadow:0 14px 36px var(--shadow)}.stat__label{margin:0 0 8px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;font-size:12px}.stat__value{margin:0;font-size:28px}.sections{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:18px}.section{padding:22px;border-radius:26px;background:rgba(255,251,246,.96);border:1px solid var(--line);box-shadow:0 18px 40px var(--shadow)}.section h2{margin:0 0 14px;font-size:26px}.section p{color:var(--muted)}.list-card{margin-top:12px;padding:16px 18px;border-radius:18px;background:var(--paper);border:1px solid var(--line)}.list-card h3{margin:0 0 8px;font-size:20px}.list-card p{margin:4px 0}.list-card__row{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.stack-form{display:grid;gap:10px}.inline-form{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:12px}.notice{margin:0 0 18px;padding:14px 16px;border-radius:16px}.notice--success{background:rgba(31,109,100,.12);color:#16534c}@media (max-width: 960px){.sections{grid-template-columns:1fr}.hero{flex-direction:column;align-items:start}.list-card__row{flex-direction:column}}
</style>
</head>
<body>
<main class="shell">
<section class="hero">
<div>
<h1>DrowsyBot Admin</h1>
<p>${escapeHtml(panelState.botReady ? `Connected as ${panelState.botUser}` : 'Bot not connected yet')}</p>
</div>
<form method="post" action="/admin/logout"><button type="submit">Sign Out</button></form>
</section>
${flashMarkup}
<section class="grid">
<article class="stat"><p class="stat__label">Guilds</p><p class="stat__value">${panelState.guildCount}</p></article>
<article class="stat"><p class="stat__label">Tracked Stages</p><p class="stat__value">${panelState.trackedStages.length}</p></article>
<article class="stat"><p class="stat__label">Invite Exceptions</p><p class="stat__value">${panelState.allowedInviteUsers.length}</p></article>
</section>
<section class="sections">
<section class="section"><h2>Tracked Stage Events</h2><p>Live stage sessions currently being recorded by the bot.</p>${trackedStageMarkup}</section>
<section class="section"><h2>Start Stage Tracking</h2><p>Choose a real stage channel and a text channel for status responses.</p>${stageControlMarkup}</section>
</section>
<section class="sections">
<section class="section"><h2>Send Announcement</h2><p>Post a bot announcement without using a slash command.</p><form class="stack-form" method="post" action="/admin/announcements/send"><label>Guild</label><select id="announcement-guild" name="guildId" required>${buildGuildOptions(panelState.guilds)}</select><label>Channel</label><select id="announcement-channel" name="channelId" required>${buildChannelOptions(announcementGuild?.textChannels ?? [])}</select><label>Title</label><input name="title" maxlength="256" placeholder="Optional title"><label>Color</label><input name="color" maxlength="7" placeholder="#5865F2"><label>Message</label><textarea name="message" rows="6" required placeholder="Type the announcement text here"></textarea><button type="submit">Send Announcement</button></form></section>
<section class="section"><h2>Invite Exceptions</h2><p>Allow or remove users who can post Discord invite links.</p><form class="stack-form" method="post" action="/admin/invites/add"><label>User ID</label><input name="userId" required placeholder="Discord user ID"><button type="submit">Allow Invite Posting</button></form>${inviteMarkup}</section>
</section>
<section class="sections">
<section class="section"><h2>Bot Actions</h2><p>Run moderation and housekeeping actions from the browser.</p><article class="list-card"><form class="stack-form" method="post" action="/admin/invites/purge"><label>Guild</label><select name="guildId" required>${buildGuildOptions(panelState.guilds)}</select><label>Messages Per Channel</label><input name="messagesPerChannel" type="number" min="1" max="1000" value="250"><button type="submit">Purge Unauthorized Invites</button></form></article><article class="list-card"><h3>Saved Guild Defaults</h3>${panelState.guilds.map(guild => `<p><strong>${escapeHtml(guild.name)}:</strong> ${escapeHtml(guild.announcementColor ?? 'Default')}</p>`).join('')}</article></section>
</section>
${messageViewerSection}
</main>
<script>
const announcementChannelMap = ${guildChannelMapJson};
const announcementGuildSelect = document.getElementById('announcement-guild');
const announcementChannelSelect = document.getElementById('announcement-channel');
const viewerGuildSelect = document.getElementById('viewer-guild');
const viewerChannelSelect = document.getElementById('viewer-channel');

function syncAnnouncementChannels() {
    const guildId = announcementGuildSelect.value;
    const channels = Array.isArray(announcementChannelMap[guildId]) ? announcementChannelMap[guildId] : [];
    announcementChannelSelect.innerHTML = channels
    .map(channel => '<option value="' + channel.id + '">#' + channel.name + '</option>')
        .join('');
}

announcementGuildSelect.addEventListener('change', syncAnnouncementChannels);

    function syncViewerChannels() {
        const guildId = viewerGuildSelect.value;
        const channels = Array.isArray(announcementChannelMap[guildId]) ? announcementChannelMap[guildId] : [];
        viewerChannelSelect.innerHTML = channels
        .map(channel => '<option value="' + channel.id + '">#' + channel.name + '</option>')
        .join('');
    }

    viewerGuildSelect.addEventListener('change', syncViewerChannels);
</script>
</body>
</html>`;
    }

    async function syncMember(form) {
        const { guildId, discordId, displayName, rank, house } = form;
        const guild = guildId ? client.guilds.cache.get(guildId) : (client.guilds.cache.get(config.GUILD_ID) ?? client.guilds.cache.first());
        if (!guild) return { error: 'Guild not found.' };

        const member = await guild.members.fetch(discordId).catch(() => null);
        if (!member) return { error: 'Discord member not found in guild.' };

        const results = { rankRoleAdded: null, houseRoleAdded: null, nicknameChanged: null, errors: [] };
        if (displayName && member.displayName !== displayName) {
            try {
                await member.setNickname(displayName);
                results.nicknameChanged = displayName;
            } catch (error) {
                results.errors.push(`Nickname update failed: ${error.message}`);
            }
        }

        if (rank) {
            const targetRankRole = guild.roles.cache.find(role => role.name.toLowerCase() === rank.toLowerCase());
            if (targetRankRole) {
                try {
                    const knownRanks = ['Mr. Sandman', 'Realm God', 'Drowsy Defender', 'Dreamy Defender', 'Dreamland Guard', 'Nighty Knights', 'Nighty Knight', 'Tired Esquire'];
                    const rolesToRemove = member.roles.cache.filter(role => knownRanks.some(name => name.toLowerCase() === role.name.toLowerCase()) && role.id !== targetRankRole.id);
                    if (rolesToRemove.size > 0) await member.roles.remove(rolesToRemove);
                    if (!member.roles.cache.has(targetRankRole.id)) {
                        await member.roles.add(targetRankRole);
                        results.rankRoleAdded = targetRankRole.name;
                    }
                } catch (error) {
                    results.errors.push(`Rank role update failed: ${error.message}`);
                }
            }
        }

        if (house) {
            const targetHouseRole = guild.roles.cache.find(role => role.name.toLowerCase() === house.toLowerCase());
            if (targetHouseRole) {
                try {
                    const knownHouses = ['Stubo United', 'Penguin Force', 'Drowsy Operators'];
                    const rolesToRemove = member.roles.cache.filter(role => knownHouses.some(name => name.toLowerCase() === role.name.toLowerCase()) && role.id !== targetHouseRole.id);
                    if (rolesToRemove.size > 0) await member.roles.remove(rolesToRemove);
                    if (!member.roles.cache.has(targetHouseRole.id)) {
                        await member.roles.add(targetHouseRole);
                        results.houseRoleAdded = targetHouseRole.name;
                    }
                } catch (error) {
                    results.errors.push(`House role update failed: ${error.message}`);
                }
            }
        }

        return { results };
    }

    async function renderPanel(response, flashMessage = '', statusCode = 200) {
        sendHtml(response, statusCode, buildPanelHtml(await buildPanelState(), flashMessage));
    }

    async function handleRequest(request, response, url) {
        if (url.pathname === '/status' && request.method === 'GET') {
            if (!isAuthorizedApiRequest(request)) {
                sendJson(response, 401, { error: 'Unauthorized.' });
                return true;
            }

            sendJson(response, 200, getBotStatus());
            return true;
        }

        if (url.pathname === '/actions/announcement' && request.method === 'POST') {
            if (!isAuthorizedApiRequest(request)) {
                sendJson(response, 401, { error: 'Unauthorized.' });
                return true;
            }

            const form = parseFormBody(await readRequestBody(request));
            const message = String(form.message ?? '').trim();
            if (!form.guildId || !form.channelId || !message || message.length > 4000) {
                sendJson(response, 400, { error: 'Guild, authorized channel, and a message up to 4000 characters are required.' });
                return true;
            }

            const result = await communityFeature.sendAnnouncementFromAdmin({
                guildId: form.guildId,
                channelId: form.channelId,
                message,
                title: String(form.title ?? '').trim().slice(0, 256),
                color: String(form.color ?? '').trim(),
            });
            sendJson(response, result.status === 'sent' ? 200 : 400, result.status === 'sent'
                ? { ok: true, result }
                : { error: result.error ?? 'Discord action failed.' });
            return true;
        }

        if (url.pathname === '/actions/sync' && request.method === 'POST') {
            if (!isAuthorizedApiRequest(request)) {
                sendJson(response, 401, { error: 'Unauthorized.' });
                return true;
            }
            if (!client.isReady()) {
                sendJson(response, 503, { error: 'Bot offline.' });
                return true;
            }
            if (syncInProgress) {
                sendJson(response, 409, { error: 'Action already running.' });
                return true;
            }

            syncInProgress = true;
            try {
                const form = parseFormBody(await readRequestBody(request));
                if (!/^\d{17,20}$/.test(String(form.discordId ?? ''))) {
                    sendJson(response, 400, { error: 'A valid Discord member ID is required.' });
                    return true;
                }
                const result = await syncMember(form);
                if (result.error) {
                    sendJson(response, 404, { error: result.error });
                    return true;
                }
                sendJson(response, 200, { ok: result.results.errors.length === 0, results: result.results });
            } finally {
                syncInProgress = false;
            }
            return true;
        }

        if (!url.pathname.startsWith('/admin/api/')) {
            return false;
        }

        const isInternalApiRequest = url.pathname.startsWith('/admin/api/') && isAuthorizedApiRequest(request);
        const isApiPath = url.pathname.startsWith('/admin/api/');
        if (isApiPath && !isInternalApiRequest) {
            sendJson(response, 401, { error: 'Valid bot API authorization is required.' });
            return true;
        }

        if (!config.ADMIN_PANEL_PASSWORD && !isInternalApiRequest) {
            sendHtml(response, 503, buildLoginHtml('The admin panel is disabled until ADMIN_PANEL_PASSWORD is configured.'));
            return true;
        }

        if (url.pathname === '/admin/login' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            if (form.password !== config.ADMIN_PANEL_PASSWORD) {
                sendHtml(response, 401, buildLoginHtml('Incorrect password.'));
                return true;
            }

            const session = createSession();
            redirect(response, '/admin', {
                'Set-Cookie': `drowsy_admin_session=${session.token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${config.ADMIN_PANEL_SESSION_HOURS * 60 * 60}`,
            });
            return true;
        }

        if (url.pathname === '/admin' && request.method === 'GET') {
            if (!getSession(request)) {
                sendHtml(response, 200, buildLoginHtml());
                return true;
            }

            await renderPanel(response);
            return true;
        }

        if (!url.pathname.startsWith('/admin/')) {
            return false;
        }

        if (!isInternalApiRequest && !getSession(request)) {
            redirect(response, '/admin');
            return true;
        }

        if (url.pathname === '/admin/logout' && request.method === 'POST') {
            destroySession(request);
            redirect(response, '/admin', {
                'Set-Cookie': 'drowsy_admin_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0',
            });
            return true;
        }

        if (url.pathname === '/admin/api/state' && request.method === 'GET') {
            sendJson(response, 200, await buildPanelState());
            return true;
        }

        if (url.pathname === '/admin/api/settings' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const baseName = String(form.shyStageBaseName ?? '').trim();
            const alwaysVisibleCount = Number.parseInt(form.shyStageAlwaysVisibleCount ?? '', 10);
            const userLimit = Number.parseInt(form.shyStageUserLimit ?? '', 10);
            const unusedDeleteMinutes = Number.parseInt(form.shyStageUnusedDeleteMinutes ?? '', 10);
            const emptyDeleteMinutes = Number.parseInt(form.shyStageEmptyDeleteMinutes ?? '', 10);
            const cleanupIntervalSeconds = Number.parseInt(form.shyStageCleanupIntervalSeconds ?? '', 10);
            const limitChoices = String(form.shyStageLimitChoices ?? '')
                .split(',')
                .map(value => value.trim().toLowerCase() === 'unlimited' ? 0 : Number.parseInt(value.trim(), 10))
                .filter(value => value === 0 || (Number.isInteger(value) && value >= 1 && value <= 99));
            const statsChannelId = String(form.postEventStatsChannelId ?? '').trim();
            const maxQueueLength = Number.parseInt(form.maxQueueLength ?? '', 10);

            if (!baseName || baseName.length > 80
                || !Number.isInteger(alwaysVisibleCount) || alwaysVisibleCount < 1 || alwaysVisibleCount > 20
                || !Number.isInteger(userLimit) || userLimit < 0 || userLimit > 99
                || !Number.isInteger(unusedDeleteMinutes) || unusedDeleteMinutes < 1 || unusedDeleteMinutes > 1440
                || !Number.isInteger(emptyDeleteMinutes) || emptyDeleteMinutes < 1 || emptyDeleteMinutes > 1440
                || !Number.isInteger(cleanupIntervalSeconds) || cleanupIntervalSeconds < 10 || cleanupIntervalSeconds > 3600
                || !Number.isInteger(maxQueueLength) || maxQueueLength < 1 || maxQueueLength > 500
                || limitChoices.length === 0) {
                sendJson(response, 400, { error: 'Invalid bot settings.' });
                return true;
            }

            const settings = state.updateBotSettings({
                shyStage: {
                    baseName,
                    alwaysVisibleCount,
                    userLimit,
                    limitChoices: [...new Set(limitChoices)],
                    unusedDeleteMinutes,
                    emptyDeleteMinutes,
                    cleanupIntervalSeconds,
                },
                postEventStats: { channelId: statsChannelId || null },
                queue: { maxQueueLength },
            });
            sendJson(response, 200, { ok: true, settings });
            return true;
        }

        if (url.pathname === '/admin/api/pd-log' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const guild = client.guilds.cache.get(form.guildId || config.GUILD_ID);
            if (!guild) {
                sendJson(response, 404, { error: 'Guild not found.' });
                return true;
            }

            await guild.channels.fetch().catch(() => null);
            const normalizedChannelName = name => name.toLowerCase().replace(/[\s_-]+/g, '');
            const logChannel = guild.channels.cache.find(channel => normalizedChannelName(channel.name) === 'pdlogs');
            if (!logChannel || !logChannel.isTextBased()) {
                sendJson(response, 404, { error: 'A text channel named pd logs was not found.' });
                return true;
            }

            const permissions = logChannel.permissionsFor(client.user);
            if (!permissions?.has(PermissionFlagsBits.SendMessages) || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
                sendJson(response, 403, { error: 'DrowsyBot cannot send messages or embeds in pd logs.' });
                return true;
            }

            const color = form.eventType === 'promotion' ? 0x10B981 : form.eventType === 'demotion' ? 0xF59E0B : 0xEF4444;
            const embed = new EmbedBuilder()
                .setColor(color)
                .setTitle(form.eventType === 'promotion' ? 'Staff Promotion' : form.eventType === 'demotion' ? 'Staff Demotion' : 'Staff Departure')
                .addFields(
                    { name: 'Staff Member', value: form.memberName || form.discordId || 'Unknown', inline: true },
                    { name: 'Discord ID', value: form.discordId || 'Unknown', inline: true },
                    ...(form.oldRank || form.newRank ? [{ name: 'Rank Change', value: `${form.oldRank || 'None'} -> ${form.newRank || 'None'}` }] : []),
                    ...(form.actorName ? [{ name: 'Actioned By', value: form.actorName }] : [])
                )
                .setTimestamp();

            await logChannel.send({ embeds: [embed] });
            sendJson(response, 200, { ok: true });
            return true;
        }

        if (url.pathname === '/admin/stages/start' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const result = await communityFeature.startTrackedStage(form.guildId, form.textChannelId, form.stageChannelId);
            const message = result.status === 'created'
                ? 'Stage tracking started.'
                : result.status === 'existing-tracker'
                    ? 'Stage tracking was already active.'
                    : result.status === 'conflict'
                        ? 'A different stage is already being tracked in that guild.'
                        : 'I could not start stage tracking with that selection.';
            await renderPanel(response, message, result.status === 'created' || result.status === 'existing-tracker' ? 200 : 400);
            return true;
        }

        if (url.pathname === '/admin/stages/end' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const result = await communityFeature.endTrackedStage(form.guildId, form.textChannelId);
            const message = result.status === 'stopped'
                ? `Stage tracking ended.${result.statsPostedText ?? ''}`
                : 'There is no tracked stage event to end for that guild.';
            await renderPanel(response, message, result.status === 'stopped' ? 200 : 400);
            return true;
        }

        if (url.pathname === '/admin/announcements/send' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const result = await communityFeature.sendAnnouncementFromAdmin(form);
            const message = result.status === 'sent'
                ? 'Announcement sent.'
                : result.error ?? 'I could not send that announcement.';
            await renderPanel(response, message, result.status === 'sent' ? 200 : 400);
            return true;
        }

        if (url.pathname === '/admin/invites/add' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const result = communityFeature.setInviteException(form.userId, true);
            await renderPanel(response, result.status === 'ok' ? 'Invite exception added.' : 'Missing user ID.', result.status === 'ok' ? 200 : 400);
            return true;
        }

        if (url.pathname === '/admin/invites/remove' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const result = communityFeature.setInviteException(form.userId, false);
            await renderPanel(response, result.status === 'ok' ? 'Invite exception removed.' : 'Missing user ID.', result.status === 'ok' ? 200 : 400);
            return true;
        }

        if (url.pathname === '/admin/invites/purge' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const messagesPerChannel = Number.parseInt(form.messagesPerChannel ?? '', 10);
            const scanLimit = Number.isInteger(messagesPerChannel) && messagesPerChannel >= 1 && messagesPerChannel <= 1000
                ? messagesPerChannel
                : 250;
            const result = await communityFeature.purgeInvitesFromAdmin(form.guildId, scanLimit);
            const message = result.status === 'ok'
                ? `Invite cleanup finished. Scanned ${result.scannedChannels} channels, skipped ${result.skippedChannels}, checked ${result.scannedMessages} messages, and deleted ${result.deletedMessages} invite links.`
                : 'I could not run invite cleanup for that guild.';
            await renderPanel(response, message, result.status === 'ok' ? 200 : 400);
            return true;
        }

        if (url.pathname === '/admin/messages/view' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const channelViewer = await readChannelMessagesPreview(form.guildId, form.channelId, form.limit);
            const panelState = await buildPanelState();
            const statusCode = channelViewer.status === 'ok' ? 200 : 400;
            sendHtml(response, statusCode, buildPanelHtml(panelState, '', channelViewer));
            return true;
        }

        if (url.pathname.startsWith('/admin/ads/')) {
            sendJson(response, 404, { error: 'Not found.' });
            return true;
        }

        if (url.pathname === '/admin/ads/upload' && request.method === 'POST') {
            const rawBody = await readRequestBody(request);
            const parsed = parseMultipartForm(request, rawBody);
            const image = parsed.files.image;

            if (!image?.buffer?.length) {
                await renderPanel(response, 'Choose an image file to upload.', 400);
                return true;
            }

            try {
                const result = await communityFeature.uploadAdvertisementFromAdmin({
                    buffer: image.buffer,
                    fileName: image.fileName,
                    contentType: image.contentType,
                    title: parsed.fields.title,
                });
                await renderPanel(response, result.status === 'created' ? 'Advertisement uploaded.' : 'I could not upload that advertisement.', result.status === 'created' ? 200 : 400);
            } catch (error) {
                await renderPanel(response, error.message === 'unsupported-file-type' ? 'Upload a PNG, JPG, GIF, or WEBP image.' : 'I could not upload that advertisement.', 400);
            }
            return true;
        }

        if (url.pathname === '/admin/ads/select' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const index = Number.parseInt(form.index ?? '', 10);
            const selected = Number.isInteger(index) ? state.setActiveAdvertisementByIndex(index) : null;
            await renderPanel(response, selected ? 'Active advertisement updated.' : 'That advertisement does not exist.', selected ? 200 : 400);
            return true;
        }

        if (url.pathname === '/admin/ads/delete' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const index = Number.parseInt(form.index ?? '', 10);
            const result = Number.isInteger(index) ? await communityFeature.removeAdvertisementFromAdmin(index) : { status: 'missing' };
            await renderPanel(response, result.status === 'removed' ? 'Advertisement deleted.' : 'That advertisement does not exist.', result.status === 'removed' ? 200 : 400);
            return true;
        }

        if (url.pathname === '/admin/ads/rotate' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const seconds = Number.parseInt(form.seconds ?? '', 10);
            if (Number.isInteger(seconds) && seconds >= 5 && seconds <= 3600) {
                state.setAdvertisementRotationIntervalMs(seconds * 1000);
                await renderPanel(response, 'Advertisement rotation updated.');
                return true;
            }

            await renderPanel(response, 'Rotation must be between 5 and 3600 seconds.', 400);
            return true;
        }

        if (url.pathname === '/admin/ads/rotate-stop' && request.method === 'POST') {
            state.setAdvertisementRotationIntervalMs(null);
            await renderPanel(response, 'Advertisement rotation stopped.');
            return true;
        }

        // STAGE QUEUE & HOST CONTROLS API FOR WEB MANAGEMENT
        if (url.pathname === '/admin/api/stage/next' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const guild = form.guildId ? client.guilds.cache.get(form.guildId) : client.guilds.cache.first();
            if (!guild) {
                sendJson(response, 404, { error: 'Guild not found.' });
                return true;
            }
            const session = state.peekGuildStageSession(guild.id);
            if (!session) {
                sendJson(response, 404, { error: 'No active stage in guild.' });
                return true;
            }

            const channelId = form.channelId || session.panelChannelIds.values().next().value;
            const channel = channelId ? (guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null)) : null;
            if (!channel?.isTextBased()) {
                sendJson(response, 400, { error: 'Valid channel required.' });
                return true;
            }

            const result = await stageFeature.nextSpeaker(channel);
            sendJson(response, 200, { ok: true, result });
            return true;
        }

        if (url.pathname === '/admin/api/stage/radio' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const guild = form.guildId ? client.guilds.cache.get(form.guildId) : client.guilds.cache.first();
            if (!guild) {
                sendJson(response, 404, { error: 'Guild not found.' });
                return true;
            }
            const session = state.peekGuildStageSession(guild.id);
            if (!session) {
                sendJson(response, 404, { error: 'No active stage in guild.' });
                return true;
            }

            const channelId = form.channelId || session.panelChannelIds.values().next().value;
            const channel = channelId ? (guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null)) : null;
            if (!channel?.isTextBased()) {
                sendJson(response, 400, { error: 'Valid channel required.' });
                return true;
            }

            const result = await stageFeature.toggleRadio(channel);
            sendJson(response, 200, { ok: true, result });
            return true;
        }

        if (url.pathname === '/admin/api/stage/join-toggle' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const guild = form.guildId ? client.guilds.cache.get(form.guildId) : client.guilds.cache.first();
            if (!guild) {
                sendJson(response, 404, { error: 'Guild not found.' });
                return true;
            }
            const session = state.peekGuildStageSession(guild.id);
            if (!session) {
                sendJson(response, 404, { error: 'No active stage in guild.' });
                return true;
            }

            const channelId = form.channelId || session.panelChannelIds.values().next().value;
            const channel = channelId ? (guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null)) : null;
            if (!channel?.isTextBased()) {
                sendJson(response, 400, { error: 'Valid channel required.' });
                return true;
            }

            const acceptingJoins = form.acceptingJoins === 'true' || form.acceptingJoins === true;
            const result = await stageFeature.setJoinState(channel, acceptingJoins);
            sendJson(response, 200, { ok: true, result });
            return true;
        }

        if (url.pathname === '/admin/api/stage/remove-user' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            const guild = form.guildId ? client.guilds.cache.get(form.guildId) : client.guilds.cache.first();
            if (!guild || !form.userId) {
                sendJson(response, 400, { error: 'Guild and userId required.' });
                return true;
            }
            const session = state.peekGuildStageSession(guild.id);
            if (!session) {
                sendJson(response, 404, { error: 'No active stage in guild.' });
                return true;
            }

            const channelId = form.channelId || session.panelChannelIds.values().next().value;
            const channel = channelId ? (guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null)) : null;
            if (!channel?.isTextBased()) {
                sendJson(response, 400, { error: 'Valid channel required.' });
                return true;
            }

            const result = await stageFeature.leaveQueue(channel, form.userId);
            sendJson(response, 200, { ok: true, result });
            return true;
        }

        // ROLE AND NICKNAME SYNC API
        if (url.pathname === '/admin/api/sync-member' && request.method === 'POST') {
            const form = parseFormBody(await readRequestBody(request));
            if (!/^\d{17,20}$/.test(String(form.discordId ?? ''))) {
                sendJson(response, 400, { error: 'A valid Discord member ID is required.' });
                return true;
            }
            const result = await syncMember(form);
            if (result.error) {
                sendJson(response, 404, { error: result.error });
                return true;
            }
            sendJson(response, 200, { ok: result.results.errors.length === 0, results: result.results });
            return true;
        }

        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return true;
    }

    return { handleRequest };
}

module.exports = { createAdminPanel };
