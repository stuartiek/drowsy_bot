const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
const BOT_SETTINGS_JSON_FILE = path.join(DATA_DIR, 'bot-settings.json');
const parsedAdminHttpPort = Number.parseInt(process.env.ADMIN_HTTP_PORT ?? '', 10);
const parsedAdminSessionHours = Number.parseInt(process.env.ADMIN_PANEL_SESSION_HOURS ?? '', 10);
const parsedShyStageBaseName = process.env.SHY_STAGE_BASE_NAME?.trim();
const parsedShyStageUnusedDeleteMinutes = Number.parseInt(process.env.SHY_STAGE_UNUSED_DELETE_MINUTES ?? '', 10);
const parsedShyStageEmptyDeleteMinutes = Number.parseInt(process.env.SHY_STAGE_EMPTY_DELETE_MINUTES ?? '', 10);
const parsedShyStageCleanupIntervalSeconds = Number.parseInt(process.env.SHY_STAGE_CLEANUP_INTERVAL_SECONDS ?? '', 10);
const parsedShyStageLimitChoices = (process.env.SHY_STAGE_LIMIT_CHOICES ?? '')
    .split(',')
    .map(token => token.trim())
    .filter(Boolean)
    .map(token => token.toLowerCase() === 'unlimited'
        ? 0
        : Number.parseInt(token, 10))
    .filter(value => value === 0 || (Number.isInteger(value) && value >= 1 && value <= 99));
const uniqueShyStageLimitChoices = [...new Set(parsedShyStageLimitChoices)].sort((left, right) => {
    if (left === 0) return 1;
    if (right === 0) return -1;
    return left - right;
});

module.exports = {
    ROOT_DIR,
    BOT_TOKEN: process.env.DISCORD_TOKEN,
    ADMIN_HTTP_HOST: process.env.ADMIN_HTTP_HOST?.trim() || '0.0.0.0',
    ADMIN_HTTP_PORT: Number.isFinite(parsedAdminHttpPort) ? parsedAdminHttpPort : 8080,
    CLIENT_ID: process.env.CLIENT_ID,
    GUILD_ID: process.env.GUILD_ID,
    ALLOW_INVITE_PASSWORD: process.env.ALLOW_INVITE_PASSWORD?.trim(),
    INVITE_REGEX: /(https?:\/\/)?(www\.)?(discord\.gg|discord(?:app)?\.com\/(invite|events))\/[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)?/i,
    DEFAULT_PURGE_SCAN_LIMIT: 250,
    MAX_PURGE_SCAN_LIMIT: 1000,
    BOT_API_TOKEN: (process.env.BOT_API_SECRET || process.env.BOT_API_TOKEN)?.trim() || null,
    ADMIN_PANEL_PASSWORD: process.env.ADMIN_PANEL_PASSWORD?.trim() || null,
    ADMIN_PANEL_SESSION_HOURS: Number.isInteger(parsedAdminSessionHours) && parsedAdminSessionHours > 0
        ? parsedAdminSessionHours
        : 12,
    SHY_STAGE_BASE_NAME: parsedShyStageBaseName || 'sleepy singing',
    SHY_STAGE_UNUSED_DELETE_MINUTES: Number.isInteger(parsedShyStageUnusedDeleteMinutes) && parsedShyStageUnusedDeleteMinutes > 0
        ? parsedShyStageUnusedDeleteMinutes
        : 5,
    SHY_STAGE_EMPTY_DELETE_MINUTES: Number.isInteger(parsedShyStageEmptyDeleteMinutes) && parsedShyStageEmptyDeleteMinutes > 0
        ? parsedShyStageEmptyDeleteMinutes
        : 15,
    SHY_STAGE_CLEANUP_INTERVAL_SECONDS: Number.isInteger(parsedShyStageCleanupIntervalSeconds) && parsedShyStageCleanupIntervalSeconds > 0
        ? parsedShyStageCleanupIntervalSeconds
        : 60,
    SHY_STAGE_LIMIT_CHOICES: uniqueShyStageLimitChoices.length > 0
        ? uniqueShyStageLimitChoices
        : [5, 10, 15, 0],
    POST_EVENT_STATS_CHANNEL_ID: '1229141305444012126',
        STAGE_ADMIN_ROLES: ['Realm God', 'Dreamy Defender', 'Dreamland Guard', 'Nighty Knight', 'Tired Esquire'],
    DATA_DIR,
    ASSETS_DIR,
    BOT_SETTINGS_JSON_FILE,
    FILES: {
        guildConfig: path.join(DATA_DIR, 'guild-config.json'),
        allowedInvites: path.join(DATA_DIR, 'allowed-invite-users.json'),
        messageStats: path.join(DATA_DIR, 'message-stats.json'),
        voiceHours: path.join(DATA_DIR, 'voice-hours.json'),
        botSettings: BOT_SETTINGS_JSON_FILE,
    },
};
