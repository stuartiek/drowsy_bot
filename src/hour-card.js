const fs = require('fs');
const path = require('path');

const WIDTH = 856;
const HEIGHT = 464;
const FONT_FAMILY = '"Satoshi", "Segoe UI", Arial, sans-serif';
const DISPLAY_FONT_FAMILY = '"Satoshi", "Segoe UI Emoji", "Segoe UI Symbol", "Segoe UI", Arial, sans-serif';
let satoshiRegistered = false;
let symbolFontsRegistered = false;

const COLORS = {
    page: '#f3f6ff',
    panel: '#e6ecff',
    panelDark: '#d8e2ff',
    chip: '#c9d8ff',
    text: '#27314f',
    muted: '#6b789d',
    green: '#29c7a7',
    pink: '#f26ca7',
    cyan: '#68c7ff',
    violet: '#7c72ff',
    peach: '#ffb38a',
    shadow: 'rgba(121, 137, 196, 0.22)',
    shadowSoft: 'rgba(139, 155, 212, 0.16)',
    highlight: 'rgba(255, 255, 255, 0.94)',
};

function strokeRound(ctx, x, y, width, height, radius, strokeStyle, lineWidth = 1) {
    ctx.save();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    roundedRect(ctx, x, y, width, height, radius);
    ctx.stroke();
    ctx.restore();
}

function fillClippedRound(ctx, x, y, width, height, radius, draw) {
    ctx.save();
    roundedRect(ctx, x, y, width, height, radius);
    ctx.clip();
    draw();
    ctx.restore();
}

function getFontSearchPaths() {
    const rootDir = path.resolve(__dirname, '..');
    const configuredPath = process.env.SATOSHI_FONT_PATH?.trim();
    const candidates = [
        configuredPath,
        path.join(rootDir, 'assets', 'fonts', 'Satoshi-Regular.ttf'),
        path.join(rootDir, 'assets', 'fonts', 'Satoshi-Regular.otf'),
        path.join(rootDir, 'assets', 'fonts', 'Satoshi-Medium.ttf'),
        path.join(rootDir, 'assets', 'fonts', 'Satoshi-Medium.otf'),
        path.join(rootDir, 'assets', 'fonts', 'Satoshi-Bold.ttf'),
        path.join(rootDir, 'assets', 'fonts', 'Satoshi-Bold.otf'),
        path.join(rootDir, 'assests', 'fonts', 'Satoshi-Regular.ttf'),
        path.join(rootDir, 'assests', 'fonts', 'Satoshi-Regular.otf'),
        path.join(rootDir, 'assests', 'fonts', 'Satoshi-Medium.ttf'),
        path.join(rootDir, 'assests', 'fonts', 'Satoshi-Medium.otf'),
        path.join(rootDir, 'assests', 'fonts', 'Satoshi-Bold.ttf'),
        path.join(rootDir, 'assests', 'fonts', 'Satoshi-Bold.otf'),
    ];

    return candidates.filter(Boolean);
}

function registerSatoshiFont(GlobalFonts) {
    if (satoshiRegistered || !GlobalFonts?.registerFromPath) return;

    let registeredAny = false;
    for (const fontPath of getFontSearchPaths()) {
        if (!fs.existsSync(fontPath)) continue;
        registeredAny = GlobalFonts.registerFromPath(fontPath, 'Satoshi') || registeredAny;
    }

    satoshiRegistered = registeredAny;
}

function getSymbolFontSearchPaths() {
    const windowsFontsDir = process.env.WINDIR ? path.join(process.env.WINDIR, 'Fonts') : null;
    const candidates = [
        windowsFontsDir ? path.join(windowsFontsDir, 'seguiemj.ttf') : null,
        windowsFontsDir ? path.join(windowsFontsDir, 'seguisym.ttf') : null,
        windowsFontsDir ? path.join(windowsFontsDir, 'segoeui.ttf') : null,
    ];

    return candidates.filter(Boolean);
}

function registerSymbolFonts(GlobalFonts) {
    if (symbolFontsRegistered || !GlobalFonts?.registerFromPath) return;

    let registeredAny = false;
    for (const fontPath of getSymbolFontSearchPaths()) {
        if (!fs.existsSync(fontPath)) continue;

        const lowerPath = fontPath.toLowerCase();
        const familyName = lowerPath.endsWith('seguiemj.ttf')
            ? 'Segoe UI Emoji'
            : lowerPath.endsWith('seguisym.ttf')
                ? 'Segoe UI Symbol'
                : 'Segoe UI';

        registeredAny = GlobalFonts.registerFromPath(fontPath, familyName) || registeredAny;
    }

    symbolFontsRegistered = registeredAny;
}

function formatHours(milliseconds) {
    return (milliseconds / 3600000).toFixed(2);
}

function formatMessageCount(value) {
    return `${value ?? 0} msgs`;
}

function formatDate(date) {
    if (!date) return 'Unknown';

    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
    }).format(date).replace(',', '');
}

function roundedRect(ctx, x, y, width, height, radius) {
    const safeRadius = Math.min(radius, width / 2, height / 2);

    ctx.beginPath();
    ctx.moveTo(x + safeRadius, y);
    ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
    ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
    ctx.arcTo(x, y + height, x, y, safeRadius);
    ctx.arcTo(x, y, x + width, y, safeRadius);
    ctx.closePath();
}

function fillRound(ctx, x, y, width, height, radius, fillStyle) {
    ctx.fillStyle = fillStyle;
    roundedRect(ctx, x, y, width, height, radius);
    ctx.fill();
}

function panel(ctx, x, y, width, height) {
    ctx.save();
    ctx.shadowColor = COLORS.highlight;
    ctx.shadowBlur = 16;
    ctx.shadowOffsetX = -8;
    ctx.shadowOffsetY = -8;
    fillRound(ctx, x, y, width, height, 12, COLORS.panel);
    ctx.restore();

    ctx.save();
    ctx.shadowColor = COLORS.shadow;
    ctx.shadowBlur = 20;
    ctx.shadowOffsetX = 10;
    ctx.shadowOffsetY = 10;
    fillRound(ctx, x, y, width, height, 12, COLORS.panel);
    ctx.restore();

    const gradient = ctx.createLinearGradient(x, y, x, y + height);
    gradient.addColorStop(0, '#f3f6ff');
    gradient.addColorStop(0.45, COLORS.panel);
    gradient.addColorStop(1, '#dbe5ff');
    fillRound(ctx, x, y, width, height, 12, gradient);

    fillClippedRound(ctx, x, y, width, height, 12, () => {
        const glow = ctx.createRadialGradient(x + (width * 0.2), y + (height * 0.12), 0, x + (width * 0.2), y + (height * 0.12), width * 0.85);
        glow.addColorStop(0, 'rgba(124, 114, 255, 0.16)');
        glow.addColorStop(0.5, 'rgba(104, 199, 255, 0.1)');
        glow.addColorStop(0.75, 'rgba(255, 179, 138, 0.08)');
        glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(x, y, width, height);

        const topSheen = ctx.createLinearGradient(x, y, x, y + (height * 0.5));
        topSheen.addColorStop(0, 'rgba(255, 255, 255, 0.4)');
        topSheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = topSheen;
        ctx.fillRect(x, y, width, height * 0.5);
    });

    strokeRound(ctx, x + 0.5, y + 0.5, width - 1, height - 1, 11.5, 'rgba(255, 255, 255, 0.65)');
    strokeRound(ctx, x + 1.5, y + 1.5, width - 3, height - 3, 10.5, 'rgba(134, 150, 205, 0.14)');
}

function text(ctx, value, x, y, size, options = {}) {
    ctx.save();
    ctx.fillStyle = options.color ?? COLORS.text;
    ctx.font = `${options.weight ?? 700} ${size}px ${options.fontFamily ?? FONT_FAMILY}`;
    ctx.textBaseline = options.baseline ?? 'alphabetic';

    if (options.maxWidth) {
        const ellipsis = '...';
        let output = String(value);
        while (ctx.measureText(output).width > options.maxWidth && output.length > 0) {
            output = output.slice(0, -1);
        }

        if (output !== value && output.length > ellipsis.length) {
            output = `${output.slice(0, -ellipsis.length)}${ellipsis}`;
        }

        ctx.fillText(output, x, y);
    } else {
        ctx.fillText(String(value), x, y);
    }

    ctx.restore();
}

function wrappedText(ctx, value, x, y, size, options = {}) {
    ctx.save();
    ctx.fillStyle = options.color ?? COLORS.text;
    ctx.font = `${options.weight ?? 700} ${size}px ${options.fontFamily ?? FONT_FAMILY}`;
    ctx.textBaseline = options.baseline ?? 'alphabetic';

    const maxWidth = options.maxWidth ?? Number.POSITIVE_INFINITY;
    const lineHeight = options.lineHeight ?? Math.round(size * 1.25);
    const maxLines = options.maxLines ?? Number.POSITIVE_INFINITY;
    const words = String(value).split(/\s+/).filter(Boolean);
    const lines = [];
    let currentLine = '';

    for (const word of words) {
        const nextLine = currentLine ? `${currentLine} ${word}` : word;
        if (ctx.measureText(nextLine).width <= maxWidth || !currentLine) {
            currentLine = nextLine;
            continue;
        }

        lines.push(currentLine);
        currentLine = word;
        if (lines.length >= maxLines) break;
    }

    if (lines.length < maxLines && currentLine) {
        lines.push(currentLine);
    }

    const renderedLines = lines.slice(0, maxLines);
    if (lines.length > maxLines && renderedLines.length > 0) {
        let lastLine = renderedLines[renderedLines.length - 1];
        while (ctx.measureText(`${lastLine}...`).width > maxWidth && lastLine.length > 0) {
            lastLine = lastLine.slice(0, -1);
        }
        renderedLines[renderedLines.length - 1] = `${lastLine}...`;
    }

    renderedLines.forEach((line, index) => {
        ctx.fillText(line, x, y + (index * lineHeight));
    });

    ctx.restore();
}

function normalizeCardText(value) {
    if (value === null || value === undefined) return '';

    return String(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u200B-\u200D\uFE0E\uFE0F]/g, '')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/[•·]/g, '-')
        .replace(/[–—―]/g, '-')
        .replace(/[│┃╎╏]/g, '|')
        .replace(/[★☆✦✧✩✪✫✬✭✮✯]/g, '*')
        .replace(/[♡♥]/g, '<3')
        .replace(/[【】]/g, '[]')
        .replace(/[「」『』]/g, '"')
        .replace(/[^\x20-\x7E]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function statRow(ctx, x, y, label, value) {
    const rowGradient = ctx.createLinearGradient(x, y, x, y + 34);
    rowGradient.addColorStop(0, '#f4f7ff');
    rowGradient.addColorStop(1, '#dde6ff');
    fillRound(ctx, x, y, 260, 34, 5, rowGradient);

    const chipGradient = ctx.createLinearGradient(x, y, x, y + 34);
    chipGradient.addColorStop(0, '#8c80ff');
    chipGradient.addColorStop(0.5, '#68c7ff');
    chipGradient.addColorStop(1, '#8ee0c5');
    fillRound(ctx, x, y, 84, 34, 5, chipGradient);

    strokeRound(ctx, x + 0.5, y + 0.5, 259, 33, 4.5, 'rgba(255, 255, 255, 0.62)');
    strokeRound(ctx, x + 0.5, y + 0.5, 83, 33, 4.5, 'rgba(255, 255, 255, 0.28)');
    text(ctx, label, x + 17, y + 23, 22, { maxWidth: 66 });
    text(ctx, value, x + 104, y + 22, 20, { color: COLORS.text, weight: 500, maxWidth: 140 });
}

function drawInitialsAvatar(ctx, subject) {
    const name = subject.displayName ?? subject.user.globalName ?? subject.user.username;
    const initials = name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(part => part[0])
        .join('')
        .toUpperCase() || '?';

    const avatarGradient = ctx.createLinearGradient(12, 8, 70, 66);
    avatarGradient.addColorStop(0, '#7c72ff');
    avatarGradient.addColorStop(0.55, '#68c7ff');
    avatarGradient.addColorStop(1, '#ffb38a');
    fillRound(ctx, 12, 8, 58, 58, 14, avatarGradient);
    text(ctx, initials, 23, 45, 21, { color: COLORS.text, maxWidth: 38 });
}

async function drawAvatar(ctx, subject, loadImage) {
    const avatarUrl = subject.user.displayAvatarURL?.({ extension: 'png', size: 128 }) ?? null;
    if (!avatarUrl) {
        drawInitialsAvatar(ctx, subject);
        return;
    }

    try {
        const image = await loadImage(avatarUrl);
        ctx.save();
        roundedRect(ctx, 12, 8, 58, 58, 14);
        ctx.clip();
        ctx.drawImage(image, 12, 8, 58, 58);
        ctx.restore();
    } catch (error) {
        drawInitialsAvatar(ctx, subject);
    }
}

function dateBox(ctx, x, label, value) {
    const gradient = ctx.createLinearGradient(x, 7, x, 67);
    gradient.addColorStop(0, '#f7f9ff');
    gradient.addColorStop(1, '#dfe7ff');
    fillRound(ctx, x, 7, 138, 60, 7, gradient);
    fillClippedRound(ctx, x, 7, 138, 60, 7, () => {
        const highlight = ctx.createLinearGradient(x, 7, x, 34);
        highlight.addColorStop(0, 'rgba(255, 255, 255, 0.5)');
        highlight.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = highlight;
        ctx.fillRect(x, 7, 138, 27);
    });
    strokeRound(ctx, x + 0.5, 7.5, 137, 59, 6.5, 'rgba(255, 255, 255, 0.65)');
    text(ctx, label, x + 12, 29, 16, { color: COLORS.text, maxWidth: 114 });
    text(ctx, value, x + 12, 57, 20, { color: COLORS.muted, weight: 500, maxWidth: 114 });
}

function eventDateBox(ctx, x, y, width, height, label, primaryValue, secondaryValue) {
    const gradient = ctx.createLinearGradient(x, y, x, y + height);
    gradient.addColorStop(0, '#f7f9ff');
    gradient.addColorStop(1, '#dfe7ff');
    fillRound(ctx, x, y, width, height, 9, gradient);
    fillClippedRound(ctx, x, y, width, height, 9, () => {
        const highlight = ctx.createLinearGradient(x, y, x, y + (height * 0.42));
        highlight.addColorStop(0, 'rgba(255, 255, 255, 0.5)');
        highlight.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = highlight;
        ctx.fillRect(x, y, width, height * 0.42);
    });
    strokeRound(ctx, x + 0.5, y + 0.5, width - 1, height - 1, 8.5, 'rgba(255, 255, 255, 0.65)');
    text(ctx, label, x + 12, y + 24, 16, { color: COLORS.text, maxWidth: width - 24 });
    text(ctx, primaryValue, x + 12, y + 48, 17, { color: COLORS.muted, weight: 600, maxWidth: width - 24 });
    text(ctx, secondaryValue, x + 12, y + 68, 16, { color: COLORS.muted, weight: 500, maxWidth: width - 24 });
}

function formatRank(rankInfo) {
    if (!rankInfo?.rank) return 'Unranked';
    return `#${rankInfo.rank}`;
}

function drawRanks(ctx, ranks) {
    panel(ctx, 12, 80, 268, 162);
    text(ctx, 'Server Ranks', 22, 105, 22);
    statRow(ctx, 21, 122, 'Voice', formatRank(ranks?.voice));
    statRow(ctx, 21, 184, 'Msgs', formatRank(ranks?.messages));
}

function drawMessages(ctx, totals) {
    panel(ctx, 292, 80, 268, 162);
    text(ctx, 'Messages', 302, 105, 22);
    statRow(ctx, 302, 118, '1d', `${totals[1] ?? 0} msgs`);
    statRow(ctx, 302, 158, '7d', `${totals[7] ?? 0} msgs`);
    statRow(ctx, 302, 198, '14d', `${totals[14] ?? 0} msgs`);
}

function drawVoiceActivity(ctx, totals) {
    panel(ctx, 574, 80, 268, 162);
    text(ctx, 'Voice Activity', 584, 105, 22);
    statRow(ctx, 584, 118, '1d', `${formatHours(totals[1] ?? 0)} hours`);
    statRow(ctx, 584, 158, '7d', `${formatHours(totals[7] ?? 0)} hours`);
    statRow(ctx, 584, 198, '14d', `${formatHours(totals[14] ?? 0)} hours`);
}

function drawTopChannels(ctx, topActivity) {
    panel(ctx, 12, 256, 408, 162);
    text(ctx, 'Top Channels & Apps', 24, 284, 21);

    fillRound(ctx, 64, 294, 346, 34, 5, COLORS.panelDark);
    fillRound(ctx, 64, 336, 346, 34, 5, COLORS.panelDark);
    fillRound(ctx, 64, 378, 346, 34, 5, COLORS.panelDark);

    text(ctx, '🔊', 27, 320, 20, { color: COLORS.cyan });
    text(ctx, normalizeCardText(topActivity?.voice?.name ?? 'No voice data'), 84, 319, 23, { maxWidth: 150, fontFamily: DISPLAY_FONT_FAMILY });
    text(ctx, `${formatHours(topActivity?.voice?.total ?? 0)} hours`, 244, 319, 20, { color: COLORS.text, weight: 500, maxWidth: 150 });

    text(ctx, '#', 25, 361, 20, { color: COLORS.violet });
    text(ctx, normalizeCardText(topActivity?.messages?.name ?? 'No message data'), 84, 361, 23, { maxWidth: 150, fontFamily: DISPLAY_FONT_FAMILY });
    text(ctx, formatMessageCount(topActivity?.messages?.total ?? 0), 244, 361, 20, { color: COLORS.text, weight: 500, maxWidth: 150 });

    text(ctx, '14d leaders', 84, 404, 19, { color: COLORS.muted, weight: 600, maxWidth: 150 });
    text(ctx, 'Voice + Messages', 244, 404, 18, { color: COLORS.muted, weight: 500, maxWidth: 150 });
}

function drawChart(ctx, voiceTotals, messageTotals) {
    panel(ctx, 432, 256, 410, 162);
    text(ctx, 'Charts', 446, 291, 23);

    ctx.fillStyle = COLORS.green;
    ctx.beginPath();
    ctx.arc(641, 274, 8, 0, Math.PI * 2);
    ctx.fill();
    text(ctx, 'Message', 658, 281, 20);

    ctx.fillStyle = COLORS.pink;
    ctx.beginPath();
    ctx.arc(766, 274, 8, 0, Math.PI * 2);
    ctx.fill();
    text(ctx, 'Voice', 783, 281, 20);

    const voiceValues = [voiceTotals[1] ?? 0, voiceTotals[7] ?? 0, voiceTotals[14] ?? 0].map(value => value / 3600000);
    const messageValues = [messageTotals[1] ?? 0, messageTotals[7] ?? 0, messageTotals[14] ?? 0];
    const max = Math.max(...voiceValues, ...messageValues, 1);
    const labels = ['1d', '7d', '14d'];
    const baseY = 390;

    labels.forEach((label, index) => {
        const x = 470 + (index * 105);
        const messageHeight = Math.max(4, Math.round((messageValues[index] / max) * 78));
        const voiceHeight = Math.max(4, Math.round((voiceValues[index] / max) * 78));

        const messageGradient = ctx.createLinearGradient(x, baseY - messageHeight, x, baseY);
        messageGradient.addColorStop(0, '#7c72ff');
        messageGradient.addColorStop(1, '#f26ca7');
        fillRound(ctx, x, baseY - messageHeight, 24, messageHeight, 7, messageGradient);

        const voiceGradient = ctx.createLinearGradient(x + 30, baseY - voiceHeight, x + 30, baseY);
        voiceGradient.addColorStop(0, '#29c7a7');
        voiceGradient.addColorStop(1, '#68c7ff');
        fillRound(ctx, x + 30, baseY - voiceHeight, 24, voiceHeight, 7, voiceGradient);

        text(ctx, label, x + 12, 413, 18, { color: COLORS.muted });
    });
}

function drawEventStatTile(ctx, x, y, width, height, label, value, accentColors) {
    const tileGradient = ctx.createLinearGradient(x, y, x + width, y + height);
    tileGradient.addColorStop(0, accentColors[0]);
    tileGradient.addColorStop(1, accentColors[1]);
    fillRound(ctx, x, y, width, height, 12, tileGradient);
    fillClippedRound(ctx, x, y, width, height, 12, () => {
        const glow = ctx.createRadialGradient(x + 28, y + 20, 0, x + 28, y + 20, width * 0.9);
        glow.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
        glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(x, y, width, height);
    });
    strokeRound(ctx, x + 0.5, y + 0.5, width - 1, height - 1, 11.5, 'rgba(255, 255, 255, 0.28)');
    text(ctx, label, x + 16, y + 31, 18, { color: '#f6f8ff', weight: 600, maxWidth: width - 32 });
    text(ctx, value, x + 16, y + 78, 36, { color: '#ffffff', weight: 700, maxWidth: width - 32 });
}

function summaryRow(ctx, x, y, width, label, value) {
    const labelChipWidth = 116;

    const rowGradient = ctx.createLinearGradient(x, y, x, y + 34);
    rowGradient.addColorStop(0, '#f4f7ff');
    rowGradient.addColorStop(1, '#dde6ff');
    fillRound(ctx, x, y, width, 34, 5, rowGradient);

    const chipGradient = ctx.createLinearGradient(x, y, x, y + 34);
    chipGradient.addColorStop(0, '#8c80ff');
    chipGradient.addColorStop(0.5, '#68c7ff');
    chipGradient.addColorStop(1, '#8ee0c5');
    fillRound(ctx, x, y, labelChipWidth, 34, 5, chipGradient);

    strokeRound(ctx, x + 0.5, y + 0.5, width - 1, 33, 4.5, 'rgba(255, 255, 255, 0.62)');
    strokeRound(ctx, x + 0.5, y + 0.5, labelChipWidth - 1, 33, 4.5, 'rgba(255, 255, 255, 0.28)');
    text(ctx, label, x + 14, y + 23, 19, { maxWidth: labelChipWidth - 26 });
    text(ctx, normalizeCardText(value), x + labelChipWidth + 20, y + 22, 20, { color: COLORS.text, weight: 500, maxWidth: width - labelChipWidth - 34, fontFamily: DISPLAY_FONT_FAMILY });
}

function formatDateTime(date) {
    if (!date) return 'Unknown';

    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: 'UTC',
        timeZoneName: 'short',
    }).format(date);
}

function splitDateTimeParts(value) {
    if (!value || value === 'Unknown') {
        return ['Unknown', ''];
    }

    const parts = String(value).split(', ');
    if (parts.length < 3) {
        return [String(value), ''];
    }

    return [`${parts[0]}, ${parts[1]}`, parts.slice(2).join(', ')];
}

async function buildEventStatsCard({ guild, stats }) {
    const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
    registerSatoshiFont(GlobalFonts);
    registerSymbolFonts(GlobalFonts);

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    const startedAt = stats.startedAt ? new Date(stats.startedAt) : null;
    const endedAt = stats.endedAt ? new Date(stats.endedAt) : null;
    const [startedDate, startedTime] = splitDateTimeParts(formatDateTime(startedAt));
    const [endedDate, endedTime] = splitDateTimeParts(formatDateTime(endedAt));

    const background = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
    background.addColorStop(0, '#f7f9ff');
    background.addColorStop(0.45, '#e7edff');
    background.addColorStop(1, '#d8e2ff');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const aura = ctx.createRadialGradient(140, 74, 0, 140, 74, 430);
    aura.addColorStop(0, 'rgba(124, 114, 255, 0.2)');
    aura.addColorStop(0.48, 'rgba(104, 199, 255, 0.14)');
    aura.addColorStop(0.8, 'rgba(255, 179, 138, 0.12)');
    aura.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = aura;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    fillRound(ctx, 0, 0, WIDTH, HEIGHT, 18, 'rgba(255, 255, 255, 0.08)');

    panel(ctx, 12, 12, 830, 100);
    text(ctx, 'Post-Event Stats', 28, 46, 30, { maxWidth: 320 });
    text(ctx, normalizeCardText(guild.name), 28, 74, 22, { color: COLORS.muted, weight: 500, maxWidth: 300, fontFamily: DISPLAY_FONT_FAMILY });
    eventDateBox(ctx, 434, 24, 190, 72, 'Started', startedDate, startedTime);
    eventDateBox(ctx, 638, 24, 190, 72, 'Ended', endedDate, endedTime);

    drawEventStatTile(ctx, 20, 118, 260, 110, 'Performers', String(stats.performers ?? 0), ['#7c72ff', '#68c7ff']);
    drawEventStatTile(ctx, 298, 118, 260, 110, 'Audience', String(stats.audience ?? 0), ['#f26ca7', '#ffb38a']);
    drawEventStatTile(ctx, 576, 118, 254, 110, 'Peak Attendance', String(stats.peakAttendance ?? 0), ['#8c80ff', '#8ee0c5']);

    panel(ctx, 20, 248, 452, 170);
    text(ctx, 'Event Summary', 34, 277, 23);
    summaryRow(ctx, 34, 294, 424, 'Stage', stats.stageName ?? 'Unknown');
    summaryRow(ctx, 34, 336, 424, 'Runtime', stats.runtimeText ?? 'Unknown');
    summaryRow(ctx, 34, 378, 424, 'Report', 'Auto-generated');

    panel(ctx, 490, 248, 340, 170);
    text(ctx, 'What Was Counted', 506, 277, 23);
    text(ctx, 'Performers', 510, 315, 20, { color: COLORS.violet, weight: 700, maxWidth: 110 });
    wrappedText(ctx, 'Unique members advanced on stage.', 624, 311, 16, { color: COLORS.muted, weight: 500, maxWidth: 178, lineHeight: 18, maxLines: 2 });
    text(ctx, 'Audience', 510, 350, 20, { color: COLORS.cyan, weight: 700, maxWidth: 110 });
    wrappedText(ctx, 'Unique attendees who never performed.', 624, 346, 16, { color: COLORS.muted, weight: 500, maxWidth: 178, lineHeight: 18, maxLines: 2 });
    text(ctx, 'Peak', 510, 385, 20, { color: COLORS.pink, weight: 700, maxWidth: 110 });
    wrappedText(ctx, 'Highest live headcount in the stage.', 624, 381, 16, { color: COLORS.muted, weight: 500, maxWidth: 178, lineHeight: 18, maxLines: 2 });

    text(ctx, 'Drowsy Bot', 24, 450, 17, { color: COLORS.text });
    text(ctx, 'Timezone: UTC', 734, 450, 17, { color: COLORS.muted });

    return canvas.toBuffer('image/png');
}

async function buildHoursCard({ subject, guild, totals, messageTotals = {}, ranks = {}, topActivity = {} }) {
    const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
    registerSatoshiFont(GlobalFonts);
    registerSymbolFonts(GlobalFonts);

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    const displayName = normalizeCardText(subject.displayName ?? subject.user.globalName ?? subject.user.username);

    const background = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
    background.addColorStop(0, '#f7f9ff');
    background.addColorStop(0.45, '#e7edff');
    background.addColorStop(1, '#d8e2ff');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const aura = ctx.createRadialGradient(120, 80, 0, 120, 80, 420);
    aura.addColorStop(0, 'rgba(124, 114, 255, 0.18)');
    aura.addColorStop(0.5, 'rgba(104, 199, 255, 0.14)');
    aura.addColorStop(0.78, 'rgba(255, 179, 138, 0.1)');
    aura.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = aura;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    fillRound(ctx, 0, 0, WIDTH, HEIGHT, 18, 'rgba(255, 255, 255, 0.08)');
    await drawAvatar(ctx, subject, loadImage);

    text(ctx, displayName, 84, 35, 26, { maxWidth: 430, fontFamily: DISPLAY_FONT_FAMILY });
    text(ctx, normalizeCardText(guild.name), 84, 61, 22, { color: COLORS.muted, weight: 500, maxWidth: 390, fontFamily: DISPLAY_FONT_FAMILY });

    dateBox(ctx, 546, 'Created On', formatDate(subject.user.createdAt));
    dateBox(ctx, 704, 'Joined On', formatDate(subject.joinedAt));

    drawRanks(ctx, ranks);
    drawMessages(ctx, messageTotals);
    drawVoiceActivity(ctx, totals);
    drawTopChannels(ctx, topActivity);
    drawChart(ctx, totals, messageTotals);

    text(ctx, 'Server Lookback: Last 14 days - Timezone: UTC', 14, 450, 17, { color: COLORS.text });
    text(ctx, 'Drowsy Bot', 734, 450, 17, { color: COLORS.muted });

    return canvas.toBuffer('image/png');
}

module.exports = { buildHoursCard, buildEventStatsCard };
