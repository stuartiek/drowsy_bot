const { MessageFlags, PermissionFlagsBits } = require('discord.js');

function createHelpers(config, state) {
    return {
        privateReply(content) {
            return { content, flags: MessageFlags.Ephemeral };
        },
        containsInviteLink(content) {
            return config.INVITE_REGEX.test(content ?? '');
        },
        isStaff(member) {
            if (!member) return false;

            return member.guild.ownerId === member.id
                || member.permissions.has(PermissionFlagsBits.Administrator)
                || member.permissions.has(PermissionFlagsBits.ManageGuild)
                || member.permissions.has(PermissionFlagsBits.ModerateMembers)
                || member.roles.cache.some(role => config.STAGE_ADMIN_ROLES.includes(role.name));
        },
        canPostInviteLinkInGuild(guild, userId) {
            if (!guild) return false;
            return guild.ownerId === userId || state.allowedInviteUsers.has(userId);
        },
    };
}

module.exports = { createHelpers };