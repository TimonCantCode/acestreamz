# AceStreamz

AceStreamz is a stateless, self-hostable Stremio/Nuvio-compatible AceStream channel manager.

It ships without stream sources, provider lists, pay-TV channel lists, logos, or Content IDs. Users create their own categories and add their own legal AceStream Content IDs.

## Stateless by design

AceStreamz does **not** save configs, profiles, Content IDs or channel lists on the server.

Configs are only kept in the current browser page until the user:

- downloads the config as JSON, or
- copies/uses the generated install URL

The generated install URL contains the current config in the URL itself. This means AceStreamz does not need any database or server-side profile storage.

Important: URLs can still appear in browser history, reverse proxy logs, access logs or analytics tools. If you host AceStreamz publicly, disable request logging for config URLs where possible and do not add analytics.

## Features

- Create custom categories
- Add custom AceStream channels
- Optional channel logos
- Optional tags per category and channel
- Favorites category
- Import/export configuration as JSON
- Import channels from M3U/M3U8 or JSON
- Local/LAN AceStream Engine URL setting
- Generated fallback logos/posters/backgrounds
- Optional live-TV mode using Stremio/Nuvio `channel` type
- Optional hiding of channels without Content IDs

## Important

AceStreamz does not provide, host, scrape, index, recommend, or include any streams.

You must provide your own legal AceStream Content IDs. Do not use this project to infringe copyrights or access services you are not authorized to use.

## Public hosting notes

This project is designed so you can publish the code safely as a neutral tool, but this is not legal advice.

For public hosting:

- Do not include Content IDs
- Do not include copyrighted channel lists
- Do not include provider logos unless you have rights to use them
- Do not proxy or fetch video streams
- Do not add analytics that capture install URLs
- Disable access logs for long config URLs where possible
- Keep `channels.example.json` empty
- Make clear that users must provide their own legal Content IDs

## Requirements

- Node.js 20 or newer recommended
- Ace Stream Engine / Ace Stream Media
- AceStream Engine reachable from the playback device

Default engine URL:

```text
http://127.0.0.1:6878
```

For TV devices, you may need to use a LAN IP, for example:

```text
http://192.168.178.50:6878
```

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/acestreamz.git
cd acestreamz
npm install
cp .env.example .env
cp channels.example.json channels.json
npm start
```

On Windows CMD:

```cmd
copy .env.example .env
copy channels.example.json channels.json
npm install
npm start
```

Open:

```text
http://localhost:7000/configure
```

## Usage

1. Open the configure page.
2. Create a category, for example `Sports`.
3. Add a channel with a name, Content ID, optional logo and optional tags.
4. Select the channel and optionally mark it as favorite.
5. Click `Generate Install URL`.
6. Use the generated manifest URL in Stremio/Nuvio.
7. Click `Download Config` if you want to save your setup.

## Configuration files

### `.env`

```env
PORT=7000
ACE_ENGINE_URL=http://127.0.0.1:6878
```

### `channels.json`

`channels.json` is intentionally ignored by Git. It is for your own local defaults only.

The GitHub-ready example is empty:

```json
{
  "categories": [],
  "channels": [],
  "selectedChannels": [],
  "favorites": [],
  "categoryOrder": [],
  "channelOrder": []
}
```

## M3U import

AceStreamz can import M3U/M3U8 files with entries like:

```m3u
#EXTM3U
#EXTINF:-1 group-title="Sports" tvg-logo="https://example.com/logo.png",My Channel
acestream://0123456789abcdef0123456789abcdef01234567
```

The `group-title` is used as the category name.

## JSON import

You can import JSON arrays like:

```json
[
  {
    "name": "My Channel",
    "category": "Sports",
    "contentId": "0123456789abcdef0123456789abcdef01234567",
    "logo": "https://example.com/logo.png",
    "tags": ["sports", "hd"]
  }
]
```

## Private files

These files and folders are intentionally ignored by Git:

```text
.env
channels.json
node_modules/
```

The `.gitignore` also ignores legacy private folders from older non-stateless builds:

```text
profiles/
.image-cache/
.profile-secret
```

## Limitations

Because AceStreamz is stateless, install URLs can become long when you add many channels. For large setups, prefer downloading and backing up your config JSON.

A future version could support optional local-only profile storage, but this public/stateless build intentionally avoids that.

## Development

```bash
npm run dev
```

## License

MIT
