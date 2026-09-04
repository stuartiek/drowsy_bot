const fs = require('fs');
const path = require('path');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
} = require('@discordjs/voice');

function createStageFeature({ config, state, helpers }) {
    function getCountedStageMemberIds(voiceChannel) {
        if (!voiceChannel?.members) return [];

        return [...voiceChannel.members.values()]
            .filter(member => !member.user.bot)
            .map(member => member.id);
    }

    function syncAttendance(session, attendeeIds) {
        const uniqueAttendeeIds = [...new Set(attendeeIds)];
        session.peakAttendance = Math.max(session.peakAttendance, uniqueAttendeeIds.length);
        for (const attendeeId of uniqueAttendeeIds) {
            session.attendeeIds.add(attendeeId);
        }
    }

    function buildStageStatsEmbed(session) {
        const performerCount = session.performerIds.size;
        const audienceCount = [...session.attendeeIds].filter(attendeeId => !session.performerIds.has(attendeeId)).length;

        return new EmbedBuilder()
            .setTitle('Event Stats')
            .setColor(0x5865F2)
            .addFields(
                { name: 'Performers', value: `${performerCount}`, inline: true },
                { name: 'Audience', value: `${audienceCount}`, inline: true },
                { name: 'Songs Sung', value: `${session.songsSung}`, inline: true },
                { name: 'Peak Attendance', value: `${session.peakAttendance}`, inline: true }
            )
            .setFooter({ text: session.startedAt ? `Started ${new Date(session.startedAt).toLocaleString()}` : 'Stage session ended' });
    }

    function buildStageStatsSummary(session, endedAt = new Date()) {
        const performerCount = session.performerIds.size;
        const audienceCount = [...session.attendeeIds].filter(attendeeId => !session.performerIds.has(attendeeId)).length;
        const startedAt = session.startedAt ? new Date(session.startedAt) : null;
        const runtimeMs = startedAt ? Math.max(0, endedAt.getTime() - startedAt.getTime()) : 0;
        const runtimeMinutes = Math.floor(runtimeMs / 60000);
        const runtimeHours = Math.floor(runtimeMinutes / 60);
        const remainingMinutes = runtimeMinutes % 60;
        const runtimeText = runtimeHours > 0
            ? `${runtimeHours}h ${remainingMinutes}m`
            : `${remainingMinutes}m`;

        return {
            performers: performerCount,
            audience: audienceCount,
            songsSung: session.songsSung,
            peakAttendance: session.peakAttendance,
            startedAt: session.startedAt,
            endedAt: endedAt.toISOString(),
            runtimeText,
            stageName: session.targetVC ? `Voice Channel ${session.targetVC}` : 'Unknown stage',
        };
    }

    async function startRadio(guild, session) {
        if (!session.targetVC) return;

        session.voiceConnection = joinVoiceChannel({
            channelId: session.targetVC,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
        });

        const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
        const playTrack = () => {
            const trackPath = path.join(config.ASSETS_DIR, 'intermission.mp3');
            if (!fs.existsSync(trackPath)) return;

            const resource = createAudioResource(trackPath);
            player.play(resource);
            if (session.voiceConnection) session.voiceConnection.subscribe(player);
            session.radioPlayer = player;
        };

        player.on(AudioPlayerStatus.Idle, () => {
            if (session.radioPlayer) playTrack();
        });

        playTrack();
    }

    function stopRadio(session) {
        if (session.radioPlayer) {
            session.radioPlayer.stop();
            session.radioPlayer = null;
        }
    }

    function buildQueueEmbed(channel, session) {
        return new EmbedBuilder()
            .setTitle('Drowsy Multi-Stage Queue')
            .setDescription(`On Stage: ${session.currentSpeaker ? `<@${session.currentSpeaker}>` : 'Open Mic'}\nCurrent VC: <#${session.targetVC}>\nQueue Status: ${session.acceptingJoins ? 'Open' : 'Closed'}\n\nComing Up:\n${session.queue.length > 0 ? session.queue.map((id, index) => `${index + 1}. <@${id}>`).join('\n') : 'The queue is empty.'}`)
            .setColor(0x5865F2)
            .setFooter({ text: `Control Room: #${channel.name}` });
    }

    function buildQueueButtons(session) {
        return [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('join').setLabel('Join Queue').setStyle(ButtonStyle.Primary).setDisabled(!session.acceptingJoins),
                new ButtonBuilder().setCustomId('leave').setLabel('Leave').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('finished').setLabel('Done').setStyle(ButtonStyle.Success)
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('toggle-joins')
                    .setLabel(session.acceptingJoins ? 'Staff: Close Queue' : 'Staff: Open Queue')
                    .setStyle(session.acceptingJoins ? ButtonStyle.Danger : ButtonStyle.Success)
            ),
        ];
    }

    async function refreshPanel(channel, session) {
        const previousMessageId = session.panelMessageIds.get(channel.id);
        if (previousMessageId) {
            const previousMessage = await channel.messages.fetch(previousMessageId).catch(() => null);
            if (previousMessage) await previousMessage.delete().catch(() => {});
        }

        const message = await channel.send({ embeds: [buildQueueEmbed(channel, session)], components: buildQueueButtons(session) });
        session.panelMessageIds.set(channel.id, message.id);
    }

    async function refreshAllPanels(guild, session) {
        for (const channelId of [...session.panelChannelIds]) {
            const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
            if (!channel?.isTextBased()) {
                session.panelChannelIds.delete(channelId);
                session.panelMessageIds.delete(channelId);
                session.adMessageIds.delete(channelId);
                continue;
            }

            await refreshPanel(channel, session);
        }
    }

    async function announceCurrentSpeaker(guild, session) {
        stopRadio(session);
        const speakerId = session.currentSpeaker;
        const speakerMember = await guild.members.fetch(speakerId).catch(() => null);
        const speakerName = speakerMember?.displayName ?? speakerMember?.user?.username ?? 'Unknown Singer';

        const nowSingingEmbed = new EmbedBuilder()
            .setTitle('Now Singing')
            .setDescription(`<@${speakerId}>\nStage: <#${session.targetVC}>`)
            .setColor(0x5865F2);

        for (const channelId of session.panelChannelIds) {
            const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
            if (!channel?.isTextBased()) continue;

            await channel.send({
                content: `<@${speakerId}>, the floor is yours in <#${session.targetVC}>!`,
                embeds: [nowSingingEmbed],
            }).catch(() => {});
        }
    }

    async function handleNextSpeaker(guild, session) {
        if (session.queue.length > 0) {
            session.currentSpeaker = session.queue.shift();
            session.performerIds.add(session.currentSpeaker);
            session.songsSung += 1;
            await announceCurrentSpeaker(guild, session);
            return;
        }

        session.currentSpeaker = null;
        await startRadio(guild, session);
    }

    async function startStage(channel, voiceChannelId, options = {}) {
        const trackingOnly = options.trackingOnly === true;
        const existingSession = state.peekGuildStageSession(channel.guild.id);
        if (existingSession) {
            if (existingSession.targetVC !== voiceChannelId) {
                return { status: 'conflict', targetVC: existingSession.targetVC };
            }

            if (trackingOnly) {
                return { status: 'existing-tracker', targetVC: existingSession.targetVC };
            }

            const hadPanel = existingSession.panelChannelIds.has(channel.id);
            existingSession.panelChannelIds.add(channel.id);
            await refreshAllPanels(channel.guild, existingSession);
            return { status: hadPanel ? 'existing-panel' : 'added-panel', targetVC: existingSession.targetVC };
        }

        const session = state.getGuildStageSession(channel.guild.id);
        session.targetVC = voiceChannelId;
        session.startedAt = new Date().toISOString();
        const voiceChannel = channel.guild.channels.cache.get(voiceChannelId) ?? await channel.guild.channels.fetch(voiceChannelId).catch(() => null);
        syncAttendance(session, getCountedStageMemberIds(voiceChannel));

        if (!trackingOnly) {
            session.panelChannelIds.add(channel.id);
            await refreshAllPanels(channel.guild, session);
            await startRadio(channel.guild, session);
        }

        return { status: 'created', targetVC: session.targetVC };
    }

    async function updateAttendance(guild, voiceChannelId) {
        const session = state.peekGuildStageSession(guild.id);
        if (!session || session.targetVC !== voiceChannelId) return;

        const voiceChannel = guild.channels.cache.get(voiceChannelId) ?? await guild.channels.fetch(voiceChannelId).catch(() => null);
        syncAttendance(session, getCountedStageMemberIds(voiceChannel));
    }

    async function registerSpeakerPromotion(guild, voiceChannelId, memberId) {
        const session = state.peekGuildStageSession(guild.id);
        if (!session || session.targetVC !== voiceChannelId) return { status: 'missing' };

        if (!session.performerIds.has(memberId)) {
            session.performerIds.add(memberId);
        }

        if (session.currentSpeaker !== memberId) {
            session.currentSpeaker = memberId;
            session.songsSung += 1;
            await announceCurrentSpeaker(guild, session);
            await refreshAllPanels(guild, session);
            return { status: 'ok', currentSpeaker: session.currentSpeaker, announced: true };
        }

        return { status: 'ok', currentSpeaker: session.currentSpeaker, announced: false };
    }

    async function registerSpeakerDemotion(guild, voiceChannelId, memberId) {
        const session = state.peekGuildStageSession(guild.id);
        if (!session || session.targetVC !== voiceChannelId) return { status: 'missing' };
        if (session.currentSpeaker !== memberId) return { status: 'ok', cleared: false, currentSpeaker: session.currentSpeaker };

        await handleNextSpeaker(guild, session);
        await refreshAllPanels(guild, session);
        return { status: 'ok', cleared: true, currentSpeaker: session.currentSpeaker };
    }

    function getQueueEmbed(channel) {
        const session = state.peekGuildStageSession(channel.guild.id);
        if (!session) return { status: 'missing' };

        return {
            status: 'ok',
            embed: buildQueueEmbed(channel, session),
        };
    }

    async function nextSpeaker(channel) {
        const session = state.peekGuildStageSession(channel.guild.id);
        if (!session) return { status: 'missing' };

        await handleNextSpeaker(channel.guild, session);
        await refreshAllPanels(channel.guild, session);
        return { status: 'ok', currentSpeaker: session.currentSpeaker };
    }

    async function toggleRadio(channel) {
        const session = state.peekGuildStageSession(channel.guild.id);
        if (!session) return { status: 'missing' };

        if (session.radioPlayer) {
            stopRadio(session);
            return { status: 'stopped' };
        }

        await startRadio(channel.guild, session);
        return { status: 'started' };
    }

    async function setJoinState(channel, acceptingJoins) {
        const session = state.peekGuildStageSession(channel.guild.id);
        if (!session) return { status: 'missing' };

        session.acceptingJoins = acceptingJoins;
        await refreshAllPanels(channel.guild, session);
        return { status: 'ok', acceptingJoins: session.acceptingJoins };
    }

    async function joinQueue(channel, member) {
        const session = state.peekGuildStageSession(channel.guild.id);
        if (!session) return { status: 'missing' };
        if (!session.acceptingJoins) return { status: 'closed' };
        if (!member.voice.channel || member.voice.channelId !== session.targetVC) {
            return { status: 'wrong-channel', targetVC: session.targetVC };
        }
        if (session.queue.includes(member.id) || session.currentSpeaker === member.id) {
            return { status: 'already-queued' };
        }
        const maxQueueLength = state.getBotSettings().queue?.maxQueueLength ?? 25;
        if (session.queue.length >= maxQueueLength) return { status: 'full', maxQueueLength };

        session.queue.push(member.id);
        if (!session.currentSpeaker) {
            await handleNextSpeaker(channel.guild, session);
        }

        await refreshAllPanels(channel.guild, session);
        return { status: 'ok', currentSpeaker: session.currentSpeaker };
    }

    async function leaveQueue(channel, userId) {
        const session = state.peekGuildStageSession(channel.guild.id);
        if (!session) return { status: 'missing' };

        const queuedBefore = session.queue.includes(userId);
        session.queue = session.queue.filter(id => id !== userId);

        if (session.currentSpeaker === userId) {
            session.currentSpeaker = null;
            await handleNextSpeaker(channel.guild, session);
            await refreshAllPanels(channel.guild, session);
            return { status: 'ok', removedCurrentSpeaker: true, currentSpeaker: session.currentSpeaker };
        }

        if (!queuedBefore) {
            return { status: 'not-queued' };
        }

        await refreshAllPanels(channel.guild, session);
        return { status: 'ok', removedCurrentSpeaker: false, currentSpeaker: session.currentSpeaker };
    }

    async function addToQueue(channel, member) {
        const session = state.peekGuildStageSession(channel.guild.id);
        if (!session) return { status: 'missing' };
        if (session.queue.includes(member.id) || session.currentSpeaker === member.id) {
            return { status: 'already-queued' };
        }
        const maxQueueLength = state.getBotSettings().queue?.maxQueueLength ?? 25;
        if (session.queue.length >= maxQueueLength) return { status: 'full', maxQueueLength };

        session.queue.push(member.id);
        if (!session.currentSpeaker) {
            await handleNextSpeaker(channel.guild, session);
        }

        await refreshAllPanels(channel.guild, session);
        return { status: 'ok', currentSpeaker: session.currentSpeaker };
    }

    async function stopStage(channel) {
        const session = state.peekGuildStageSession(channel.guild.id);
        if (!session) return { status: 'missing' };

        await updateAttendance(channel.guild, session.targetVC);
        const endedAt = new Date();
        const statsSummary = buildStageStatsSummary(session, endedAt);

        if (session.targetVC) {
            const stageChannel = channel.guild.channels.cache.get(session.targetVC) ?? await channel.guild.channels.fetch(session.targetVC).catch(() => null);
            if (stageChannel?.name) {
                statsSummary.stageName = stageChannel.name;
            }
        }

        stopRadio(session);
        if (session.voiceConnection) session.voiceConnection.destroy();

        for (const [panelChannelId, messageId] of session.panelMessageIds.entries()) {
            const panelChannel = channel.guild.channels.cache.get(panelChannelId) ?? await channel.guild.channels.fetch(panelChannelId).catch(() => null);
            if (!panelChannel?.isTextBased()) continue;
            const panelMessage = await panelChannel.messages.fetch(messageId).catch(() => null);
            if (panelMessage) await panelMessage.delete().catch(() => {});
        }

        const statsEmbed = buildStageStatsEmbed(session);
        state.clearGuildStageSession(channel.guild.id);
        return { status: 'stopped', statsEmbed, statsSummary };
    }

    async function handleButtonInteraction(interaction) {
        if (!interaction.isButton()) return false;

        const session = state.peekGuildStageSession(interaction.guild.id);
        if (!session) {
            await interaction.reply(helpers.privateReply('This control panel is no longer active.'));
            return true;
        }

        if (!session.panelChannelIds.has(interaction.channelId)) {
            await interaction.reply(helpers.privateReply('This control panel is no longer active.'));
            return true;
        }

        const member = await interaction.guild.members.fetch(interaction.user.id);

        if (interaction.customId === 'join') {
            if (!session.acceptingJoins) {
                await interaction.reply(helpers.privateReply('This queue is closed to new joiners right now.'));
                return true;
            }

            if (!member.voice.channel || member.voice.channelId !== session.targetVC) {
                await interaction.reply(helpers.privateReply(`You must be in <#${session.targetVC}> to join this queue.`));
                return true;
            }

            if (session.queue.includes(interaction.user.id) || session.currentSpeaker === interaction.user.id) {
                await interaction.reply(helpers.privateReply('You are already in the lineup.'));
                return true;
            }

            session.queue.push(interaction.user.id);
            if (!session.currentSpeaker) {
                await handleNextSpeaker(interaction.guild, session);
            }
        } else if (interaction.customId === 'leave') {
            session.queue = session.queue.filter(id => id !== interaction.user.id);
            if (session.currentSpeaker === interaction.user.id) {
                session.currentSpeaker = null;
                await handleNextSpeaker(interaction.guild, session);
            }
        } else if (interaction.customId === 'finished') {
            if (interaction.user.id !== session.currentSpeaker) {
                await interaction.reply(helpers.privateReply('It is not your turn.'));
                return true;
            }

            await handleNextSpeaker(interaction.guild, session);
        } else if (interaction.customId === 'toggle-joins') {
            if (!helpers.isStaff(member)) {
                await interaction.reply(helpers.privateReply('Staff only.'));
                return true;
            }

            session.acceptingJoins = !session.acceptingJoins;
        } else {
            return false;
        }

        await interaction.deferUpdate();
        await refreshAllPanels(interaction.guild, session);
        return true;
    }

    return {
        startStage,
        getQueueEmbed,
        joinQueue,
        leaveQueue,
        addToQueue,
        nextSpeaker,
        toggleRadio,
        setJoinState,
        stopStage,
        updateAttendance,
        registerSpeakerPromotion,
        registerSpeakerDemotion,
        handleButtonInteraction,
    };
}

module.exports = { createStageFeature };