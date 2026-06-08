require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const app = express();

const PORT = Number(process.env.PORT || 7000);
const DEFAULT_ACE_ENGINE_URL = process.env.ACE_ENGINE_URL || "http://127.0.0.1:6878";

app.use("/assets", express.static(path.join(__dirname, "assets")));

const IMAGE_PRESETS = {
  logo: {
    width: 512,
    height: 512,
    logoMaxWidth: 380,
    logoMaxHeight: 260
  },
  poster: {
    width: 300,
    height: 450,
    logoMaxWidth: 240,
    logoMaxHeight: 160
  },
  background: {
    width: 1280,
    height: 720,
    logoMaxWidth: 520,
    logoMaxHeight: 250
  }
};

function defaultConfig() {
  return {
    categories: [],
    channels: [],
    selectedChannels: [],
    favorites: [],
    categoryOrder: [],
    channelOrder: [],
    hideContinueWatching: true,
    hideEmptyChannels: false,
    engineMode: "local",
    engineUrl: DEFAULT_ACE_ENGINE_URL
  };
}

function loadJsonFile(filename, fallback) {
  try {
    const filePath = path.join(__dirname, filename);
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Could not load ${filename}:`, error.message);
    return fallback;
  }
}

function normalizeContentId(contentId) {
  return String(contentId || "")
    .trim()
    .replace(/^acestream:\/\//i, "");
}

function isPlaceholderContentId(contentId) {
  const normalized = normalizeContentId(contentId);

  return (
    !normalized ||
    normalized.includes("DEINE_") ||
    normalized.includes("HIER") ||
    normalized.length < 20
  );
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return tags.map((tag) => String(tag).trim()).filter(Boolean);
  }

  return String(tags || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function normalizeCategory(raw, index = 0) {
  const name = String(raw.name || "").trim();
  if (!name) return null;

  const id = raw.id && String(raw.id).startsWith("cat-")
    ? String(raw.id)
    : `cat-${slugify(name) || "category"}-${index}`;

  return {
    id,
    name,
    description: String(raw.description || "").trim(),
    logo: String(raw.logo || "").trim(),
    tags: normalizeTags(raw.tags)
  };
}

function normalizeChannel(raw, index = 0, categories = []) {
  const name = String(raw.name || "").trim();
  const contentId = normalizeContentId(raw.contentId);
  if (!name) return null;

  const categoryId = String(raw.categoryId || raw.category || "").trim();
  const fallbackCategoryId = categories[0]?.id || "";

  const id = raw.id && String(raw.id).startsWith("ch-")
    ? String(raw.id)
    : `ch-${slugify(name) || "channel"}-${index}`;

  return {
    id,
    categoryId: categoryId || fallbackCategoryId,
    name,
    contentId,
    logo: String(raw.logo || "").trim(),
    tags: normalizeTags(raw.tags)
  };
}

function normalizeConfig(config) {
  const input = {
    ...defaultConfig(),
    ...(config || {})
  };

  let categories = (input.categories || [])
    .map((category, index) => normalizeCategory(category, index))
    .filter(Boolean);

  let channels = (input.channels || [])
    .map((channel, index) => normalizeChannel(channel, index, categories))
    .filter(Boolean);

  const categoryIds = new Set(categories.map((category) => category.id));

  for (const channel of channels) {
    if (!categoryIds.has(channel.categoryId)) {
      const uncategorized = categories.find((category) => category.id === "cat-uncategorized") || {
        id: "cat-uncategorized",
        name: "Uncategorized",
        description: "Channels without a category",
        logo: "",
        tags: []
      };

      if (!categoryIds.has(uncategorized.id)) {
        categories.push(uncategorized);
        categoryIds.add(uncategorized.id);
      }

      channel.categoryId = uncategorized.id;
    }
  }

  const channelIds = new Set(channels.map((channel) => channel.id));

  const selectedChannels = Array.isArray(input.selectedChannels) && input.selectedChannels.length
    ? input.selectedChannels.filter((id) => channelIds.has(id))
    : channels.map((channel) => channel.id);

  const favorites = Array.isArray(input.favorites)
    ? input.favorites.filter((id) => channelIds.has(id))
    : [];

  const categoryOrder = Array.isArray(input.categoryOrder) && input.categoryOrder.length
    ? [
        ...input.categoryOrder.filter((id) => categoryIds.has(id)),
        ...categories.map((category) => category.id).filter((id) => !input.categoryOrder.includes(id))
      ]
    : categories.map((category) => category.id);

  const channelOrder = Array.isArray(input.channelOrder) && input.channelOrder.length
    ? [
        ...input.channelOrder.filter((id) => channelIds.has(id)),
        ...channels.map((channel) => channel.id).filter((id) => !input.channelOrder.includes(id))
      ]
    : channels.map((channel) => channel.id);

  return {
    ...defaultConfig(),
    ...input,
    categories,
    channels,
    selectedChannels,
    favorites,
    categoryOrder,
    channelOrder
  };
}

function loadBundledChannelsConfig() {
  const bundled = loadJsonFile("channels.json", { categories: [], channels: [] });
  return normalizeConfig(bundled);
}

function decodeConfig(configString) {
  try {
    return normalizeConfig(JSON.parse(Buffer.from(configString, "base64url").toString("utf8")));
  } catch {
    return defaultConfig();
  }
}

function getBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function getMediaType(config) {
  return config.hideContinueWatching ? "channel" : "tv";
}

function getEngineUrl(config) {
  const raw = String(config.engineUrl || DEFAULT_ACE_ENGINE_URL).trim();

  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) {
      return DEFAULT_ACE_ENGINE_URL;
    }
    return url.origin;
  } catch {
    return DEFAULT_ACE_ENGINE_URL;
  }
}

function sortByOrder(items, order = []) {
  const orderMap = new Map(order.map((id, index) => [id, index]));

  return [...items].sort((a, b) => {
    const aIndex = orderMap.has(a.id) ? orderMap.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bIndex = orderMap.has(b.id) ? orderMap.get(b.id) : Number.MAX_SAFE_INTEGER;

    if (aIndex !== bIndex) return aIndex - bIndex;
    return String(a.name || "").localeCompare(String(b.name || ""), "en");
  });
}

function getSelectedChannels(config) {
  const selectedIds = new Set(config.selectedChannels || []);

  const filtered = config.channels.filter((channel) => {
    if (!selectedIds.has(channel.id)) return false;

    if (config.hideEmptyChannels && isPlaceholderContentId(channel.contentId)) {
      return false;
    }

    return true;
  });

  return sortByOrder(filtered, config.channelOrder || []);
}

function getCatalogsForConfig(config) {
  const selectedChannels = getSelectedChannels(config);
  const favorites = new Set(config.favorites || []);
  const mediaType = getMediaType(config);
  const catalogs = [];

  const hasFavorites = selectedChannels.some((channel) => favorites.has(channel.id));

  if (hasFavorites) {
    catalogs.push({
      type: mediaType,
      id: "favorites",
      name: "⭐ Favorites"
    });
  }

  const selectedCategoryIds = new Set(selectedChannels.map((channel) => channel.categoryId));
  const categories = sortByOrder(
    config.categories.filter((category) => selectedCategoryIds.has(category.id)),
    config.categoryOrder || []
  );

  for (const category of categories) {
    catalogs.push({
      type: mediaType,
      id: `category-${category.id}`,
      name: category.name
    });
  }

  return catalogs;
}

function hashValue(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapText(text, maxCharsPerLine = 22, maxLines = 3) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;

    if (next.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }

    if (lines.length >= maxLines) break;
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  return lines;
}

function isLocalAssetPath(value) {
  const cleanValue = String(value || "").trim();
  return cleanValue.startsWith("/assets/") || cleanValue.startsWith("assets/");
}

function localAssetPath(value) {
  const relativePath = String(value || "").replace(/^\/+/, "");
  const filePath = path.resolve(__dirname, relativePath);
  const rootPath = path.resolve(__dirname, "assets");

  if (!filePath.startsWith(rootPath)) {
    return null;
  }

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return filePath;
}

async function loadLocalImageBuffer(value) {
  if (!isLocalAssetPath(value)) return null;

  const filePath = localAssetPath(value);
  if (!filePath) return null;

  return fs.readFileSync(filePath);
}

function createBaseSvg(width, height) {
  return Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#141414"/>
      <stop offset="100%" stop-color="#050505"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" rx="24" fill="url(#bg)"/>
  <rect x="0" y="0" width="100%" height="100%" rx="24" fill="none" stroke="#2a2a2a" stroke-width="2"/>
</svg>
`);
}

function createFallbackLogoSvg(item, width, height) {
  const initials = String(item.name || "?")
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();

  return Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" rx="32" fill="#222"/>
  <text
    x="50%"
    y="50%"
    text-anchor="middle"
    dominant-baseline="middle"
    font-family="Arial, sans-serif"
    font-size="${Math.round(width * 0.18)}"
    font-weight="700"
    fill="#ffffff"
  >${escapeXml(initials)}</text>
</svg>
`);
}

function createTextOverlaySvg(item, width, height, kind) {
  if (kind === "logo") {
    return null;
  }

  const lines = wrapText(item.name, kind === "background" ? 34 : 18, 3);
  const fontSize = kind === "background" ? 52 : 24;
  const lineHeight = Math.round(fontSize * 1.2);

  const totalHeight = lines.length * lineHeight;
  const startY = kind === "background" ? height - 110 : height - 88;

  const tspans = lines
    .map((line, index) => {
      const y = startY + index * lineHeight;
      return `<text x="50%" y="${y}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${escapeXml(line)}</text>`;
    })
    .join("");

  return Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="${Math.max(0, startY - fontSize)}" width="100%" height="${totalHeight + fontSize * 1.6}" fill="#000000" opacity="0.35"/>
  ${tspans}
</svg>
`);
}

async function renderItemImage(item, kind) {
  const preset = IMAGE_PRESETS[kind] || IMAGE_PRESETS.logo;
  const base = sharp(createBaseSvg(preset.width, preset.height)).png();

  let logoBuffer = null;

  try {
    logoBuffer = await loadLocalImageBuffer(item.logo);
  } catch {
    logoBuffer = null;
  }

  let normalizedLogo;

  if (logoBuffer) {
    normalizedLogo = await sharp(logoBuffer, { animated: false })
      .resize({
        width: preset.logoMaxWidth,
        height: preset.logoMaxHeight,
        fit: "inside",
        withoutEnlargement: true
      })
      .png()
      .toBuffer();
  } else {
    normalizedLogo = await sharp(
      createFallbackLogoSvg(item, preset.logoMaxWidth, preset.logoMaxHeight)
    )
      .resize({
        width: preset.logoMaxWidth,
        height: preset.logoMaxHeight,
        fit: "inside"
      })
      .png()
      .toBuffer();
  }

  const overlays = [
    {
      input: normalizedLogo,
      gravity: "center"
    }
  ];

  const textOverlay = createTextOverlaySvg(item, preset.width, preset.height, kind);

  if (textOverlay) {
    overlays.push({
      input: textOverlay,
      left: 0,
      top: 0
    });
  }

  return await base.composite(overlays).png().toBuffer();
}

function itemImageUrl(req, item, kind) {
  const config = req.params.config;
  return `${getBaseUrl(req)}/${encodeURIComponent(config)}/image/${kind}/ace-${encodeURIComponent(item.id)}.png`;
}

function isRemoteUrl(value) {
  const text = String(value || "").trim();
  return text.startsWith("http://") || text.startsWith("https://");
}

function channelToMeta(req, channel, config, prefix = "") {
  const mediaType = getMediaType(config);
  const category = config.categories.find((item) => item.id === channel.categoryId);

  const fallbackLogo = itemImageUrl(req, channel, "logo");
  const logo = isRemoteUrl(channel.logo) ? channel.logo : fallbackLogo;
  const poster = itemImageUrl(req, channel, "poster");
  const background = itemImageUrl(req, channel, "background");

  const descriptionParts = [];
  if (category?.name) descriptionParts.push(category.name);
  if (channel.tags?.length) descriptionParts.push(channel.tags.join(", "));

  return {
    id: `ace-${channel.id}`,
    type: mediaType,
    name: prefix ? `${prefix} ${channel.name}` : channel.name,
    description: descriptionParts.join("\n"),
    poster,
    logo,
    background,
    genres: channel.tags || [],
    behaviorHints: {
      defaultVideoId: `ace-${channel.id}`,
      hasScheduledVideos: false
    }
  };
}

app.get("/", (req, res) => {
  res.redirect("/configure");
});

app.get("/configure", (req, res) => {
  const bundledConfig = loadBundledChannelsConfig();
  const baseUrl = getBaseUrl(req);

  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AceStreamz</title>
  <style>
    :root {
      --bg: #0b0b0d;
      --card: #17171b;
      --card2: #202026;
      --line: #30303a;
      --text: #f2f2f4;
      --muted: #aaaab5;
      --accent: #ffffff;
      --danger: #702020;
    }
    * { box-sizing: border-box; }
    body {
      font-family: Arial, sans-serif;
      max-width: 1120px;
      margin: 32px auto;
      padding: 16px;
      line-height: 1.5;
      background: var(--bg);
      color: var(--text);
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 18px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
    }
    .sticky {
      position: sticky;
      top: 0;
      z-index: 10;
      backdrop-filter: blur(16px);
    }
    h1, h2, h3 { margin-top: 0; }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .grid .full { grid-column: 1 / -1; }
    .category-header {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 12px;
      align-items: center;
      border-bottom: 1px solid var(--line);
      padding-bottom: 12px;
      margin-bottom: 12px;
    }
    .category-title {
      font-size: 21px;
      font-weight: bold;
      cursor: pointer;
      user-select: none;
    }
    .category-body { display: none; }
    .category-body.open { display: block; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .channel-row {
      display: grid;
      grid-template-columns: 26px 26px 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 9px 0;
      border-bottom: 1px solid #262632;
    }
    .channel-row.dragging, .category-card.dragging { opacity: 0.45; }
    .drag-handle { color: var(--muted); cursor: grab; user-select: none; }
    .star { cursor: pointer; font-size: 22px; user-select: none; }
    .star.active { color: gold; }
    input[type="text"], select, textarea {
      width: 100%;
      padding: 12px;
      font-size: 15px;
      margin-top: 8px;
      border-radius: 10px;
      border: 1px solid #464653;
      background: #0d0d12;
      color: #fff;
    }
    textarea { min-height: 86px; resize: vertical; }
    label { display: block; margin: 10px 0; }
    button {
      padding: 9px 13px;
      font-size: 14px;
      cursor: pointer;
      border-radius: 10px;
      border: 0;
      background: var(--accent);
      color: #111;
    }
    button.secondary { background: var(--card2); color: var(--text); border: 1px solid var(--line); }
    button.danger { background: var(--danger); color: #fff; }
    code { background: #2a2a33; padding: 3px 5px; border-radius: 5px; }
    .small { color: var(--muted); font-size: 14px; }
    .top-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
    .empty-state { color: var(--muted); padding: 10px 0; }
    @media (max-width: 760px) {
      .grid { grid-template-columns: 1fr; }
      .category-header { grid-template-columns: auto 1fr; }
      .actions { grid-column: 1 / -1; justify-content: flex-start; }
      .channel-row { grid-template-columns: 24px 24px 1fr; }
      .row-actions { grid-column: 1 / -1; }
    }
  </style>
</head>
<body>
  <h1>AceStreamz</h1>

  <div class="card sticky">
    <p>
      Stateless mode: AceStreamz does not store profiles or configs online. Export your config as a JSON file if you want to save it.
    </p>

    <div class="top-buttons">
      <button onclick="generateUrl()">Generate Install URL</button>
      <button class="secondary" onclick="exportConfig()">Download Config</button>
      <button class="secondary" onclick="document.getElementById('import-file').click()">Import Config</button>
      <button class="secondary" onclick="document.getElementById('channel-import-file').click()">Import Channel List</button>
    </div>

    <input id="import-file" type="file" accept="application/json,.json" style="display:none" />
    <input id="channel-import-file" type="file" accept="application/json,.json,.m3u,.m3u8,text/plain" style="display:none" />

    <div class="grid">
      <div class="full">
        <label>Addon Install URL</label>
        <input id="addon-url" type="text" readonly onclick="this.select()" />
        <p class="small">This URL contains the current config. It is not saved by AceStreamz, but URLs can appear in browser history or web server logs.</p>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Behavior & Engine</h2>
    <div class="grid">
      <div>
        <label>
          <input type="checkbox" id="hide-continue-watching" checked />
          Use live TV mode / try to avoid Continue Watching
        </label>
        <p class="small">Best effort: the addon uses type <code>channel</code> instead of <code>tv</code>.</p>
      </div>
      <div>
        <label>
          <input type="checkbox" id="hide-empty-channels" />
          Hide channels without Content ID
        </label>
      </div>
      <div>
        <label>Engine Mode</label>
        <select id="engine-mode" onchange="applyEnginePreset()">
          <option value="local">Local Windows / Android</option>
          <option value="lan">LAN Server</option>
          <option value="custom">Custom URL</option>
        </select>
      </div>
      <div>
        <label>Engine URL</label>
        <input id="engine-url" type="text" value="${DEFAULT_ACE_ENGINE_URL}" />
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Search</h2>
    <input id="search" type="text" placeholder="Search categories, channels or tags..." />
  </div>

  <div class="card">
    <h2>Create Category</h2>
    <div class="grid">
      <div>
        <label>Category Name</label>
        <input id="category-name" type="text" placeholder="e.g. Sports, News, Movies" />
      </div>
      <div>
        <label>Optional Logo URL</label>
        <input id="category-logo" type="text" placeholder="https://.../logo.png or leave empty" />
      </div>
      <div class="full">
        <label>Optional Description</label>
        <textarea id="category-description" placeholder="What kind of channels go here?"></textarea>
      </div>
      <div class="full">
        <label>Optional Tags, comma-separated</label>
        <input id="category-tags" type="text" placeholder="sports, live, personal" />
      </div>
    </div>
    <div class="top-buttons" style="margin-top:12px">
      <button onclick="addCategory()">Add Category</button>
    </div>
  </div>

  <div class="card">
    <h2>Add Channel</h2>
    <div class="grid">
      <div>
        <label>Channel Name</label>
        <input id="channel-name" type="text" placeholder="e.g. My F1 Channel" />
      </div>
      <div>
        <label>Category</label>
        <select id="channel-category"></select>
      </div>
      <div>
        <label>Content ID</label>
        <input id="channel-content-id" type="text" placeholder="acestream://... or just the ID" />
      </div>
      <div>
        <label>Optional Logo URL</label>
        <input id="channel-logo" type="text" placeholder="https://.../logo.png or leave empty" />
      </div>
      <div class="full">
        <label>Optional Tags, comma-separated</label>
        <input id="channel-tags" type="text" placeholder="sports, f1, hd" />
      </div>
    </div>
    <div class="top-buttons" style="margin-top:12px">
      <button onclick="addChannel()">Add Channel</button>
    </div>
  </div>

  <div id="categories"></div>

  <script>
    const baseUrl = ${JSON.stringify(baseUrl)};
    const defaultEngineUrl = ${JSON.stringify(DEFAULT_ACE_ENGINE_URL)};
    const bundledConfig = ${JSON.stringify(bundledConfig)};
    let draggedChannelId = "";
    let draggedCategoryId = "";

    const state = {
      categories: bundledConfig.categories || [],
      channels: bundledConfig.channels || [],
      selectedChannels: new Set(bundledConfig.selectedChannels || []),
      favorites: new Set(bundledConfig.favorites || []),
      categoryOrder: bundledConfig.categoryOrder || [],
      channelOrder: bundledConfig.channelOrder || [],
      openCategories: new Set()
    };

    function normalizeContentId(value) {
      return String(value || "").trim().replace(/^acestream:\\/\\//i, "");
    }

    function normalizeTags(value) {
      if (Array.isArray(value)) return value.map(function(tag) { return String(tag).trim(); }).filter(Boolean);
      return String(value || "").split(",").map(function(tag) { return tag.trim(); }).filter(Boolean);
    }

    function slugify(value) {
      return String(value || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }

    function base64UrlEncode(value) {
      const json = JSON.stringify(value);
      const bytes = new TextEncoder().encode(json);
      let binary = "";

      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }

      return btoa(binary)
        .replace(/\\+/g, "-")
        .replace(/\\//g, "_")
        .replace(/=+$/, "");
    }

    function orderedItems(items, order) {
      const orderMap = new Map((order || []).map(function(id, index) { return [id, index]; }));

      return items.slice().sort(function(a, b) {
        const ai = orderMap.has(a.id) ? orderMap.get(a.id) : Number.MAX_SAFE_INTEGER;
        const bi = orderMap.has(b.id) ? orderMap.get(b.id) : Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a.name.localeCompare(b.name, "en");
      });
    }

    function getSearchText() {
      return document.getElementById("search").value.trim().toLowerCase();
    }

    function itemMatchesSearch(item) {
      const q = getSearchText();
      if (!q) return true;

      const haystack = [
        item.name,
        item.description,
        (item.tags || []).join(" ")
      ].join(" ").toLowerCase();

      return haystack.includes(q);
    }

    function getCategory(categoryId) {
      return state.categories.find(function(category) { return category.id === categoryId; });
    }

    function getChannelsForCategory(categoryId) {
      return orderedItems(
        state.channels.filter(function(channel) {
          return channel.categoryId === categoryId && itemMatchesSearch(channel);
        }),
        state.channelOrder
      );
    }

    function updateCategorySelect() {
      const select = document.getElementById("channel-category");
      select.innerHTML = "";

      if (state.categories.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "Create a category first";
        select.appendChild(option);
        select.disabled = true;
        return;
      }

      select.disabled = false;

      for (const category of orderedItems(state.categories, state.categoryOrder)) {
        const option = document.createElement("option");
        option.value = category.id;
        option.textContent = category.name;
        select.appendChild(option);
      }
    }

    function render() {
      updateCategorySelect();
      renderCategories();
      generateUrl();
    }

    function toggleOpen(categoryId) {
      if (state.openCategories.has(categoryId)) {
        state.openCategories.delete(categoryId);
      } else {
        state.openCategories.add(categoryId);
      }

      render();
    }

    function createChannelRow(channel) {
      const row = document.createElement("div");
      row.className = "channel-row";
      row.draggable = true;
      row.dataset.channelId = channel.id;

      row.ondragstart = function() {
        draggedChannelId = channel.id;
        row.classList.add("dragging");
      };
      row.ondragend = function() {
        draggedChannelId = "";
        row.classList.remove("dragging");
      };
      row.ondragover = function(event) {
        event.preventDefault();
      };
      row.ondrop = function(event) {
        event.preventDefault();
        moveChannelBefore(draggedChannelId, channel.id);
      };

      const handle = document.createElement("span");
      handle.className = "drag-handle";
      handle.textContent = "☰";

      const star = document.createElement("span");
      star.className = state.favorites.has(channel.id) ? "star active" : "star";
      star.textContent = state.favorites.has(channel.id) ? "★" : "☆";
      star.onclick = function() { toggleFavorite(channel.id); };

      const main = document.createElement("div");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.selectedChannels.has(channel.id);
      checkbox.onchange = function() { toggleChannel(channel.id, checkbox.checked); };

      const title = document.createElement("span");
      const tags = channel.tags && channel.tags.length ? " · " + channel.tags.join(", ") : "";
      title.textContent = " " + channel.name + tags;

      main.appendChild(checkbox);
      main.appendChild(title);

      const actions = document.createElement("div");
      actions.className = "row-actions";

      const editButton = document.createElement("button");
      editButton.className = "secondary";
      editButton.textContent = "Edit";
      editButton.onclick = function() { editChannel(channel.id); };

      const removeButton = document.createElement("button");
      removeButton.className = "danger";
      removeButton.style.marginLeft = "8px";
      removeButton.textContent = "Remove";
      removeButton.onclick = function() { removeChannel(channel.id); };

      actions.appendChild(editButton);
      actions.appendChild(removeButton);

      row.appendChild(handle);
      row.appendChild(star);
      row.appendChild(main);
      row.appendChild(actions);

      return row;
    }

    function renderCategories() {
      const root = document.getElementById("categories");
      const search = getSearchText();
      root.innerHTML = "";

      if (state.categories.length === 0) {
        const card = document.createElement("div");
        card.className = "card";
        card.innerHTML = '<p class="empty-state">No categories yet. Create your first category above.</p>';
        root.appendChild(card);
        return;
      }

      for (const category of orderedItems(state.categories, state.categoryOrder)) {
        const channels = getChannelsForCategory(category.id);
        const categoryMatches = itemMatchesSearch(category);

        if (search && !categoryMatches && channels.length === 0) continue;

        const card = document.createElement("div");
        card.className = "card category-card";
        card.draggable = true;

        card.ondragstart = function() {
          draggedCategoryId = category.id;
          card.classList.add("dragging");
        };
        card.ondragend = function() {
          draggedCategoryId = "";
          card.classList.remove("dragging");
        };
        card.ondragover = function(event) {
          event.preventDefault();
        };
        card.ondrop = function(event) {
          event.preventDefault();
          moveCategoryBefore(draggedCategoryId, category.id);
        };

        const header = document.createElement("div");
        header.className = "category-header";

        const openButton = document.createElement("button");
        const isOpen = state.openCategories.has(category.id) || Boolean(search);
        openButton.textContent = isOpen ? "−" : "+";
        openButton.onclick = function() { toggleOpen(category.id); };

        const title = document.createElement("div");
        title.className = "category-title";
        title.onclick = function() { toggleOpen(category.id); };
        const description = category.description ? " — " + category.description : "";
        title.textContent = category.name + description;

        const actions = document.createElement("div");
        actions.className = "actions";

        const allButton = document.createElement("button");
        allButton.className = "secondary";
        allButton.textContent = "All";
        allButton.onclick = function() { selectAllInCategory(category.id); };

        const noneButton = document.createElement("button");
        noneButton.className = "secondary";
        noneButton.textContent = "None";
        noneButton.onclick = function() { selectNoneInCategory(category.id); };

        const favAllButton = document.createElement("button");
        favAllButton.className = "secondary";
        favAllButton.textContent = "Favorite All";
        favAllButton.onclick = function() { favoriteAllInCategory(category.id); };

        const unfavButton = document.createElement("button");
        unfavButton.className = "secondary";
        unfavButton.textContent = "Remove Favorites";
        unfavButton.onclick = function() { unfavoriteAllInCategory(category.id); };

        const editButton = document.createElement("button");
        editButton.className = "secondary";
        editButton.textContent = "Edit Category";
        editButton.onclick = function() { editCategory(category.id); };

        const removeButton = document.createElement("button");
        removeButton.className = "danger";
        removeButton.textContent = "Remove Category";
        removeButton.onclick = function() { removeCategory(category.id); };

        actions.appendChild(allButton);
        actions.appendChild(noneButton);
        actions.appendChild(favAllButton);
        actions.appendChild(unfavButton);
        actions.appendChild(editButton);
        actions.appendChild(removeButton);

        header.appendChild(openButton);
        header.appendChild(title);
        header.appendChild(actions);

        const body = document.createElement("div");
        body.className = isOpen ? "category-body open" : "category-body";

        if (channels.length === 0) {
          const empty = document.createElement("p");
          empty.className = "empty-state";
          empty.textContent = "No channels in this category yet.";
          body.appendChild(empty);
        } else {
          for (const channel of channels) {
            body.appendChild(createChannelRow(channel));
          }
        }

        card.appendChild(header);
        card.appendChild(body);
        root.appendChild(card);
      }
    }

    function addCategory() {
      const nameInput = document.getElementById("category-name");
      const logoInput = document.getElementById("category-logo");
      const descriptionInput = document.getElementById("category-description");
      const tagsInput = document.getElementById("category-tags");

      const name = nameInput.value.trim();

      if (!name) {
        alert("Please enter a category name.");
        return;
      }

      const id = "cat-" + (slugify(name) || "category") + "-" + Date.now();

      const category = {
        id,
        name,
        description: descriptionInput.value.trim(),
        logo: logoInput.value.trim(),
        tags: normalizeTags(tagsInput.value)
      };

      state.categories.push(category);
      state.categoryOrder.push(id);
      state.openCategories.add(id);

      nameInput.value = "";
      logoInput.value = "";
      descriptionInput.value = "";
      tagsInput.value = "";

      render();
    }

    function editCategory(categoryId) {
      const category = getCategory(categoryId);
      if (!category) return;

      const name = prompt("Category name:", category.name);
      if (name === null || !name.trim()) return;

      const description = prompt("Description:", category.description || "");
      if (description === null) return;

      const logo = prompt("Logo URL:", category.logo || "");
      if (logo === null) return;

      const tags = prompt("Tags, comma-separated:", (category.tags || []).join(", "));
      if (tags === null) return;

      category.name = name.trim();
      category.description = description.trim();
      category.logo = logo.trim();
      category.tags = normalizeTags(tags);

      render();
    }

    function removeCategory(categoryId) {
      const category = getCategory(categoryId);
      if (!category) return;

      const count = state.channels.filter(function(channel) { return channel.categoryId === categoryId; }).length;
      const confirmed = confirm("Remove category '" + category.name + "' and " + count + " channel(s)?");
      if (!confirmed) return;

      const removedChannelIds = new Set(
        state.channels
          .filter(function(channel) { return channel.categoryId === categoryId; })
          .map(function(channel) { return channel.id; })
      );

      state.categories = state.categories.filter(function(item) { return item.id !== categoryId; });
      state.channels = state.channels.filter(function(channel) { return channel.categoryId !== categoryId; });
      state.categoryOrder = state.categoryOrder.filter(function(id) { return id !== categoryId; });
      state.channelOrder = state.channelOrder.filter(function(id) { return !removedChannelIds.has(id); });
      state.openCategories.delete(categoryId);

      for (const id of removedChannelIds) {
        state.selectedChannels.delete(id);
        state.favorites.delete(id);
      }

      render();
    }

    function addChannel() {
      const nameInput = document.getElementById("channel-name");
      const categoryInput = document.getElementById("channel-category");
      const contentIdInput = document.getElementById("channel-content-id");
      const logoInput = document.getElementById("channel-logo");
      const tagsInput = document.getElementById("channel-tags");

      const name = nameInput.value.trim();
      const categoryId = categoryInput.value;
      const contentId = normalizeContentId(contentIdInput.value);
      const logo = logoInput.value.trim();
      const tags = normalizeTags(tagsInput.value);

      if (!state.categories.length) {
        alert("Please create a category first.");
        return;
      }

      if (!name || !contentId || !categoryId) {
        alert("Please enter a name, category and Content ID.");
        return;
      }

      const id = "ch-" + (slugify(name) || "channel") + "-" + Date.now();

      const channel = {
        id,
        categoryId,
        name,
        contentId,
        logo,
        tags
      };

      state.channels.push(channel);
      state.selectedChannels.add(id);
      state.channelOrder.push(id);
      state.openCategories.add(categoryId);

      nameInput.value = "";
      contentIdInput.value = "";
      logoInput.value = "";
      tagsInput.value = "";

      render();
    }

    function editChannel(channelId) {
      const channel = state.channels.find(function(item) { return item.id === channelId; });
      if (!channel) return;

      const name = prompt("Channel name:", channel.name);
      if (name === null || !name.trim()) return;

      const contentId = prompt("Content ID:", channel.contentId || "");
      if (contentId === null || !contentId.trim()) return;

      const logo = prompt("Logo URL:", channel.logo || "");
      if (logo === null) return;

      const tags = prompt("Tags, comma-separated:", (channel.tags || []).join(", "));
      if (tags === null) return;

      channel.name = name.trim();
      channel.contentId = normalizeContentId(contentId);
      channel.logo = logo.trim();
      channel.tags = normalizeTags(tags);

      render();
    }

    function removeChannel(channelId) {
      const channel = state.channels.find(function(item) { return item.id === channelId; });
      if (!channel) return;

      const confirmed = confirm("Remove channel '" + channel.name + "'?");
      if (!confirmed) return;

      state.channels = state.channels.filter(function(item) { return item.id !== channelId; });
      state.selectedChannels.delete(channelId);
      state.favorites.delete(channelId);
      state.channelOrder = state.channelOrder.filter(function(id) { return id !== channelId; });

      render();
    }

    function toggleChannel(channelId, checked) {
      if (checked) {
        state.selectedChannels.add(channelId);
      } else {
        state.selectedChannels.delete(channelId);
        state.favorites.delete(channelId);
      }

      render();
    }

    function toggleFavorite(channelId) {
      if (!state.selectedChannels.has(channelId)) {
        state.selectedChannels.add(channelId);
      }

      if (state.favorites.has(channelId)) {
        state.favorites.delete(channelId);
      } else {
        state.favorites.add(channelId);
      }

      render();
    }

    function selectAllInCategory(categoryId) {
      for (const channel of state.channels.filter(function(item) { return item.categoryId === categoryId; })) {
        state.selectedChannels.add(channel.id);
      }

      render();
    }

    function selectNoneInCategory(categoryId) {
      for (const channel of state.channels.filter(function(item) { return item.categoryId === categoryId; })) {
        state.selectedChannels.delete(channel.id);
        state.favorites.delete(channel.id);
      }

      render();
    }

    function favoriteAllInCategory(categoryId) {
      for (const channel of state.channels.filter(function(item) { return item.categoryId === categoryId; })) {
        state.selectedChannels.add(channel.id);
        state.favorites.add(channel.id);
      }

      render();
    }

    function unfavoriteAllInCategory(categoryId) {
      for (const channel of state.channels.filter(function(item) { return item.categoryId === categoryId; })) {
        state.favorites.delete(channel.id);
      }

      render();
    }

    function moveChannelBefore(sourceId, targetId) {
      if (!sourceId || !targetId || sourceId === targetId) return;

      const nextOrder = state.channelOrder.filter(function(id) { return id !== sourceId; });
      const targetIndex = nextOrder.indexOf(targetId);

      if (targetIndex === -1) {
        nextOrder.push(sourceId);
      } else {
        nextOrder.splice(targetIndex, 0, sourceId);
      }

      state.channelOrder = nextOrder;
      render();
    }

    function moveCategoryBefore(sourceId, targetId) {
      if (!sourceId || !targetId || sourceId === targetId) return;

      const nextOrder = state.categoryOrder.filter(function(id) { return id !== sourceId; });
      const targetIndex = nextOrder.indexOf(targetId);

      if (targetIndex === -1) {
        nextOrder.push(sourceId);
      } else {
        nextOrder.splice(targetIndex, 0, sourceId);
      }

      state.categoryOrder = nextOrder;
      render();
    }

    function applyEnginePreset() {
      const mode = document.getElementById("engine-mode").value;
      const input = document.getElementById("engine-url");

      if (mode === "local") {
        input.value = "http://127.0.0.1:6878";
      } else if (mode === "lan" && input.value === "http://127.0.0.1:6878") {
        input.value = "http://192.168.178.50:6878";
      }

      generateUrl();
    }

    function buildConfig() {
      return {
        categories: state.categories.map(function(category) {
          return {
            id: category.id,
            name: category.name,
            description: category.description || "",
            logo: category.logo || "",
            tags: category.tags || []
          };
        }),
        channels: state.channels.map(function(channel) {
          return {
            id: channel.id,
            categoryId: channel.categoryId,
            name: channel.name,
            contentId: channel.contentId,
            logo: channel.logo || "",
            tags: channel.tags || []
          };
        }),
        selectedChannels: Array.from(state.selectedChannels),
        favorites: Array.from(state.favorites),
        categoryOrder: state.categoryOrder.slice(),
        channelOrder: state.channelOrder.slice(),
        hideContinueWatching: document.getElementById("hide-continue-watching").checked,
        hideEmptyChannels: document.getElementById("hide-empty-channels").checked,
        engineMode: document.getElementById("engine-mode").value,
        engineUrl: document.getElementById("engine-url").value.trim() || defaultEngineUrl
      };
    }

    function normalizeImportedConfig(raw) {
      return {
        categories: Array.isArray(raw.categories) ? raw.categories : [],
        channels: Array.isArray(raw.channels) ? raw.channels : [],
        selectedChannels: Array.isArray(raw.selectedChannels) ? raw.selectedChannels : [],
        favorites: Array.isArray(raw.favorites) ? raw.favorites : [],
        categoryOrder: Array.isArray(raw.categoryOrder) ? raw.categoryOrder : [],
        channelOrder: Array.isArray(raw.channelOrder) ? raw.channelOrder : [],
        hideContinueWatching: typeof raw.hideContinueWatching === "boolean" ? raw.hideContinueWatching : true,
        hideEmptyChannels: typeof raw.hideEmptyChannels === "boolean" ? raw.hideEmptyChannels : false,
        engineMode: raw.engineMode || "local",
        engineUrl: raw.engineUrl || defaultEngineUrl
      };
    }

    function applyConfig(config) {
      const normalized = normalizeImportedConfig(config);

      state.categories = normalized.categories.map(function(category, index) {
        return {
          id: category.id || "cat-imported-" + Date.now() + "-" + index,
          name: category.name || "Imported Category",
          description: category.description || "",
          logo: category.logo || "",
          tags: normalizeTags(category.tags)
        };
      });

      state.channels = normalized.channels.map(function(channel, index) {
        return {
          id: channel.id || "ch-imported-" + Date.now() + "-" + index,
          categoryId: channel.categoryId || state.categories[0]?.id || "",
          name: channel.name || "Imported Channel",
          contentId: normalizeContentId(channel.contentId || ""),
          logo: channel.logo || "",
          tags: normalizeTags(channel.tags)
        };
      });

      const categoryIds = state.categories.map(function(category) { return category.id; });
      const channelIds = state.channels.map(function(channel) { return channel.id; });

      state.selectedChannels = new Set(
        normalized.selectedChannels.length ? normalized.selectedChannels.filter(function(id) { return channelIds.includes(id); }) : channelIds
      );

      state.favorites = new Set(
        normalized.favorites.filter(function(id) { return channelIds.includes(id); })
      );

      state.categoryOrder = normalized.categoryOrder.length ? normalized.categoryOrder : categoryIds;
      state.channelOrder = normalized.channelOrder.length ? normalized.channelOrder : channelIds;
      state.openCategories = new Set();

      if (state.categories.length) {
        state.openCategories.add(state.categories[0].id);
      }

      document.getElementById("hide-continue-watching").checked = normalized.hideContinueWatching;
      document.getElementById("hide-empty-channels").checked = normalized.hideEmptyChannels;
      document.getElementById("engine-mode").value = normalized.engineMode;
      document.getElementById("engine-url").value = normalized.engineUrl;

      render();
    }

    function generateUrl() {
      const config = buildConfig();
      const encoded = base64UrlEncode(config);
      const url = baseUrl + "/" + encoded + "/manifest.json";
      document.getElementById("addon-url").value = url;
      return url;
    }

    function exportConfig() {
      const config = buildConfig();
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10);

      link.href = url;
      link.download = "acestreamz-config-" + date + ".json";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }

    async function importConfigFromFile(file) {
      try {
        const text = await file.text();
        const config = JSON.parse(text);
        applyConfig(config);
        alert("Config imported.");
      } catch (error) {
        alert("Import failed. Please check the JSON file.");
      }
    }

    function extractContentId(line) {
      const text = String(line || "").trim();
      if (!text) return "";
      if (/^acestream:\\/\\//i.test(text)) return normalizeContentId(text);
      const match = text.match(/[a-fA-F0-9]{40}/);
      return match ? match[0] : "";
    }

    function parseM3U(text) {
      const lines = text.split(/\\r?\\n/);
      const imported = [];
      let pending = null;

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith("#EXTINF")) {
          const nameMatch = trimmed.match(/#EXTINF:[^,]*,(.+)$/i);
          const logoMatch = trimmed.match(/tvg-logo=["']([^"']+)["']/i);
          const groupMatch = trimmed.match(/group-title=["']([^"']+)["']/i);

          pending = {
            name: nameMatch ? nameMatch[1].trim() : "Imported Channel",
            logo: logoMatch ? logoMatch[1].trim() : "",
            category: groupMatch ? groupMatch[1].trim() : "Imported"
          };

          continue;
        }

        const contentId = extractContentId(trimmed);
        if (contentId) {
          imported.push({
            name: pending && pending.name ? pending.name : "Imported Channel " + (imported.length + 1),
            contentId,
            logo: pending && pending.logo ? pending.logo : "",
            category: pending && pending.category ? pending.category : "Imported"
          });
          pending = null;
        }
      }

      return imported;
    }

    function parseChannelJson(raw) {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.channels)
          ? parsed.channels
          : [];

      return items.map(function(item, index) {
        return {
          name: item.name || item.title || item.channel || "Imported Channel " + (index + 1),
          contentId: normalizeContentId(item.contentId || item.id || item.url || item.acestream || ""),
          logo: item.logo || item.poster || item.tvgLogo || "",
          category: item.category || item.categoryName || item.group || item.groupTitle || "Imported",
          tags: normalizeTags(item.tags)
        };
      }).filter(function(item) {
        return item.name && item.contentId;
      });
    }

    function getOrCreateCategoryByName(name) {
      const cleanName = String(name || "Imported").trim() || "Imported";
      const existing = state.categories.find(function(category) {
        return category.name.toLowerCase() === cleanName.toLowerCase();
      });

      if (existing) return existing;

      const id = "cat-" + (slugify(cleanName) || "imported") + "-" + Date.now() + "-" + Math.floor(Math.random() * 10000);
      const category = {
        id,
        name: cleanName,
        description: "Imported channels",
        logo: "",
        tags: ["Import"]
      };

      state.categories.push(category);
      state.categoryOrder.push(id);

      return category;
    }

    async function importChannelsFromFile(file) {
      try {
        const text = await file.text();
        let imported;

        if (file.name.toLowerCase().endsWith(".json")) {
          imported = parseChannelJson(text);
        } else {
          imported = parseM3U(text);
        }

        if (!imported.length) {
          alert("No channels found.");
          return;
        }

        for (const item of imported) {
          const category = getOrCreateCategoryByName(item.category || "Imported");
          const id = "ch-" + (slugify(item.name) || "channel") + "-" + Date.now() + "-" + Math.floor(Math.random() * 10000);

          const channel = {
            id,
            categoryId: category.id,
            name: item.name,
            contentId: normalizeContentId(item.contentId),
            logo: item.logo || "",
            tags: normalizeTags(item.tags || ["Import"])
          };

          state.channels.push(channel);
          state.selectedChannels.add(id);
          state.channelOrder.push(id);
          state.openCategories.add(category.id);
        }

        render();
        alert(imported.length + " channels imported.");
      } catch (error) {
        alert("Channel list import failed.");
      }
    }

    document.getElementById("hide-continue-watching").addEventListener("change", generateUrl);
    document.getElementById("hide-empty-channels").addEventListener("change", generateUrl);
    document.getElementById("engine-url").addEventListener("input", generateUrl);
    document.getElementById("search").addEventListener("input", render);

    document.getElementById("import-file").addEventListener("change", async function(event) {
      const file = event.target.files[0];
      if (!file) return;
      await importConfigFromFile(file);
      event.target.value = "";
    });

    document.getElementById("channel-import-file").addEventListener("change", async function(event) {
      const file = event.target.files[0];
      if (!file) return;
      await importChannelsFromFile(file);
      event.target.value = "";
    });

    render();
  </script>
</body>
</html>
  `);
});

app.get("/:config/image/:kind/:id.png", async (req, res) => {
  try {
    const allowedKinds = new Set(["logo", "poster", "background"]);

    if (!allowedKinds.has(req.params.kind)) {
      return res.status(400).send("Invalid image kind");
    }

    const config = decodeConfig(req.params.config);

    const cleanId = decodeURIComponent(req.params.id)
      .replace(/^ace-/, "")
      .replace(/\.png$/i, "");

    const item =
      config.channels.find((channel) => channel.id === cleanId) ||
      config.categories.find((category) => category.id === cleanId);

    if (!item) {
      return res.status(404).send("Item not found");
    }

    const image = await renderItemImage(item, req.params.kind);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(image);
  } catch (error) {
    console.error("Image render failed:", error);
    res.status(500).send("Image render failed");
  }
});

app.get("/:config/manifest.json", (req, res) => {
  const config = decodeConfig(req.params.config);
  const catalogs = getCatalogsForConfig(config);
  const mediaType = getMediaType(config);

  res.json({
    id: `org.local.acestreamz.${hashValue(req.params.config).slice(0, 16)}`,
    version: "5.0.0",
    name: "AceStreamz",
    description: "Stateless AceStream channel manager for user-provided Content IDs",
    resources: ["catalog", "meta", "stream"],
    types: [mediaType],
    catalogs,
    idPrefixes: ["ace-"],
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  });
});

app.get("/:config/catalog/:type/:catalogId.json", (req, res) => {
  const config = decodeConfig(req.params.config);
  const selectedChannels = getSelectedChannels(config);
  const favorites = new Set(config.favorites || []);

  let catalogChannels = [];

  if (req.params.catalogId === "favorites") {
    catalogChannels = selectedChannels.filter((channel) => favorites.has(channel.id));
  } else if (req.params.catalogId.startsWith("category-")) {
    const categoryId = req.params.catalogId.replace("category-", "");
    catalogChannels = selectedChannels.filter((channel) => channel.categoryId === categoryId);
  }

  res.json({
    metas: catalogChannels.map((channel) =>
      channelToMeta(req, channel, config, favorites.has(channel.id) ? "⭐" : "")
    )
  });
});

app.get("/:config/meta/:type/:id.json", (req, res) => {
  const config = decodeConfig(req.params.config);

  const cleanId = req.params.id.replace(/^ace-/, "");
  const channel = config.channels.find((item) => item.id === cleanId);

  if (!channel) {
    return res.json({ meta: null });
  }

  res.json({
    meta: channelToMeta(req, channel, config)
  });
});

app.get("/:config/stream/:type/:id.json", (req, res) => {
  const config = decodeConfig(req.params.config);

  const cleanId = req.params.id.replace(/^ace-/, "");
  const channel = config.channels.find((item) => item.id === cleanId);

  if (!channel || isPlaceholderContentId(channel.contentId)) {
    return res.json({ streams: [] });
  }

  const contentId = normalizeContentId(channel.contentId);
  const engineUrl = getEngineUrl(config);

  const tsUrl = `${engineUrl}/ace/getstream?content_id=${encodeURIComponent(contentId)}`;
  const hlsUrl = `${engineUrl}/ace/manifest.m3u8?content_id=${encodeURIComponent(contentId)}`;

  res.json({
    streams: [
      {
        title: "AceStream TS",
        name: "AceStream Engine",
        url: tsUrl
      },
      {
        title: "AceStream HLS",
        name: "AceStream Engine HLS",
        url: hlsUrl
      }
    ]
  });
});

app.listen(PORT, () => {
  console.log(`AceStreamz is running at http://localhost:${PORT}`);
  console.log(`Configure: http://localhost:${PORT}/configure`);
});
