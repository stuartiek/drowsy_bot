# Drowsy Bot

Drowsy Bot is a Discord bot focused on three areas:

- hosted stage and queue events
- invite-link moderation and invite allowlisting

It is built with Node.js and discord.js and stores runtime data in JSON files under `data/`.

## Current Feature Set

- Multi-stage queue flow for voice events
- Intermission radio playback from a local MP3 file
- Public scheduled-event lookup
- Staff announcement command for posting through the bot
- Invite moderation with allowlist and cleanup tools

The dedicated PDF export source is available at `docs/drowsy-bot-pdf.html`.

## Removed Systems

These systems are no longer part of the bot:

- reaction roles
- logging system
- moderation commands
- sticky-role handling

## Requirements

- Node.js 20 or newer
- A Discord application with a bot user
- A Discord server where the bot can be invited and managed

## Installation

```bash
git clone https://github.com/ABZ-Digital-Group/drowsy_bot.git
cd drowsy_bot
npm install
node index.js
```

## Environment Variables

Create a `.env` file:

```env
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_id
GUILD_ID=your_server_id
ALLOW_INVITE_PASSWORD=optional_dm_password
ADMIN_HTTP_PORT=8080
ADMIN_HTTP_HOST=127.0.0.1
BOT_API_SECRET=use-the-same-long-random-value-in-the-management-site
SHY_STAGE_BASE_NAME=sleepy singing
SHY_STAGE_UNUSED_DELETE_MINUTES=5
SHY_STAGE_EMPTY_DELETE_MINUTES=15
SHY_STAGE_CLEANUP_INTERVAL_SECONDS=60
SHY_STAGE_LIMIT_CHOICES=5,10,15,unlimited
```

### Variable Reference

- `DISCORD_TOKEN`: bot token from the Discord developer portal
- `CLIENT_ID`: Discord application ID used to register guild commands
- `GUILD_ID`: guild where slash commands are registered
- `ALLOW_INVITE_PASSWORD`: optional password used by the DM command `!allowinvite <password>`
- `ADMIN_HTTP_PORT`: port for the browser admin panel
- `ADMIN_HTTP_HOST`: bind host for the private bot API; use `127.0.0.1` behind a local reverse proxy
- `BOT_API_SECRET`: shared secret required by management-site API requests; keep it server-side
- `SHY_STAGE_BASE_NAME`: optional base name prefix for shy stage channels (defaults to `sleepy singing`)
- `SHY_STAGE_UNUSED_DELETE_MINUTES`: optional minutes before an unused auto-created shy stage is deleted
- `SHY_STAGE_EMPTY_DELETE_MINUTES`: optional minutes before a previously used shy stage above 1 and 2 is deleted after becoming empty
- `SHY_STAGE_CLEANUP_INTERVAL_SECONDS`: optional cleanup sweep interval for shy-stage deletion checks

## Management Website Connection

The management website connects to the bot with `X-Bot-Api-Key` over `BOT_API_URL`. Configure the same `BOT_API_SECRET` in both applications. Set the website value to the bot's private HTTPS URL, or to `http://127.0.0.1:8080` when both services run on the same VPS. Do not expose the Discord token or API secret to browser JavaScript.

The bot API provides `GET /health`, authenticated `GET /status`, authenticated `POST /actions/sync`, and authenticated `POST /actions/announcement`.
- `SHY_STAGE_LIMIT_CHOICES`: optional comma-separated member-limit button choices for bot-created shy stages, for example `5,10,15,unlimited`
- `SHY_STAGE_CLEANUP_INTERVAL_SECONDS`: optional cleanup sweep interval for shy-stage deletion checks

## Discord Intents

The bot uses these intents:

- Guilds
- GuildMessages
- MessageContent
- GuildVoiceStates
- GuildMembers
- DirectMessages
- GuildScheduledEvents

## Staff Access Model

Staff-only commands are available to:

- the guild owner
- members with `Administrator`
- members with `Manage Guild`
- members with `Moderate Members`
- members who hold one of these role names:
  - `Realm God`
  - `Dreamy Defender`
  - `Dreamland Guard`
  - `Nighty Knight`
  - `Tired Esquire`

## Project Structure

```text
index.js
src/
  commands.js
  config.js
  helpers.js
  state.js
  features/
    community.js
    stage.js
assets/
data/
```

## Data Files

The bot creates and uses these files under `data/`:

- `guild-config.json`: guild-level bot settings
- `allowed-invite-users.json`: invite allowlist

Some older data files may still exist from previous versions, but they are no longer used by the current runtime.

## Stage Queue System

The stage queue is built for hosted performances or open-mic style events.

### Commands

- `!queue` / `!q`: show the current queue
- `!queuejoin` / `!qj`: join the queue
- `!queueleave` / `!ql`: leave the queue
- `!queuenext` / `!qn`: move to the next performer (staff only)
- `!addqueue` / `!aq`: add someone to the queue by mention, user ID, or exact username/display name (staff only)
- `!startqueue` / `!sq`: start a queue for your current voice channel (staff only)
- `!endqueue` / `!eq`: end the active queue (staff only)

### How It Works

1. A staff member joins the voice channel they want to host.
2. They run `!startqueue` or `!sq` in a text channel.
3. The bot posts a queue panel with buttons.
4. Staff can run `!startqueue` in additional text channels for the same active voice channel to create mirrored control panels.
5. Members can join with `!queuejoin`, leave with `!queueleave`, or use the panel buttons.
6. If nobody is currently up, the first person to join is moved on stage immediately.
7. Staff move the event forward with `!queuenext` or the active speaker ends their turn with `Done`.
8. Anyone can run `!queue` to post the current lineup in the channel.
9. Staff can add someone directly with `!addqueue`.
10. When staff end the session with `!endqueue`, the bot returns post-event stats for performers, audience, songs sung, and peak attendance.

### Queue Buttons

- `Join Queue`
- `Leave`
- `Done`
- `Staff: Close Queue` / `Staff: Open Queue`

### Notes

- `assets/intermission.mp3` is used for radio playback.
- only one voice channel can be active per server at a time
- multiple text-channel control panels can manage that same active voice channel

## Shy Stage Overflow Rooms

- voice channels named `Shy Stage 1`, `Shy Stage 2`, `Shy Stage 3`, and so on are managed automatically
- Roman numeral names are also supported, such as `shy stage I`, `shy stage II`, and `Shy Stage III`
- `Shy Stage 1` and `Shy Stage 2` stay visible at all times
- pre-made overflow rooms above `Shy Stage 2` are hidden until needed
- when the last currently visible shy stage has someone in it, the bot reveals the next pre-made shy stage channel with a default member limit of `3`
- empty overflow rooms above `Shy Stage 2` are hidden again when they are not in use
- the bot posts room-cap buttons in the shy stage chat when an overflow room is revealed
- when the first person joins a managed overflow room, only that user can lock the room limit, and it stays locked for that room until the bot restarts

### How It Works

1. Keep two base shy stages available at all times.
2. A member joins the last currently available shy stage.
3. If that join makes the room active with its first non-bot member, the bot prepares the next shy stage.
4. The next pre-made shy stage is revealed if it is currently hidden.
5. The bot gives the revealed room a default member limit of `3` unless that room already has a locked limit.
6. The bot posts room-cap buttons in that shy stage chat.
7. When the first person joins that managed overflow room, only that user can lock the room limit for the life of that room.
8. Empty overflow rooms above `Shy Stage 2` are hidden again until needed.

### Example Flow

1. `Shy Stage I` and `Shy Stage II` are visible.
2. Someone joins `Shy Stage I`. Nothing new is created yet because `Shy Stage II` is still the last available shy stage.
3. Someone joins `Shy Stage II`.
4. Because `Shy Stage II` is the last currently visible shy stage and just got its first non-bot member, the bot reveals `Shy Stage III`.
5. `Shy Stage III` becomes the next overflow target while it is in use.
6. The room-cap buttons appear in `Shy Stage III` chat.
7. Once `Shy Stage III` is empty again, the bot hides it until it is needed later.

### Requirements

- the bot must be able to view the shy-stage channels
- the bot must have permission to manage channels in that category
- the bot must be able to send messages in the side-chat text channel

### OBS Text Source

If the bot and OBS run on the same machine, you can add a text source that reads from:

```text
assets/obs-now-singing.txt
```

The bot keeps that file updated with:

- the current singer's display name
- `Open Mic` when nobody is up
- `Show Ended` when the queue is stopped

### OBS Browser Source For VPS Hosting

If the bot is hosted on a VPS, OBS cannot read the bot's local filesystem directly. In that case:

1. Set `OBS_HTTP_PORT` in `.env`.
2. Open or proxy that port on the VPS.
3. In OBS, add a Browser Source pointing to:

```text
http://YOUR_VPS_HOST:OBS_HTTP_PORT/obs/now-singing
```

That browser source now renders the active singer's server profile picture using their guild avatar when available, and falls back to their normal Discord avatar otherwise.

There is also a raw text endpoint available at:

```text
http://YOUR_VPS_HOST:OBS_HTTP_PORT/obs/now-singing.txt
```

And a JSON endpoint with both the current display name and avatar URL:

```text
http://YOUR_VPS_HOST:OBS_HTTP_PORT/obs/now-singing.json
```

The browser source updates whenever OBS refreshes the page. If you want near-live updates, set the Browser Source to refresh when it becomes active or use a short custom refresh workflow through OBS/browser-source controls.

### OBS Advertisement Overlay

Staff can upload ad images directly through slash commands:

- `/ad-upload image:<attachment> [title]`
- `/ad-list`
- `/ad-show index:<number>`
- `/ad-rotate seconds:<number>`
- `/ad-rotate-stop`
- `/ad-remove index:<number>`

The active ad is exposed for OBS at:

```text
http://YOUR_VPS_HOST:OBS_HTTP_PORT/obs/ad
```

There is also a JSON endpoint if you want to build your own browser source logic:

```text
http://YOUR_VPS_HOST:OBS_HTTP_PORT/obs/ad.json
```

The ad browser source dims itself when no stage session is active and switches back on when the queue is running.
When auto-rotation is enabled, the overlay advances through the uploaded ads on the interval you set.

### Combined Live Event Screen

If you want one hosted page for a cloud VM or browser capture, use:

```text
http://YOUR_VPS_HOST:OBS_HTTP_PORT/obs/live
```

That page combines the current singer card and the sponsor/ad panel into one layout and refreshes automatically.

There is also a matching JSON endpoint at:

```text
http://YOUR_VPS_HOST:OBS_HTTP_PORT/obs/live.json
```

## Events System

The bot can post active and upcoming Discord scheduled events.

### Public Entry Points

- `/events`
- `-events`

### Behavior

- fetches scheduled events from the guild
- filters to active and scheduled entries
- sorts by start time
- posts Discord event URLs so the client renders them naturally

## Invite Moderation

Invite links are allowed only for the guild owner and users on the bot's invite allowlist.

### Staff Commands

- `/allow-invites target:<user>`
- `/revoke-invites target:<user>`
- `/purge-invites [messages_per_channel]`

### User Self-Allow Flow

Users can DM the bot:

```text
!allowinvite your_password_here
```

If the password matches `ALLOW_INVITE_PASSWORD`, they are added to the allowlist.

### Invite Cleanup

`/purge-invites` scans accessible text and announcement channels and deletes unauthorized invite links.

## Command Reference

### Public Commands

- `/events`
- `-events`

### Staff Commands

- `/announce message:<text> [title] [color] [channel]`
  Use `\n` inside `message` if you want line breaks in the posted announcement.
- `/announce-color [color] [reset]`
- `/start-queue`
- `/stop-queue`
- `/next`
- `/radio`
- `/allow-invites`
- `/revoke-invites`
- `/purge-invites`
- `/ad-upload`
- `/ad-list`
- `/ad-show`
- `/ad-rotate`
- `/ad-rotate-stop`
- `/ad-remove`

## First-Time Setup Checklist

1. Create the Discord application and bot.
2. Enable the required intents in the Discord developer portal.
3. Invite the bot to the target server.
4. Create `.env` with valid IDs and token.
5. Run `npm install`.
6. Add `assets/intermission.mp3` if you want radio playback.
7. Start the bot so it registers slash commands for the configured guild.
8. Test `/events` and the stage queue commands.

## Deployment Notes

Typical update flow:

```bash
git pull origin main
npm install
node index.js
```

For a production server, use the included `systemd` unit so the bot starts on boot and restarts after a crash:

```bash
sudo cp deploy/drowsy-bot.service /etc/systemd/system/drowsy-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now drowsy-bot
sudo systemctl status drowsy-bot
```

View bot and management API startup errors with:

```bash
sudo journalctl -u drowsy-bot -f
curl http://127.0.0.1:8080/health
```

## Troubleshooting

### Slash Commands Do Not Appear

Check:

- `CLIENT_ID` is correct
- `GUILD_ID` is correct
- the bot can log in successfully
- the bot has been restarted after deployment

### Missing Dependency Error

If you see `Cannot find module 'dotenv'` or another dependency error, run:

```bash
npm install
```

### Invite Moderation Does Not Delete Links

Check:

- the bot can manage messages in that channel
- the message actually matches the Discord invite regex
- the sender is not the guild owner
- the sender is not on the allowlist

### Queue Radio Does Not Play

Check:

- `assets/intermission.mp3` exists
- the bot can connect and speak in the voice channel
- dependencies installed successfully on the host

## Architecture Notes

- [index.js](index.js): bot bootstrap and event binding
- [src/config.js](src/config.js): constants, env vars, and file paths
- [src/state.js](src/state.js): file-backed persistence and shared runtime state
- [src/helpers.js](src/helpers.js): shared helper utilities
- [src/commands.js](src/commands.js): slash command schema
- [src/features/stage.js](src/features/stage.js): queue, speaker handoff, and radio flow
- [src/features/community.js](src/features/community.js): events and invite moderation

## License

ISC