const fs = require('fs');
const path = require('path');

function createState(config) {
    fs.mkdirSync(config.ASSETS_DIR, { recursive: true });
    fs.mkdirSync(config.DATA_DIR, { recursive: true });

    if (!fs.existsSync(config.FILES.voiceHours)) {
        fs.writeFileSync(config.FILES.voiceHours, JSON.stringify({
            sessions: [],
            active: {},
            totals: {},
        }, null, 2));
    }

    if (!fs.existsSync(config.FILES.messageStats)) {
        fs.writeFileSync(config.FILES.messageStats, JSON.stringify({
            entries: {},
        }, null, 2));
    }

    if (!fs.existsSync(config.FILES.botSettings)) {
        fs.writeFileSync(config.FILES.botSettings, JSON.stringify({
            shyStage: {
                baseName: config.SHY_STAGE_BASE_NAME,
                alwaysVisibleCount: 2,
                userLimit: 3,
                limitChoices: config.SHY_STAGE_LIMIT_CHOICES,
                unusedDeleteMinutes: config.SHY_STAGE_UNUSED_DELETE_MINUTES,
                emptyDeleteMinutes: config.SHY_STAGE_EMPTY_DELETE_MINUTES,
                cleanupIntervalSeconds: config.SHY_STAGE_CLEANUP_INTERVAL_SECONDS,
            },
            postEventStats: {
                channelId: config.POST_EVENT_STATS_CHANNEL_ID,
            },
            queue: {
                maxQueueLength: 25,
            },
        }, null, 2));
    }

    function readJsonFile(filePath, fallbackValue) {
        if (!fs.existsSync(filePath)) return fallbackValue;

        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (error) {
            console.error(`Failed to parse ${path.basename(filePath)}:`, error);
            return fallbackValue;
        }
    }

    function writeJsonFile(filePath, value) {
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    }

    function loadAllowedInviteUsers() {
        const parsed = readJsonFile(config.FILES.allowedInvites, []);
        if (Array.isArray(parsed)) return new Set(parsed);
        if (parsed && Array.isArray(parsed.users)) return new Set(parsed.users);
        return new Set();
    }

    function getVoiceHoursKey(guildId, userId) {
        return `${guildId}:${userId}`;
    }

    function getMessageStatsKey(guildId, userId) {
        return `${guildId}:${userId}`;
    }

    function normalizeIsoDate(value) {
        const timestamp = Date.parse(value ?? '');
        return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
    }

    function loadVoiceHoursState() {
        const parsed = readJsonFile(config.FILES.voiceHours, {
            sessions: [],
            active: {},
            totals: {},
        });
        const sessions = Array.isArray(parsed?.sessions)
            ? parsed.sessions
                .map(session => ({
                    guildId: typeof session?.guildId === 'string' ? session.guildId : null,
                    userId: typeof session?.userId === 'string' ? session.userId : null,
                    channelId: typeof session?.channelId === 'string' ? session.channelId : null,
                    startedAt: normalizeIsoDate(session?.startedAt),
                    endedAt: normalizeIsoDate(session?.endedAt),
                }))
                .filter(session => session.guildId && session.userId && session.startedAt && session.endedAt)
            : [];
        const active = {};

        if (parsed?.active && typeof parsed.active === 'object') {
            for (const [key, session] of Object.entries(parsed.active)) {
                const guildId = typeof session?.guildId === 'string' ? session.guildId : key.split(':')[0];
                const userId = typeof session?.userId === 'string' ? session.userId : key.split(':')[1];
                const startedAt = normalizeIsoDate(session?.startedAt);
                if (!guildId || !userId || !startedAt) continue;

                active[getVoiceHoursKey(guildId, userId)] = {
                    guildId,
                    userId,
                    channelId: typeof session?.channelId === 'string' ? session.channelId : null,
                    startedAt,
                    muted: session?.muted === true,
                };
            }
        }

        const totals = {};
        if (parsed?.totals && typeof parsed.totals === 'object') {
            for (const [key, value] of Object.entries(parsed.totals)) {
                const guildId = typeof value?.guildId === 'string' ? value.guildId : key.split(':')[0];
                const userId = typeof value?.userId === 'string' ? value.userId : key.split(':')[1];
                const totalMilliseconds = Number.isFinite(value?.totalMilliseconds) && value.totalMilliseconds > 0
                    ? Math.floor(value.totalMilliseconds)
                    : 0;
                if (!guildId || !userId) continue;

                totals[getVoiceHoursKey(guildId, userId)] = {
                    guildId,
                    userId,
                    totalMilliseconds,
                };
            }
        }

        for (const session of sessions) {
            const key = getVoiceHoursKey(session.guildId, session.userId);
            if (totals[key]) continue;

            const startedAtMs = Date.parse(session.startedAt);
            const endedAtMs = Date.parse(session.endedAt);
            const duration = Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs) && endedAtMs > startedAtMs
                ? endedAtMs - startedAtMs
                : 0;

            totals[key] = {
                guildId: session.guildId,
                userId: session.userId,
                totalMilliseconds: duration,
            };
        }

        return { sessions, active, totals };
    }

    function loadMessageStatsState() {
        const parsed = readJsonFile(config.FILES.messageStats, { entries: {} });
        const sourceEntries = parsed && typeof parsed.entries === 'object' && parsed.entries
            ? parsed.entries
            : parsed && typeof parsed === 'object'
                ? parsed
                : {};
        const sourceTotals = parsed?.totals && typeof parsed.totals === 'object'
            ? parsed.totals
            : {};

        const entries = {};
        const totals = {};
        for (const [key, value] of Object.entries(sourceEntries)) {
            const guildId = typeof value?.guildId === 'string' ? value.guildId : key.split(':')[0];
            const userId = typeof value?.userId === 'string' ? value.userId : key.split(':')[1];
            if (!guildId || !userId) continue;

            const normalizedCounts = {};
            const counts = value?.counts && typeof value.counts === 'object' ? value.counts : {};
            for (const [dateKey, count] of Object.entries(counts)) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
                if (!Number.isFinite(count) || count <= 0) continue;
                normalizedCounts[dateKey] = Math.floor(count);
            }

            entries[getMessageStatsKey(guildId, userId)] = {
                guildId,
                userId,
                counts: normalizedCounts,
                channels: {},
            };

            const channels = value?.channels && typeof value.channels === 'object' ? value.channels : {};
            for (const [channelId, channelCounts] of Object.entries(channels)) {
                if (typeof channelId !== 'string' || !channelCounts || typeof channelCounts !== 'object') continue;

                const normalizedChannelCounts = {};
                for (const [dateKey, count] of Object.entries(channelCounts)) {
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
                    if (!Number.isFinite(count) || count <= 0) continue;
                    normalizedChannelCounts[dateKey] = Math.floor(count);
                }

                if (Object.keys(normalizedChannelCounts).length > 0) {
                    entries[getMessageStatsKey(guildId, userId)].channels[channelId] = normalizedChannelCounts;
                }
            }

            const explicitTotal = Number.isFinite(sourceTotals[key]?.totalMessages) && sourceTotals[key].totalMessages > 0
                ? Math.floor(sourceTotals[key].totalMessages)
                : Number.isFinite(value?.totalMessages) && value.totalMessages > 0
                    ? Math.floor(value.totalMessages)
                    : null;
            totals[getMessageStatsKey(guildId, userId)] = {
                guildId,
                userId,
                totalMessages: explicitTotal ?? Object.values(normalizedCounts).reduce((sum, count) => sum + count, 0),
            };
        }

        return { entries, totals };
    }

    const guildConfigs = readJsonFile(config.FILES.guildConfig, {});
    const messageStatsState = loadMessageStatsState();
    const voiceHoursState = loadVoiceHoursState();
    const botSettings = readJsonFile(config.FILES.botSettings, {});

    const state = {
        guildConfigs,
        allowedInviteUsers: loadAllowedInviteUsers(),
        messageStats: messageStatsState,
        voiceHours: voiceHoursState,
        botSettings,
        getBotSettings() {
            return state.botSettings;
        },
        updateBotSettings(updates) {
            state.botSettings = {
                ...state.botSettings,
                ...updates,
                shyStage: { ...state.botSettings.shyStage, ...updates.shyStage },
                postEventStats: { ...state.botSettings.postEventStats, ...updates.postEventStats },
            };
            writeJsonFile(config.FILES.botSettings, state.botSettings);
            return state.botSettings;
        },
        guildStageSessions: new Map(),
        saveAllowedInviteUsers() {
            writeJsonFile(config.FILES.allowedInvites, { users: [...state.allowedInviteUsers] });
        },
        saveMessageStats() {
            writeJsonFile(config.FILES.messageStats, state.messageStats);
        },
        saveVoiceHours() {
            writeJsonFile(config.FILES.voiceHours, state.voiceHours);
        },
        pruneMessageStats(now = new Date()) {
            const cutoff = new Date(now.getTime() - (16 * 24 * 60 * 60 * 1000));
            const cutoffKey = cutoff.toISOString().slice(0, 10);

            for (const entry of Object.values(state.messageStats.entries)) {
                for (const dateKey of Object.keys(entry.counts)) {
                    if (dateKey < cutoffKey) {
                        delete entry.counts[dateKey];
                    }
                }

                if (entry.channels && typeof entry.channels === 'object') {
                    for (const [channelId, channelCounts] of Object.entries(entry.channels)) {
                        for (const dateKey of Object.keys(channelCounts)) {
                            if (dateKey < cutoffKey) {
                                delete channelCounts[dateKey];
                            }
                        }

                        if (Object.keys(channelCounts).length === 0) {
                            delete entry.channels[channelId];
                        }
                    }
                }
            }
        },
        pruneVoiceHourSessions(now = new Date()) {
            const cutoff = now.getTime() - (16 * 24 * 60 * 60 * 1000);
            state.voiceHours.sessions = state.voiceHours.sessions.filter(session => Date.parse(session.endedAt) >= cutoff);
        },
        startVoiceHourSession(guildId, userId, channelId, startedAt = new Date(), muted = false) {
            const key = getVoiceHoursKey(guildId, userId);
            if (state.voiceHours.active[key]) {
                state.voiceHours.active[key].channelId = channelId;
                state.voiceHours.active[key].muted = muted;
                state.saveVoiceHours();
                return state.voiceHours.active[key];
            }

            state.voiceHours.active[key] = {
                guildId,
                userId,
                channelId,
                startedAt: startedAt.toISOString(),
                muted,
            };
            state.saveVoiceHours();
            return state.voiceHours.active[key];
        },
        moveVoiceHourSession(guildId, userId, channelId, movedAt = new Date(), muted = false) {
            const key = getVoiceHoursKey(guildId, userId);
            if (!state.voiceHours.active[key]) return null;
            state.endVoiceHourSession(guildId, userId, movedAt);
            return state.startVoiceHourSession(guildId, userId, channelId, movedAt, muted);
        },
        updateVoiceHourSessionMute(guildId, userId, muted, changedAt = new Date()) {
            const key = getVoiceHoursKey(guildId, userId);
            const activeSession = state.voiceHours.active[key];
            if (!activeSession) return null;

            if (activeSession.muted === muted) return activeSession;

            if (muted) {
                return state.endVoiceHourSession(guildId, userId, changedAt);
            }

            return state.startVoiceHourSession(guildId, userId, activeSession.channelId, changedAt, false);
        },
        setVoiceHourSessionChannel(guildId, userId, channelId) {
            const key = getVoiceHoursKey(guildId, userId);
            if (!state.voiceHours.active[key]) return null;
            state.voiceHours.active[key].channelId = channelId;
            state.saveVoiceHours();
            return state.voiceHours.active[key];
        },
        endVoiceHourSession(guildId, userId, endedAt = new Date()) {
            const key = getVoiceHoursKey(guildId, userId);
            const activeSession = state.voiceHours.active[key];
            if (!activeSession) return null;

            delete state.voiceHours.active[key];

            const startedAtMs = Date.parse(activeSession.startedAt);
            const endedAtMs = endedAt.getTime();
            if (Number.isFinite(startedAtMs) && endedAtMs > startedAtMs) {
                const completedSession = {
                    ...activeSession,
                    endedAt: endedAt.toISOString(),
                };
                const totalKey = getVoiceHoursKey(guildId, userId);
                if (!state.voiceHours.totals[totalKey]) {
                    state.voiceHours.totals[totalKey] = {
                        guildId,
                        userId,
                        totalMilliseconds: 0,
                    };
                }
                state.voiceHours.totals[totalKey].totalMilliseconds += endedAtMs - startedAtMs;
                state.voiceHours.sessions.push(completedSession);
                state.pruneVoiceHourSessions(endedAt);
                state.saveVoiceHours();
                return completedSession;
            }

            state.saveVoiceHours();
            return null;
        },
        getVoiceHourTotals(guildId, userId, now = new Date()) {
            const nowMs = now.getTime();
            const windows = [1, 7, 14];
            const totals = Object.fromEntries(windows.map(days => [days, 0]));
            const sessions = [
                ...state.voiceHours.sessions,
                ...Object.values(state.voiceHours.active)
                    .filter(session => session.guildId === guildId && session.userId === userId && session.muted !== true)
                    .map(session => ({ ...session, endedAt: now.toISOString() })),
            ];

            for (const session of sessions) {
                if (session.guildId !== guildId || session.userId !== userId) continue;

                const startedAtMs = Date.parse(session.startedAt);
                const endedAtMs = Date.parse(session.endedAt);
                if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) continue;

                for (const days of windows) {
                    const windowStartMs = nowMs - (days * 24 * 60 * 60 * 1000);
                    const overlapStartMs = Math.max(startedAtMs, windowStartMs);
                    const overlapEndMs = Math.min(endedAtMs, nowMs);
                    if (overlapEndMs > overlapStartMs) {
                        totals[days] += overlapEndMs - overlapStartMs;
                    }
                }
            }

            return totals;
        },
        incrementMessageCount(guildId, userId, channelId = null, timestamp = new Date()) {
            const key = getMessageStatsKey(guildId, userId);
            if (!state.messageStats.entries[key]) {
                state.messageStats.entries[key] = {
                    guildId,
                    userId,
                    counts: {},
                    channels: {},
                };
            }

            const dateKey = timestamp.toISOString().slice(0, 10);
            const entry = state.messageStats.entries[key];
            entry.counts[dateKey] = (entry.counts[dateKey] ?? 0) + 1;
            if (channelId) {
                if (!entry.channels[channelId]) {
                    entry.channels[channelId] = {};
                }
                entry.channels[channelId][dateKey] = (entry.channels[channelId][dateKey] ?? 0) + 1;
            }
            if (!state.messageStats.totals[key]) {
                state.messageStats.totals[key] = {
                    guildId,
                    userId,
                    totalMessages: 0,
                };
            }
            state.messageStats.totals[key].totalMessages += 1;
            state.pruneMessageStats(timestamp);
            state.saveMessageStats();
            return entry.counts[dateKey];
        },
        getMessageTotals(guildId, userId, now = new Date()) {
            const windows = [1, 7, 14];
            const totals = Object.fromEntries(windows.map(days => [days, 0]));
            const entry = state.messageStats.entries[getMessageStatsKey(guildId, userId)];
            if (!entry) return totals;

            for (const [dateKey, count] of Object.entries(entry.counts)) {
                const startOfDay = Date.parse(`${dateKey}T00:00:00.000Z`);
                if (!Number.isFinite(startOfDay) || !Number.isFinite(count) || count <= 0) continue;
                const dayAge = Math.floor((now.getTime() - startOfDay) / (24 * 60 * 60 * 1000));

                for (const days of windows) {
                    if (dayAge >= 0 && dayAge < days) {
                        totals[days] += count;
                    }
                }
            }

            return totals;
        },
        getOverallVoiceTotal(guildId, userId, now = new Date()) {
            const key = getVoiceHoursKey(guildId, userId);
            const storedTotal = state.voiceHours.totals[key]?.totalMilliseconds ?? 0;
            const activeSession = state.voiceHours.active[key];
            if (!activeSession || activeSession.muted === true) return storedTotal;

            const startedAtMs = Date.parse(activeSession.startedAt);
            const nowMs = now.getTime();
            if (!Number.isFinite(startedAtMs) || nowMs <= startedAtMs) return storedTotal;
            return storedTotal + (nowMs - startedAtMs);
        },
        getOverallMessageTotal(guildId, userId) {
            return state.messageStats.totals[getMessageStatsKey(guildId, userId)]?.totalMessages ?? 0;
        },
        getOverallRanks(guildId, userId, now = new Date()) {
            const voiceEntries = [];
            const seenVoiceUsers = new Set();

            for (const entry of Object.values(state.voiceHours.totals)) {
                if (entry.guildId !== guildId) continue;
                seenVoiceUsers.add(entry.userId);
                voiceEntries.push({ userId: entry.userId, total: state.getOverallVoiceTotal(guildId, entry.userId, now) });
            }

            for (const session of Object.values(state.voiceHours.active)) {
                if (session.guildId !== guildId || seenVoiceUsers.has(session.userId)) continue;
                voiceEntries.push({ userId: session.userId, total: state.getOverallVoiceTotal(guildId, session.userId, now) });
            }

            const messageEntries = [];
            for (const entry of Object.values(state.messageStats.totals)) {
                if (entry.guildId !== guildId) continue;
                messageEntries.push({ userId: entry.userId, total: entry.totalMessages ?? 0 });
            }

            const getRank = (entries, targetId) => {
                const ranked = entries
                    .filter(entry => entry.total > 0)
                    .sort((left, right) => right.total - left.total || left.userId.localeCompare(right.userId));
                const index = ranked.findIndex(entry => entry.userId === targetId);
                return {
                    rank: index >= 0 ? index + 1 : null,
                    totalUsers: ranked.length,
                };
            };

            return {
                voice: getRank(voiceEntries, userId),
                messages: getRank(messageEntries, userId),
            };
        },
        getTopChannelsSummary(guildId, userId, now = new Date()) {
            const windowStartMs = now.getTime() - (14 * 24 * 60 * 60 * 1000);
            const voiceByChannel = new Map();
            const sessions = [
                ...state.voiceHours.sessions,
                ...Object.values(state.voiceHours.active)
                    .filter(session => session.guildId === guildId && session.userId === userId && session.muted !== true)
                    .map(session => ({ ...session, endedAt: now.toISOString() })),
            ];

            for (const session of sessions) {
                if (session.guildId !== guildId || session.userId !== userId || !session.channelId) continue;
                const startedAtMs = Date.parse(session.startedAt);
                const endedAtMs = Date.parse(session.endedAt);
                if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) continue;

                const overlapStartMs = Math.max(startedAtMs, windowStartMs);
                const overlapEndMs = Math.min(endedAtMs, now.getTime());
                if (overlapEndMs <= overlapStartMs) continue;

                voiceByChannel.set(
                    session.channelId,
                    (voiceByChannel.get(session.channelId) ?? 0) + (overlapEndMs - overlapStartMs)
                );
            }

            const messageEntry = state.messageStats.entries[getMessageStatsKey(guildId, userId)];
            const messageByChannel = new Map();
            if (messageEntry?.channels) {
                for (const [channelId, counts] of Object.entries(messageEntry.channels)) {
                    let total = 0;
                    for (const [dateKey, count] of Object.entries(counts)) {
                        const startOfDay = Date.parse(`${dateKey}T00:00:00.000Z`);
                        if (!Number.isFinite(startOfDay) || !Number.isFinite(count) || count <= 0) continue;
                        if (startOfDay >= windowStartMs && startOfDay <= now.getTime()) {
                            total += count;
                        }
                    }

                    if (total > 0) {
                        messageByChannel.set(channelId, total);
                    }
                }
            }

            const topEntry = map => {
                let best = null;
                for (const [channelId, total] of map.entries()) {
                    if (!best || total > best.total || (total === best.total && channelId < best.channelId)) {
                        best = { channelId, total };
                    }
                }
                return best;
            };

            return {
                voice: topEntry(voiceByChannel),
                messages: topEntry(messageByChannel),
            };
        },
        persistGuildConfigs() {
            writeJsonFile(config.FILES.guildConfig, state.guildConfigs);
        },
        getGuildConfig(guildId) {
            if (!state.guildConfigs[guildId]) {
                state.guildConfigs[guildId] = {};
            }

            return state.guildConfigs[guildId];
        },
        getGuildStageSession(guildId) {
            if (!state.guildStageSessions.has(guildId)) {
                state.guildStageSessions.set(guildId, {
                    queue: [],
                    currentSpeaker: null,
                    acceptingJoins: true,
                    startedAt: null,
                    performerIds: new Set(),
                    attendeeIds: new Set(),
                    songsSung: 0,
                    peakAttendance: 0,
                    panelMessageIds: new Map(),
                    adMessageIds: new Map(),
                    panelChannelIds: new Set(),
                    radioPlayer: null,
                    voiceConnection: null,
                    targetVC: null,
                });
            }

            return state.guildStageSessions.get(guildId);
        },
        peekGuildStageSession(guildId) {
            return state.guildStageSessions.get(guildId) ?? null;
        },
        clearGuildStageSession(guildId) {
            state.guildStageSessions.delete(guildId);
        },
    };

    return state;
}

module.exports = { createState };
