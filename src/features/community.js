const fs = require('fs');
const path = require('path');
const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    GuildScheduledEventStatus,
    MessageFlags,
    PermissionFlagsBits,
    Routes,
} = require('discord.js');

const { buildHoursCard, buildEventStatsCard } = require('../hour-card');

const IMAGE_CONTENT_TYPE_EXTENSIONS = {
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
};

function createCommunityFeature({ client, config, state, helpers, stageFeature }) {
    let shyStageCleanupTimer = null;
    let hoursCardRenderingDisabled = false;
    const fallbackAnnouncementColor = 0x5865F2;
    const hourWindows = [1, 7, 14];
    function getShyStageSettings() {
        const settings = state.getBotSettings().shyStage ?? {};
        return {
            baseName: settings.baseName || config.SHY_STAGE_BASE_NAME || 'sleepy singing',
            alwaysVisibleCount: Number.isInteger(settings.alwaysVisibleCount) && settings.alwaysVisibleCount >= 1 ? settings.alwaysVisibleCount : 2,
            userLimit: Number.isInteger(settings.userLimit) && settings.userLimit >= 0 ? settings.userLimit : 3,
            limitChoices: Array.isArray(settings.limitChoices) && settings.limitChoices.length > 0 ? settings.limitChoices : config.SHY_STAGE_LIMIT_CHOICES,
            unusedDeleteMs: (Number.isInteger(settings.unusedDeleteMinutes) && settings.unusedDeleteMinutes > 0 ? settings.unusedDeleteMinutes : config.SHY_STAGE_UNUSED_DELETE_MINUTES) * 60 * 1000,
            emptyDeleteMs: (Number.isInteger(settings.emptyDeleteMinutes) && settings.emptyDeleteMinutes > 0 ? settings.emptyDeleteMinutes : config.SHY_STAGE_EMPTY_DELETE_MINUTES) * 60 * 1000,
            cleanupIntervalMs: (Number.isInteger(settings.cleanupIntervalSeconds) && settings.cleanupIntervalSeconds > 0 ? settings.cleanupIntervalSeconds : config.SHY_STAGE_CLEANUP_INTERVAL_SECONDS) * 1000,
        };
    }

    function getShyStageBasePatterns() {
        const { baseName } = getShyStageSettings();
        return [...new Set([baseName, 'sleepy singing', 'Shy Stage'].filter(Boolean))];
    }
    const shyStageLifecycle = new Map();
    const romanNumeralValues = new Map([
        ['I', 1],
        ['V', 5],
        ['X', 10],
        ['L', 50],
        ['C', 100],
        ['D', 500],
        ['M', 1000],
    ]);

    function formatHours(milliseconds) {
        return (milliseconds / 3600000).toFixed(2);
    }

    function formatProfileDate(date) {
        if (!date) return 'Unknown';

        return new Intl.DateTimeFormat('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC',
        }).format(date);
    }

    function buildVoiceActivityRows(totals) {
        return hourWindows
            .map(days => {
                const label = `${days}d`.padEnd(3, ' ');
                const hours = formatHours(totals[days] ?? 0).padStart(6, ' ');
                return `${label} ${hours} hours`;
            })
            .join('\n');
    }

    function buildMessageRows(totals) {
        return hourWindows
            .map(days => {
                const label = `${days}d`.padEnd(3, ' ');
                const messages = String(totals[days] ?? 0).padStart(6, ' ');
                return `${label} ${messages} msgs`;
            })
            .join('\n');
    }

    function formatRankValue(rankInfo) {
        if (!rankInfo?.rank || !rankInfo?.totalUsers) return 'Unranked';
        return `#${rankInfo.rank} of ${rankInfo.totalUsers}`;
    }

    async function resolveChannelLabel(guild, channelId, fallback) {
        if (!channelId) return fallback;

        const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
        if (!channel) return fallback;
        return channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice
            ? channel.name
            : `#${channel.name}`;
    }

    function isCountedVoiceState(voiceState) {
        return Boolean(voiceState?.channelId)
            && voiceState.selfMute !== true
            && voiceState.serverMute !== true;
    }

    function escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function parseShyStageIndex(channelName) {
        const baseNamePattern = getShyStageBasePatterns().map(escapeRegExp).join('|');
        const match = new RegExp(`^(?:[^a-z0-9]+\\s*)?(?:${baseNamePattern})\\s+([ivxlcdm]+|\\d+)$`, 'i').exec(channelName?.trim() ?? '');
        if (!match) return null;

        const indexToken = match[1].toUpperCase();
        const parsedIndex = /^\d+$/.test(indexToken)
            ? Number.parseInt(indexToken, 10)
            : parseRomanNumeral(indexToken);
        return Number.isInteger(parsedIndex) && parsedIndex > 0 ? parsedIndex : null;
    }

    function parseRomanNumeral(value) {
        let total = 0;
        let previousValue = 0;

        for (let index = value.length - 1; index >= 0; index -= 1) {
            const currentValue = romanNumeralValues.get(value[index]);
            if (!currentValue) return null;

            if (currentValue < previousValue) {
                total -= currentValue;
            } else {
                total += currentValue;
                previousValue = currentValue;
            }
        }

        return total;
    }

    function getShyStageChannels(guild) {
        return guild.channels.cache
            .filter(channel => channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice)
            .map(channel => ({ channel, index: parseShyStageIndex(channel.name) }))
            .filter(entry => entry.index !== null)
            .sort((left, right) => left.index - right.index);
    }

    function getShyStageCategoryId(stageChannels) {
        return stageChannels[0]?.channel.parentId ?? null;
    }

    function getShyStageMemberCount(channel) {
        return channel.members.filter(member => !member.user.bot).size;
    }

    function isManagedOverflowShyStage(channel) {
        const index = parseShyStageIndex(channel?.name ?? null);
        return index !== null && index > getShyStageSettings().alwaysVisibleCount;
    }

    function isShyStageVisibleToEveryone(channel) {
        const everyoneRole = channel.guild.roles.everyone;
        const overwrite = channel.permissionOverwrites.cache.get(everyoneRole.id);

        if (overwrite?.deny.has(PermissionFlagsBits.ViewChannel)) return false;
        if (overwrite?.allow.has(PermissionFlagsBits.ViewChannel)) return true;
        return true;
    }

    function getShyStageLifecycleState(channel) {
        const existingState = shyStageLifecycle.get(channel.id);
        if (existingState) return existingState;

        const initialState = {
            createdByBot: false,
            hasBeenOccupied: false,
            emptySince: channel.createdTimestamp ?? Date.now(),
            limitConfigured: false,
            lockedUserLimit: null,
            openNoticeMessageId: null,
            openNoticeChannelId: null,
            limitPromptMessageId: null,
            limitPromptChannelId: null,
            firstOccupantUserId: null,
        };
        shyStageLifecycle.set(channel.id, initialState);
        return initialState;
    }

    function trackShyStageOccupancy(channel, memberCount) {
        const lifecycleState = getShyStageLifecycleState(channel);
        if (memberCount > 0) {
            lifecycleState.hasBeenOccupied = true;
            lifecycleState.emptySince = null;
            return lifecycleState;
        }

        if (lifecycleState.emptySince === null) {
            lifecycleState.emptySince = Date.now();
        }

        return lifecycleState;
    }

    async function setShyStageVisibility(channel, isVisible) {
        const everyoneRole = channel.guild.roles.everyone;
        const currentViewState = isShyStageVisibleToEveryone(channel);

        if (currentViewState === isVisible) return channel;

        await channel.permissionOverwrites.edit(everyoneRole, {
            ViewChannel: isVisible,
        });

        return channel;
    }

    function formatShyStageLimitChoice(limit) {
        return limit === 0 ? 'Unlimited' : String(limit);
    }

    function buildShyStageLimitButtons(channelId, selectedLimit = null) {
        return [
            new ActionRowBuilder().addComponents(
                ...getShyStageSettings().limitChoices.map(limit => new ButtonBuilder()
                    .setCustomId(`shy-stage-limit:${channelId}:${limit}`)
                    .setLabel(formatShyStageLimitChoice(limit))
                    .setStyle(limit === selectedLimit ? ButtonStyle.Success : ButtonStyle.Secondary)
                    .setDisabled(selectedLimit !== null))
            ),
        ];
    }

    function toApiMessagePayload(payload) {
        return {
            ...payload,
            components: Array.isArray(payload.components)
                ? payload.components.map(component => typeof component.toJSON === 'function' ? component.toJSON() : component)
                : undefined,
        };
    }

    async function postShyStageSideChatMessage(channel, payload, options = {}) {
        const allowSiblingFallback = options.allowSiblingFallback === true;
        const apiPayload = toApiMessagePayload(payload);

        try {
            return await client.rest.post(Routes.channelMessages(channel.id), { body: apiPayload });
        } catch (error) {
            console.error(`Failed to post shy-stage side-chat message to ${channel.id} (${channel.name ?? 'unknown'}):`, error);

            if (!allowSiblingFallback || !channel.parentId) throw error;

            const siblingTextChannels = channel.guild.channels.cache
                .filter(candidate => candidate.id !== channel.id && candidate.parentId === channel.parentId && candidate.isTextBased())
                .sort((left, right) => left.rawPosition - right.rawPosition);
            const fallbackChannel = siblingTextChannels.first();
            if (!fallbackChannel || typeof fallbackChannel.send !== 'function') {
                throw error;
            }

            const sentMessage = await fallbackChannel.send(payload);
            return {
                id: sentMessage.id,
                channel_id: fallbackChannel.id,
            };
        }
    }

    async function editShyStageSideChatMessage(channelId, messageId, payload) {
        const apiPayload = toApiMessagePayload(payload);
        return client.rest.patch(Routes.channelMessage(channelId, messageId), { body: apiPayload });
    }

    async function promptShyStageLimitSelection(channel, member) {
        const lifecycleState = getShyStageLifecycleState(channel);
        if (!isManagedOverflowShyStage(channel) || lifecycleState.limitConfigured || lifecycleState.limitPromptMessageId) return;

        const promptPayload = {
            content: `<@${member.id}> set the room cap size for <#${channel.id}>. This can only be chosen once for this room.`,
            components: buildShyStageLimitButtons(channel.id),
        };

        if (lifecycleState.openNoticeMessageId && lifecycleState.openNoticeChannelId) {
            const updatedMessage = await editShyStageSideChatMessage(
                lifecycleState.openNoticeChannelId,
                lifecycleState.openNoticeMessageId,
                promptPayload,
            ).catch(error => {
                console.error(`Failed to convert shy-stage open notice into limit prompt for ${channel.id}:`, error);
                return null;
            });

            if (updatedMessage) {
                lifecycleState.limitPromptMessageId = lifecycleState.openNoticeMessageId;
                lifecycleState.limitPromptChannelId = lifecycleState.openNoticeChannelId;
                lifecycleState.firstOccupantUserId = member.id;
                return;
            }
        }

        const promptMessage = await postShyStageSideChatMessage(channel, promptPayload, { allowSiblingFallback: false }).catch(error => {
            console.error(`Failed to send shy-stage limit prompt for ${channel.id}:`, error);
            return null;
        });

        if (!promptMessage) return;

        lifecycleState.limitPromptMessageId = promptMessage.id;
        lifecycleState.limitPromptChannelId = promptMessage.channel_id ?? channel.id;
        lifecycleState.firstOccupantUserId = member.id;
    }

    async function finalizeShyStageLimitPrompt(guild, lifecycleState, channel, selectedLimit) {
        if (!lifecycleState.limitPromptMessageId || !lifecycleState.limitPromptChannelId) return;

        await editShyStageSideChatMessage(lifecycleState.limitPromptChannelId, lifecycleState.limitPromptMessageId, {
            content: `Member limit for <#${channel.id}> is locked to ${formatShyStageLimitChoice(selectedLimit)} until this room is deleted and recreated.`,
            components: buildShyStageLimitButtons(channel.id, selectedLimit),
        }).catch(() => {});
    }

    async function handleShyStageLimitButton(interaction) {
        const match = /^shy-stage-limit:(\d{17,20}):(0|\d+)$/.exec(interaction.customId);
        if (!match) return false;

        const [, channelId, limitToken] = match;
        const selectedLimit = Number.parseInt(limitToken, 10);
        const channel = interaction.guild.channels.cache.get(channelId)
            ?? await interaction.guild.channels.fetch(channelId).catch(() => null);

        if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
            await interaction.reply(helpers.privateReply('That shy stage no longer exists.'));
            return true;
        }

        const lifecycleState = getShyStageLifecycleState(channel);
        if (lifecycleState.limitConfigured) {
            await interaction.reply(helpers.privateReply(`The member limit for <#${channel.id}> is already locked.`));
            return true;
        }

        if (!isManagedOverflowShyStage(channel)) {
            await interaction.reply(helpers.privateReply('This limit picker only works for managed shy-stage overflow rooms.'));
            return true;
        }

        if (!lifecycleState.firstOccupantUserId) {
            const firstOccupant = channel.members.find(member => !member.user.bot) ?? null;
            lifecycleState.firstOccupantUserId = firstOccupant?.id ?? null;
        }

        if (interaction.user.id !== lifecycleState.firstOccupantUserId) {
            await interaction.reply(helpers.privateReply('Only the first person who joined this room can set its member limit.'));
            return true;
        }

        await channel.edit({ userLimit: selectedLimit }).catch(async error => {
            console.error(`Failed to set shy-stage user limit for ${channel.id}:`, error);
            await interaction.reply(helpers.privateReply('I could not update that channel limit.'));
        });

        if (channel.userLimit !== selectedLimit) {
            return true;
        }

        lifecycleState.limitConfigured = true;
        lifecycleState.lockedUserLimit = selectedLimit;
        await finalizeShyStageLimitPrompt(interaction.guild, lifecycleState, channel, selectedLimit);
        await interaction.reply(helpers.privateReply(`Locked <#${channel.id}> to ${formatShyStageLimitChoice(selectedLimit)} until the room is deleted.`));
        return true;
    }

    async function ensureShyStageSettings(channel) {
        if (!isManagedOverflowShyStage(channel)) {
            return channel;
        }

        const lifecycleState = getShyStageLifecycleState(channel);
        const desiredLimit = lifecycleState.limitConfigured && lifecycleState.lockedUserLimit !== null
            ? lifecycleState.lockedUserLimit
            : getShyStageSettings().userLimit;

        if (channel.userLimit !== desiredLimit) {
            await channel.edit({ userLimit: desiredLimit });
        }

        return channel;
    }

    function formatShyStageIndex(index) {
        const numerals = [
            ['M', 1000],
            ['CM', 900],
            ['D', 500],
            ['CD', 400],
            ['C', 100],
            ['XC', 90],
            ['L', 50],
            ['XL', 40],
            ['X', 10],
            ['IX', 9],
            ['V', 5],
            ['IV', 4],
            ['I', 1],
        ];

        let remaining = index;
        let output = '';

        for (const [token, value] of numerals) {
            while (remaining >= value) {
                output += token;
                remaining -= value;
            }
        }

        return output || String(index);
    }

    async function announceShyStageOpened(channel) {
        const lifecycleState = getShyStageLifecycleState(channel);
        const openMessage = await postShyStageSideChatMessage(channel, {
            content: `Set room cap size for <#${channel.id}>. This can only be chosen once for this room.`,
            components: buildShyStageLimitButtons(channel.id),
        }, { allowSiblingFallback: false }).catch(error => {
            console.error(`Failed to announce shy stage opening for ${channel.id}:`, error);
            return null;
        });

        if (!openMessage) return;

        lifecycleState.openNoticeMessageId = openMessage.id;
        lifecycleState.openNoticeChannelId = openMessage.channel_id ?? channel.id;
        lifecycleState.limitPromptMessageId = openMessage.id;
        lifecycleState.limitPromptChannelId = openMessage.channel_id ?? channel.id;
    }

    async function syncShyStageRooms(guild, changedChannelId = null) {
        const stageChannels = getShyStageChannels(guild);
        const shyStageSettings = getShyStageSettings();
        if (stageChannels.length < shyStageSettings.alwaysVisibleCount) return;

        console.log('[shy-stage] detected channels:', stageChannels.map(entry => ({
            id: entry.channel.id,
            name: entry.channel.name,
            index: entry.index,
            parentId: entry.channel.parentId,
        })));

        const stageState = stageChannels.map(entry => ({
            ...entry,
            memberCount: getShyStageMemberCount(entry.channel),
            isVisible: isShyStageVisibleToEveryone(entry.channel),
        }));

        console.log('[shy-stage] state snapshot:', stageState.map(entry => ({
            id: entry.channel.id,
            name: entry.channel.name,
            index: entry.index,
            memberCount: entry.memberCount,
            isVisible: entry.isVisible,
        })));

        const visibleStageEntries = stageState.filter(entry => entry.index <= shyStageSettings.alwaysVisibleCount || entry.isVisible || entry.memberCount > 0);
        const lastVisibleEntry = visibleStageEntries[visibleStageEntries.length - 1] ?? null;

        for (const entry of stageState) {
            await ensureShyStageSettings(entry.channel);
            trackShyStageOccupancy(entry.channel, entry.memberCount);

            const shouldBeVisible = entry.index <= shyStageSettings.alwaysVisibleCount || entry.memberCount > 0;
            await setShyStageVisibility(entry.channel, shouldBeVisible);
        }

        if (!changedChannelId) return;

        const changedEntry = stageState.find(entry => entry.channel.id === changedChannelId);
        if (!changedEntry || !lastVisibleEntry) return;

        console.log('[shy-stage] changed entry + last visible:', {
            changedChannelId,
            changedEntry: changedEntry ? {
                id: changedEntry.channel.id,
                name: changedEntry.channel.name,
                index: changedEntry.index,
                memberCount: changedEntry.memberCount,
                isVisible: changedEntry.isVisible,
            } : null,
            lastVisibleEntry: lastVisibleEntry ? {
                id: lastVisibleEntry.channel.id,
                name: lastVisibleEntry.channel.name,
                index: lastVisibleEntry.index,
                memberCount: lastVisibleEntry.memberCount,
                isVisible: lastVisibleEntry.isVisible,
            } : null,
        });

        const changedLifecycleState = getShyStageLifecycleState(changedEntry.channel);
        if (isManagedOverflowShyStage(changedEntry.channel) && changedEntry.memberCount === 1 && !changedLifecycleState.limitConfigured && !changedLifecycleState.limitPromptMessageId) {
            const firstMember = changedEntry.channel.members.find(member => !member.user.bot) ?? null;
            if (firstMember) {
                await promptShyStageLimitSelection(changedEntry.channel, firstMember);
            }
        }

        const isLastVisibleSlot = changedEntry.index === lastVisibleEntry.index;
        const isOccupied = changedEntry.memberCount > 0;
        if (!isLastVisibleSlot || !isOccupied) return;

        const nextIndex = changedEntry.index + 1;
        const existingNext = stageState.find(entry => entry.index === nextIndex)?.channel;
        console.log('[shy-stage] reveal check:', {
            currentName: changedEntry.channel.name,
            currentIndex: changedEntry.index,
            isLastVisibleSlot,
            isOccupied,
            nextIndex,
            existingNext: existingNext ? {
                id: existingNext.id,
                name: existingNext.name,
                visible: isShyStageVisibleToEveryone(existingNext),
            } : null,
        });

        if (existingNext && !isShyStageVisibleToEveryone(existingNext)) {
            console.log('[shy-stage] revealing next channel:', {
                id: existingNext.id,
                name: existingNext.name,
            });
            await setShyStageVisibility(existingNext, true);
            await ensureShyStageSettings(existingNext);
            await announceShyStageOpened(existingNext);
        }
    }

    function buildHoursEmbed(subject, voiceTotals, messageTotals, ranks, guild) {
        const displayName = subject.displayName ?? subject.user.globalName ?? subject.user.username;
        const joinedAt = subject.joinedAt ?? null;

        return new EmbedBuilder()
            .setAuthor({
                name: `${displayName} - ${guild.name}`,
                iconURL: subject.user.displayAvatarURL({ size: 128 }),
            })
            .setColor(0x2F3136)
            .setThumbnail(subject.user.displayAvatarURL({ size: 128 }))
            .addFields(
                {
                    name: 'Created On',
                    value: formatProfileDate(subject.user.createdAt),
                    inline: true,
                },
                {
                    name: 'Joined On',
                    value: formatProfileDate(joinedAt),
                    inline: true,
                },
                {
                    name: 'Voice Rank',
                    value: formatRankValue(ranks.voice),
                    inline: true,
                },
                {
                    name: 'Message Rank',
                    value: formatRankValue(ranks.messages),
                    inline: true,
                },
                {
                    name: 'Voice Activity',
                    value: `\`\`\`txt\n${buildVoiceActivityRows(voiceTotals)}\n\`\`\``,
                    inline: false,
                },
                {
                    name: 'Messages',
                    value: `\`\`\`txt\n${buildMessageRows(messageTotals)}\n\`\`\``,
                    inline: false,
                }
            )
            .setFooter({ text: 'Server Lookback: Last 14 days - Timezone: UTC' })
            .setTimestamp(new Date());
    }

    function normalizeAnnouncementText(value) {
        return value.replace(/\\n/g, '\n');
    }

    function parseAnnouncementColor(value) {
        if (!value) return null;

        const normalized = value.trim();
        if (!/^#?[0-9a-fA-F]{6}$/.test(normalized)) {
            return { error: 'Use a 6-digit hex color like #5865F2.' };
        }

        const hex = `#${normalized.replace(/^#/, '').toUpperCase()}`;
        return {
            hex,
            value: Number.parseInt(hex.slice(1), 16),
        };
    }

    function sanitizeAdvertisementLabel(value) {
        return (value ?? '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40);
    }

    function resolveImageExtension(attachment) {
        const attachmentExtension = path.extname(attachment.name ?? '').toLowerCase();
        if (attachmentExtension) return attachmentExtension;
        return IMAGE_CONTENT_TYPE_EXTENSIONS[attachment.contentType ?? ''] ?? null;
    }

    async function storeAdvertisementAttachment(attachment, title) {
        const extension = resolveImageExtension(attachment);
        if (!extension) {
            throw new Error('unsupported-file-type');
        }

        const response = await fetch(attachment.url);
        if (!response.ok) {
            throw new Error(`download-failed:${response.status}`);
        }

        const label = sanitizeAdvertisementLabel(title || attachment.name || 'ad') || 'ad';
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const fileName = `${id}-${label}${extension}`;
        const filePath = path.join(config.ADS_DIR, fileName);
        const buffer = Buffer.from(await response.arrayBuffer());

        await fs.promises.writeFile(filePath, buffer);

        const advertisement = {
            id,
            title: (title ?? '').trim() || attachment.name || fileName,
            fileName,
            originalName: attachment.name || fileName,
            contentType: attachment.contentType || 'application/octet-stream',
            uploadedAt: new Date().toISOString(),
        };

        state.addAdvertisement(advertisement);
        return advertisement;
    }

    async function storeAdvertisementBuffer({ buffer, fileName, contentType, title }) {
        const attachment = {
            name: fileName,
            contentType,
        };
        const extension = resolveImageExtension(attachment);
        if (!extension || !Buffer.isBuffer(buffer) || buffer.length === 0) {
            throw new Error('unsupported-file-type');
        }

        const label = sanitizeAdvertisementLabel(title || fileName || 'ad') || 'ad';
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const safeFileName = `${id}-${label}${extension}`;
        const filePath = path.join(config.ADS_DIR, safeFileName);

        await fs.promises.writeFile(filePath, buffer);

        const advertisement = {
            id,
            title: (title ?? '').trim() || fileName || safeFileName,
            fileName: safeFileName,
            originalName: fileName || safeFileName,
            contentType: contentType || 'application/octet-stream',
            uploadedAt: new Date().toISOString(),
        };

        state.addAdvertisement(advertisement);
        return advertisement;
    }

    function buildAdvertisementList() {
        const advertisements = state.getAdvertisements();
        if (advertisements.length === 0) return 'No ad images have been uploaded yet.';

        const activeId = state.advertisements.activeId;
        const rotationLine = state.advertisements.rotationIntervalMs
            ? `Auto-rotation: every ${Math.floor(state.advertisements.rotationIntervalMs / 1000)}s`
            : 'Auto-rotation: off';

        return `${rotationLine}\n${advertisements
            .map((item, index) => `${index + 1}. ${item.title}${item.id === activeId ? ' (active)' : ''}`)
            .join('\n')}`;
    }

    function getCurrentAdvertisementSnapshot() {
        const items = state.getAdvertisements();
        const activeId = typeof state.advertisements.activeId === 'string' ? state.advertisements.activeId : null;
        const activeIndex = Math.max(0, items.findIndex(item => item?.id === activeId));
        const rotationIntervalMs = Number.isInteger(state.advertisements.rotationIntervalMs) && state.advertisements.rotationIntervalMs > 0
            ? state.advertisements.rotationIntervalMs
            : null;
        const rotationStartedAt = Date.parse(state.advertisements.rotationStartedAt ?? '');
        const hasRotation = rotationIntervalMs && items.length > 1 && Number.isFinite(rotationStartedAt);
        const rotationOffset = hasRotation
            ? Math.floor(Math.max(0, Date.now() - rotationStartedAt) / rotationIntervalMs) % items.length
            : 0;
        const item = items[(activeIndex + rotationOffset) % Math.max(items.length, 1)] ?? null;

        return {
            item,
            rotationIntervalMs,
            signature: item
                ? `${item.id}:${rotationIntervalMs ?? 'off'}:${hasRotation ? rotationOffset : 0}`
                : 'none',
        };
    }

    function buildAdvertisementMessagePayload(snapshot, session) {
        if (!snapshot.item) return null;

        const filePath = path.join(config.ADS_DIR, snapshot.item.fileName);
        if (!fs.existsSync(filePath)) return null;

        const advertisementAttachment = new AttachmentBuilder(filePath, { name: snapshot.item.fileName });
        const rotationText = snapshot.rotationIntervalMs
            ? `Auto-rotation every ${Math.floor(snapshot.rotationIntervalMs / 1000)}s`
            : 'Fixed ad';

        const embed = new EmbedBuilder()
            .setTitle('Sponsor Spotlight')
            .setDescription(`Showing in <#${session.targetVC}>\n${rotationText}`)
            .setColor(0xD07A2D)
            .setFooter({ text: snapshot.item.title })
            .setImage(`attachment://${snapshot.item.fileName}`)
            .setTimestamp(new Date());

        return {
            content: 'Current sponsor ad:',
            embeds: [embed],
            files: [advertisementAttachment],
        };
    }

    async function syncStageAdvertisementsForGuild(guild) {
        const session = state.peekGuildStageSession(guild.id);
        if (!session) return;

        const snapshot = getCurrentAdvertisementSnapshot();
        const payload = buildAdvertisementMessagePayload(snapshot, session);

        if (!payload) {
            for (const [channelId, messageId] of session.adMessageIds.entries()) {
                const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
                if (!channel?.isTextBased()) continue;
                const message = await channel.messages.fetch(messageId).catch(() => null);
                if (message) await message.delete().catch(() => {});
            }

            session.adMessageIds.clear();
            session.lastAdvertisementSignature = null;
            return;
        }

        const signatureChanged = session.lastAdvertisementSignature !== snapshot.signature;

        for (const channelId of [...session.panelChannelIds]) {
            const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
            if (!channel?.isTextBased()) {
                session.panelChannelIds.delete(channelId);
                session.panelMessageIds.delete(channelId);
                session.adMessageIds.delete(channelId);
                continue;
            }

            const messageId = session.adMessageIds.get(channelId);
            const message = messageId ? await channel.messages.fetch(messageId).catch(() => null) : null;

            if (message && !signatureChanged) continue;

            if (message) {
                await message.delete().catch(() => {});
                session.adMessageIds.delete(channelId);
            }

            const createdMessage = await channel.send(payload).catch(() => null);
            if (createdMessage) {
                session.adMessageIds.set(channelId, createdMessage.id);
            }
        }

        session.lastAdvertisementSignature = snapshot.signature;
    }

    async function syncAllStageAdvertisements() {
        for (const guildId of state.guildStageSessions.keys()) {
            const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
            if (!guild) continue;
            await syncStageAdvertisementsForGuild(guild);
        }
    }

    async function postStageStatsCard(guild, statsSummary) {
        const statsChannelId = state.getBotSettings().postEventStats?.channelId || config.POST_EVENT_STATS_CHANNEL_ID;
        if (!statsSummary || !statsChannelId) return '';

        const statsChannel = guild.channels.cache.get(statsChannelId)
            ?? await guild.channels.fetch(statsChannelId).catch(() => null)
            ?? await client.channels.fetch(statsChannelId).catch(() => null);

        if (!statsChannel?.isTextBased() || typeof statsChannel.send !== 'function') {
            return ` I could not find a sendable channel for <#${statsChannelId}>.`;
        }

        try {
            const statsCard = await buildEventStatsCard({ guild, stats: statsSummary });
            const attachment = new AttachmentBuilder(statsCard, { name: 'post-event-stats.png' });
            await statsChannel.send({ files: [attachment] });
            return ` Stats posted in <#${statsChannelId}>.`;
        } catch (error) {
            console.error('Failed to post event stats:', error);
            return ` I could not post stats in <#${statsChannelId}>.`;
        }
    }

    async function concludeStageSession(guild, controlChannel, options = {}) {
        const session = state.peekGuildStageSession(guild.id);
        if (!session) return { status: 'missing', statsPostedText: '' };

        const panelChannelIds = [...session.panelChannelIds];
        const result = await stageFeature.stopStage(controlChannel);
        if (result.status === 'missing') return { status: 'missing', statsPostedText: '' };

        const statsPostedText = await postStageStatsCard(guild, result.statsSummary);

        if (options.notifyPanels) {
            const notification = {
                content: `Event finished automatically because <#${session.targetVC}> is now empty.${statsPostedText}`,
                embeds: result.statsEmbed ? [result.statsEmbed] : [],
            };

            for (const panelChannelId of panelChannelIds) {
                const panelChannel = guild.channels.cache.get(panelChannelId) ?? await guild.channels.fetch(panelChannelId).catch(() => null);
                if (!panelChannel?.isTextBased() || typeof panelChannel.send !== 'function') continue;
                await panelChannel.send(notification).catch(() => {});
            }
        }

        return { ...result, statsPostedText };
    }

    async function startTrackedStage(guildId, textChannelId, stageChannelId) {
        const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return { status: 'missing-guild' };

        const textChannel = guild.channels.cache.get(textChannelId) ?? await guild.channels.fetch(textChannelId).catch(() => null);
        if (!textChannel?.isTextBased()) return { status: 'missing-text-channel' };

        const stageChannel = guild.channels.cache.get(stageChannelId) ?? await guild.channels.fetch(stageChannelId).catch(() => null);
        if (!stageChannel || stageChannel.type !== ChannelType.GuildStageVoice) {
            return { status: 'invalid-stage-channel' };
        }

        return stageFeature.startStage(textChannel, stageChannelId, { trackingOnly: true });
    }

    async function endTrackedStage(guildId, textChannelId) {
        const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return { status: 'missing-guild' };

        const textChannel = guild.channels.cache.get(textChannelId) ?? await guild.channels.fetch(textChannelId).catch(() => null);
        if (!textChannel?.isTextBased()) return { status: 'missing-text-channel' };

        return concludeStageSession(guild, textChannel);
    }

    async function sendAnnouncementFromAdmin({ guildId, channelId, message, title, color }) {
        const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return { status: 'missing-guild' };

        const targetChannel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
        if (!targetChannel?.isTextBased() || targetChannel.isDMBased?.()) {
            return { status: 'missing-channel' };
        }

        const normalizedMessage = normalizeAnnouncementText(message ?? '');
        if (!normalizedMessage.trim()) return { status: 'missing-message' };

        const guildConfig = state.getGuildConfig(guild.id);
        const requestedColor = parseAnnouncementColor(color);
        if (requestedColor?.error) return { status: 'invalid-color', error: requestedColor.error };

        const defaultColor = parseAnnouncementColor(guildConfig.announcementColor);
        const embedColor = requestedColor?.value ?? defaultColor?.value ?? fallbackAnnouncementColor;
        const botMember = guild.members.me ?? await guild.members.fetchMe();
        const permissions = targetChannel.permissionsFor(botMember);
        const requiredPermissions = targetChannel.isThread()
            ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads]
            : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

        if (!permissions?.has(requiredPermissions)) {
            return { status: 'missing-permission' };
        }

        const trimmedTitle = title?.trim() || null;
        const payload = trimmedTitle || requestedColor?.value
            ? {
                embeds: [new EmbedBuilder()
                    .setDescription(normalizedMessage)
                    .setColor(embedColor)
                    .setTitle(trimmedTitle ?? 'Announcement')],
            }
            : { content: normalizedMessage };

        await targetChannel.send(payload);
        return { status: 'sent' };
    }

    function setInviteException(userId, allowed) {
        if (!userId?.trim()) return { status: 'missing-user' };

        if (allowed) {
            state.allowedInviteUsers.add(userId.trim());
        } else {
            state.allowedInviteUsers.delete(userId.trim());
        }

        state.saveAllowedInviteUsers();
        return { status: 'ok' };
    }

    async function uploadAdvertisementFromAdmin({ buffer, fileName, contentType, title }) {
        const advertisement = await storeAdvertisementBuffer({ buffer, fileName, contentType, title });
        await syncAllStageAdvertisements();
        return { status: 'created', advertisement };
    }

    async function removeAdvertisementFromAdmin(index) {
        const removed = state.removeAdvertisementByIndex(index);
        if (!removed) return { status: 'missing' };

        await fs.promises.unlink(path.join(config.ADS_DIR, removed.fileName)).catch(() => {});
        await syncAllStageAdvertisements();
        return { status: 'removed', removed };
    }

    async function purgeInvitesFromAdmin(guildId, scanLimit) {
        const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return { status: 'missing-guild' };

        const result = await purgeInviteLinksInGuild(guild, scanLimit);
        return { status: 'ok', ...result };
    }

    async function fetchActiveEventLinks(guild) {
        const scheduledEvents = await guild.scheduledEvents.fetch();
        return [...scheduledEvents.values()]
            .filter(event => event.status === GuildScheduledEventStatus.Scheduled || event.status === GuildScheduledEventStatus.Active)
            .sort((left, right) => {
                const leftStart = left.scheduledStartTimestamp ?? Number.MAX_SAFE_INTEGER;
                const rightStart = right.scheduledStartTimestamp ?? Number.MAX_SAFE_INTEGER;
                return leftStart - rightStart;
            })
            .map(event => `https://discord.com/events/${guild.id}/${event.id}`);
    }

    async function sendActiveEvents(target, guild) {
        const eventLinks = await fetchActiveEventLinks(guild);
        const payload = eventLinks.length > 0
            ? eventLinks.join('\n')
            : 'There are no live or upcoming server events right now.';

        if (typeof target.isRepliable === 'function' && target.isRepliable()) {
            const method = target.deferred || target.replied ? 'editReply' : 'reply';
            return target[method](payload);
        }

        return target.reply(payload);
    }

    async function purgeInviteLinksInChannel(channel, guild, scanLimit) {
        let lastMessageId;
        let scannedMessages = 0;
        let deletedMessages = 0;

        while (scannedMessages < scanLimit) {
            const batchSize = Math.min(100, scanLimit - scannedMessages);
            const messages = await channel.messages.fetch({ limit: batchSize, before: lastMessageId });
            if (messages.size === 0) break;

            for (const message of messages.values()) {
                if (message.author.bot) continue;
                if (!helpers.containsInviteLink(message.content)) continue;
                if (helpers.canPostInviteLinkInGuild(guild, message.author.id)) continue;

                try {
                    await message.delete();
                    deletedMessages += 1;
                } catch (error) {
                    console.error(`Failed to delete invite link in #${channel.name}:`, error);
                }
            }

            scannedMessages += messages.size;
            lastMessageId = messages.last()?.id;
            if (!lastMessageId) break;
        }

        return { scannedMessages, deletedMessages };
    }

    async function purgeInviteLinksInGuild(guild, scanLimit) {
        const botMember = guild.members.me ?? await guild.members.fetchMe();
        const channels = guild.channels.cache.filter(channel => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement);

        let scannedChannels = 0;
        let skippedChannels = 0;
        let scannedMessages = 0;
        let deletedMessages = 0;

        for (const channel of channels.values()) {
            const permissions = channel.permissionsFor(botMember);
            if (!permissions?.has(['ViewChannel', 'ReadMessageHistory', 'ManageMessages'])) {
                skippedChannels += 1;
                continue;
            }

            scannedChannels += 1;
            const result = await purgeInviteLinksInChannel(channel, guild, scanLimit);
            scannedMessages += result.scannedMessages;
            deletedMessages += result.deletedMessages;
        }

        return { scannedChannels, skippedChannels, scannedMessages, deletedMessages };
    }

    async function restoreScheduledTasks() {
        if (!shyStageCleanupTimer) {
            shyStageCleanupTimer = setInterval(() => {
                for (const guild of client.guilds.cache.values()) {
                    syncShyStageRooms(guild).catch(error => {
                        console.error('Shy-stage visibility sync failed:', error);
                    });
                }
            }, getShyStageSettings().cleanupIntervalMs);
        }

        for (const guild of client.guilds.cache.values()) {
            await syncShyStageRooms(guild);
        }
    }

    async function restoreVoiceHourSessions() {
        const now = new Date();
        const activeKeys = new Set();
        const checkedGuildIds = new Set();

        for (const guild of client.guilds.cache.values()) {
            const channels = await guild.channels.fetch().catch(() => null);
            if (!channels) continue;
            checkedGuildIds.add(guild.id);

            for (const channel of channels.values()) {
                if (channel?.type !== ChannelType.GuildVoice && channel?.type !== ChannelType.GuildStageVoice) continue;

                for (const member of channel.members.values()) {
                    if (member.user.bot) continue;
                    if (!isCountedVoiceState(member.voice)) continue;

                    activeKeys.add(`${guild.id}:${member.id}`);
                    state.startVoiceHourSession(guild.id, member.id, channel.id, now, false);
                }
            }
        }

        for (const session of Object.values(state.voiceHours.active)) {
            if (checkedGuildIds.has(session.guildId) && !activeKeys.has(`${session.guildId}:${session.userId}`)) {
                state.endVoiceHourSession(session.guildId, session.userId, now);
            }
        }
    }

    async function resolveHoursTarget(message) {
        const trimmedContent = message.content.trim();
        const targetUser = message.mentions.users.first();
        if (targetUser) return targetUser;

        const match = trimmedContent.match(/^-h\s+(\d{17,20})(?:\s|$)/i);
        if (!match) return message.author;

        const userId = match[1];
        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (member) return member.user;

        return await message.client.users.fetch(userId).catch(() => message.author);
    }

    async function sendHoursGui(message) {
        const targetUser = await resolveHoursTarget(message);
        const member = await message.guild.members.fetch(targetUser.id).catch(() => null);
        const subject = member ?? {
            user: targetUser,
            displayName: targetUser.globalName ?? targetUser.username,
            joinedAt: null,
            toString: () => `<@${targetUser.id}>`,
        };
        const voiceTotals = state.getVoiceHourTotals(message.guild.id, targetUser.id);
        const messageTotals = state.getMessageTotals(message.guild.id, targetUser.id);
        const ranks = state.getOverallRanks(message.guild.id, targetUser.id);
        const topChannels = state.getTopChannelsSummary(message.guild.id, targetUser.id);
        const topActivity = {
            voice: {
                name: await resolveChannelLabel(message.guild, topChannels.voice?.channelId, 'No voice data'),
                total: topChannels.voice?.total ?? 0,
            },
            messages: {
                name: await resolveChannelLabel(message.guild, topChannels.messages?.channelId, 'No message data'),
                total: topChannels.messages?.total ?? 0,
            },
        };

        if (hoursCardRenderingDisabled) {
            await message.reply({ embeds: [buildHoursEmbed(subject, voiceTotals, messageTotals, ranks, message.guild)] });
            return;
        }

        try {
            const card = await buildHoursCard({ subject, guild: message.guild, totals: voiceTotals, messageTotals, ranks, topActivity });
            const attachment = new AttachmentBuilder(card, { name: 'voice-hours.png' });
            await message.reply({ files: [attachment] });
        } catch (error) {
            const errorText = `${error?.message ?? ''} ${error?.cause?.message ?? ''}`;
            if (errorText.includes('native binding') || errorText.includes('@napi-rs/canvas-linux')) {
                hoursCardRenderingDisabled = true;
                console.warn('Hours image cards disabled: @napi-rs/canvas native Linux binding is missing. Run npm install --include=optional on the server, then restart the bot.');
            } else {
                console.error('Failed to render hours card:', error);
            }

            await message.reply({ embeds: [buildHoursEmbed(subject, voiceTotals, messageTotals, ranks, message.guild)] });
        }
    }

    async function resolveQueueTargetMember(message, rawArgs) {
        const mentionedMember = message.mentions.members.first();
        if (mentionedMember) return mentionedMember;

        const firstArg = rawArgs[0]?.trim();
        if (!firstArg) return null;

        const normalizedId = firstArg.replace(/[<@!>]/g, '');
        if (/^\d{17,20}$/.test(normalizedId)) {
            return await message.guild.members.fetch(normalizedId).catch(() => null);
        }

        const searchTerm = rawArgs.join(' ').trim().toLowerCase();
        if (!searchTerm) return null;

        return message.guild.members.cache.find(candidate => {
            const username = candidate.user.username?.toLowerCase();
            const globalName = candidate.user.globalName?.toLowerCase();
            const displayName = candidate.displayName?.toLowerCase();
            return username === searchTerm || globalName === searchTerm || displayName === searchTerm;
        }) ?? null;
    }

    async function handleMessageCreate(message) {
        if (message.author.bot) return;

        if (message.guild) {
            state.incrementMessageCount(message.guild.id, message.author.id, message.channelId, message.createdAt ?? new Date());
        }

        if (message.guild && /^!(queue|q|queuejoin|qj|queueleave|ql|queuenext|qn|addqueue|aq|startqueue|sq|endqueue|eq)(?:\s|$)/i.test(message.content.trim())) {
            const [rawCommand, ...rawArgs] = message.content.trim().split(/\s+/);
            const command = rawCommand.toLowerCase();
            const member = await message.guild.members.fetch(message.author.id).catch(() => null);

            if (!member) {
                await message.reply('I could not resolve your member record right now.');
                return;
            }

            const isStaff = helpers.isStaff(member);
            const requireStaff = async () => {
                if (isStaff) return true;
                await message.reply('Staff only.');
                return false;
            };

            if (command === '!queue' || command === '!q') {
                const result = stageFeature.getQueueEmbed(message.channel);
                if (result.status === 'missing') {
                    await message.reply('There is no active stage in this server.');
                    return;
                }

                await message.reply({ embeds: [result.embed] });
                return;
            }

            if (command === '!queuejoin' || command === '!qj') {
                const result = await stageFeature.joinQueue(message.channel, member);
                if (result.status === 'missing') {
                    await message.reply('There is no active stage in this server.');
                    return;
                }
                if (result.status === 'closed') {
                    await message.reply('This queue is closed to new joiners right now.');
                    return;
                }
                if (result.status === 'wrong-channel') {
                    await message.reply(`You must be in <#${result.targetVC}> to join this queue.`);
                    return;
                }
                if (result.status === 'already-queued') {
                    await message.reply('You are already in the lineup.');
                    return;
                }

                await message.reply('You joined the queue.');
                return;
            }

            if (command === '!queueleave' || command === '!ql') {
                const result = await stageFeature.leaveQueue(message.channel, message.author.id);
                if (result.status === 'missing') {
                    await message.reply('There is no active stage in this server.');
                    return;
                }
                if (result.status === 'not-queued') {
                    await message.reply('You are not currently in the queue.');
                    return;
                }

                await message.reply(result.removedCurrentSpeaker ? 'You left the stage and the queue moved forward.' : 'You left the queue.');
                return;
            }

            if (command === '!queuenext' || command === '!qn') {
                if (!await requireStaff()) return;

                const result = await stageFeature.nextSpeaker(message.channel);
                if (result.status === 'missing') {
                    await message.reply('There is no active stage in this server.');
                    return;
                }

                await message.reply('Moved to the next performer.');
                return;
            }

            if (command === '!addqueue' || command === '!aq') {
                if (!await requireStaff()) return;

                const targetUser = await resolveQueueTargetMember(message, rawArgs);
                if (!targetUser) {
                    await message.reply('Mention a user, provide a user ID, or use their exact username/display name to add them to the queue.');
                    return;
                }

                const result = await stageFeature.addToQueue(message.channel, targetUser);
                if (result.status === 'missing') {
                    await message.reply('There is no active stage in this server.');
                    return;
                }
                if (result.status === 'already-queued') {
                    await message.reply(`${targetUser} is already in the lineup.`);
                    return;
                }

                await message.reply(`Added ${targetUser} to the queue.`);
                return;
            }

            if (command === '!startqueue' || command === '!sq') {
                if (!await requireStaff()) return;

                if (!member.voice.channel) {
                    await message.reply('Join the voice channel you want me to host in first.');
                    return;
                }

                const result = await stageFeature.startStage(message.channel, member.voice.channelId);
                if (result.status === 'conflict') {
                    await message.reply(`A stage is already active in <#${result.targetVC}>. You can add more control panels only for that same voice channel.`);
                    return;
                }

                const response = result.status === 'created'
                    ? `Stage initialized for <#${member.voice.channelId}>.`
                    : result.status === 'added-panel'
                        ? `Added a control panel for the active stage in <#${result.targetVC}>.`
                        : `Refreshed this control panel for the active stage in <#${result.targetVC}>.`;

                await message.reply(response);
                return;
            }

            if (command === '!endqueue' || command === '!eq') {
                if (!await requireStaff()) return;

                const result = await concludeStageSession(message.guild, message.channel);
                if (result.status === 'missing') {
                    await message.reply('There is no active stage in this server.');
                    return;
                }

                await message.reply({
                    content: `Event finished. Connection closed.${result.statsPostedText}`,
                    embeds: result.statsEmbed ? [result.statsEmbed] : [],
                });
                return;
            }
        }

        if (message.guild && /^!(stagestart|ss|stageend|se)(?:\s|$)/i.test(message.content.trim())) {
            const [rawCommand] = message.content.trim().split(/\s+/);
            const command = rawCommand.toLowerCase();
            const member = await message.guild.members.fetch(message.author.id).catch(() => null);

            if (!member) {
                await message.reply('I could not resolve your member record right now.');
                return;
            }

            if (!helpers.isStaff(member)) {
                await message.reply('Staff only.');
                return;
            }

            if (command === '!stagestart' || command === '!ss') {
                if (!member.voice.channel) {
                    await message.reply('Join the stage channel you want me to track first.');
                    return;
                }

                if (member.voice.channel.type !== ChannelType.GuildStageVoice) {
                    await message.reply('`!stagestart` only works when you are connected to a Discord stage channel.');
                    return;
                }

                const result = await stageFeature.startStage(message.channel, member.voice.channelId, { trackingOnly: true });
                if (result.status === 'conflict') {
                    await message.reply(`A stage event is already being tracked in <#${result.targetVC}>. You can add more control panels only for that same stage channel.`);
                    return;
                }

                await message.reply(result.status === 'created'
                    ? `Started tracking the stage event in <#${member.voice.channelId}>.`
                    : `Stage event tracking is already active in <#${result.targetVC}>.`);
                return;
            }

            const result = await concludeStageSession(message.guild, message.channel);
            if (result.status === 'missing') {
                await message.reply('There is no active stage event being tracked in this server.');
                return;
            }

            await message.reply({
                content: `Stage event tracking ended.${result.statsPostedText}`,
                embeds: result.statsEmbed ? [result.statsEmbed] : [],
            });
            return;
        }

        if (message.guild && /^-h(?:\s|$)/i.test(message.content.trim())) {
            await sendHoursGui(message);
            return;
        }

        if (message.guild && message.content.trim().toLowerCase() === '-events') {
            try {
                await sendActiveEvents(message, message.guild);
            } catch (error) {
                console.error('Event lookup failed:', error);
                await message.reply('I could not fetch the server events right now.');
            }
            return;
        }

        if (message.channel.type === ChannelType.DM && message.content.startsWith('!allowinvite ')) {
            if (!config.ALLOW_INVITE_PASSWORD) {
                await message.reply('Invite password is not configured right now.');
                return;
            }

            const input = message.content.slice('!allowinvite '.length).trim();
            if (input === config.ALLOW_INVITE_PASSWORD) {
                state.allowedInviteUsers.add(message.author.id);
                state.saveAllowedInviteUsers();
                await message.reply('You are now allowed to send Discord invite links in the server.');
            } else {
                await message.reply('Incorrect password.');
            }
            return;
        }

        if (!message.guild) return;
        if (!helpers.containsInviteLink(message.content)) return;
        if (helpers.canPostInviteLinkInGuild(message.guild, message.author.id)) return;

        try {
            await message.delete();
            const warning = await message.channel.send('Invite links are not allowed here.');
            setTimeout(() => warning.delete().catch(() => {}), 5000);
        } catch (error) {
            console.error('Invite moderation failed:', error);
        }
    }

    async function handleInteraction(interaction) {
        if (!interaction.guild) return;

        if (interaction.isButton()) {
            const handledShyStageLimit = await handleShyStageLimitButton(interaction);
            if (handledShyStageLimit) return;

            const handled = await stageFeature.handleButtonInteraction(interaction);
            if (handled) return;
        }

        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === 'events') {
            try {
                await interaction.deferReply();
                await sendActiveEvents(interaction, interaction.guild);
            } catch (error) {
                console.error('Slash event lookup failed:', error);
                const method = interaction.replied || interaction.deferred ? 'editReply' : 'reply';
                await interaction[method]('I could not fetch the server events right now.');
            }
            return;
        }

        if (interaction.commandName === 'queue') {
            const result = stageFeature.getQueueEmbed(interaction.channel);
            if (result.status === 'missing') {
                await interaction.reply(helpers.privateReply('There is no active stage in this server.'));
                return;
            }

            await interaction.reply({ embeds: [result.embed] });
            return;
        }

        const member = await interaction.guild.members.fetch(interaction.user.id);
        const staffOnlyCommands = new Set([
            'announce',
            'announce-color',
            'start-queue',
            'startqueue',
            'open-queue',
            'close-queue',
            'stop-queue',
            'next',
            'radio',
            'allow-invites',
            'revoke-invites',
            'purge-invites',
        ]);

        if (staffOnlyCommands.has(interaction.commandName) && !helpers.isStaff(member)) {
            await interaction.reply(helpers.privateReply('Staff only.'));
            return;
        }

        if (interaction.commandName === 'announce-color') {
            const guildConfig = state.getGuildConfig(interaction.guild.id);
            const shouldReset = interaction.options.getBoolean('reset') === true;
            const colorInput = interaction.options.getString('color');

            if (shouldReset) {
                delete guildConfig.announcementColor;
                state.persistGuildConfigs();
                await interaction.reply(helpers.privateReply('Default announcement embed color cleared.'));
                return;
            }

            if (!colorInput) {
                const currentColor = typeof guildConfig.announcementColor === 'string'
                    ? guildConfig.announcementColor
                    : null;
                await interaction.reply(helpers.privateReply(
                    currentColor
                        ? `Default announcement embed color is ${currentColor}.`
                        : 'No default announcement embed color is saved for this server.'
                ));
                return;
            }

            const color = parseAnnouncementColor(colorInput);
            if (color?.error) {
                await interaction.reply(helpers.privateReply(color.error));
                return;
            }

            guildConfig.announcementColor = color.hex;
            state.persistGuildConfigs();
            await interaction.reply(helpers.privateReply(`Default announcement embed color set to ${color.hex}.`));
            return;
        }

        if (interaction.commandName === 'announce') {
            const targetChannel = interaction.options.getChannel('channel') ?? interaction.channel;
            if (!targetChannel?.isTextBased() || targetChannel.isDMBased?.()) {
                await interaction.reply(helpers.privateReply('Choose a server text channel for the announcement.'));
                return;
            }

            const message = normalizeAnnouncementText(interaction.options.getString('message', true));
            const title = interaction.options.getString('title')?.trim() || null;
            const guildConfig = state.getGuildConfig(interaction.guild.id);
            const requestedColor = parseAnnouncementColor(interaction.options.getString('color'));
            if (requestedColor?.error) {
                await interaction.reply(helpers.privateReply(requestedColor.error));
                return;
            }

            const defaultColor = parseAnnouncementColor(guildConfig.announcementColor);
            const embedColor = requestedColor?.value ?? defaultColor?.value ?? fallbackAnnouncementColor;

            const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
            const permissions = targetChannel.permissionsFor(botMember);
            const requiredPermissions = targetChannel.isThread()
                ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads]
                : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

            if (!permissions?.has(requiredPermissions)) {
                await interaction.reply(helpers.privateReply(`I can't send messages in <#${targetChannel.id}>.`));
                return;
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            try {
                const payload = title || requestedColor?.value
                    ? {
                        embeds: [new EmbedBuilder()
                            .setDescription(message)
                            .setColor(embedColor)
                            .setTitle(title ?? 'Announcement')],
                    }
                    : { content: message };

                await targetChannel.send(payload);
                await interaction.editReply(`Announcement sent to <#${targetChannel.id}>.`);
            } catch (error) {
                console.error('Announcement send failed:', error);
                await interaction.editReply(`I couldn't send the announcement to <#${targetChannel.id}>.`);
            }
            return;
        }

        if (interaction.commandName === 'start-queue' || interaction.commandName === 'startqueue') {
            if (!member.voice.channel) {
                await interaction.reply(helpers.privateReply('Join the voice channel you want me to host in first.'));
                return;
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = await stageFeature.startStage(interaction.channel, member.voice.channelId);
            if (result.status === 'conflict') {
                await interaction.editReply(`A stage is already active in <#${result.targetVC}>. You can add more control panels only for that same voice channel.`);
                return;
            }

            const response = result.status === 'created'
                ? `Stage initialized for <#${member.voice.channelId}>.`
                : result.status === 'added-panel'
                    ? `Added a control panel for the active stage in <#${result.targetVC}>.`
                    : `Refreshed this control panel for the active stage in <#${result.targetVC}>.`;

            await interaction.editReply(response);
            return;
        }

        if (interaction.commandName === 'open-queue' || interaction.commandName === 'close-queue') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = await stageFeature.setJoinState(interaction.channel, interaction.commandName === 'open-queue');
            if (result.status === 'missing') {
                await interaction.editReply('There is no active stage in this server.');
                return;
            }

            await interaction.editReply(result.acceptingJoins
                ? 'Queue reopened. New people can join again.'
                : 'Queue closed. New people cannot join right now.');
            return;
        }

        if (interaction.commandName === 'ad-upload') {
            const attachment = interaction.options.getAttachment('image', true);
            const title = interaction.options.getString('title');

            if (!(attachment.contentType ?? '').startsWith('image/') && !resolveImageExtension(attachment)) {
                await interaction.reply(helpers.privateReply('Upload a PNG, JPG, GIF, or WEBP image.'));
                return;
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            try {
                const advertisement = await storeAdvertisementAttachment(attachment, title);
                await syncStageAdvertisementsForGuild(interaction.guild);
                await interaction.editReply(`Uploaded ad ${advertisement.title}. It is now the active OBS ad.`);
            } catch (error) {
                console.error('Ad upload failed:', error);
                await interaction.editReply('I could not save that image right now.');
            }
            return;
        }

        if (interaction.commandName === 'ad-list') {
            await interaction.reply(helpers.privateReply(buildAdvertisementList()));
            return;
        }

        if (interaction.commandName === 'ad-show') {
            const index = interaction.options.getInteger('index', true) - 1;
            const advertisement = state.setActiveAdvertisementByIndex(index);

            if (!advertisement) {
                await interaction.reply(helpers.privateReply('That ad number does not exist.'));
                return;
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await syncStageAdvertisementsForGuild(interaction.guild);
            await interaction.editReply(`Active ad set to ${advertisement.title}.`);
            return;
        }

        if (interaction.commandName === 'ad-rotate') {
            const advertisements = state.getAdvertisements();
            if (advertisements.length < 2) {
                await interaction.reply(helpers.privateReply('Upload at least two ads before enabling auto-rotation.'));
                return;
            }

            const seconds = interaction.options.getInteger('seconds', true);
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            state.setAdvertisementRotationIntervalMs(seconds * 1000);
            await syncStageAdvertisementsForGuild(interaction.guild);
            await interaction.editReply(`Auto-rotation enabled. Ads will advance every ${seconds} seconds.`);
            return;
        }

        if (interaction.commandName === 'ad-rotate-stop') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            state.setAdvertisementRotationIntervalMs(null);
            await syncStageAdvertisementsForGuild(interaction.guild);
            await interaction.editReply('Auto-rotation disabled.');
            return;
        }

        if (interaction.commandName === 'ad-remove') {
            const index = interaction.options.getInteger('index', true) - 1;
            const removed = state.removeAdvertisementByIndex(index);

            if (!removed) {
                await interaction.reply(helpers.privateReply('That ad number does not exist.'));
                return;
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await fs.promises.unlink(path.join(config.ADS_DIR, removed.fileName)).catch(() => {});
            await syncStageAdvertisementsForGuild(interaction.guild);
            await interaction.editReply(`Deleted ad ${removed.title}.`);
            return;
        }

        if (interaction.commandName === 'next') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = await stageFeature.nextSpeaker(interaction.channel);
            if (result.status === 'missing') {
                await interaction.editReply('There is no active stage in this server.');
                return;
            }

            await syncStageAdvertisementsForGuild(interaction.guild);
            await interaction.editReply('Moved to the next performer.');
            return;
        }

        if (interaction.commandName === 'radio') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = await stageFeature.toggleRadio(interaction.channel);
            if (result.status === 'missing') {
                await interaction.editReply('There is no active stage in this server.');
                return;
            }

            if (result.status === 'started') {
                await syncStageAdvertisementsForGuild(interaction.guild);
            }

            await interaction.editReply(result.status === 'started' ? 'Radio started.' : 'Radio stopped.');
            return;
        }

        if (interaction.commandName === 'stop-queue') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = await concludeStageSession(interaction.guild, interaction.channel);
            if (result.status === 'missing') {
                await interaction.editReply('There is no active stage in this server.');
                return;
            }

            await interaction.editReply({
                content: `Event finished. Connection closed.${result.statsPostedText}`,
                embeds: result.statsEmbed ? [result.statsEmbed] : [],
            });
            return;
        }

        if (interaction.commandName === 'allow-invites') {
            const target = interaction.options.getUser('target', true);
            state.allowedInviteUsers.add(target.id);
            state.saveAllowedInviteUsers();
            await interaction.reply(helpers.privateReply(`<@${target.id}> can now post Discord invite links.`));
            return;
        }

        if (interaction.commandName === 'revoke-invites') {
            const target = interaction.options.getUser('target', true);
            const removed = state.allowedInviteUsers.delete(target.id);
            if (removed) state.saveAllowedInviteUsers();
            await interaction.reply(helpers.privateReply(
                removed
                    ? `Removed invite link permission for <@${target.id}>.`
                    : `<@${target.id}> was not on the invite allowlist.`
            ));
            return;
        }

        if (interaction.commandName === 'purge-invites') {
            const scanLimit = interaction.options.getInteger('messages_per_channel') ?? config.DEFAULT_PURGE_SCAN_LIMIT;
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = await purgeInviteLinksInGuild(interaction.guild, scanLimit);
            await interaction.editReply(`Invite cleanup finished. Scanned ${result.scannedChannels} channels, skipped ${result.skippedChannels}, checked ${result.scannedMessages} messages, and deleted ${result.deletedMessages} invite links.`);
            return;
        }
    }

    async function handleVoiceStateUpdate(oldState, newState) {
        const member = newState.member ?? oldState.member;
        const guild = newState.guild ?? oldState.guild;
        if (!member || member.user.bot || !guild) return;

        const oldStageIndex = parseShyStageIndex(oldState.channel?.name ?? null);
        const newStageIndex = parseShyStageIndex(newState.channel?.name ?? null);
        const touchedShyStage = oldStageIndex !== null || newStageIndex !== null;

        const oldChannelId = oldState.channelId;
        const newChannelId = newState.channelId;
        const wasCounted = isCountedVoiceState(oldState);
        const isCounted = isCountedVoiceState(newState);
        const activeStageSession = state.peekGuildStageSession(guild.id);
        const touchedActiveStage = activeStageSession && (oldChannelId === activeStageSession.targetVC || newChannelId === activeStageSession.targetVC);
        let shouldAutoStopStage = false;

        if (touchedActiveStage) {
            await stageFeature.updateAttendance(guild, activeStageSession.targetVC);

            if (oldChannelId === activeStageSession.targetVC && newChannelId === activeStageSession.targetVC) {
                if (oldState.suppress === true && newState.suppress === false) {
                    await stageFeature.registerSpeakerPromotion(guild, activeStageSession.targetVC, member.id);
                } else if (oldState.suppress === false && newState.suppress === true) {
                    await stageFeature.registerSpeakerDemotion(guild, activeStageSession.targetVC, member.id);
                }
            }

            const activeStageChannel = guild.channels.cache.get(activeStageSession.targetVC)
                ?? await guild.channels.fetch(activeStageSession.targetVC).catch(() => null);
            const activeStageMemberCount = activeStageChannel?.members?.filter(stageMember => !stageMember.user.bot).size ?? 0;
            shouldAutoStopStage = activeStageMemberCount === 0;
        }

        const maybeAutoStopStage = async () => {
            if (!shouldAutoStopStage) return;

            const currentStageSession = state.peekGuildStageSession(guild.id);
            if (!currentStageSession?.targetVC) return;

            const controlChannelId = currentStageSession.panelChannelIds.values().next().value;
            if (!controlChannelId) return;

            const controlChannel = guild.channels.cache.get(controlChannelId)
                ?? await guild.channels.fetch(controlChannelId).catch(() => null);
            if (!controlChannel?.isTextBased()) return;

            shouldAutoStopStage = false;
            await concludeStageSession(guild, controlChannel, { notifyPanels: true });
        };

        if (oldChannelId === newChannelId) {
            if (oldChannelId && wasCounted !== isCounted) {
                state.updateVoiceHourSessionMute(guild.id, member.id, !isCounted, new Date());
            }
            if (touchedShyStage && oldChannelId) {
                await syncShyStageRooms(guild, oldChannelId);
            }
            await maybeAutoStopStage();
            return;
        }

        if (!oldChannelId && newChannelId) {
            if (isCounted) {
                state.startVoiceHourSession(guild.id, member.id, newChannelId, new Date(), false);
            }
            if (newStageIndex !== null) {
                await syncShyStageRooms(guild, newChannelId);
            }
            await maybeAutoStopStage();
            return;
        }

        if (oldChannelId && !newChannelId) {
            if (wasCounted) {
                state.endVoiceHourSession(guild.id, member.id);
            }
            if (oldStageIndex !== null) {
                await syncShyStageRooms(guild, oldChannelId);
            }
            await maybeAutoStopStage();
            return;
        }

        if (wasCounted && isCounted) {
            state.moveVoiceHourSession(guild.id, member.id, newChannelId, new Date(), false);
            if (touchedShyStage) {
                await syncShyStageRooms(guild, newChannelId ?? oldChannelId);
            }
            await maybeAutoStopStage();
            return;
        }

        if (wasCounted) {
            state.endVoiceHourSession(guild.id, member.id);
            if (oldStageIndex !== null) {
                await syncShyStageRooms(guild, oldChannelId);
            }
            await maybeAutoStopStage();
            return;
        }

        if (isCounted) {
            state.startVoiceHourSession(guild.id, member.id, newChannelId, new Date(), false);
            if (newStageIndex !== null) {
                await syncShyStageRooms(guild, newChannelId);
            }
            await maybeAutoStopStage();
        }
    }

    return {
        restoreScheduledTasks,
        restoreVoiceHourSessions,
        handleMessageCreate,
        handleVoiceStateUpdate,
        handleInteraction,
        startTrackedStage,
        endTrackedStage,
        sendAnnouncementFromAdmin,
        setInviteException,
        uploadAdvertisementFromAdmin,
        removeAdvertisementFromAdmin,
        purgeInvitesFromAdmin,
    };
}

module.exports = { createCommunityFeature };
