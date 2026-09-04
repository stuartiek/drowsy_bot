const { ChannelType, SlashCommandBuilder } = require('discord.js');
const config = require('./config');

function buildCommands() {
    return [
        new SlashCommandBuilder().setName('events').setDescription('Post links for live and upcoming server events'),
        new SlashCommandBuilder()
            .setName('announce')
            .setDescription('Send an announcement through the bot (Staff Only)')
            .addStringOption(option => option.setName('message').setDescription('Announcement text').setRequired(true).setMaxLength(2000))
            .addStringOption(option => option.setName('title').setDescription('Optional embed title').setMaxLength(256))
            .addStringOption(option => option.setName('color').setDescription('Optional embed color, like #5865F2').setMaxLength(7))
            .addChannelOption(option => option
                .setName('channel')
                .setDescription('Channel to post in, defaults to the current channel')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
        new SlashCommandBuilder()
            .setName('announce-color')
            .setDescription('Set or clear the default embed color for announcements (Staff Only)')
            .addStringOption(option => option.setName('color').setDescription('Default embed color, like #5865F2').setMaxLength(7))
            .addBooleanOption(option => option.setName('reset').setDescription('Clear the saved default color')),
        new SlashCommandBuilder()
            .setName('allow-invites')
            .setDescription('Allow a user or bot to post Discord invite links (Staff Only)')
            .addUserOption(option => option.setName('target').setDescription('User or bot to allow').setRequired(true)),
        new SlashCommandBuilder()
            .setName('revoke-invites')
            .setDescription('Remove invite link permission from a user or bot (Staff Only)')
            .addUserOption(option => option.setName('target').setDescription('User or bot to remove').setRequired(true)),
        new SlashCommandBuilder()
            .setName('purge-invites')
            .setDescription('Delete unauthorized invite links across text channels (Staff Only)')
            .addIntegerOption(option => option.setName('messages_per_channel').setDescription('Messages to scan per channel').setMinValue(1).setMaxValue(config.MAX_PURGE_SCAN_LIMIT)),
        new SlashCommandBuilder().setName('queue').setDescription('Show the current stage queue'),
        new SlashCommandBuilder().setName('start-queue').setDescription('Start a queue for your current voice channel (Staff Only)'),
        new SlashCommandBuilder().setName('startqueue').setDescription('Start a queue for your current voice channel (Staff Only)'),
        new SlashCommandBuilder().setName('open-queue').setDescription('Open the active queue for new joiners (Staff Only)'),
        new SlashCommandBuilder().setName('close-queue').setDescription('Close the active queue to new joiners (Staff Only)'),
        new SlashCommandBuilder().setName('next').setDescription('Move the queue to the next performer (Staff Only)'),
        new SlashCommandBuilder().setName('radio').setDescription('Toggle intermission radio for the active queue (Staff Only)'),
        new SlashCommandBuilder().setName('stop-queue').setDescription('Stop the active queue and post event stats (Staff Only)'),
    ].map(command => command.toJSON());
}

module.exports = { buildCommands };