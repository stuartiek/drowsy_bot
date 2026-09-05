require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

const {
    Client,
    GatewayIntentBits,
    Partials,
    REST,
    Routes,
} = require('discord.js');

const config = require('./src/config');
const { buildCommands } = require('./src/commands');
const { createHelpers } = require('./src/helpers');
const { createState } = require('./src/state');
const { createCommunityFeature } = require('./src/features/community');
const { createStageFeature } = require('./src/features/stage');
const { createAdminPanel } = require('./src/web/admin-panel');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildScheduledEvents,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User],
});

const state = createState(config);
const helpers = createHelpers(config, state);
const stageFeature = createStageFeature({ client, config, state, helpers });
const communityFeature = createCommunityFeature({ client, config, state, helpers, stageFeature });
const adminPanel = createAdminPanel({ client, config, state, communityFeature });
const adminSessions = new Map();

function escapeHtml(value) {
    return value
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

    if (hours <= 0) return `${minutes}m`;
    return `${hours}h ${minutes}m`;
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

function createAdminSession() {
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + (config.ADMIN_PANEL_SESSION_HOURS * 60 * 60 * 1000);
    adminSessions.set(token, { expiresAt });
    return { token, expiresAt };
}

function getAdminSession(request) {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies.drowsy_admin_session;
    if (!token) return null;

    const session = adminSessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        adminSessions.delete(token);
        return null;
    }

    return { token, ...session };
}

function destroyAdminSession(request) {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies.drowsy_admin_session;
    if (token) {
        adminSessions.delete(token);
    }
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
        let body = '';

        request.on('data', chunk => {
            body += chunk;
            if (body.length > 1024 * 1024) {
                reject(new Error('Request body too large'));
                request.destroy();
            }
        });

        request.on('end', () => resolve(body));
        request.on('error', reject);
    });
}

function parseFormBody(body) {
    const params = new URLSearchParams(body);
    return Object.fromEntries(params.entries());
}

async function buildAdminPanelState() {
    const advertisements = state.getAdvertisements();
    const activeAdvertisement = state.getActiveAdvertisement();
    const trackedStages = await Promise.all([...state.guildStageSessions.entries()].map(async ([guildId, session]) => {
        const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
        const stageChannel = session.targetVC && guild
            ? guild.channels.cache.get(session.targetVC) ?? await guild.channels.fetch(session.targetVC).catch(() => null)
            : null;

        return {
            guildId,
            guildName: guild?.name ?? guildId,
            channelName: stageChannel?.name ?? 'Unknown stage',
            channelId: session.targetVC,
            startedAt: session.startedAt,
            runtimeText: session.startedAt ? formatDuration(Date.now() - Date.parse(session.startedAt)) : 'Unknown',
            performers: session.performerIds.size,
            songsSung: session.songsSung,
            peakAttendance: session.peakAttendance,
            attendeeCount: session.attendeeIds.size,
        };
    }));

    const guildConfigs = Object.entries(state.guildConfigs).map(([guildId, guildConfig]) => ({
        guildId,
        guildName: client.guilds.cache.get(guildId)?.name ?? guildId,
        announcementColor: typeof guildConfig?.announcementColor === 'string' ? guildConfig.announcementColor : null,
    }));

    return {
        botReady: client.isReady(),
        botUser: client.user?.tag ?? 'Offline',
        guildCount: client.guilds.cache.size,
        trackedStages,
        advertisementCount: advertisements.length,
        activeAdvertisement,
        rotationIntervalMs: state.advertisements.rotationIntervalMs,
        allowedInviteUserCount: state.allowedInviteUsers.size,
        guildConfigs,
    };
}

function buildAdminLoginHtml(errorMessage = '') {
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
        :root {
            color-scheme: light;
            --sand: #f7efdf;
            --paper: #fffaf2;
            --ink: #24150b;
            --rust: #9e4d1c;
            --gold: #ddb06d;
            --line: rgba(86, 50, 30, 0.15);
            --shadow: rgba(54, 28, 12, 0.16);
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            padding: 24px;
            background:
                radial-gradient(circle at top left, rgba(221, 176, 109, 0.28), transparent 28%),
                linear-gradient(135deg, #f2e6cf, #f8f2e8 45%, #efe4d0 100%);
            color: var(--ink);
            font-family: Georgia, "Times New Roman", serif;
        }
        .card {
            width: min(440px, 100%);
            padding: 30px;
            border: 1px solid var(--line);
            border-radius: 24px;
            background: rgba(255, 250, 242, 0.94);
            box-shadow: 0 24px 60px var(--shadow);
        }
        h1 { margin: 0 0 10px; font-size: 34px; }
        p { margin: 0 0 16px; line-height: 1.55; }
        label { display: block; margin-bottom: 8px; font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase; }
        input {
            width: 100%;
            padding: 14px 16px;
            border: 1px solid var(--line);
            border-radius: 14px;
            background: #fff;
            font: inherit;
        }
        button {
            width: 100%;
            margin-top: 16px;
            padding: 14px 16px;
            border: 0;
            border-radius: 999px;
            background: linear-gradient(135deg, var(--rust), #c36a30);
            color: #fff8ef;
            font: inherit;
            cursor: pointer;
        }
        button:disabled { opacity: 0.55; cursor: not-allowed; }
        .notice {
            margin: 0 0 16px;
            padding: 12px 14px;
            border-radius: 14px;
        }
        .notice--error {
            background: rgba(176, 42, 42, 0.1);
            color: #7a1f1f;
        }
    </style>
</head>
<body>
    <main class="card">
        <h1>DrowsyBot Admin</h1>
        <p>Sign in to view bot status, tracked stage events, and advertisement controls.</p>
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

function buildAdminPanelHtml(panelState) {
    const trackedStageMarkup = panelState.trackedStages.length > 0
        ? panelState.trackedStages.map(stage => `
            <article class="list-card">
                <h3>${escapeHtml(stage.guildName)}</h3>
                <p><strong>Stage:</strong> ${escapeHtml(stage.channelName)}${stage.channelId ? ` (<code>${escapeHtml(stage.channelId)}</code>)` : ''}</p>
                <p><strong>Started:</strong> ${escapeHtml(formatDateTime(stage.startedAt))}</p>
                <p><strong>Runtime:</strong> ${escapeHtml(stage.runtimeText)}</p>
                <p><strong>Performers:</strong> ${stage.performers} | <strong>Songs:</strong> ${stage.songsSung} | <strong>Peak:</strong> ${stage.peakAttendance}</p>
            </article>`).join('')
        : '<article class="list-card"><p>No stage events are being tracked right now.</p></article>';

    const advertisementMarkup = panelState.advertisementCount > 0
        ? state.getAdvertisements().map((advertisement, index) => `
            <article class="list-card">
                <div class="list-card__row">
                    <div>
                        <h3>${escapeHtml(advertisement.title ?? `Ad ${index + 1}`)}</h3>
                        <p><strong>File:</strong> ${escapeHtml(advertisement.fileName ?? 'Unknown')}</p>
                    </div>
                    <form method="post" action="/admin/ads/select">
                        <input type="hidden" name="index" value="${index}">
                        <button type="submit" class="button button--ghost">${panelState.activeAdvertisement?.id === advertisement.id ? 'Active' : 'Set Active'}</button>
                    </form>
                </div>
            </article>`).join('')
        : '<article class="list-card"><p>No advertisements uploaded yet.</p></article>';

    const guildConfigMarkup = panelState.guildConfigs.length > 0
        ? panelState.guildConfigs.map(guildConfig => `
            <article class="list-card">
                <h3>${escapeHtml(guildConfig.guildName)}</h3>
                <p><strong>Announcement Color:</strong> ${escapeHtml(guildConfig.announcementColor ?? 'Default')}</p>
            </article>`).join('')
        : '<article class="list-card"><p>No per-guild announcement colors saved yet.</p></article>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>DrowsyBot Admin</title>
    <style>
        :root {
            color-scheme: light;
            --paper: #fcf7ef;
            --sand: #f0e2c7;
            --ink: #24150b;
            --muted: #71594a;
            --rust: #9f4b22;
            --teal: #1f6d64;
            --line: rgba(91, 53, 31, 0.14);
            --shadow: rgba(50, 25, 12, 0.12);
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            background:
                radial-gradient(circle at top left, rgba(221, 176, 109, 0.22), transparent 24%),
                linear-gradient(135deg, #f6eddc, #fcf8f1 42%, #efe3cc 100%);
            color: var(--ink);
            font-family: Georgia, "Times New Roman", serif;
        }
        .shell {
            width: min(1220px, calc(100vw - 32px));
            margin: 20px auto 32px;
        }
        .hero {
            display: flex;
            justify-content: space-between;
            align-items: end;
            gap: 16px;
            margin-bottom: 20px;
            padding: 28px;
            border-radius: 28px;
            background: linear-gradient(135deg, rgba(135, 67, 30, 0.95), rgba(48, 91, 83, 0.92));
            color: #fff8ef;
            box-shadow: 0 24px 56px var(--shadow);
        }
        .hero h1 { margin: 0; font-size: clamp(34px, 5vw, 52px); }
        .hero p { margin: 8px 0 0; color: rgba(255, 248, 239, 0.82); }
        .button, button {
            padding: 12px 18px;
            border: 0;
            border-radius: 999px;
            background: linear-gradient(135deg, var(--rust), #c66d32);
            color: #fff8ef;
            font: inherit;
            cursor: pointer;
        }
        .button--ghost {
            background: rgba(36, 21, 11, 0.08);
            color: var(--ink);
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 16px;
            margin-bottom: 18px;
        }
        .stat {
            padding: 20px;
            border-radius: 22px;
            background: rgba(255, 250, 242, 0.96);
            border: 1px solid var(--line);
            box-shadow: 0 14px 36px var(--shadow);
        }
        .stat__label {
            margin: 0 0 8px;
            color: var(--muted);
            letter-spacing: 0.1em;
            text-transform: uppercase;
            font-size: 12px;
        }
        .stat__value { margin: 0; font-size: 28px; }
        .sections {
            display: grid;
            grid-template-columns: 1.2fr 1fr;
            gap: 18px;
        }
        .section {
            padding: 22px;
            border-radius: 26px;
            background: rgba(255, 251, 246, 0.96);
            border: 1px solid var(--line);
            box-shadow: 0 18px 40px var(--shadow);
        }
        .section h2 { margin: 0 0 14px; font-size: 26px; }
        .section p { color: var(--muted); }
        .list-card {
            margin-top: 12px;
            padding: 16px 18px;
            border-radius: 18px;
            background: var(--paper);
            border: 1px solid var(--line);
        }
        .list-card h3 { margin: 0 0 8px; font-size: 20px; }
        .list-card p { margin: 4px 0; }
        .list-card__row {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            align-items: center;
        }
        .inline-form {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
            align-items: center;
            margin-top: 12px;
        }
        .inline-form input {
            min-width: 120px;
            padding: 12px 14px;
            border-radius: 12px;
            border: 1px solid var(--line);
            font: inherit;
            background: #fff;
        }
        code {
            padding: 2px 6px;
            border-radius: 8px;
            background: rgba(36, 21, 11, 0.06);
            font-family: Consolas, monospace;
            font-size: 12px;
        }
        @media (max-width: 960px) {
            .sections { grid-template-columns: 1fr; }
            .hero { flex-direction: column; align-items: start; }
            .list-card__row { flex-direction: column; align-items: start; }
        }
    </style>
</head>
<body>
    <main class="shell">
        <section class="hero">
            <div>
                <h1>DrowsyBot Admin</h1>
                <p>${escapeHtml(panelState.botReady ? `Connected as ${panelState.botUser}` : 'Bot not connected yet')}</p>
            </div>
            <form method="post" action="/admin/logout">
                <button type="submit" class="button">Sign Out</button>
            </form>
        </section>

        <section class="grid">
            <article class="stat">
                <p class="stat__label">Guilds</p>
                <p class="stat__value">${panelState.guildCount}</p>
            </article>
            <article class="stat">
                <p class="stat__label">Tracked Stages</p>
                <p class="stat__value">${panelState.trackedStages.length}</p>
            </article>
            <article class="stat">
                <p class="stat__label">Ads Uploaded</p>
                <p class="stat__value">${panelState.advertisementCount}</p>
            </article>
            <article class="stat">
                <p class="stat__label">Invite Exceptions</p>
                <p class="stat__value">${panelState.allowedInviteUserCount}</p>
            </article>
        </section>

        <section class="sections">
            <section class="section">
                <h2>Tracked Stage Events</h2>
                <p>Live tracking visibility for stage sessions currently being recorded by the bot.</p>
                ${trackedStageMarkup}
            </section>

            <section class="section">
                <h2>Advertisement Controls</h2>
                <p>Manage the OBS advertisement rotation without using Discord commands.</p>
                <article class="list-card">
                    <p><strong>Current Active Ad:</strong> ${escapeHtml(panelState.activeAdvertisement?.title ?? 'None')}</p>
                    <p><strong>Rotation:</strong> ${panelState.rotationIntervalMs ? `${Math.max(1, Math.floor(panelState.rotationIntervalMs / 1000))}s` : 'Off'}</p>
                    <form class="inline-form" method="post" action="/admin/ads/rotate">
                        <input type="number" name="seconds" min="5" max="3600" placeholder="Seconds">
                        <button type="submit">Start Rotation</button>
                    </form>
                    <form class="inline-form" method="post" action="/admin/ads/rotate-stop">
                        <button type="submit" class="button button--ghost">Stop Rotation</button>
                    </form>
                </article>
                ${advertisementMarkup}
            </section>
        </section>

        <section class="sections" style="margin-top: 18px;">
            <section class="section">
                <h2>Guild Config</h2>
                <p>Read-only view of saved per-guild announcement colors.</p>
                ${guildConfigMarkup}
            </section>

            <section class="section">
                <h2>Panel Notes</h2>
                <article class="list-card">
                    <p>This first pass is intentionally narrow: it gives staff a password-protected live dashboard plus safe ad controls on the existing bot HTTP server.</p>
                    <p>Next additions can include announcement posting, invite exception edits, or stage stop controls if you want the panel to replace more Discord commands.</p>
                </article>
            </section>
        </section>
    </main>
</body>
</html>`;
}

function readObsNowSingingText() {
    return fs.readFileSync(config.FILES.obsNowSinging, 'utf8').trim() || 'Show Offline';
}

function readObsNowSingingOverlay() {
    try {
        const parsed = JSON.parse(fs.readFileSync(config.FILES.obsNowSingingJson, 'utf8'));
        return {
            text: typeof parsed.text === 'string' && parsed.text.trim() ? parsed.text.trim() : 'Show Offline',
            avatarUrl: typeof parsed.avatarUrl === 'string' && parsed.avatarUrl.trim() ? parsed.avatarUrl.trim() : null,
        };
    } catch (error) {
        return {
            text: readObsNowSingingText(),
            avatarUrl: null,
        };
    }
}

function readObsAdvertisement() {
    try {
        const parsed = JSON.parse(fs.readFileSync(config.FILES.obsAds, 'utf8'));
        const items = Array.isArray(parsed?.items) ? parsed.items : [];
        const activeId = typeof parsed?.activeId === 'string' ? parsed.activeId : null;
        const activeIndex = Math.max(0, items.findIndex(item => item?.id === activeId));
        const rotationIntervalMs = Number.isInteger(parsed?.rotationIntervalMs) && parsed.rotationIntervalMs > 0
            ? parsed.rotationIntervalMs
            : null;
        const rotationStartedAt = Date.parse(parsed?.rotationStartedAt ?? '');
        const hasRotation = rotationIntervalMs && items.length > 1 && Number.isFinite(rotationStartedAt);
        const rotationOffset = hasRotation
            ? Math.floor(Math.max(0, Date.now() - rotationStartedAt) / rotationIntervalMs) % items.length
            : 0;
        const activeItem = items[(activeIndex + rotationOffset) % Math.max(items.length, 1)] ?? null;

        if (!activeItem) {
            return {
                active: false,
                item: null,
                rotationIntervalMs: null,
            };
        }

        return {
            active: state.guildStageSessions.size > 0,
            rotationIntervalMs,
            item: {
                title: typeof activeItem.title === 'string' ? activeItem.title : 'Advertisement',
                contentType: typeof activeItem.contentType === 'string' ? activeItem.contentType : 'application/octet-stream',
                fileName: activeItem.fileName,
                url: `/obs/ads/files/${encodeURIComponent(activeItem.fileName)}`,
            },
        };
    } catch (error) {
        return {
            active: false,
            item: null,
            rotationIntervalMs: null,
        };
    }
}

function readObsAdvertisementByFileName(fileName) {
    try {
        const parsed = JSON.parse(fs.readFileSync(config.FILES.obsAds, 'utf8'));
        const items = Array.isArray(parsed?.items) ? parsed.items : [];
        return items.find(item => item?.fileName === fileName) ?? null;
    } catch (error) {
        return null;
    }
}

function readObsLiveEventOverlay() {
    const singer = readObsNowSingingOverlay();
    const advertisement = readObsAdvertisement();

    return {
        stageActive: advertisement.active,
        singer,
        advertisement,
    };
}

function buildObsOverlayHtml(overlay) {
    const safeText = escapeHtml(overlay.text);
    const avatarClasses = overlay.avatarUrl ? 'avatar' : 'avatar avatar--placeholder';
    const avatarSrc = overlay.avatarUrl ? ` src="${escapeHtml(overlay.avatarUrl)}"` : '';
    const imageMarkup = `<img id="now-singing-avatar" class="${avatarClasses}"${avatarSrc} alt="${safeText}">`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Now Singing</title>
    <style>
        :root {
            color-scheme: only light;
        }

        * {
            box-sizing: border-box;
        }

        html,
        body {
            margin: 0;
            min-height: 100%;
            background: transparent;
            overflow: hidden;
            font-family: Georgia, "Times New Roman", serif;
        }

        body {
            display: grid;
            place-items: center;
            padding: 16px;
        }

        .frame {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 360px;
            height: 360px;
            padding: 16px;
            border: 3px solid rgba(255, 230, 167, 0.7);
            border-radius: 50%;
            background: radial-gradient(circle at 30% 30%, rgba(255, 248, 220, 0.2), rgba(64, 34, 16, 0.78));
            box-shadow: 0 12px 30px rgba(0, 0, 0, 0.25);
            overflow: hidden;
        }

        .avatar {
            display: block;
            width: 100%;
            height: 100%;
            border-radius: 50%;
            object-fit: cover;
            background: rgba(17, 24, 39, 0.72);
        }

        .avatar--placeholder {
            background:
                radial-gradient(circle at 50% 35%, rgba(255, 248, 220, 0.92) 0 16%, transparent 17%),
                radial-gradient(circle at 50% 78%, rgba(255, 248, 220, 0.92) 0 28%, transparent 29%),
                linear-gradient(135deg, rgba(17, 24, 39, 0.9), rgba(64, 34, 16, 0.82));
        }
    </style>
</head>
<body>
    <div class="frame" title="${safeText}">
        ${imageMarkup}
    </div>
    <script>
        const singerAvatarElement = document.getElementById('now-singing-avatar');

        async function refreshSinger() {
            const response = await fetch('/obs/now-singing.json', { cache: 'no-store' });
            if (!response.ok) return;

            const nextOverlay = await response.json();
            const nextText = typeof nextOverlay.text === 'string' && nextOverlay.text.trim() ? nextOverlay.text.trim() : 'Show Offline';
            const nextAvatarUrl = typeof nextOverlay.avatarUrl === 'string' && nextOverlay.avatarUrl.trim() ? nextOverlay.avatarUrl.trim() : null;

            singerAvatarElement.setAttribute('aria-label', nextText);
            singerAvatarElement.parentElement.setAttribute('title', nextText);

            if (nextAvatarUrl) {
                singerAvatarElement.classList.remove('avatar--placeholder');
                singerAvatarElement.setAttribute('src', nextAvatarUrl);
                singerAvatarElement.setAttribute('alt', nextText);
            } else {
                singerAvatarElement.removeAttribute('src');
                singerAvatarElement.setAttribute('alt', nextText);
                singerAvatarElement.classList.add('avatar--placeholder');
            }
        }

        refreshSinger().catch(() => {});
        setInterval(() => {
            refreshSinger().catch(() => {});
        }, 1000);
    </script>
</body>
</html>`;
}

function buildAdvertisementOverlayHtml(advertisementState) {
    const title = escapeHtml(advertisementState.item?.title ?? 'Advertisement');
    const imageMarkup = advertisementState.item
        ? `<div class="slide slide--visible" data-kind="image"><img id="ad-image" class="ad-image" src="${escapeHtml(advertisementState.item.url)}" alt="${title}"></div>`
        : '<div class="slide slide--visible" data-kind="empty"><div id="ad-empty" class="ad-empty">No active ad uploaded</div></div>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Drowsy Ads</title>
    <style>
        :root {
            color-scheme: only light;
            --paper: rgba(251, 244, 233, 0.94);
            --ink: #24130a;
            --shadow: rgba(43, 22, 11, 0.28);
            --accent: #d07a2d;
        }

        * {
            box-sizing: border-box;
        }

        html,
        body {
            margin: 0;
            min-height: 100%;
            background: transparent;
            overflow: hidden;
            font-family: Georgia, "Times New Roman", serif;
        }

        body {
            display: grid;
            place-items: center;
            padding: 24px;
        }

        .panel {
            width: min(720px, 100vw - 48px);
            padding: 18px;
            border: 2px solid rgba(208, 122, 45, 0.55);
            border-radius: 28px;
            background:
                linear-gradient(135deg, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0)),
                radial-gradient(circle at top, rgba(255, 221, 173, 0.55), rgba(53, 27, 13, 0.9));
            box-shadow: 0 16px 40px var(--shadow);
            backdrop-filter: blur(8px);
            transition: opacity 360ms ease, transform 360ms ease, box-shadow 360ms ease;
        }

        .eyebrow {
            margin: 0 0 12px;
            font-size: 13px;
            letter-spacing: 0.2em;
            text-transform: uppercase;
            color: rgba(251, 244, 233, 0.85);
        }

        .canvas {
            position: relative;
            display: grid;
            min-height: 400px;
            place-items: center;
            border-radius: 20px;
            overflow: hidden;
            background: var(--paper);
            isolation: isolate;
        }

        .canvas::before {
            content: '';
            position: absolute;
            inset: 0;
            background:
                radial-gradient(circle at top right, rgba(208, 122, 45, 0.14), transparent 32%),
                linear-gradient(180deg, rgba(255, 255, 255, 0.45), transparent 28%);
            pointer-events: none;
            z-index: 0;
        }

        .stage {
            position: absolute;
            inset: 0;
            z-index: 1;
        }

        .slide {
            position: absolute;
            inset: 0;
            display: grid;
            place-items: center;
            opacity: 0;
            transform: scale(1.02);
            filter: saturate(0.96);
            transition: opacity 520ms ease, transform 520ms ease, filter 520ms ease;
            will-change: opacity, transform, filter;
        }

        .slide--visible {
            opacity: 1;
            transform: scale(1);
            filter: saturate(1);
        }

        .ad-image {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: #fff;
            transform-origin: center;
        }

        .ad-empty {
            padding: 48px;
            color: rgba(36, 19, 10, 0.7);
            font-size: 28px;
            text-align: center;
        }

        .status {
            position: absolute;
            top: 16px;
            right: 16px;
            padding: 8px 12px;
            border-radius: 999px;
            background: rgba(36, 19, 10, 0.8);
            color: #fff4e7;
            font-size: 12px;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            z-index: 2;
        }

        .rotation {
            position: absolute;
            left: 16px;
            bottom: 16px;
            padding: 8px 12px;
            border-radius: 999px;
            background: rgba(255, 244, 231, 0.9);
            color: rgba(36, 19, 10, 0.82);
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            z-index: 2;
        }

        body[data-stage-active="false"] .panel {
            opacity: 0.45;
            transform: scale(0.98);
            box-shadow: 0 10px 24px rgba(43, 22, 11, 0.18);
        }

        body[data-stage-active="false"] .status::after {
            content: 'Stage inactive';
        }

        body[data-stage-active="true"] .status::after {
            content: 'Stage live';
        }

        body[data-rotation-active="false"] .rotation {
            display: none;
        }

        @media (prefers-reduced-motion: reduce) {
            .panel,
            .slide {
                transition: none;
            }
        }
    </style>
</head>
<body data-stage-active="${advertisementState.active ? 'true' : 'false'}" data-rotation-active="${advertisementState.rotationIntervalMs ? 'true' : 'false'}">
    <section class="panel">
        <p class="eyebrow">Drowsy Sponsor Panel</p>
        <div class="canvas">
            <div class="stage" id="ad-stage">
                ${imageMarkup}
            </div>
            <div class="status"></div>
            <div class="rotation">Rotating</div>
        </div>
    </section>
    <script>
        const body = document.body;
        const stage = document.getElementById('ad-stage');
        const rotationElement = document.querySelector('.rotation');

        function buildSlide(nextState) {
            const slideElement = document.createElement('div');

            if (!nextState.item) {
                slideElement.className = 'slide';
                slideElement.dataset.kind = 'empty';

                const emptyElement = document.createElement('div');
                emptyElement.id = 'ad-empty';
                emptyElement.className = 'ad-empty';
                emptyElement.textContent = 'No active ad uploaded';
                slideElement.appendChild(emptyElement);
                return slideElement;
            }

            slideElement.className = 'slide';
            slideElement.dataset.kind = 'image';

            const imageElement = document.createElement('img');
            imageElement.id = 'ad-image';
            imageElement.className = 'ad-image';
            imageElement.src = nextState.item.url;
            imageElement.alt = nextState.item.title;
            slideElement.appendChild(imageElement);
            return slideElement;
        }

        function getVisibleSlide() {
            return stage.querySelector('.slide--visible');
        }

        function isSameSlide(currentSlide, nextState) {
            if (!currentSlide) return false;

            if (!nextState.item) {
                return currentSlide.dataset.kind === 'empty';
            }

            const imageElement = currentSlide.querySelector('.ad-image');
            return currentSlide.dataset.kind === 'image'
                && imageElement
                && imageElement.getAttribute('src') === nextState.item.url
                && imageElement.getAttribute('alt') === nextState.item.title;
        }

        function renderAdvertisement(nextState) {
            body.dataset.stageActive = nextState.active ? 'true' : 'false';
            body.dataset.rotationActive = nextState.rotationIntervalMs ? 'true' : 'false';
            rotationElement.textContent = nextState.rotationIntervalMs
                ? 'Rotating every ' + Math.max(1, Math.floor(nextState.rotationIntervalMs / 1000)) + 's'
                : 'Rotating';

            const currentSlide = getVisibleSlide();
            if (isSameSlide(currentSlide, nextState)) {
                return;
            }

            const nextSlide = buildSlide(nextState);
            stage.appendChild(nextSlide);

            requestAnimationFrame(() => {
                nextSlide.classList.add('slide--visible');
                if (currentSlide) currentSlide.classList.remove('slide--visible');
            });

            if (currentSlide) {
                setTimeout(() => {
                    if (currentSlide.parentElement === stage) {
                        currentSlide.remove();
                    }
                }, 560);
            }
        }

        async function refreshAdvertisement() {
            const response = await fetch('/obs/ad.json', { cache: 'no-store' });
            if (!response.ok) return;
            const nextState = await response.json();
            renderAdvertisement(nextState);
        }

        refreshAdvertisement().catch(() => {});
        setInterval(() => {
            refreshAdvertisement().catch(() => {});
        }, 3000);
    </script>
</body>
</html>`;
}

function buildLiveEventOverlayHtml(liveState) {
    const singerText = escapeHtml(liveState.singer.text);
    const singerAvatarUrl = liveState.singer.avatarUrl ? escapeHtml(liveState.singer.avatarUrl) : '';
    const singerAvatarMarkup = liveState.singer.avatarUrl
        ? `<img id="live-singer-avatar" class="performer-avatar" src="${singerAvatarUrl}" alt="${singerText}">`
        : '<div id="live-singer-avatar" class="performer-avatar performer-avatar--placeholder" aria-hidden="true"></div>';
    const adTitle = escapeHtml(liveState.advertisement.item?.title ?? 'Advertisement');
    const adMarkup = liveState.advertisement.item
        ? `<div class="live-ad-slide live-ad-slide--visible" data-kind="image"><img class="live-ad-image" src="${escapeHtml(liveState.advertisement.item.url)}" alt="${adTitle}"></div>`
        : '<div class="live-ad-slide live-ad-slide--visible" data-kind="empty"><div class="live-ad-empty">No active ad uploaded</div></div>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Drowsy Live Event Screen</title>
    <style>
        :root {
            color-scheme: only light;
            --cream: #f5eee1;
            --ink: #2c1a10;
            --panel: rgba(84, 48, 29, 0.78);
            --gold: #ddb06d;
            --shadow: rgba(35, 17, 8, 0.32);
        }

        * {
            box-sizing: border-box;
        }

        html,
        body {
            margin: 0;
            min-height: 100%;
            background:
                radial-gradient(circle at top left, rgba(255, 223, 169, 0.18), transparent 26%),
                radial-gradient(circle at right, rgba(221, 176, 109, 0.15), transparent 24%),
                linear-gradient(135deg, #1d120d, #3b2417 42%, #6f4b34 100%);
            color: var(--cream);
            overflow: hidden;
            font-family: Georgia, "Times New Roman", serif;
        }

        body {
            padding: 32px;
        }

        .screen {
            display: grid;
            grid-template-columns: minmax(300px, 32vw) minmax(520px, 1fr);
            gap: 24px;
            min-height: calc(100vh - 64px);
        }

        .panel {
            position: relative;
            overflow: hidden;
            border: 2px solid rgba(221, 176, 109, 0.55);
            border-radius: 30px;
            background:
                linear-gradient(180deg, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.02)),
                var(--panel);
            box-shadow: 0 20px 48px var(--shadow);
            backdrop-filter: blur(10px);
            transition: opacity 320ms ease, transform 320ms ease, box-shadow 320ms ease;
        }

        .panel::before {
            content: '';
            position: absolute;
            inset: 0;
            background: linear-gradient(135deg, rgba(255, 255, 255, 0.08), transparent 42%);
            pointer-events: none;
        }

        .performer-panel {
            display: grid;
            align-content: start;
            gap: 24px;
            padding: 28px;
        }

        .eyebrow {
            margin: 0;
            font-size: 13px;
            letter-spacing: 0.24em;
            text-transform: uppercase;
            color: rgba(245, 238, 225, 0.8);
        }

        .performer-card {
            display: grid;
            justify-items: center;
            gap: 18px;
            padding: 26px 20px 28px;
            border-radius: 24px;
            background: rgba(255, 250, 242, 0.08);
        }

        .performer-avatar {
            display: block;
            width: min(240px, 100%);
            aspect-ratio: 1;
            border-radius: 50%;
            object-fit: cover;
            border: 4px solid rgba(221, 176, 109, 0.75);
            background: rgba(19, 12, 9, 0.55);
            box-shadow: 0 14px 32px rgba(0, 0, 0, 0.24);
        }

        .performer-avatar--placeholder {
            background:
                radial-gradient(circle at 50% 35%, rgba(255, 248, 220, 0.92) 0 16%, transparent 17%),
                radial-gradient(circle at 50% 78%, rgba(255, 248, 220, 0.92) 0 28%, transparent 29%),
                linear-gradient(135deg, rgba(17, 24, 39, 0.9), rgba(64, 34, 16, 0.82));
        }

        .performer-name {
            margin: 0;
            font-size: clamp(34px, 4vw, 56px);
            line-height: 1;
            text-align: center;
            text-wrap: balance;
        }

        .performer-caption {
            margin: 0;
            font-size: 16px;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: rgba(245, 238, 225, 0.72);
        }

        .stage-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            justify-self: start;
            padding: 10px 16px;
            border-radius: 999px;
            background: rgba(23, 15, 10, 0.7);
            color: #fff7eb;
            font-size: 13px;
            letter-spacing: 0.16em;
            text-transform: uppercase;
        }

        .stage-badge::before {
            content: '';
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #78d06b;
            box-shadow: 0 0 0 6px rgba(120, 208, 107, 0.18);
        }

        .advert-panel {
            display: grid;
            gap: 18px;
            padding: 24px;
        }

        .advert-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
        }

        .rotation-badge {
            padding: 9px 14px;
            border-radius: 999px;
            background: rgba(255, 248, 235, 0.9);
            color: var(--ink);
            font-size: 12px;
            letter-spacing: 0.12em;
            text-transform: uppercase;
        }

        .advert-canvas {
            position: relative;
            min-height: 0;
            flex: 1;
            border-radius: 24px;
            overflow: hidden;
            background: rgba(255, 250, 242, 0.96);
            min-height: 540px;
            isolation: isolate;
        }

        .advert-canvas::before {
            content: '';
            position: absolute;
            inset: 0;
            background:
                radial-gradient(circle at top right, rgba(221, 176, 109, 0.15), transparent 28%),
                linear-gradient(180deg, rgba(255, 255, 255, 0.55), transparent 30%);
            pointer-events: none;
            z-index: 0;
        }

        .live-ad-stage {
            position: absolute;
            inset: 0;
            z-index: 1;
        }

        .live-ad-slide {
            position: absolute;
            inset: 0;
            display: grid;
            place-items: center;
            opacity: 0;
            transform: translateX(32px) scale(1.02);
            filter: saturate(0.94);
            transition: opacity 560ms ease, transform 560ms ease, filter 560ms ease;
            will-change: opacity, transform, filter;
        }

        .live-ad-slide--visible {
            opacity: 1;
            transform: translateX(0) scale(1);
            filter: saturate(1);
        }

        .live-ad-image {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: #fff;
        }

        .live-ad-empty {
            padding: 48px;
            color: rgba(44, 26, 16, 0.72);
            font-size: 28px;
            text-align: center;
        }

        body[data-stage-active="false"] .panel {
            opacity: 0.52;
            transform: scale(0.986);
            box-shadow: 0 12px 28px rgba(35, 17, 8, 0.22);
        }

        body[data-stage-active="false"] .stage-badge {
            background: rgba(23, 15, 10, 0.56);
        }

        body[data-stage-active="false"] .stage-badge::before {
            background: #b79b72;
            box-shadow: 0 0 0 6px rgba(183, 155, 114, 0.16);
        }

        body[data-stage-active="false"] .stage-badge span::after {
            content: 'Inactive';
        }

        body[data-stage-active="true"] .stage-badge span::after {
            content: 'Live';
        }

        body[data-rotation-active="false"] .rotation-badge {
            display: none;
        }

        @media (max-width: 1100px) {
            body {
                padding: 20px;
            }

            .screen {
                grid-template-columns: 1fr;
                min-height: auto;
            }

            .advert-canvas {
                min-height: 420px;
            }
        }

        @media (prefers-reduced-motion: reduce) {
            .panel,
            .live-ad-slide {
                transition: none;
            }
        }
    </style>
</head>
<body data-stage-active="${liveState.stageActive ? 'true' : 'false'}" data-rotation-active="${liveState.advertisement.rotationIntervalMs ? 'true' : 'false'}">
    <main class="screen">
        <section class="panel performer-panel">
            <p class="eyebrow">Now Performing</p>
            <div class="performer-card">
                ${singerAvatarMarkup}
                <p class="performer-caption">Drowsy Stage</p>
                <h1 id="performer-name" class="performer-name">${singerText}</h1>
            </div>
            <div class="stage-badge"><span></span></div>
        </section>
        <section class="panel advert-panel">
            <div class="advert-header">
                <p class="eyebrow">Sponsor Spotlight</p>
                <div class="rotation-badge" id="rotation-badge">Rotating</div>
            </div>
            <div class="advert-canvas">
                <div class="live-ad-stage" id="live-ad-stage">
                    ${adMarkup}
                </div>
            </div>
        </section>
    </main>
    <script>
        const liveBody = document.body;
        const performerNameElement = document.getElementById('performer-name');
        const singerAvatarElement = document.getElementById('live-singer-avatar');
        const rotationBadgeElement = document.getElementById('rotation-badge');
        const liveAdStageElement = document.getElementById('live-ad-stage');

        function buildAdSlide(nextState) {
            const slideElement = document.createElement('div');

            if (!nextState.advertisement.item) {
                slideElement.className = 'live-ad-slide';
                slideElement.dataset.kind = 'empty';

                const emptyElement = document.createElement('div');
                emptyElement.className = 'live-ad-empty';
                emptyElement.textContent = 'No active ad uploaded';
                slideElement.appendChild(emptyElement);
                return slideElement;
            }

            slideElement.className = 'live-ad-slide';
            slideElement.dataset.kind = 'image';

            const imageElement = document.createElement('img');
            imageElement.className = 'live-ad-image';
            imageElement.src = nextState.advertisement.item.url;
            imageElement.alt = nextState.advertisement.item.title;
            slideElement.appendChild(imageElement);
            return slideElement;
        }

        function getVisibleAdSlide() {
            return liveAdStageElement.querySelector('.live-ad-slide--visible');
        }

        function isSameAdSlide(currentSlide, nextState) {
            if (!currentSlide) return false;

            if (!nextState.advertisement.item) {
                return currentSlide.dataset.kind === 'empty';
            }

            const imageElement = currentSlide.querySelector('.live-ad-image');
            return currentSlide.dataset.kind === 'image'
                && imageElement
                && imageElement.getAttribute('src') === nextState.advertisement.item.url
                && imageElement.getAttribute('alt') === nextState.advertisement.item.title;
        }

        function renderSinger(nextState) {
            const nextText = typeof nextState.singer.text === 'string' && nextState.singer.text.trim()
                ? nextState.singer.text.trim()
                : 'Show Offline';

            performerNameElement.textContent = nextText;

            if (nextState.singer.avatarUrl) {
                if (singerAvatarElement.tagName !== 'IMG') {
                    const replacement = document.createElement('img');
                    replacement.id = 'live-singer-avatar';
                    replacement.className = 'performer-avatar';
                    singerAvatarElement.replaceWith(replacement);
                }

                const imageElement = document.getElementById('live-singer-avatar');
                imageElement.className = 'performer-avatar';
                imageElement.src = nextState.singer.avatarUrl;
                imageElement.alt = nextText;
                return;
            }

            if (singerAvatarElement.tagName === 'IMG') {
                const placeholder = document.createElement('div');
                placeholder.id = 'live-singer-avatar';
                placeholder.className = 'performer-avatar performer-avatar--placeholder';
                placeholder.setAttribute('aria-hidden', 'true');
                document.getElementById('live-singer-avatar').replaceWith(placeholder);
                return;
            }

            singerAvatarElement.className = 'performer-avatar performer-avatar--placeholder';
        }

        function renderAdvertisement(nextState) {
            liveBody.dataset.rotationActive = nextState.advertisement.rotationIntervalMs ? 'true' : 'false';
            rotationBadgeElement.textContent = nextState.advertisement.rotationIntervalMs
                ? 'Rotating every ' + Math.max(1, Math.floor(nextState.advertisement.rotationIntervalMs / 1000)) + 's'
                : 'Rotating';

            const currentSlide = getVisibleAdSlide();
            if (isSameAdSlide(currentSlide, nextState)) {
                return;
            }

            const nextSlide = buildAdSlide(nextState);
            liveAdStageElement.appendChild(nextSlide);

            requestAnimationFrame(() => {
                nextSlide.classList.add('live-ad-slide--visible');
                if (currentSlide) currentSlide.classList.remove('live-ad-slide--visible');
            });

            if (currentSlide) {
                setTimeout(() => {
                    if (currentSlide.parentElement === liveAdStageElement) {
                        currentSlide.remove();
                    }
                }, 600);
            }
        }

        function renderLiveState(nextState) {
            liveBody.dataset.stageActive = nextState.stageActive ? 'true' : 'false';
            renderSinger(nextState);
            renderAdvertisement(nextState);
        }

        async function refreshLiveState() {
            const response = await fetch('/obs/live.json', { cache: 'no-store' });
            if (!response.ok) return;
            const nextState = await response.json();
            renderLiveState(nextState);
        }

        refreshLiveState().catch(() => {});
        setInterval(() => {
            refreshLiveState().catch(() => {});
        }, 1500);
    </script>
</body>
</html>`;
}

async function handleAdminRequest(request, response, url) {
    if (!config.ADMIN_PANEL_PASSWORD) {
        sendHtml(response, 503, buildAdminLoginHtml('The admin panel is disabled until ADMIN_PANEL_PASSWORD is configured.'));
        return;
    }

    if (url.pathname === '/admin/login' && request.method === 'POST') {
        const form = parseFormBody(await readRequestBody(request));
        if (form.password !== config.ADMIN_PANEL_PASSWORD) {
            sendHtml(response, 401, buildAdminLoginHtml('Incorrect password.'));
            return;
        }

        const session = createAdminSession();
        redirect(response, '/admin', {
            'Set-Cookie': `drowsy_admin_session=${session.token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${config.ADMIN_PANEL_SESSION_HOURS * 60 * 60}`,
        });
        return;
    }

    if (url.pathname === '/admin' && request.method === 'GET') {
        const session = getAdminSession(request);
        if (!session) {
            sendHtml(response, 200, buildAdminLoginHtml());
            return;
        }

        sendHtml(response, 200, buildAdminPanelHtml(await buildAdminPanelState()));
        return;
    }

    const session = getAdminSession(request);
    if (!session) {
        redirect(response, '/admin');
        return;
    }

    if (url.pathname === '/admin/logout' && request.method === 'POST') {
        destroyAdminSession(request);
        redirect(response, '/admin', {
            'Set-Cookie': 'drowsy_admin_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0',
        });
        return;
    }

    if (url.pathname === '/admin/api/state' && request.method === 'GET') {
        sendJson(response, 200, await buildAdminPanelState());
        return;
    }

    if (url.pathname === '/admin/ads/select' && request.method === 'POST') {
        const form = parseFormBody(await readRequestBody(request));
        const index = Number.parseInt(form.index ?? '', 10);
        if (Number.isInteger(index) && state.setActiveAdvertisementByIndex(index)) {
            redirect(response, '/admin');
            return;
        }

        sendHtml(response, 400, buildAdminPanelHtml(await buildAdminPanelState()));
        return;
    }

    if (url.pathname === '/admin/ads/rotate' && request.method === 'POST') {
        const form = parseFormBody(await readRequestBody(request));
        const seconds = Number.parseInt(form.seconds ?? '', 10);
        if (Number.isInteger(seconds) && seconds >= 5 && seconds <= 3600) {
            state.setAdvertisementRotationIntervalMs(seconds * 1000);
            redirect(response, '/admin');
            return;
        }

        sendHtml(response, 400, buildAdminPanelHtml(await buildAdminPanelState()));
        return;
    }

    if (url.pathname === '/admin/ads/rotate-stop' && request.method === 'POST') {
        state.setAdvertisementRotationIntervalMs(null);
        redirect(response, '/admin');
        return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
}

function startHttpServer() {

    const server = http.createServer((request, response) => {
        Promise.resolve((async () => {
        const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
        if (await adminPanel.handleRequest(request, response, url)) return;

        if (url.pathname === '/health') {
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ ok: true }));
            return;
        }

        if (url.pathname.startsWith('/obs/')) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }

        if (url.pathname === '/obs/now-singing.txt') {
            response.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            response.end(`${currentSinger}\n`);
            return;
        }

        if (url.pathname === '/obs/now-singing.json') {
            response.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            response.end(JSON.stringify(currentOverlay));
            return;
        }

        if (url.pathname === '/obs/now-singing') {
            response.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            response.end(buildObsOverlayHtml(currentOverlay));
            return;
        }

        if (url.pathname === '/obs/ad.json') {
            response.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            response.end(JSON.stringify(currentAdvertisement));
            return;
        }

        if (url.pathname === '/obs/live.json') {
            response.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            response.end(JSON.stringify(readObsLiveEventOverlay()));
            return;
        }

        if (url.pathname === '/obs/ad') {
            response.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            response.end(buildAdvertisementOverlayHtml(currentAdvertisement));
            return;
        }

        if (url.pathname === '/obs/live') {
            response.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            response.end(buildLiveEventOverlayHtml(readObsLiveEventOverlay()));
            return;
        }

        if (url.pathname.startsWith('/obs/ads/files/')) {
            const fileName = decodeURIComponent(url.pathname.slice('/obs/ads/files/'.length));
            const path = require('path');
            const safeFileName = path.basename(fileName);
            const filePath = path.resolve(config.ADS_DIR, safeFileName);

            if (safeFileName !== fileName || !filePath.startsWith(path.resolve(config.ADS_DIR) + path.sep) || !fs.existsSync(filePath)) {
                response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end('Not found');
                return;
            }

            const advertisement = readObsAdvertisementByFileName(safeFileName);
            response.writeHead(200, {
                'Content-Type': advertisement?.contentType ?? 'application/octet-stream',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            fs.createReadStream(filePath).pipe(response);
            return;
        }

        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        })()).catch(error => {
            console.error('HTTP server request failed:', error);
            if (!response.headersSent) {
                response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            }
            response.end('Internal server error');
        });
    });

    server.listen(config.ADMIN_HTTP_PORT, config.ADMIN_HTTP_HOST, () => {
        console.log(`Admin HTTP server listening on http://${config.ADMIN_HTTP_HOST}:${config.ADMIN_HTTP_PORT}`);
    });

    server.on('error', error => {
        console.error('Failed to start admin HTTP server:', error);
        if (error.code === 'EADDRINUSE') {
            console.error(`Port ${config.ADMIN_HTTP_PORT} is already in use. Stop the existing bot process or choose a different ADMIN_HTTP_PORT.`);
            process.exit(1);
        }
    });
}

function bindAsync(eventName, handler) {
    client.on(eventName, (...args) => {
        Promise.resolve(handler(...args)).catch(error => {
            console.error(`Unhandled ${eventName} error:`, error);
        });
    });
}
    startHttpServer();

client.once('clientReady', async () => {
    console.log('Drowsy bot online.');

    const rest = new REST({ version: '10' }).setToken(config.BOT_TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(config.CLIENT_ID, config.GUILD_ID), { body: buildCommands() });
    } catch (error) {
        console.error('Failed to register slash commands:', error);
    }

    await communityFeature.restoreScheduledTasks();
    await communityFeature.restoreVoiceHourSessions();
});

bindAsync('messageCreate', message => communityFeature.handleMessageCreate(message));
bindAsync('voiceStateUpdate', (oldState, newState) => communityFeature.handleVoiceStateUpdate(oldState, newState));
bindAsync('interactionCreate', interaction => communityFeature.handleInteraction(interaction));

client.login(config.BOT_TOKEN);
