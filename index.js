// Dive plugin: yt-dlp downloads, FFmpeg/HandBrake transcodes, lossless edits.
// Ported from the pi-coding-agent yt-dlp-ffmpeg extension. Confirmation is
// handled by Dive's standard dialog (requiresConfirmation on risky skills);
// the pi version's interactive pickers became parameter defaults.
const { randomUUID } = require("crypto");
const { execFile } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const RULES_FILE_PATH = path.join(
  os.homedir(),
  "dive",
  "media-tools.rules.json",
);
const LEGACY_RULES_FILE_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "extensions",
  "yt-dlp-ffmpeg.rules.json",
);
const DISCOVERY_RULES_FILE_PATH = path.join(
  os.homedir(),
  "dive",
  "media-tools.discovery-rules.json",
);
const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
const MAX_BUFFER = 64 * 1024 * 1024;

const VIDEO_EXTENSIONS = new Set([
  ".3gp",
  ".avi",
  ".flv",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".mts",
  ".m2ts",
  ".ts",
  ".vob",
  ".webm",
  ".wmv",
]);

function resolveBinary(name) {
  for (const dir of EXTRA_BIN_DIRS) {
    const full = path.join(dir, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* keep looking */
    }
  }
  return name;
}

function exec(command, args) {
  return new Promise((resolve) => {
    const inheritedPath = process.env.PATH || "";
    const env = {
      ...process.env,
      PATH: [EXTRA_BIN_DIRS.join(path.delimiter), inheritedPath]
        .filter(Boolean)
        .join(path.delimiter),
    };
    execFile(
      resolveBinary(command),
      args,
      { maxBuffer: MAX_BUFFER, env },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || (error && error.message) || ""),
        });
      },
    );
  });
}

function shellQuote(value) {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandPreview(command, args) {
  return [command, ...args.map(shellQuote)].join(" ");
}

function dedupeUrls(urls) {
  const unique = new Set();
  const result = [];
  for (const url of urls || []) {
    const trimmed = String(url || "").trim();
    if (!trimmed || unique.has(trimmed)) continue;
    unique.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function isLikelyPlaylistUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.searchParams.has("list")) return true;
    const pathname = parsed.pathname.toLowerCase();
    return pathname.includes("/playlist") || pathname.includes("/sets/");
  } catch {
    return false;
  }
}

function isGenericMediaCollectionUrl(rawUrl) {
  try {
    // "programmes" is a collection marker below, which would otherwise make
    // every single-episode permalink look like a list and open the picker.
    if (isBbcProgrammePermalinkUrl(rawUrl)) return false;
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname.toLowerCase();
    const segments = pathname.split("/").filter(Boolean);
    if (parsed.searchParams.has("list")) return true;
    if (
      ["page", "offset", "start"].some((key) => parsed.searchParams.has(key))
    ) {
      return true;
    }
    if (segments.length === 0) return false;
    const collectionMarkers = new Set([
      "archive",
      "archives",
      "audios",
      "collection",
      "collections",
      "episodes",
      "feed",
      "feeds",
      "podcast",
      "podcasts",
      "programmes",
      "series",
      "sets",
      "shows",
      "videos",
    ]);
    const last = segments[segments.length - 1];
    if (collectionMarkers.has(last)) return true;
    const markerIndex = segments.findIndex((segment) =>
      collectionMarkers.has(segment),
    );
    if (markerIndex < 0 || segments.length - markerIndex > 2) return false;
    return (
      !/^\d+$/.test(last) &&
      !/^(episode|episodes|item|track|video)-?\d+$/i.test(last)
    );
  } catch {
    return false;
  }
}

const BBC_PID_PATTERN = /^[bmpw][0-9a-z]{7,}$/i;
const BBC_SOUNDS_EPISODE_PATHS = new Set(["play"]);
const BBC_SOUNDS_COLLECTION_PATHS = new Set(["brand", "series"]);

// /sounds/<kind>/<pid>: "play" addresses one episode, brand/series a collection.
function bbcSoundsKind(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname.toLowerCase().endsWith("bbc.co.uk")) return "";
    const segments = parsed.pathname.toLowerCase().split("/").filter(Boolean);
    if (segments.length !== 3 || segments[0] !== "sounds") return "";
    if (!BBC_PID_PATTERN.test(segments[2])) return "";
    if (BBC_SOUNDS_EPISODE_PATHS.has(segments[1])) return "episode";
    if (BBC_SOUNDS_COLLECTION_PATHS.has(segments[1])) return "collection";
    return "";
  } catch {
    return "";
  }
}

function isBbcSoundsCollectionUrl(rawUrl) {
  return bbcSoundsKind(rawUrl) === "collection";
}

// A bare /programmes/<pid> or /sounds/play/<pid>. Usually one episode, but a
// brand page is spelled identically, so callers needing certainty must ask
// BBC's descriptor through resolveBbcProgrammeUrls.
function isBbcProgrammePermalinkUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname.toLowerCase().endsWith("bbc.co.uk")) return false;
    const segments = parsed.pathname.toLowerCase().split("/").filter(Boolean);
    if (segments.length === 2 && segments[0] === "programmes")
      return BBC_PID_PATTERN.test(segments[1]);
    return bbcSoundsKind(rawUrl) === "episode";
  } catch {
    return false;
  }
}

// Anchored to the pid's position rather than taking the last segment: the pid
// pattern also matches ordinary path words like "programmes" and "podcasts",
// and the last segment of an episode index is "player", not a pid.
function bbcPidFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname.toLowerCase().endsWith("bbc.co.uk")) return "";
    const segments = parsed.pathname.toLowerCase().split("/").filter(Boolean);
    let pid = "";
    if (segments[0] === "programmes" && segments.length >= 2) pid = segments[1];
    else if (segments[0] === "sounds" && segments.length >= 3) pid = segments[2];
    return pid && BBC_PID_PATTERN.test(pid) ? pid : "";
  } catch {
    return "";
  }
}

// yt-dlp's BBC extractor fails on every /sounds/ form ("Unable to extract
// playlist data") but resolves the same pid under /programmes/.
function bbcProgrammeUrl(rawUrl) {
  const pid = bbcPidFromUrl(rawUrl);
  return pid ? `https://www.bbc.co.uk/programmes/${pid}` : "";
}

function bbcEpisodeIndexUrl(rawUrl) {
  const pid = bbcPidFromUrl(rawUrl);
  return pid ? `https://www.bbc.co.uk/programmes/${pid}/episodes/player` : "";
}

function isBbcProgrammesUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    return (
      hostname.endsWith("bbc.co.uk") &&
      (pathname.includes("/programmes/") || pathname.includes("/sounds/play/"))
    );
  } catch {
    return false;
  }
}

function isBbcEpisodeListUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return (
      isBbcProgrammesUrl(rawUrl) &&
      parsed.pathname.toLowerCase().includes("/episodes/")
    );
  } catch {
    return false;
  }
}

function isClearlyAudioMediaUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    if (hostname.endsWith("rtve.es") && pathname.includes("/play/audios/")) {
      return true;
    }
    if (hostname.endsWith("bbc.co.uk") && pathname.includes("/sounds/play/")) {
      return true;
    }
    return (
      /\/(?:audio|audios|podcast|podcasts|radio|listen)(?:\/|$)/i.test(
        pathname,
      ) || /\.(?:aac|m4a|mp3|ogg|opus|wav)(?:$|[?#])/i.test(pathname)
    );
  } catch {
    return false;
  }
}

function isClearlyVideoMediaUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com") ||
      hostname === "youtu.be" ||
      hostname.endsWith(".youtu.be") ||
      hostname === "vimeo.com" ||
      hostname.endsWith(".vimeo.com")
    ) {
      return true;
    }
    return (
      /\/(?:iplayer|video|videos|watch|tv)(?:\/|$)/i.test(pathname) ||
      /\.(?:m4v|mp4|mpeg|mpg|webm)(?:$|[?#])/i.test(pathname)
    );
  } catch {
    return false;
  }
}

function resolveMediaMode(args = {}) {
  if (args.mode === "audio" || args.mode === "video") return args.mode;
  const urls = dedupeUrls(args.urls);
  if (urls.length === 0) return undefined;
  if (urls.every(isClearlyAudioMediaUrl)) return "audio";
  if (urls.every(isClearlyVideoMediaUrl)) return "video";
  return undefined;
}

function ambiguousMediaModeMessage(urls) {
  const listedUrls = urls.length > 0 ? `\n\nURL(s): ${urls.join(", ")}` : "";
  return `The media type is ambiguous for this URL. It may contain audio or video. Ask the user whether they want audio or video, then call download_media_with_ytdlp again with mode: "audio" or mode: "video". No preview or download was started.${listedUrls}`;
}

function isMediaPlaylistUrl(rawUrl) {
  return (
    isLikelyPlaylistUrl(rawUrl) ||
    isGenericMediaCollectionUrl(rawUrl) ||
    isBbcEpisodeListUrl(rawUrl) ||
    isBbcSoundsCollectionUrl(rawUrl) ||
    isRtveSeriesUrl(rawUrl)
  );
}

function shouldPreviewMediaUrls(args = {}) {
  const urls = dedupeUrls(args.urls);
  return args.preview === true || urls.some((url) => isMediaPlaylistUrl(url));
}

const MEDIA_PREVIEW_STATE_VERSION = 1;
const MEDIA_PREVIEW_TTL_MS = 30 * 60 * 1000;
const MEDIA_PREVIEW_MAX_ENTRIES = 500;
const MEDIA_PREVIEW_METADATA_CONCURRENCY = 4;
const mediaPreviewCache = new Map();

function mediaPreviewStateDirectory(context = {}) {
  const dataDir =
    context && typeof context.dataDir === "string"
      ? context.dataDir.trim()
      : "";
  return path.join(
    dataDir && path.isAbsolute(dataDir)
      ? dataDir
      : path.join(os.homedir(), "dive"),
    "media-tools-previews",
  );
}

function isSafeMediaPreviewId(value) {
  return /^[a-f0-9-]{16,100}$/i.test(String(value || ""));
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Some extractors print more than one line around a JSON result. Try the
    // last non-empty line without treating any page content as instructions.
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function appendYtDlpCookieArgs(commandArgs, options = {}) {
  const cookiesFile = options.cookiesFile
    ? expandHome(options.cookiesFile)
    : "";
  if (cookiesFile) {
    commandArgs.push("--cookies", cookiesFile);
  } else if (
    options.cookiesFromBrowser &&
    options.cookiesFromBrowser !== "none"
  ) {
    const profile = options.cookiesProfile
      ? String(options.cookiesProfile).trim()
      : "";
    commandArgs.push(
      "--cookies-from-browser",
      profile
        ? `${options.cookiesFromBrowser}:${profile}`
        : options.cookiesFromBrowser,
    );
  }
}

// True when yt-dlp returned a single playable item rather than a list. Such a
// result already identifies exactly what to download, so no picker is needed.
function isResolvedSingleMedia(data) {
  if (!data || typeof data !== "object") return false;
  if (data._type === "playlist" || data._type === "multi_video") return false;
  if (Array.isArray(data.entries)) return false;
  if (!data.id && !data.title) return false;
  return (
    (Array.isArray(data.formats) && data.formats.length > 0) ||
    typeof data.url === "string" ||
    Array.isArray(data.requested_downloads)
  );
}

// BBC publishes a small descriptor beside every programme page naming its type,
// which the URL cannot: /programmes/<pid> is equally the shape of one episode
// and of a whole brand.
async function fetchBbcProgrammeKind(rawUrl) {
  const pid = bbcPidFromUrl(rawUrl);
  if (!pid) return "";
  try {
    const result = await exec("curl", [
      "-sL",
      "--max-time",
      "20",
      "-A",
      "Mozilla/5.0",
      `https://www.bbc.co.uk/programmes/${pid}.json`,
    ]);
    if (result.code !== 0 || !String(result.stdout || "").trim()) return "";
    const type = String(
      JSON.parse(result.stdout)?.programme?.type || "",
    ).toLowerCase();
    if (type === "episode" || type === "clip") return "episode";
    if (type === "brand" || type === "series") return "collection";
    return "";
  } catch {
    return "";
  }
}

// Address every BBC link as a programme. Sounds collection links go to the
// episode index; Sounds episode links to the programme page. A bare
// /programmes/<pid> is ambiguous, so it is classified first, and anything that
// will not classify is left untouched rather than rewritten to a URL that may
// not exist -- Sounds carries podcast-only content with no /programmes/ page.
async function resolveBbcProgrammeUrls(urls) {
  if (!urls.some((url) => isBbcProgrammePermalinkUrl(url) || isBbcSoundsCollectionUrl(url)))
    return urls;
  const resolved = await Promise.all(
    urls.map(async (url) => {
      if (isBbcSoundsCollectionUrl(url)) return bbcEpisodeIndexUrl(url) || url;
      if (!isBbcProgrammePermalinkUrl(url)) return url;
      const kind = await fetchBbcProgrammeKind(url);
      if (!kind) return url;
      const target =
        kind === "collection" ? bbcEpisodeIndexUrl(url) : bbcProgrammeUrl(url);
      return target || url;
    }),
  );
  return dedupeUrls(resolved);
}

async function runYtDlpJson(
  url,
  options = {},
  { playlist = false, maxEntries } = {},
) {
  const commandArgs = [
    "--dump-single-json",
    "--no-warnings",
    "--skip-download",
    "--ignore-no-formats",
  ];
  if (playlist) {
    commandArgs.push("--flat-playlist");
    if (Number.isInteger(maxEntries) && maxEntries > 0) {
      // -I supersedes --playlist-end, now an undocumented legacy alias.
      commandArgs.push("-I", `:${maxEntries}`);
    }
  } else {
    commandArgs.push("--no-playlist");
  }
  appendYtDlpCookieArgs(commandArgs, options);
  commandArgs.push(url);
  const result = await exec("yt-dlp", commandArgs);
  return { ...result, data: parseJsonOutput(result.stdout) };
}

function formatMediaDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}.${raw.slice(4, 6)}.${raw.slice(6, 8)}`;
  }
  return normalizeDateCandidate(raw) || raw.slice(0, 40);
}

function formatMediaDuration(value) {
  if (value === null || value === undefined || value === "") return "";
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function firstHttpUrl(...values) {
  for (const value of values) {
    const candidate = String(value || "").trim();
    if (candidate.startsWith("http://") || candidate.startsWith("https://"))
      return candidate;
  }
  return "";
}

function decodeRtveHtml(value) {
  return String(value || "")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => {
      const number = Number(code);
      return Number.isSafeInteger(number) && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : _match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const number = Number.parseInt(code, 16);
      return Number.isSafeInteger(number) && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : _match;
    });
}

function stripRtveMarkup(value) {
  return decodeRtveHtml(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRtveAttribute(block, attribute) {
  const pattern = new RegExp(`${attribute}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i");
  const match = pattern.exec(block);
  return match ? decodeRtveHtml(match[2]) : "";
}

function parseRtveDuration(value) {
  const parts = String(value || "")
    .trim()
    .split(":")
    .map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isInteger(part) || part < 0))
    return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return undefined;
}

function parseRtveSeriesItem(setupValue, block, sourceUrl, index) {
  let setup = {};
  try {
    const parsed = JSON.parse(decodeRtveHtml(setupValue));
    if (parsed && typeof parsed === "object") setup = parsed;
  } catch {
    /* the block can still provide usable HTML metadata */
  }
  const shareValue = extractRtveAttribute(block, "data-share");
  let share = {};
  if (shareValue) {
    try {
      const parsed = JSON.parse(shareValue);
      if (parsed && typeof parsed === "object") share = parsed;
    } catch {
      /* ignore malformed optional share metadata */
    }
  }
  const hrefs = [...block.matchAll(/\bhref\s*=\s*(["'])([\s\S]*?)\1/gi)]
    .map((match) => decodeRtveHtml(match[2]))
    .filter((url) => /^(?:https?:)?\/\//i.test(url));
  const webpageUrl = firstHttpUrl(
    hrefs.find((url) => /rtve\.es\/play\/audios\//i.test(url)),
  );
  const directUrl = firstHttpUrl(share.file, share.url);
  const titleMatch =
    /class=["'][^"']*\bmaintitle\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i.exec(
      block,
    );
  const title = String(
    setup.title || (titleMatch ? stripRtveMarkup(titleMatch[1]) : ""),
  ).trim();
  const dateMatch =
    /class=["'][^"']*\bdatemi\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i.exec(
      block,
    );
  const durationMatch =
    /class=["'][^"']*\bduration\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i.exec(
      block,
    );
  const thumbnailMatch = /\bsrc=["']([^"']+)["']/i.exec(block);
  const date = dateMatch
    ? normalizeDateCandidate(stripRtveMarkup(dateMatch[1]))
    : undefined;
  const duration = durationMatch
    ? parseRtveDuration(stripRtveMarkup(durationMatch[1]))
    : undefined;
  const stableUrl = webpageUrl || directUrl;
  if (!stableUrl) return null;
  return {
    id: String(setup.idAsset || "").trim(),
    title,
    webpage_url: stableUrl,
    original_url: stableUrl,
    direct_url: directUrl,
    duration,
    release_date: date,
    thumbnail: thumbnailMatch
      ? firstHttpUrl(decodeRtveHtml(thumbnailMatch[1]))
      : "",
    availability: directUrl ? "Available" : "Unknown",
    playlist_index: index,
    extractor: "rtve.es:series",
    source_url: sourceUrl,
  };
}

function extractRtveSeriesEntries(html, sourceUrl) {
  const patterns = [
    {
      regex:
        /<li\b[^>]*class=(["'])[^"']*\belem_\b[^"']*\1[^>]*data-setup=(["'])(.*?)\2>([\s\S]*?)<\/li>/gi,
      setupIndex: 3,
      blockIndex: 4,
    },
    {
      regex:
        /<li\b[^>]*data-setup=(["'])(.*?)\1[^>]*class=(["'])[^"']*\belem_\b[^"']*\3[^>]*>([\s\S]*?)<\/li>/gi,
      setupIndex: 2,
      blockIndex: 4,
    },
  ];
  const entries = [];
  const seen = new Set();
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern.regex)) {
      const item = parseRtveSeriesItem(
        match[pattern.setupIndex],
        match[pattern.blockIndex],
        sourceUrl,
        entries.length + 1,
      );
      if (!item) continue;
      const key = item.id || item.webpage_url || item.direct_url;
      if (seen.has(key)) continue;
      seen.add(key);
      item.playlist_index = entries.length + 1;
      entries.push(item);
    }
  }
  return entries;
}

async function discoverRtveSeriesEntries(sourceUrl) {
  const page = await exec("curl", [
    "-sL",
    "--max-time",
    "30",
    "-A",
    "Mozilla/5.0",
    sourceUrl,
  ]);
  if (page.code !== 0 || !page.stdout.trim()) {
    return {
      entries: [],
      detail: String(page.stderr || page.stdout || "")
        .trim()
        .slice(0, 500),
    };
  }
  const entries = extractRtveSeriesEntries(page.stdout, sourceUrl);
  return {
    entries,
    detail: entries.length
      ? ""
      : "RTVE page contained no downloadable episode entries",
  };
}

const GENERIC_MEDIA_FILE_RE =
  /\.(?:aac|m4a|m3u8|m4v|mp3|mp4|mpd|ogg|opus|wav|webm)(?:$|[?#])/i;

function resolveMediaUrl(value, sourceUrl) {
  const raw = decodeRtveHtml(String(value || "").trim());
  if (!raw) return "";
  try {
    const resolved = new URL(raw, sourceUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.href
      : "";
  } catch {
    return "";
  }
}

function parseFlexibleMediaDuration(value) {
  const raw = stripRtveMarkup(value);
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const iso = raw.match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i,
  );
  if (iso) {
    return (
      Number(iso[1] || 0) * 86400 +
      Number(iso[2] || 0) * 3600 +
      Number(iso[3] || 0) * 60 +
      Number(iso[4] || 0)
    );
  }
  return parseRtveDuration(raw);
}

function extractElementText(block, names) {
  for (const name of names) {
    const match = new RegExp(
      `<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`,
      "i",
    ).exec(block);
    if (match) return stripRtveMarkup(match[1]);
  }
  return "";
}

function extractElementAttribute(block, names, attribute) {
  for (const name of names) {
    const match = new RegExp(
      `<${name}\\b[^>]*\\b${attribute}\\s*=\\s*(["'])([\\s\\S]*?)\\1`,
      "i",
    ).exec(block);
    if (match) return decodeRtveHtml(match[2]);
  }
  return "";
}

function structuredMediaCandidate(item, sourceUrl, index, extractor) {
  const value = item && typeof item === "object" ? item : {};
  const encoding = Array.isArray(value.encoding)
    ? value.encoding[0]
    : value.encoding;
  const associatedMedia = value.associatedMedia || {};
  const offers = value.offers || {};
  const directUrl = resolveMediaUrl(
    value.contentUrl ||
      value.mediaUrl ||
      value.file ||
      value.enclosure?.url ||
      encoding?.contentUrl ||
      associatedMedia.contentUrl,
    sourceUrl,
  );
  const webpageUrl = resolveMediaUrl(
    value.url || value.sameAs || value.mainEntityOfPage,
    sourceUrl,
  );
  const stableUrl = webpageUrl || directUrl;
  if (!stableUrl) return null;
  const image = Array.isArray(value.image) ? value.image[0] : value.image;
  const thumbnail =
    typeof value.thumbnailUrl === "string"
      ? value.thumbnailUrl
      : typeof image === "string"
        ? image
        : image?.url;
  const title = String(value.name || value.title || value.headline || "")
    .trim()
    .slice(0, 500);
  const duration = parseFlexibleMediaDuration(value.duration);
  return {
    id: String(value.identifier || value.id || "").trim(),
    title,
    description: stripRtveMarkup(value.description || "").slice(0, 1000),
    webpage_url: stableUrl,
    original_url: stableUrl,
    direct_url: directUrl,
    duration,
    release_date: normalizeDateCandidate(
      value.datePublished || value.uploadDate || value.dateCreated,
    ),
    thumbnail: resolveMediaUrl(thumbnail, sourceUrl),
    availability: String(
      value.availability ||
        offers.availability ||
        (directUrl ? "Available" : ""),
    ).trim(),
    playlist_index: index,
    extractor,
    source_url: sourceUrl,
  };
}

function parseJsonLdBlock(value) {
  const candidates = [String(value || ""), decodeRtveHtml(value)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* try the next representation */
    }
  }
  return null;
}

function collectJsonLdMediaItems(value, output) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdMediaItems(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value.itemListElement)) {
    for (const listed of value.itemListElement) {
      const item = listed?.item || listed;
      if (item && typeof item === "object") output.push(item);
    }
  }
  const types = Array.isArray(value["@type"])
    ? value["@type"]
    : [value["@type"]];
  const mediaTypes = new Set([
    "AudioObject",
    "Episode",
    "MusicRecording",
    "PodcastEpisode",
    "VideoObject",
  ]);
  if (
    types.some((type) => mediaTypes.has(String(type))) &&
    (value.url || value.contentUrl || value.enclosure)
  ) {
    output.push(value);
  }
  if (value["@graph"]) collectJsonLdMediaItems(value["@graph"], output);
}

function extractJsonLdMediaEntries(html, sourceUrl) {
  const items = [];
  const scriptPattern =
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const parsed = parseJsonLdBlock(match[1]);
    if (parsed) collectJsonLdMediaItems(parsed, items);
  }
  const entries = [];
  const seen = new Set();
  for (const item of items) {
    const candidate = structuredMediaCandidate(
      item,
      sourceUrl,
      entries.length + 1,
      "generic:json-ld",
    );
    if (!candidate) continue;
    const key = candidate.id || candidate.webpage_url || candidate.direct_url;
    if (seen.has(key)) continue;
    seen.add(key);
    candidate.playlist_index = entries.length + 1;
    entries.push(candidate);
  }
  return entries;
}

function extractRssMediaEntries(html, sourceUrl) {
  const entries = [];
  const seen = new Set();
  const itemPattern = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(itemPattern)) {
    const block = match[2];
    const directUrl = resolveMediaUrl(
      extractElementAttribute(block, ["enclosure", "media:content"], "url") ||
        extractElementAttribute(block, ["content"], "url"),
      sourceUrl,
    );
    const webpageUrl = resolveMediaUrl(
      extractElementAttribute(block, ["link"], "href") ||
        extractElementText(block, ["link", "guid"]),
      sourceUrl,
    );
    const stableUrl = webpageUrl || directUrl;
    if (!stableUrl) continue;
    const candidate = {
      id: extractElementText(block, ["guid", "id"]),
      title: extractElementText(block, ["title"]).slice(0, 500),
      description: extractElementText(block, ["description", "summary"]).slice(
        0,
        1000,
      ),
      webpage_url: stableUrl,
      original_url: stableUrl,
      direct_url: directUrl,
      duration: parseFlexibleMediaDuration(
        extractElementText(block, ["itunes:duration", "duration"]),
      ),
      release_date: normalizeDateCandidate(
        extractElementText(block, ["pubDate", "published", "updated", "date"]),
      ),
      thumbnail: resolveMediaUrl(
        extractElementAttribute(
          block,
          ["itunes:image", "media:thumbnail"],
          "href",
        ) ||
          extractElementAttribute(
            block,
            ["itunes:image", "media:thumbnail"],
            "url",
          ),
        sourceUrl,
      ),
      availability: directUrl ? "Available" : "Unknown",
      playlist_index: entries.length + 1,
      extractor: "generic:rss",
      source_url: sourceUrl,
    };
    const key = candidate.id || candidate.webpage_url || candidate.direct_url;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(candidate);
  }
  return entries;
}

function isMediaFileUrl(url) {
  return GENERIC_MEDIA_FILE_RE.test(String(url || ""));
}

// Site chrome the keyword test below would otherwise wave through.
const NAV_ONLY_PATH_SEGMENTS = new Set([
  "about", "accessibility", "audios", "categories", "contact", "contacts",
  "episodes", "help", "podcasts", "privacy", "programmes", "register",
  "schedules", "search", "series", "shows", "sign-in", "signin", "terms",
  "videos",
]);

function isPlausibleMediaEntryUrl(url, sourceUrl) {
  try {
    const candidate = new URL(url);
    const source = new URL(sourceUrl);
    if (candidate.protocol !== "http:" && candidate.protocol !== "https:")
      return false;
    if (candidate.origin !== source.origin) return false;
    if (candidate.href === source.href) return false;
    // In-page anchors ("Skip to content") resolve to the source page plus a
    // fragment, so comparing href alone does not catch them.
    if (
      candidate.pathname === source.pathname &&
      candidate.search === source.search
    )
      return false;
    const pathname = candidate.pathname.toLowerCase();
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length === 0) return false;
    if (NAV_ONLY_PATH_SEGMENTS.has(parts[parts.length - 1])) return false;
    return (
      /(?:episode|podcast|audio|video|programme|program|listen|watch|media|track|item|story|show|series)/.test(
        pathname,
      ) || /\d{4,}/.test(pathname)
    );
  } catch {
    return false;
  }
}

function inferGenericTitle(context, fallbackUrl) {
  const heading = /<(?:h[1-6]|strong|b)\b[^>]*>([\s\S]*?)<\/[^>]+>/i.exec(
    context,
  );
  if (heading) {
    const title = stripRtveMarkup(heading[1]);
    if (title) return title.slice(0, 500);
  }
  const labelled = /(?:aria-label|title)=["']([^"']+)["']/i.exec(context);
  if (labelled) return decodeRtveHtml(labelled[1]).trim().slice(0, 500);
  try {
    return decodeURIComponent(path.basename(new URL(fallbackUrl).pathname))
      .replace(/[-_]+/g, " ")
      .replace(/\.[A-Za-z0-9]{2,5}$/, "")
      .trim()
      .slice(0, 500);
  } catch {
    return "";
  }
}

function extractGenericHtmlEntries(html, sourceUrl) {
  const entries = extractJsonLdMediaEntries(html, sourceUrl);
  const seen = new Set(
    entries
      .flatMap((entry) => [entry.webpage_url, entry.direct_url])
      .filter(Boolean),
  );
  const append = (candidate) => {
    if (!candidate) return;
    const key = candidate.id || candidate.webpage_url || candidate.direct_url;
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidate.playlist_index = entries.length + 1;
    entries.push(candidate);
  };
  for (const candidate of extractRssMediaEntries(html, sourceUrl))
    append(candidate);

  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const attributes = match[1];
    const hrefMatch = /\bhref\s*=\s*(["'])([\s\S]*?)\1/i.exec(attributes);
    if (!hrefMatch) continue;
    const url = resolveMediaUrl(hrefMatch[2], sourceUrl);
    if (!url) continue;
    const text = stripRtveMarkup(match[2]);
    const titleAttribute = /(?:aria-label|title)=["']([^"']+)["']/i.exec(
      attributes,
    );
    const title =
      text || (titleAttribute ? decodeRtveHtml(titleAttribute[1]).trim() : "");
    if (isMediaFileUrl(url)) {
      append({
        title: title.slice(0, 500) || inferGenericTitle(match[0], url),
        webpage_url: url,
        original_url: url,
        direct_url: url,
        availability: "Available",
        extractor: "generic:html",
        source_url: sourceUrl,
      });
    } else if (title && isPlausibleMediaEntryUrl(url, sourceUrl)) {
      append({
        title: title.slice(0, 500),
        webpage_url: url,
        original_url: url,
        availability: "Unknown",
        extractor: "generic:html",
        source_url: sourceUrl,
      });
    }
  }

  const mediaUrlPattern = /https?:\/\/[^"'<>\s]+/gi;
  for (const match of html.matchAll(mediaUrlPattern)) {
    const url = resolveMediaUrl(match[0].replace(/[),.;]+$/, ""), sourceUrl);
    if (!isMediaFileUrl(url)) continue;
    const contextStart = Math.max(0, match.index - 1000);
    const contextEnd = Math.min(
      html.length,
      match.index + match[0].length + 1000,
    );
    append({
      title: inferGenericTitle(html.slice(contextStart, contextEnd), url),
      webpage_url: url,
      original_url: url,
      direct_url: url,
      availability: "Available",
      extractor: "generic:html",
      source_url: sourceUrl,
    });
  }
  return entries;
}

const DISCOVERY_RULES_VERSION = 1;
const DISCOVERY_RULE_MAX_PATTERN_LENGTH = 4000;
const DISCOVERY_RULE_MAX_ENTRIES = 500;
const DISCOVERY_RULE_FIELDS = new Set([
  "id",
  "url",
  "webpageUrl",
  "link",
  "mediaUrl",
  "file",
  "title",
  "date",
  "duration",
  "thumbnail",
  "description",
]);

function normalizeDiscoveryRule(rawRule) {
  if (!rawRule || typeof rawRule !== "object") return null;
  const domain = String(rawRule.domain || "")
    .trim()
    .toLowerCase();
  const name = String(rawRule.name || domain || "").trim();
  const entryPattern = String(rawRule.entryPattern || "").trim();
  if (!domain || !name || !entryPattern) return null;
  if (entryPattern.length > DISCOVERY_RULE_MAX_PATTERN_LENGTH) return null;
  const fields = {};
  if (rawRule.fields && typeof rawRule.fields === "object") {
    for (const [field, patternValue] of Object.entries(rawRule.fields)) {
      if (!DISCOVERY_RULE_FIELDS.has(field)) continue;
      const pattern =
        typeof patternValue === "string"
          ? patternValue.trim()
          : String(patternValue?.pattern || "").trim();
      if (pattern && pattern.length <= DISCOVERY_RULE_MAX_PATTERN_LENGTH) {
        fields[field] = pattern;
      }
    }
  }
  if (!fields.url && !fields.webpageUrl && !fields.mediaUrl && !fields.file) {
    return null;
  }
  return {
    name,
    domain,
    urlPattern: String(rawRule.urlPattern || "")
      .trim()
      .slice(0, 1000),
    entryPattern,
    fields,
  };
}

async function loadMediaDiscoveryRules() {
  try {
    const parsed = JSON.parse(
      await fsp.readFile(DISCOVERY_RULES_FILE_PATH, "utf8"),
    );
    if (
      parsed.version !== DISCOVERY_RULES_VERSION ||
      !Array.isArray(parsed.rules)
    ) {
      return { version: DISCOVERY_RULES_VERSION, rules: [] };
    }
    return {
      version: DISCOVERY_RULES_VERSION,
      rules: parsed.rules.map(normalizeDiscoveryRule).filter(Boolean),
    };
  } catch {
    return { version: DISCOVERY_RULES_VERSION, rules: [] };
  }
}

async function saveMediaDiscoveryRules(rules) {
  await fsp.mkdir(path.dirname(DISCOVERY_RULES_FILE_PATH), { recursive: true });
  await fsp.writeFile(
    DISCOVERY_RULES_FILE_PATH,
    `${JSON.stringify({ version: DISCOVERY_RULES_VERSION, rules }, null, 2)}\\n`,
    "utf8",
  );
}

function discoveryRuleMatchesUrl(url, rule) {
  if (!matchesDomain(url, rule.domain)) return false;
  if (!rule.urlPattern) return true;
  if (rule.urlPattern.startsWith("re:")) {
    try {
      return new RegExp(rule.urlPattern.slice(3), "i").test(url);
    } catch {
      return false;
    }
  }
  return url.toLowerCase().includes(rule.urlPattern.toLowerCase());
}

function extractDiscoveryPattern(text, pattern) {
  if (!pattern) return "";
  try {
    const regex = new RegExp(pattern, "i");
    const match = regex.exec(String(text || ""));
    return match ? decodeRtveHtml(match[1] ?? match[0]) : "";
  } catch {
    return "";
  }
}

function extractConfiguredMediaEntries(html, sourceUrl, rules, maxEntries) {
  const entries = [];
  const seen = new Set();
  const limit = Math.min(
    DISCOVERY_RULE_MAX_ENTRIES,
    Math.max(1, Number(maxEntries) || DISCOVERY_RULE_MAX_ENTRIES),
  );
  for (const rule of rules) {
    if (!discoveryRuleMatchesUrl(sourceUrl, rule)) continue;
    let entryRegex;
    try {
      entryRegex = new RegExp(rule.entryPattern, "gi");
    } catch {
      continue;
    }
    for (const match of html.matchAll(entryRegex)) {
      if (entries.length >= limit) return entries;
      const block = match[1] || match[0];
      const field = (name) => extractDiscoveryPattern(block, rule.fields[name]);
      const webpageUrl = resolveMediaUrl(
        field("url") || field("webpageUrl") || field("link"),
        sourceUrl,
      );
      const directUrl = resolveMediaUrl(
        field("mediaUrl") || field("file"),
        sourceUrl,
      );
      const stableUrl = webpageUrl || directUrl;
      if (!stableUrl) continue;
      const key = stableUrl || directUrl;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        id: field("id"),
        title:
          stripRtveMarkup(field("title")) ||
          inferGenericTitle(block, stableUrl),
        description: stripRtveMarkup(field("description")).slice(0, 1000),
        webpage_url: webpageUrl || directUrl,
        original_url: webpageUrl || directUrl,
        direct_url: directUrl,
        duration: parseFlexibleMediaDuration(field("duration")),
        release_date: normalizeDateCandidate(field("date")),
        thumbnail: resolveMediaUrl(field("thumbnail"), sourceUrl),
        availability: directUrl ? "Available" : "Unknown",
        playlist_index: entries.length + 1,
        extractor: `rule:${rule.name}`,
        source_url: sourceUrl,
      });
    }
  }
  return entries;
}

async function fetchMediaPageHtml(sourceUrl, options = {}) {
  const args = ["-sL", "--max-time", "30", "-A", "Mozilla/5.0"];
  if (options.cookiesFile) {
    args.push("--cookie", expandHome(options.cookiesFile));
  }
  args.push(sourceUrl);
  const page = await exec("curl", args);
  return page.code === 0 && page.stdout.trim() ? page.stdout : "";
}

async function discoverGenericMediaEntries(
  sourceUrl,
  options = {},
  rules = [],
) {
  const html = await fetchMediaPageHtml(sourceUrl, options);
  if (!html) {
    return {
      entries: [],
      detail: "Could not fetch the page for generic media discovery",
    };
  }
  const configured = extractConfiguredMediaEntries(
    html,
    sourceUrl,
    rules,
    options.maxEntries,
  );
  const entries = configured.length
    ? configured
    : extractGenericHtmlEntries(html, sourceUrl).slice(
        0,
        Math.min(
          DISCOVERY_RULE_MAX_ENTRIES,
          Number(options.maxEntries) || DISCOVERY_RULE_MAX_ENTRIES,
        ),
      );
  return {
    entries,
    detail: entries.length
      ? ""
      : "No structured media entries were found in the page HTML",
  };
}

async function hasMatchingMediaDiscoveryRule(urls) {
  const rules = await loadMediaDiscoveryRules();
  return (urls || []).some((url) =>
    rules.rules.some((rule) => discoveryRuleMatchesUrl(url, rule)),
  );
}

// Compare on host + path so http/https and trailing-slash variants collapse.
function mediaCandidateKey(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return `${parsed.hostname.toLowerCase().replace(/^www\./, "")}${parsed.pathname
      .replace(/\/+$/, "")
      .toLowerCase()}${parsed.search}`;
  } catch {
    return String(value).trim().toLowerCase();
  }
}

function normalizeMediaCandidate(entry, sourceUrl, index) {
  const item = entry && typeof entry === "object" ? entry : {};
  const downloadUrl = firstHttpUrl(
    item.webpage_url,
    item.original_url,
    item.url,
  );
  const directUrl = firstHttpUrl(item.direct_url, item.media_url, item.file);
  const rawAvailability = String(
    item.availability || item.live_status || "",
  ).trim();
  const availability = rawAvailability
    ? rawAvailability.replace(/[_-]+/g, " ")
    : downloadUrl
      ? "Available"
      : "Unavailable";
  const durationSeconds = Number(item.duration);
  const duration = formatMediaDuration(durationSeconds);
  const date = formatMediaDate(
    item.release_date ||
      item.upload_date ||
      item.release_timestamp ||
      item.timestamp,
  );
  const title = String(item.title || item.fulltitle || "").trim();
  const playlistIndex = Number(item.playlist_index);
  return {
    index,
    sourceUrl,
    url: downloadUrl,
    downloadUrl,
    webpageUrl: downloadUrl,
    mediaUrl: directUrl,
    id: String(item.id || "").trim(),
    title,
    displayName: title || `Media entry ${index}`,
    description: String(item.description || "")
      .trim()
      .slice(0, 500),
    availability,
    date,
    durationSeconds:
      Number.isFinite(durationSeconds) && durationSeconds >= 0
        ? durationSeconds
        : null,
    duration,
    thumbnail: firstHttpUrl(item.thumbnail),
    series: String(item.series || "").trim(),
    season: String(item.season || "").trim(),
    episode: String(item.episode || "").trim(),
    episodeNumber: Number.isFinite(Number(item.episode_number))
      ? Number(item.episode_number)
      : null,
    playlistIndex: Number.isInteger(playlistIndex) ? playlistIndex : null,
    extractor: String(item.extractor || "").trim(),
  };
}

function mergeNonEmptyObjects(base, extra) {
  const merged = { ...(base || {}) };
  if (!extra || typeof extra !== "object") return merged;
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== "") {
      merged[key] = value;
    }
  }
  return merged;
}

async function mapWithConcurrency(items, worker, concurrency) {
  const output = new Array(items.length);
  let next = 0;
  const workerCount = Math.min(
    Math.max(1, concurrency),
    Math.max(1, items.length),
  );
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        output[index] = await worker(items[index], index);
      }
    }),
  );
  return output;
}

function mediaPreviewOptions(args = {}) {
  const optionKeys = [
    "mode",
    "audioFormat",
    "videoContainer",
    "playlistMode",
    "overwriteMode",
    "cookiesFromBrowser",
    "cookiesProfile",
    "cookiesFile",
    "continueOnErrors",
    "playlistItems",
    "sleepRequests",
    "compatibilityProfile",
  ];
  const options = {};
  for (const key of optionKeys) {
    if (args[key] !== undefined) options[key] = args[key];
  }
  return options;
}

async function saveMediaPreviewState(state, context = {}) {
  mediaPreviewCache.set(state.previewId, state);
  try {
    const directory = mediaPreviewStateDirectory(context);
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(
      path.join(directory, `${state.previewId}.json`),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // In-process state still permits the immediate selection flow when the
    // configured data directory is unavailable.
  }
}

async function loadMediaPreviewState(previewId, context = {}) {
  const id = String(previewId || "");
  if (!isSafeMediaPreviewId(id)) return null;
  const cached = mediaPreviewCache.get(id);
  let state = cached;
  if (!state) {
    try {
      state = JSON.parse(
        await fsp.readFile(
          path.join(mediaPreviewStateDirectory(context), `${id}.json`),
          "utf8",
        ),
      );
    } catch {
      return null;
    }
  }
  if (
    !state ||
    state.version !== MEDIA_PREVIEW_STATE_VERSION ||
    !Number.isFinite(Number(state.createdAt)) ||
    Date.now() - Number(state.createdAt) > MEDIA_PREVIEW_TTL_MS
  ) {
    mediaPreviewCache.delete(id);
    return null;
  }
  mediaPreviewCache.set(id, state);
  return state;
}

function mediaPreviewModelText(state) {
  const count = state.candidates.length;
  return `Media playlist preview displayed in the Dive interface: ${count} entr${count === 1 ? "y" : "ies"}. Ask the user to select entries in the preview panel; nothing has been downloaded.`;
}

function buildMediaPreviewUiResult(state) {
  return {
    __diveUi: "media_playlist_preview",
    previewId: state.previewId,
    sourceUrls: state.sourceUrls,
    destinationPath: state.destinationPath,
    mode: state.options.mode === "video" ? "video" : "audio",
    audioFormat: state.options.audioFormat || "",
    videoContainer: state.options.videoContainer || "",
    compatibilityProfile: state.options.compatibilityProfile || "",
    candidates: state.candidates.map((candidate) => ({
      index: candidate.index,
      url: candidate.downloadUrl,
      webpageUrl: candidate.webpageUrl,
      mediaUrl: candidate.mediaUrl,
      title: candidate.title,
      displayName: candidate.displayName,
      description: candidate.description,
      availability: candidate.availability,
      date: candidate.date,
      durationSeconds: candidate.durationSeconds,
      duration: candidate.duration,
      thumbnail: candidate.thumbnail,
      series: candidate.series,
      season: candidate.season,
      episode: candidate.episode,
      episodeNumber: candidate.episodeNumber,
      playlistIndex: candidate.playlistIndex,
      extractor: candidate.extractor,
    })),
    warnings: state.warnings,
    modelText: mediaPreviewModelText(state),
  };
}

async function prepareMediaPreviewRequest(args = {}) {
  const urls = await resolveBbcProgrammeUrls(dedupeUrls(args.urls));
  if (urls.length === 0)
    return { error: "Error: no valid URLs were provided." };
  const destinationSelection = selectDestinationPath(args.destinationPath);
  if (!path.isAbsolute(destinationSelection.path)) {
    return {
      error: `Error: destination path must be absolute: ${destinationSelection.path}`,
    };
  }
  const cookiesFile = args.cookiesFile ? expandHome(args.cookiesFile) : "";
  if (cookiesFile && !path.isAbsolute(cookiesFile)) {
    return {
      error: `Error: cookies file path must be absolute: ${cookiesFile}`,
    };
  }
  if (cookiesFile && !(await pathExists(cookiesFile))) {
    return { error: `Error: cookies file is not readable: ${cookiesFile}` };
  }
  const destinationCheck = await ensureWritableDirectory(
    destinationSelection.path,
  );
  if (!destinationCheck.ok) {
    return {
      error: `Error: destination folder is not writable: ${destinationSelection.path}\n${destinationCheck.error}`,
    };
  }
  const ytDlpCheck = await exec("yt-dlp", ["--version"]);
  if (ytDlpCheck.code !== 0) {
    return {
      error:
        "Error: yt-dlp is not available (checked PATH, /opt/homebrew/bin, /usr/local/bin).",
    };
  }
  const maxEntries = Math.min(
    MEDIA_PREVIEW_MAX_ENTRIES,
    Math.max(
      1,
      Number.parseInt(args.maxPlaylistEntries, 10) || MEDIA_PREVIEW_MAX_ENTRIES,
    ),
  );
  return {
    urls,
    destinationPath: destinationSelection.path,
    cookiesFile,
    maxEntries,
  };
}

async function createMediaPreview(args = {}, context = {}) {
  const prepared = await prepareMediaPreviewRequest(args);
  if (prepared.error) return prepared.error;
  const options = {
    ...args,
    cookiesFile: prepared.cookiesFile || args.cookiesFile,
  };
  const warnings = [];
  const rawCandidates = [];
  const discoveryRules = await loadMediaDiscoveryRules();
  let remaining = prepared.maxEntries;

  for (const sourceUrl of prepared.urls) {
    if (remaining <= 0) break;
    const result = await runYtDlpJson(sourceUrl, options, {
      playlist: true,
      maxEntries: remaining,
    });
    const data = result.data;
    let entries = Array.isArray(data?.entries)
      ? data.entries.filter((entry) => entry && typeof entry === "object")
      : [];
    let fallbackDetail = "";
    const hasConfiguredRule = discoveryRules.rules.some((rule) =>
      discoveryRuleMatchesUrl(sourceUrl, rule),
    );
    if (entries.length === 0 && isResolvedSingleMedia(data)) {
      // yt-dlp resolved this URL to one concrete item. That answer is
      // authoritative: scraping the page here is what listed page navigation
      // ("Skip to content", "More menu") as selectable entries.
      entries = [data];
    } else if (entries.length === 0 && isRtveSeriesUrl(sourceUrl)) {
      const rtveFallback = await discoverRtveSeriesEntries(sourceUrl);
      entries = rtveFallback.entries;
      fallbackDetail = rtveFallback.detail;
    } else if (
      entries.length === 0 &&
      (isGenericMediaCollectionUrl(sourceUrl) ||
        hasConfiguredRule ||
        args.preview === true)
    ) {
      const genericFallback = await discoverGenericMediaEntries(
        sourceUrl,
        { ...options, maxEntries: remaining },
        discoveryRules.rules,
      );
      entries = genericFallback.entries;
      fallbackDetail = genericFallback.detail;
    }
    if (
      entries.length === 0 &&
      data &&
      typeof data === "object" &&
      (data.id || data.title)
    ) {
      entries = [data];
    }
    if (entries.length === 0) {
      const detail = String(result.stderr || result.stdout || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 500);
      warnings.push({
        url: sourceUrl,
        detail: fallbackDetail || detail || "yt-dlp returned no entries",
      });
      continue;
    }
    const playlistCount = Number(data?.playlist_count);
    if (Number.isInteger(playlistCount) && playlistCount > entries.length) {
      warnings.push({
        url: sourceUrl,
        detail: `Only the first ${entries.length} of ${playlistCount} entries were previewed.`,
      });
    }
    const selectedEntries = entries.slice(0, remaining);
    const hydratedEntries = await mapWithConcurrency(
      selectedEntries,
      async (entry) => {
        const entryUrl = firstHttpUrl(
          entry.webpage_url,
          entry.original_url,
          entry.url,
        );
        const hasUsefulMetadata = Boolean(
          String(entry.title || entry.fulltitle || "").trim() &&
          (entry.duration !== undefined ||
            entry.release_date ||
            entry.upload_date ||
            entry.thumbnail),
        );
        let mergedEntry = entry;
        if (entryUrl && !hasUsefulMetadata) {
          const detail = await runYtDlpJson(entryUrl, options);
          if (detail.data)
            mergedEntry = mergeNonEmptyObjects(entry, detail.data);
        }
        const hasDate = Boolean(
          mergedEntry.release_date ||
          mergedEntry.upload_date ||
          mergedEntry.release_timestamp ||
          mergedEntry.timestamp,
        );
        if (entryUrl && isBbcProgrammesUrl(entryUrl) && !hasDate) {
          const page = await exec("curl", [
            "-sL",
            "--max-time",
            "20",
            entryUrl,
          ]);
          if (page.code === 0 && page.stdout.trim()) {
            const broadcastDate = extractBbcBroadcastDate(page.stdout);
            if (broadcastDate) {
              mergedEntry = { ...mergedEntry, release_date: broadcastDate };
            }
          }
        }
        return mergedEntry;
      },
      MEDIA_PREVIEW_METADATA_CONCURRENCY,
    );
    for (const entry of hydratedEntries) {
      rawCandidates.push({ entry, sourceUrl });
    }
    remaining -= selectedEntries.length;
  }

  if (rawCandidates.length === 0) {
    return `Error: yt-dlp found no selectable media entries. No download was started.${warnings.length ? `\n${warnings.map((warning) => `${warning.url}: ${warning.detail}`).join("\n")}` : ""}`;
  }

  // Index pages hand out http:// links while a direct resolution reports
  // https://, so the same episode can arrive twice from different sources.
  const seenCandidateKeys = new Set();
  const candidates = [];
  for (const { entry, sourceUrl } of rawCandidates) {
    const candidate = normalizeMediaCandidate(
      entry,
      sourceUrl,
      candidates.length + 1,
    );
    const key = mediaCandidateKey(candidate.downloadUrl);
    if (key) {
      if (seenCandidateKeys.has(key)) continue;
      seenCandidateKeys.add(key);
    }
    candidates.push(candidate);
  }
  const missingUrls = candidates.filter(
    (candidate) => !candidate.downloadUrl,
  ).length;
  if (missingUrls > 0) {
    warnings.push({
      url: "",
      detail: `${missingUrls} entr${missingUrls === 1 ? "y has" : "ies have"} no direct webpage URL and cannot be selected for download.`,
    });
  }
  const state = {
    version: MEDIA_PREVIEW_STATE_VERSION,
    previewId: randomUUID(),
    createdAt: Date.now(),
    sourceUrls: prepared.urls,
    destinationPath: prepared.destinationPath,
    options: mediaPreviewOptions({
      ...args,
      cookiesFile: prepared.cookiesFile || args.cookiesFile,
    }),
    candidates,
    warnings,
  };
  await saveMediaPreviewState(state, context);
  return buildMediaPreviewUiResult(state);
}

function mediaSelectionOptions(args, state, selectedUrls) {
  const optionKeys = [
    "mode",
    "audioFormat",
    "videoContainer",
    "overwriteMode",
    "cookiesFromBrowser",
    "cookiesProfile",
    "cookiesFile",
    "continueOnErrors",
    "playlistItems",
    "sleepRequests",
    "compatibilityProfile",
  ];
  const options = { ...(state.options || {}) };
  for (const key of optionKeys) {
    if (args[key] !== undefined) options[key] = args[key];
  }
  return {
    ...options,
    urls: selectedUrls,
    destinationPath: args.destinationPath || state.destinationPath,
    playlistMode: "single",
  };
}

async function downloadSelectedMedia(args = {}, context = {}) {
  const requestedPreviewId = String(args.previewId || "").trim();
  let state = await loadMediaPreviewState(requestedPreviewId, context);
  if (!state && requestedPreviewId) {
    return "Error: media preview has expired or is unavailable. No download was started.";
  }
  if (!state) {
    const suppliedEntryUrls =
      Array.isArray(args.entryUrls) && args.entryUrls.length
        ? args.entryUrls.map((url) => String(url || "").trim())
        : [];
    if (suppliedEntryUrls.length > 0) {
      // The UI sends the complete candidate URL array as a fallback. Keep
      // empty slots so the original 1-based indices remain stable even when a
      // preview item had no downloadable URL.
      state = {
        destinationPath: args.destinationPath,
        options: mediaPreviewOptions(args),
        candidates: suppliedEntryUrls.map((url, index) =>
          normalizeMediaCandidate({ webpage_url: url }, "", index + 1),
        ),
      };
    } else {
      const fallbackUrls = dedupeUrls(args.urls);
      if (fallbackUrls.length === 0) {
        return "Error: media preview has expired or is unavailable. No download was started.";
      }
      const fallback = await createMediaPreview(
        {
          ...args,
          urls: fallbackUrls,
          playlistMode: "playlist",
          maxPlaylistEntries: fallbackUrls.length,
        },
        context,
      );
      if (!fallback || typeof fallback === "string")
        return fallback || "Error: media preview unavailable.";
      state = await loadMediaPreviewState(fallback.previewId, context);
    }
  }
  if (!state)
    return "Error: media preview has expired or is unavailable. No download was started.";
  if (!Array.isArray(args.selectedIndices)) {
    return "No media entries selected; download cancelled.";
  }
  const requested = args.selectedIndices.map(Number);
  if (requested.length === 0)
    return "No media entries selected; download cancelled.";
  const invalid = requested.filter(
    (index) =>
      !Number.isInteger(index) ||
      !state.candidates.some((candidate) => candidate.index === index),
  );
  if (invalid.length > 0) {
    return `Error: selected media entry indices are invalid: ${invalid.join(", ")}. No download was started.`;
  }
  const selectedIndices = [...new Set(requested)].sort((a, b) => a - b);
  const selected = selectedIndices.map((index) =>
    state.candidates.find((candidate) => candidate.index === index),
  );
  const selectedUrls = selected
    .map((candidate) => candidate.downloadUrl)
    .filter(Boolean);
  if (selectedUrls.length !== selected.length) {
    return "Error: one or more selected entries has no downloadable webpage URL. No download was started.";
  }
  const result = await downloadMedia(
    mediaSelectionOptions(args, state, selectedUrls),
  );
  return `${result}\n\nSelected media entries: ${selectedIndices.join(", ")}`;
}

async function executeDownloadMedia(args = {}, context = {}) {
  const hasSelection =
    Array.isArray(args.selectedIndices) || typeof args.previewId === "string";
  if (hasSelection) return downloadSelectedMedia(args, context);
  const urls = dedupeUrls(args.urls);
  const mode = resolveMediaMode({ ...args, urls });
  if (!mode) return ambiguousMediaModeMessage(urls);
  const effectiveArgs = { ...args, urls, mode };
  if (
    shouldPreviewMediaUrls(effectiveArgs) ||
    (await hasMatchingMediaDiscoveryRule(urls))
  ) {
    const preview = await createMediaPreview(effectiveArgs, context);
    return preview;
  }
  return downloadMedia(effectiveArgs);
}

function isRtveAudioUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.hostname.toLowerCase().endsWith("rtve.es") &&
      parsed.pathname.toLowerCase().includes("/play/audios/")
    );
  } catch {
    return false;
  }
}

function isRtveSeriesUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.hostname.toLowerCase().endsWith("rtve.es") &&
      /^\/play\/audios\/[^/]+\/?$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function normalizeIsoDate(date) {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function normalizeSlashDate(date) {
  const match = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return undefined;
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function monthNameToNumber(name) {
  const monthMap = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12",
    enero: "01",
    febrero: "02",
    marzo: "03",
    abril: "04",
    mayo: "05",
    junio: "06",
    julio: "07",
    agosto: "08",
    septiembre: "09",
    octubre: "10",
    noviembre: "11",
    diciembre: "12",
  };
  return monthMap[name.toLowerCase()];
}

function normalizeDateCandidate(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return undefined;
  if (/^\d{4}\.\d{2}\.\d{2}$/.test(value)) return value;
  const isoDirect = normalizeIsoDate(value);
  if (isoDirect) return isoDirect;
  const slash = normalizeSlashDate(value);
  if (slash) return slash;
  const isoTimeMatch = value.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoTimeMatch) {
    const normalized = normalizeIsoDate(isoTimeMatch[1]);
    if (normalized) return normalized;
  }
  const dashDayMonthYear = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dashDayMonthYear) {
    return `${dashDayMonthYear[3]}.${dashDayMonthYear[2]}.${dashDayMonthYear[1]}`;
  }
  const dayMonthYearShort = value.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (dayMonthYearShort) {
    const year = Number.parseInt(dayMonthYearShort[3], 10);
    const fullYear = year >= 70 ? 1900 + year : 2000 + year;
    return `${String(fullYear).padStart(4, "0")}.${dayMonthYearShort[2]}.${dayMonthYearShort[1]}`;
  }
  const monthNamePattern = value.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (monthNamePattern) {
    const month = monthNameToNumber(monthNamePattern[1]);
    if (month) {
      return `${monthNamePattern[3]}.${month}.${monthNamePattern[2].padStart(2, "0")}`;
    }
  }
  const dayMonthNamePattern = value.match(
    /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/,
  );
  if (dayMonthNamePattern) {
    const month = monthNameToNumber(dayMonthNamePattern[2]);
    if (month) {
      return `${dayMonthNamePattern[3]}.${month}.${dayMonthNamePattern[1].padStart(2, "0")}`;
    }
  }
  return undefined;
}

function tryExtractWithRegex(sourceText, pattern) {
  let compiled;
  try {
    compiled = new RegExp(pattern, "i");
  } catch {
    return undefined;
  }
  const match = compiled.exec(sourceText);
  if (!match) return undefined;
  return normalizeDateCandidate(match[1] ?? match[0]);
}

const RULE_PRESETS = {
  html: [
    {
      label: "JSON emission field",
      pattern: '"emission":"(\\d{2}/\\d{2}/\\d{4})"',
    },
    {
      label: "HTML datetime content",
      pattern: 'content="(\\d{4}-\\d{2}-\\d{2})T[^"]*"',
    },
    {
      label: "datemi span",
      pattern: 'class="datemi"[^>]*>(\\d{2}/\\d{2}/\\d{4})<',
    },
    { label: "ISO date in page", pattern: "\\b(\\d{4}-\\d{2}-\\d{2})\\b" },
    { label: "Slash date in page", pattern: "\\b(\\d{2}/\\d{2}/\\d{4})\\b" },
  ],
  url: [
    { label: "dd-mm-yy in URL", pattern: "/(\\d{2}-\\d{2}-\\d{2})(?:/|$)" },
    { label: "yyyy-mm-dd in URL", pattern: "/(\\d{4}-\\d{2}-\\d{2})(?:/|$)" },
  ],
};

function makeRuleCandidates(source, sourceText) {
  const candidates = [];
  for (const preset of RULE_PRESETS[source] || []) {
    const value = tryExtractWithRegex(sourceText, preset.pattern);
    if (!value) continue;
    candidates.push({
      label: preset.label,
      pattern: preset.pattern,
      source,
      value,
    });
  }
  const unique = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.pattern}::${candidate.value}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()];
}

async function loadRules() {
  for (const filePath of [RULES_FILE_PATH, LEGACY_RULES_FILE_PATH]) {
    try {
      const content = await fsp.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed.version !== 1 || !Array.isArray(parsed.rules)) continue;
      const rules = [];
      for (const rule of parsed.rules) {
        if (
          rule &&
          typeof rule.domain === "string" &&
          typeof rule.pattern === "string" &&
          (rule.source === "html" || rule.source === "url")
        ) {
          rules.push({
            domain: rule.domain,
            source: rule.source,
            pattern: rule.pattern,
          });
        }
      }
      // One-time migration: seed the Dive rules file from the pi one.
      if (filePath === LEGACY_RULES_FILE_PATH && rules.length > 0) {
        await saveRulesFile({ version: 1, rules }).catch(() => undefined);
      }
      return { version: 1, rules };
    } catch {
      /* try next location */
    }
  }
  return { version: 1, rules: [] };
}

async function saveRulesFile(file) {
  await fsp.writeFile(
    RULES_FILE_PATH,
    `${JSON.stringify(file, null, 2)}\n`,
    "utf8",
  );
}

function matchesDomain(url, domain) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const normalizedDomain = String(domain || "")
      .trim()
      .toLowerCase();
    if (!normalizedDomain) return false;
    return (
      hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)
    );
  } catch {
    return false;
  }
}

function extractDateFromCustomRules(url, html, rules) {
  for (const rule of rules) {
    if (!matchesDomain(url, rule.domain)) continue;
    const sourceText = rule.source === "url" ? url : html;
    if (!sourceText) continue;
    const extracted = tryExtractWithRegex(sourceText, rule.pattern);
    if (extracted) return extracted;
  }
  return undefined;
}

function extractDateFromSegment(segment) {
  const contentMatch = segment.match(/content="(\d{4}-\d{2}-\d{2})T[^"]*"/i);
  if (contentMatch) {
    const formatted = normalizeIsoDate(contentMatch[1]);
    if (formatted) return formatted;
  }
  const titleMatch = segment.match(
    /title="(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})"/i,
  );
  if (!titleMatch) return undefined;
  const month = monthNameToNumber(titleMatch[2]);
  if (!month) return undefined;
  return `${titleMatch[3]}.${month}.${titleMatch[1].padStart(2, "0")}`;
}

function extractBbcBroadcastDate(html) {
  // JSON-LD datePublished is the original broadcast date and agrees with BBC's
  // first_broadcast_date. Prefer it: the "Last on" block reports the most recent
  // repeat, and the bare scan after it can land on an availability expiry.
  const published = /"datePublished"\s*:\s*"(\d{4})-(\d{2})-(\d{2})/.exec(html);
  if (published) return `${published[1]}.${published[2]}.${published[3]}`;
  const lastOnBlockMatch = html.match(
    /<h2>\s*Last on\s*<\/h2>[\s\S]{0,12000}/i,
  );
  if (lastOnBlockMatch) {
    const inLastOn = extractDateFromSegment(lastOnBlockMatch[0]);
    if (inLastOn) return inLastOn;
  }
  return extractDateFromSegment(html);
}

function extractRtveEmissionDateFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\/(\d{2})-(\d{2})-(\d{2})\/?$/);
    if (!match) return undefined;
    const year = Number.parseInt(match[3], 10);
    const fullYear = year >= 70 ? 1900 + year : 2000 + year;
    return `${String(fullYear).padStart(4, "0")}.${match[2]}.${match[1]}`;
  } catch {
    return undefined;
  }
}

function extractRtveEmissionDate(html) {
  const emissionJsonMatch = html.match(/"emission":"(\d{2}\/\d{2}\/\d{4})"/i);
  if (emissionJsonMatch) {
    const normalized = normalizeSlashDate(emissionJsonMatch[1]);
    if (normalized) return normalized;
  }
  const datemiMatch = html.match(/class="datemi"[^>]*>(\d{2}\/\d{2}\/\d{4})</i);
  if (datemiMatch) {
    const normalized = normalizeSlashDate(datemiMatch[1]);
    if (normalized) return normalized;
  }
  const ariaLabelMatch = html.match(
    /Fecha de emisión:[^"]*(\d{2}\/\d{2}\/\d{4})/i,
  );
  if (ariaLabelMatch) {
    const normalized = normalizeSlashDate(ariaLabelMatch[1]);
    if (normalized) return normalized;
  }
  return undefined;
}

async function ensureWritableDirectory(dirPath) {
  try {
    await fsp.access(dirPath, fs.constants.F_OK);
    await fsp.access(dirPath, fs.constants.W_OK);
    return { ok: true };
  } catch {
    try {
      await fsp.mkdir(dirPath, { recursive: true });
      await fsp.access(dirPath, fs.constants.W_OK);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to access destination folder",
      };
    }
  }
}

async function pathExists(target) {
  try {
    await fsp.access(target, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHome(value) {
  const trimmed = String(value || "").trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/"))
    return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

function selectDestinationPath(destinationPath) {
  if (destinationPath && String(destinationPath).trim().length > 0) {
    return { path: expandHome(destinationPath), source: "custom" };
  }
  return { path: path.join(os.homedir(), "Downloads"), source: "default" };
}

function buildOutputTemplate(destinationPath) {
  return path.join(
    destinationPath,
    "%(release_date>%Y.%m.%d,upload_date>%Y.%m.%d,release_timestamp>%Y.%m.%d,timestamp>%Y.%m.%d|UnknownDate)s — %(title)s.%(ext)s",
  );
}

function buildOutputTemplateWithFixedDate(destinationPath, date) {
  return path.join(destinationPath, `${date} — %(title)s.%(ext)s`);
}

function buildJobs(options) {
  const {
    mode,
    audioFormat,
    videoContainer,
    playlistMode,
    overwriteMode,
    outputTemplate,
    destinationPath,
    urls,
    dateOverrides,
    cookiesFromBrowser,
    cookiesProfile,
    cookiesFile,
    continueOnErrors,
    playlistItems,
    sleepRequests,
    compatibilityProfile,
  } = options;
  const urlsWithOverride = urls.filter((url) => dateOverrides.has(url));
  const urlsWithoutOverride = urls.filter((url) => !dateOverrides.has(url));

  const sharedArgs = [];
  const ffmpegBinary = resolveBinary("ffmpeg");
  if (path.isAbsolute(ffmpegBinary)) {
    sharedArgs.push("--ffmpeg-location", path.dirname(ffmpegBinary));
  }
  if (mode === "audio") {
    sharedArgs.push(
      "-x",
      "--audio-quality",
      "0",
      "--audio-format",
      audioFormat ?? "best",
    );
  } else if (compatibilityProfile === "mac-lg-tv") {
    sharedArgs.push(
      "-f",
      "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best",
      "--merge-output-format",
      "mp4",
    );
  } else {
    sharedArgs.push(
      "-f",
      "bv*+ba/b",
      "--merge-output-format",
      videoContainer ?? "mkv",
    );
  }
  if (overwriteMode === "skip") sharedArgs.push("--no-overwrites");
  else sharedArgs.push("--force-overwrites");
  if (continueOnErrors) sharedArgs.push("--ignore-errors");
  if (playlistItems && playlistItems.trim()) {
    sharedArgs.push("--playlist-items", playlistItems.trim());
  }
  if (
    typeof sleepRequests === "number" &&
    Number.isFinite(sleepRequests) &&
    sleepRequests > 0
  ) {
    sharedArgs.push("--sleep-requests", String(sleepRequests));
  }
  if (cookiesFile && cookiesFile.trim()) {
    sharedArgs.push("--cookies", cookiesFile.trim());
  } else if (cookiesFromBrowser && cookiesFromBrowser !== "none") {
    const cookieSource =
      cookiesProfile && cookiesProfile.trim()
        ? `${cookiesFromBrowser}:${cookiesProfile.trim()}`
        : cookiesFromBrowser;
    sharedArgs.push("--cookies-from-browser", cookieSource);
  }

  const jobs = [];
  if (urlsWithoutOverride.length > 0) {
    const playlistUrls = urlsWithoutOverride.filter(isLikelyPlaylistUrl);
    const singleUrls = urlsWithoutOverride.filter(
      (url) => !isLikelyPlaylistUrl(url),
    );
    const mixed = playlistUrls.length > 0 && singleUrls.length > 0;
    if (!mixed) {
      const allArePlaylistLike =
        playlistUrls.length === urlsWithoutOverride.length;
      const playlistFlag =
        allArePlaylistLike && playlistMode === "playlist"
          ? "--yes-playlist"
          : "--no-playlist";
      jobs.push({
        label: allArePlaylistLike ? "playlist URLs" : "single URLs",
        urls: urlsWithoutOverride,
        args: [
          ...sharedArgs,
          "--output",
          outputTemplate,
          playlistFlag,
          ...urlsWithoutOverride,
        ],
      });
    } else {
      if (singleUrls.length > 0) {
        jobs.push({
          label: "single URLs",
          urls: singleUrls,
          args: [
            ...sharedArgs,
            "--output",
            outputTemplate,
            "--no-playlist",
            ...singleUrls,
          ],
        });
      }
      if (playlistUrls.length > 0) {
        const playlistFlag =
          playlistMode === "playlist" ? "--yes-playlist" : "--no-playlist";
        jobs.push({
          label: "playlist-like URLs",
          urls: playlistUrls,
          args: [
            ...sharedArgs,
            "--output",
            outputTemplate,
            playlistFlag,
            ...playlistUrls,
          ],
        });
      }
    }
  }
  for (const url of urlsWithOverride) {
    const forcedDate = dateOverrides.get(url);
    if (!forcedDate) continue;
    const playlistFlag =
      isLikelyPlaylistUrl(url) && playlistMode === "playlist"
        ? "--yes-playlist"
        : "--no-playlist";
    const overrideLabel = isBbcProgrammesUrl(url)
      ? "BBC URL (page date fallback)"
      : isRtveAudioUrl(url)
        ? "RTVE URL (date fallback)"
        : "Custom-rule URL (date override)";
    jobs.push({
      label: overrideLabel,
      urls: [url],
      args: [
        ...sharedArgs,
        "--output",
        buildOutputTemplateWithFixedDate(destinationPath, forcedDate),
        playlistFlag,
        url,
      ],
    });
  }
  return jobs;
}

function extractAuthHint(stderr, stdout) {
  const combined = `${stderr}\n${stdout}`.toLowerCase();
  if (
    combined.includes("sign in to confirm your age") ||
    combined.includes("age-restricted") ||
    combined.includes("this video is private") ||
    combined.includes("cookies") ||
    combined.includes("captcha") ||
    combined.includes("blocked it from display") ||
    combined.includes("not a bot")
  ) {
    return "This looks authentication/captcha-related. Retry with cookiesFromBrowser set to a browser where the site is logged in and the videos play. If a rightsholder blocks playback even in the browser, cookies will not bypass that restriction.";
  }
  return undefined;
}

function summarizeDownloadResults(results, destinationPath) {
  const successful = results.filter((result) => result.code === 0).length;
  const failed = results.length - successful;
  const lines = [
    `Download completed. Success: ${successful}/${results.length}, Failed: ${failed}/${results.length}`,
    `Output folder: ${destinationPath}`,
  ];
  for (const result of results) {
    lines.push("");
    lines.push(`Job: ${result.label}`);
    lines.push(`URLs: ${result.urlCount}`);
    lines.push(`Exit code: ${result.code}`);
    if (result.code !== 0) {
      const hint = extractAuthHint(result.stderr, result.stdout);
      if (hint) lines.push(`Hint: ${hint}`);
      if (result.stderr.trim().length > 0) {
        lines.push(`stderr:\n${result.stderr.trim().slice(0, 4000)}`);
      } else if (result.stdout.trim().length > 0) {
        lines.push(`stdout:\n${result.stdout.trim().slice(0, 4000)}`);
      }
    }
  }
  return lines.join("\n");
}

async function downloadMedia(args) {
  const urls = await resolveBbcProgrammeUrls(dedupeUrls(args.urls));
  if (urls.length === 0) return "Error: no valid URLs were provided.";

  const mode = resolveMediaMode(args);
  if (!mode) {
    return ambiguousMediaModeMessage(dedupeUrls(args.urls));
  }
  const compatibilityProfile =
    args.compatibilityProfile === "source" ||
    args.compatibilityProfile === "mac-lg-tv"
      ? args.compatibilityProfile
      : mode === "video"
        ? "mac-lg-tv"
        : "source";
  const AUDIO_FORMATS = [
    "best",
    "aac",
    "alac",
    "flac",
    "m4a",
    "mp3",
    "opus",
    "vorbis",
    "wav",
  ];
  const VIDEO_CONTAINERS = ["mkv", "mp4", "webm", "mov"];
  const requestedAudioFormat =
    mode === "audio" && AUDIO_FORMATS.includes(args.audioFormat)
      ? args.audioFormat
      : "";
  // Dive has no mid-execution prompt, so a re-encode cannot be confirmed in
  // place. Refuse instead: the model relays this, the user decides, and only
  // then is confirmAudioConversion set. "best" copies the source stream and
  // needs no confirmation, so the ordinary path is unaffected.
  if (
    requestedAudioFormat &&
    requestedAudioFormat !== "best" &&
    args.confirmAudioConversion !== true
  ) {
    return lossyAudioConversionRefusal(requestedAudioFormat);
  }
  const audioFormat =
    mode === "audio" ? requestedAudioFormat || "best" : undefined;
  const videoContainer =
    mode === "video"
      ? compatibilityProfile === "mac-lg-tv"
        ? "mp4"
        : VIDEO_CONTAINERS.includes(args.videoContainer)
          ? args.videoContainer
          : "mkv"
      : undefined;
  const playlistMode = args.playlistMode === "playlist" ? "playlist" : "single";
  const overwriteMode =
    args.overwriteMode === "overwrite" ? "overwrite" : "skip";
  const continueOnErrors =
    typeof args.continueOnErrors === "boolean"
      ? args.continueOnErrors
      : playlistMode === "playlist";
  const cookiesProfile = args.cookiesProfile
    ? String(args.cookiesProfile).trim()
    : undefined;
  const cookiesFile = args.cookiesFile
    ? expandHome(args.cookiesFile)
    : undefined;
  const cookiesFromBrowser = [
    "none",
    "safari",
    "chrome",
    "chromium",
    "firefox",
    "edge",
    "brave",
    "vivaldi",
  ].includes(args.cookiesFromBrowser)
    ? args.cookiesFromBrowser
    : "none";
  const playlistItems = args.playlistItems
    ? String(args.playlistItems).trim()
    : undefined;
  const sleepRequests =
    Number(args.sleepRequests) > 0 ? Number(args.sleepRequests) : undefined;

  const destinationSelection = selectDestinationPath(args.destinationPath);
  if (!path.isAbsolute(destinationSelection.path)) {
    return `Error: destination path must be absolute: ${destinationSelection.path}`;
  }
  if (cookiesFile && !path.isAbsolute(cookiesFile)) {
    return `Error: cookies file path must be absolute: ${cookiesFile}`;
  }
  if (cookiesFile && !(await pathExists(cookiesFile))) {
    return `Error: cookies file is not readable: ${cookiesFile}`;
  }
  const destinationCheck = await ensureWritableDirectory(
    destinationSelection.path,
  );
  if (!destinationCheck.ok) {
    return `Error: destination folder is not writable: ${destinationSelection.path}\n${destinationCheck.error}`;
  }
  const ytDlpCheck = await exec("yt-dlp", ["--version"]);
  if (ytDlpCheck.code !== 0) {
    return "Error: yt-dlp is not available (checked PATH, /opt/homebrew/bin, /usr/local/bin).";
  }
  const ffmpegCheck = await exec("ffmpeg", ["-version"]);
  if (ffmpegCheck.code !== 0) {
    return "Error: ffmpeg is not available (checked PATH, /opt/homebrew/bin, /usr/local/bin).";
  }

  const customRules = await loadRules();
  const dateOverrides = new Map();
  for (const url of urls) {
    let pageHtml;
    let shouldFetchPage = customRules.rules.some(
      (rule) => rule.source === "html" && matchesDomain(url, rule.domain),
    );
    if (isBbcProgrammesUrl(url) || isRtveAudioUrl(url)) shouldFetchPage = true;
    if (shouldFetchPage) {
      const pageResult = await exec("curl", ["-sL", "--max-time", "20", url]);
      if (pageResult.code === 0 && pageResult.stdout.trim().length > 0) {
        pageHtml = pageResult.stdout;
      }
    }
    const customDate = extractDateFromCustomRules(
      url,
      pageHtml,
      customRules.rules,
    );
    if (customDate) {
      dateOverrides.set(url, customDate);
      continue;
    }
    if (isBbcProgrammesUrl(url)) {
      if (!pageHtml) continue;
      const extractedDate = extractBbcBroadcastDate(pageHtml);
      if (extractedDate) dateOverrides.set(url, extractedDate);
      continue;
    }
    if (isRtveAudioUrl(url)) {
      if (pageHtml) {
        const extractedDate = extractRtveEmissionDate(pageHtml);
        if (extractedDate) {
          dateOverrides.set(url, extractedDate);
          continue;
        }
      }
      const extractedDateFromUrl = extractRtveEmissionDateFromUrl(url);
      if (extractedDateFromUrl) dateOverrides.set(url, extractedDateFromUrl);
    }
  }

  const outputTemplate = buildOutputTemplate(destinationSelection.path);
  const jobs = buildJobs({
    mode,
    audioFormat,
    videoContainer,
    playlistMode,
    overwriteMode,
    outputTemplate,
    destinationPath: destinationSelection.path,
    urls,
    dateOverrides,
    cookiesFromBrowser,
    cookiesProfile,
    cookiesFile,
    continueOnErrors,
    playlistItems,
    sleepRequests,
    compatibilityProfile,
  });

  const results = [];
  const downloadedUrls = [];
  for (const job of jobs) {
    const execResult = await exec("yt-dlp", job.args);
    if (execResult.code === 0) downloadedUrls.push(...job.urls);
    results.push({
      label: job.label,
      urlCount: job.urls.length,
      commandPreview: commandPreview("yt-dlp", job.args),
      code: execResult.code,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
    });
  }
  let summary = summarizeDownloadResults(results, destinationSelection.path);
  if (args.tracklist !== false && downloadedUrls.length > 0) {
    const written = await writeBbcTracklists(
      downloadedUrls,
      destinationSelection.path,
    );
    if (written.length > 0) {
      summary += `\n\nTracklists written: ${written.length}\n${written
        .map((file) => `  ${path.basename(file)}`)
        .join("\n")}`;
    }
  }
  return summary;
}

function lossyAudioConversionRefusal(format) {
  const lossy = ["mp3", "opus", "vorbis"].includes(format);
  return [
    `Refused: audioFormat="${format}" was not run.`,
    "",
    lossy
      ? `Converting to ${format} re-encodes already-lossy audio a second time and permanently degrades it.`
      : `Converting to ${format} re-encodes the audio; for a lossy source it gains no quality and produces much larger files.`,
    "Leaving audioFormat unset copies the source stream exactly, with no re-encode.",
    "",
    "Ask the user which they want. Download with audioFormat unset, or, only if",
    `the user explicitly asks for ${format}, call again with audioFormat="${format}"`,
    "and confirmAudioConversion=true.",
  ].join("\n");
}

// ---------- BBC tracklists ----------

async function fetchBbcJson(url) {
  try {
    const result = await exec("curl", [
      "-sL",
      "--max-time",
      "20",
      "-A",
      "Mozilla/5.0",
      url,
    ]);
    if (result.code !== 0 || !String(result.stdout || "").trim())
      return undefined;
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

function tracklistCell(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function tracklistTimestamp(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, "0");
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(rest).padStart(2, "0")}`;
}

// Matches the audio filename yt-dlp writes ("<date> - <brand>, <episode>"), so
// the tracklist sorts directly beside the recording it belongs to.
function bbcTracklistBasename(programme) {
  const episodeTitle = String(programme?.title || "").trim();
  if (!episodeTitle) return "";
  const brand = String(programme?.parent?.programme?.title || "").trim();
  const date = String(programme?.first_broadcast_date || "").slice(0, 10);
  const stamp = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date.replace(/-/g, ".")
    : "UnknownDate";
  const title = brand ? `${brand}, ${episodeTitle}` : episodeTitle;
  return `${stamp} \u2014 ${title}`.replace(/[/\\:*?"<>|]/g, "-").slice(0, 180);
}

function buildBbcTracklistMarkdown(programme, segmentEvents, pid) {
  const tracks = segmentEvents.filter(
    (event) => event && event.segment && event.segment.type === "music",
  );
  if (tracks.length === 0) return "";
  const brand = String(programme?.parent?.programme?.title || "").trim();
  const episodeTitle = String(programme?.title || pid).trim();
  const lines = [`# ${brand ? `${brand} \u2014 ${episodeTitle}` : episodeTitle}`, ""];
  const facts = [];
  const date = String(programme?.first_broadcast_date || "").slice(0, 10);
  if (date) facts.push(`**Broadcast** ${date}`);
  const station = programme?.ownership?.service?.title;
  if (station) facts.push(`**Station** ${tracklistCell(station)}`);
  if (facts.length > 0) lines.push(facts.join(" \u00b7 "), "");
  lines.push(
    `[Programme page](https://www.bbc.co.uk/programmes/${pid}) \u00b7 [BBC Sounds](https://www.bbc.co.uk/sounds/play/${pid})`,
    "",
    `## Tracklist (${tracks.length})`,
    "",
    "| # | Time | Artist | Track | Release | Label |",
    "|---:|---|---|---|---|---|",
  );
  tracks.forEach((event, index) => {
    const seg = event.segment || {};
    lines.push(
      `| ${event.position ?? index + 1} | ${tracklistTimestamp(event.version_offset)} | ${tracklistCell(seg.artist)} | ${tracklistCell(seg.track_title)} | ${tracklistCell(seg.release_title)} | ${tracklistCell(seg.record_label)} |`,
    );
  });
  lines.push("", "---", "", `Tracklist data from BBC programme \`${pid}\`.`, "");
  return lines.join("\n");
}

// BBC publishes the music played during a programme as structured data. Write it
// beside the audio: a recording without its tracklist loses the one thing a
// listener most often wants to look up afterwards.
async function writeBbcTracklists(urls, destinationPath) {
  const written = [];
  const pids = [];
  for (const url of urls) {
    if (!isBbcProgrammesUrl(url)) continue;
    const pid = bbcPidFromUrl(url);
    if (pid && !pids.includes(pid)) pids.push(pid);
  }
  for (const pid of pids) {
    const [meta, segments] = await Promise.all([
      fetchBbcJson(`https://www.bbc.co.uk/programmes/${pid}.json`),
      fetchBbcJson(`https://www.bbc.co.uk/programmes/${pid}/segments.json`),
    ]);
    const programme = meta?.programme;
    if (!programme) continue;
    const events = Array.isArray(segments?.segment_events)
      ? segments.segment_events
      : [];
    const markdown = buildBbcTracklistMarkdown(programme, events, pid);
    const base = bbcTracklistBasename(programme);
    if (!markdown || !base) continue;
    const target = path.join(destinationPath, `${base}.md`);
    try {
      await fsp.writeFile(target, markdown, "utf8");
      written.push(target);
    } catch {
      /* a tracklist is a bonus; never fail the download over one */
    }
  }
  return written;
}

// ---------- capabilities ----------

async function commandStatus(command, args) {
  const result = await exec(command, args);
  if (result.code !== 0) {
    return {
      available: false,
      error: (result.stderr || result.stdout || `exit code ${result.code}`)
        .trim()
        .slice(0, 500),
    };
  }
  const version = (result.stdout || result.stderr).trim().split("\n")[0].trim();
  return { available: true, version };
}

async function findApplicationBundle(appName) {
  const candidates = [
    path.join("/Applications", `${appName}.app`),
    path.join(os.homedir(), "Applications", `${appName}.app`),
    path.join("/System/Applications", `${appName}.app`),
  ];
  for (const candidate of candidates) {
    try {
      const candidateStat = await fsp.stat(candidate);
      if (candidateStat.isDirectory()) return candidate;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

async function inspectCapabilities() {
  const [ffmpeg, ffprobe, ytDlp, handbrakeCli, handbrakeApp, losslessCutApp] =
    await Promise.all([
      commandStatus("ffmpeg", ["-version"]),
      commandStatus("ffprobe", ["-version"]),
      commandStatus("yt-dlp", ["--version"]),
      commandStatus("HandBrakeCLI", ["--version"]),
      findApplicationBundle("HandBrake"),
      findApplicationBundle("LosslessCut"),
    ]);
  return JSON.stringify(
    {
      ffmpeg,
      ffprobe,
      ytDlp,
      handbrakeCli,
      handbrakeGui: { available: Boolean(handbrakeApp), path: handbrakeApp },
      losslessCutGui: {
        available: Boolean(losslessCutApp),
        path: losslessCutApp,
      },
      recommendations: {
        downloads: ytDlp.available
          ? "download_media_with_ytdlp"
          : "install yt-dlp",
        batchTranscode: handbrakeCli.available
          ? "transcode_videos_with_ffmpeg with engine=ffmpeg or engine=handbrake"
          : "transcode_videos_with_ffmpeg with engine=ffmpeg",
        manualTrimming: losslessCutApp
          ? "edit_media_losslessly mode=open-gui"
          : "edit_media_losslessly with ffmpeg-copy trim/remux",
        macLgTvDefault: "MP4 container, H.264 video, AAC audio",
      },
    },
    null,
    2,
  );
}

// ---------- transcode ----------

function isHiddenPathSegment(target) {
  return target
    .split("/")
    .some(
      (segment) =>
        segment.length > 0 &&
        segment.startsWith(".") &&
        segment !== "." &&
        segment !== "..",
    );
}

function isVideoFile(target) {
  return (
    VIDEO_EXTENSIONS.has(path.extname(target).toLowerCase()) &&
    !isHiddenPathSegment(target)
  );
}

async function scanVideoFiles(root, recursive) {
  const found = [];
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (recursive) found.push(...(await scanVideoFiles(fullPath, recursive)));
      continue;
    }
    if (entry.isFile() && isVideoFile(fullPath)) found.push(fullPath);
  }
  return found.sort((a, b) => a.localeCompare(b));
}

async function readAudioCodec(inputPath) {
  const result = await exec("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name",
    "-of",
    "json",
    inputPath,
  ]);
  if (result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout);
    const codec =
      parsed.streams && parsed.streams[0] && parsed.streams[0].codec_name;
    return codec ? codec.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function buildTranscodeFinalPath(inputPath, outputNaming) {
  if (outputNaming === "same-path") return inputPath;
  const currentExt = path.extname(inputPath);
  if (currentExt.toLowerCase() === ".mp4") return inputPath;
  return `${inputPath.slice(0, -currentExt.length)}.mp4`;
}

function buildTranscodeTempPath(finalPath) {
  const dir = path.dirname(finalPath);
  const ext = path.extname(finalPath) || ".mp4";
  const stem = path.basename(finalPath, ext);
  return path.join(
    dir,
    `.${stem}.dive-transcode-${Date.now()}-${randomUUID()}${ext}`,
  );
}

const TRANSCODE_PROFILE_DEFAULTS = {
  custom: {
    videoCodec: "libx265",
    crf: 23,
    preset: "medium",
    audioMode: "copy-ac3-else-aac",
    audioBitrate: "320k",
    audioChannels: 2,
  },
  "mac-lg-tv-h264": {
    videoCodec: "libx264",
    crf: 18,
    preset: "slow",
    audioMode: "aac",
    audioBitrate: "320k",
    audioChannels: 2,
  },
  "lg-tv-hevc": {
    videoCodec: "libx265",
    crf: 22,
    preset: "medium",
    audioMode: "copy-ac3-else-aac",
    audioBitrate: "320k",
    audioChannels: 2,
  },
  "hevc-archive": {
    videoCodec: "libx265",
    crf: 23,
    preset: "medium",
    audioMode: "copy-ac3-else-aac",
    audioBitrate: "320k",
    audioChannels: 2,
  },
  "handbrake-fast-1080p30": {
    videoCodec: "libx264",
    crf: 20,
    preset: "medium",
    audioMode: "aac",
    audioBitrate: "320k",
    audioChannels: 2,
    handbrakePreset: "Fast 1080p30",
  },
  "handbrake-hq-1080p30": {
    videoCodec: "libx264",
    crf: 18,
    preset: "slow",
    audioMode: "aac",
    audioBitrate: "320k",
    audioChannels: 2,
    handbrakePreset: "HQ 1080p30 Surround",
  },
  "handbrake-hq-2160p60-4k-hevc": {
    videoCodec: "libx265",
    crf: 22,
    preset: "medium",
    audioMode: "copy-ac3-else-aac",
    audioBitrate: "320k",
    audioChannels: 2,
    handbrakePreset: "H.265 MKV 2160p60 4K",
  },
  "handbrake-apple-compatible": {
    videoCodec: "libx264",
    crf: 20,
    preset: "medium",
    audioMode: "aac",
    audioBitrate: "320k",
    audioChannels: 2,
    handbrakePreset: "Apple 1080p30 Surround",
  },
  "handbrake-lg-tv-compatible": {
    videoCodec: "libx264",
    crf: 18,
    preset: "slow",
    audioMode: "aac",
    audioBitrate: "320k",
    audioChannels: 2,
    handbrakePreset: "HQ 1080p30 Surround",
  },
};

function resolveTranscodeSettings(params) {
  const profile = TRANSCODE_PROFILE_DEFAULTS[params.profile]
    ? params.profile
    : "custom";
  const requestedEngine = ["auto", "ffmpeg", "handbrake"].includes(
    params.engine,
  )
    ? params.engine
    : "auto";
  const engine =
    requestedEngine === "auto"
      ? profile.startsWith("handbrake-")
        ? "handbrake"
        : "ffmpeg"
      : requestedEngine;
  const defaults = TRANSCODE_PROFILE_DEFAULTS[profile];
  return {
    engine,
    profile,
    videoCodec: ["libx265", "libx264", "copy"].includes(params.videoCodec)
      ? params.videoCodec
      : defaults.videoCodec,
    crf:
      typeof params.crf === "number" && params.crf >= 0 && params.crf <= 51
        ? params.crf
        : defaults.crf,
    preset: (params.preset && String(params.preset).trim()) || defaults.preset,
    audioMode: ["copy-ac3-else-aac", "aac", "copy"].includes(params.audioMode)
      ? params.audioMode
      : defaults.audioMode,
    audioBitrate:
      (params.audioBitrate && String(params.audioBitrate).trim()) ||
      defaults.audioBitrate,
    audioChannels:
      typeof params.audioChannels === "number" &&
      params.audioChannels >= 1 &&
      params.audioChannels <= 8
        ? params.audioChannels
        : defaults.audioChannels,
    handbrakePreset:
      (params.handbrakePreset && String(params.handbrakePreset).trim()) ||
      defaults.handbrakePreset,
  };
}

function buildTranscodeArgs(options) {
  const args = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    options.inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
  ];
  if (options.videoCodec === "copy") {
    args.push("-c:v", "copy");
  } else {
    args.push(
      "-c:v",
      options.videoCodec,
      "-crf",
      String(options.crf),
      "-preset",
      options.preset,
    );
  }
  let audioAction = "none";
  if (options.audioCodec) {
    if (
      options.audioMode === "copy" ||
      (options.audioMode === "copy-ac3-else-aac" &&
        options.audioCodec === "ac3")
    ) {
      audioAction = "copy";
      args.push("-c:a", "copy");
    } else {
      audioAction = "aac";
      args.push(
        "-c:a",
        "aac",
        "-b:a",
        options.audioBitrate,
        "-ac",
        String(options.audioChannels),
      );
    }
  }
  args.push("-movflags", "+faststart", options.tempPath);
  return { args, audioAction };
}

function buildHandBrakeArgs(options) {
  return [
    "--input",
    options.inputPath,
    "--output",
    options.tempPath,
    "--preset",
    options.preset,
  ];
}

function summarizeTranscodePlan(options) {
  const lines = [];
  lines.push(`Roots: ${options.roots.join(", ")}`);
  lines.push(`Files found: ${options.fileCount}`);
  lines.push(`Recursive: ${options.recursive ? "yes" : "no"}`);
  lines.push(`Dry run: ${options.dryRun ? "yes" : "no"}`);
  lines.push(`Replace originals: ${options.replaceOriginals ? "yes" : "no"}`);
  lines.push(`Output naming: ${options.outputNaming}`);
  lines.push(`Engine: ${options.engine}`);
  lines.push(`Profile: ${options.profile}`);
  if (options.engine === "handbrake") {
    lines.push(`HandBrake preset: ${options.handbrakePreset ?? "not set"}`);
  } else {
    lines.push(
      options.videoCodec === "copy"
        ? "Video: copy original stream"
        : `Video: ${options.videoCodec} CRF ${options.crf}, preset ${options.preset}, original resolution`,
    );
    lines.push(
      `Audio: ${options.audioMode}${options.audioMode === "aac" || options.audioMode === "copy-ac3-else-aac" ? ` (${options.audioBitrate}, ${options.audioChannels} ch when converted)` : ""}`,
    );
  }
  lines.push("");
  lines.push("Preview commands:");
  for (const item of options.previewItems.slice(0, 8)) {
    lines.push(`- ${item.inputPath}`);
    lines.push(`  final: ${item.finalPath}`);
    lines.push(`  audio: ${item.audioCodec ?? "none"} -> ${item.audioAction}`);
    if (item.handbrakePreset)
      lines.push(`  HandBrake preset: ${item.handbrakePreset}`);
    lines.push(`  ${commandPreview(item.command, item.args)}`);
  }
  if (options.fileCount > options.previewItems.length) {
    lines.push(
      `... ${options.fileCount - options.previewItems.length} more file(s)`,
    );
  }
  return lines.join("\n");
}

async function transcodeVideos(params) {
  const roots = [
    ...new Set(
      (params.roots || []).map((root) => expandHome(root)).filter(Boolean),
    ),
  ];
  if (roots.length === 0) return "Error: no root folders were provided.";
  for (const root of roots) {
    if (!path.isAbsolute(root))
      return `Error: root folder must be absolute: ${root}`;
    try {
      const rootStat = await fsp.stat(root);
      if (!rootStat.isDirectory())
        return `Error: root path is not a folder: ${root}`;
    } catch (error) {
      return `Error: root folder is not accessible: ${root}\n${error.message || error}`;
    }
  }
  const ffmpegCheck = await exec("ffmpeg", ["-version"]);
  if (ffmpegCheck.code !== 0) return "Error: ffmpeg is not available.";
  const ffprobeCheck = await exec("ffprobe", ["-version"]);
  if (ffprobeCheck.code !== 0) return "Error: ffprobe is not available.";

  const recursive = params.recursive !== false;
  const dryRun = params.dryRun !== false;
  const replaceOriginals = params.replaceOriginals === true;
  const outputNaming = ["same-path", "mp4-extension"].includes(
    params.outputNaming,
  )
    ? params.outputNaming
    : replaceOriginals
      ? "same-path"
      : "mp4-extension";
  const settings = resolveTranscodeSettings(params);
  const {
    engine,
    profile,
    videoCodec,
    crf,
    preset,
    audioMode,
    audioBitrate,
    audioChannels,
    handbrakePreset,
  } = settings;

  if (engine === "handbrake") {
    const handbrakeCheck = await exec("HandBrakeCLI", ["--version"]);
    if (handbrakeCheck.code !== 0) {
      return "Error: HandBrakeCLI is not available. The HandBrake GUI app may be installed, but automated batch conversion requires HandBrakeCLI (brew install handbrake). Use engine=ffmpeg or a non-handbrake profile instead.";
    }
    if (!handbrakePreset) return "Error: HandBrake engine requires a preset.";
    const presetList = await exec("HandBrakeCLI", ["--preset-list"]);
    if (presetList.code !== 0) {
      return `Error: HandBrakeCLI preset list failed.\n${(presetList.stderr || presetList.stdout).trim().slice(0, 800)}`;
    }
    if (!presetList.stdout.includes(handbrakePreset)) {
      return `Error: HandBrake preset not found: ${handbrakePreset}`;
    }
  }

  const files = [];
  for (const root of roots) {
    files.push(...(await scanVideoFiles(root, recursive)));
  }
  const uniqueFiles = [...new Set(files)].sort((a, b) => a.localeCompare(b));
  if (uniqueFiles.length === 0)
    return "No video files found in the requested folders.";

  const plans = [];
  for (const inputPath of uniqueFiles) {
    const finalPath = buildTranscodeFinalPath(inputPath, outputNaming);
    const tempPath = buildTranscodeTempPath(finalPath);
    const audioCodec = await readAudioCodec(inputPath);
    if (engine === "handbrake") {
      const hbPreset = handbrakePreset ?? "Fast 1080p30";
      plans.push({
        command: "HandBrakeCLI",
        inputPath,
        finalPath,
        tempPath,
        audioCodec,
        audioAction: "aac",
        handbrakePreset: hbPreset,
        args: buildHandBrakeArgs({ inputPath, tempPath, preset: hbPreset }),
      });
    } else {
      const { args, audioAction } = buildTranscodeArgs({
        inputPath,
        tempPath,
        videoCodec,
        crf,
        preset,
        audioCodec,
        audioMode,
        audioBitrate,
        audioChannels,
      });
      plans.push({
        command: "ffmpeg",
        inputPath,
        finalPath,
        tempPath,
        audioCodec,
        audioAction,
        args,
      });
    }
  }

  const planSummary = summarizeTranscodePlan({
    roots,
    fileCount: plans.length,
    recursive,
    dryRun,
    replaceOriginals,
    outputNaming,
    engine,
    profile,
    videoCodec,
    handbrakePreset,
    crf,
    preset,
    audioMode,
    audioBitrate,
    audioChannels,
    previewItems: plans,
  });

  if (dryRun) {
    return `Dry run complete. ${plans.length} video file(s) found. To execute, call again with dryRun=false.\n\n${planSummary}`;
  }

  const results = [];
  for (const item of plans) {
    if (!replaceOriginals && (await pathExists(item.finalPath))) {
      results.push({
        ...item,
        code: 0,
        status: "skipped",
        error: `Output already exists: ${item.finalPath}`,
      });
      continue;
    }
    const execResult = await exec(item.command, item.args);
    if (execResult.code !== 0) {
      await fsp.rm(item.tempPath, { force: true });
      results.push({
        ...item,
        code: execResult.code,
        status: "failed",
        error: `${item.command} failed`,
        stderr: execResult.stderr,
        stdout: execResult.stdout,
      });
      continue;
    }
    try {
      const tempStat = await fsp.stat(item.tempPath);
      if (!tempStat.isFile() || tempStat.size <= 0) {
        await fsp.rm(item.tempPath, { force: true });
        results.push({
          ...item,
          code: 1,
          status: "failed",
          error: "Temporary output missing or empty after transcode success",
        });
        continue;
      }
      if (replaceOriginals) {
        if (item.finalPath === item.inputPath) {
          const backupPath = `${item.inputPath}.dive-original-${Date.now()}-${randomUUID()}`;
          await fsp.rename(item.inputPath, backupPath);
          try {
            await fsp.rename(item.tempPath, item.finalPath);
            await fsp.rm(backupPath, { force: true });
          } catch (error) {
            await fsp.rename(backupPath, item.inputPath).catch(() => undefined);
            await fsp.rm(item.tempPath, { force: true });
            throw error;
          }
        } else {
          const finalBackupPath = `${item.finalPath}.dive-replaced-${Date.now()}-${randomUUID()}`;
          const finalExisted = await pathExists(item.finalPath);
          if (finalExisted) await fsp.rename(item.finalPath, finalBackupPath);
          try {
            await fsp.rename(item.tempPath, item.finalPath);
            await fsp.rm(item.inputPath, { force: true });
            if (finalExisted) await fsp.rm(finalBackupPath, { force: true });
          } catch (error) {
            if (finalExisted) {
              await fsp
                .rename(finalBackupPath, item.finalPath)
                .catch(() => undefined);
            }
            await fsp.rm(item.tempPath, { force: true });
            throw error;
          }
        }
      } else {
        await fsp.rename(item.tempPath, item.finalPath);
      }
      results.push({ ...item, code: 0, status: "success" });
    } catch (error) {
      await fsp.rm(item.tempPath, { force: true });
      results.push({
        ...item,
        code: 1,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const success = results.filter(
    (result) => result.status === "success",
  ).length;
  const skipped = results.filter(
    (result) => result.status === "skipped",
  ).length;
  const failed = results.filter((result) => result.status === "failed").length;
  const lines = [
    `Transcode complete. Success: ${success}, Skipped: ${skipped}, Failed: ${failed}, Total: ${results.length}`,
  ];
  for (const result of results
    .filter((item) => item.status !== "success")
    .slice(0, 12)) {
    lines.push("");
    lines.push(`${result.status.toUpperCase()}: ${result.inputPath}`);
    lines.push(`Final: ${result.finalPath}`);
    if (result.error) lines.push(`Error: ${result.error}`);
    if (result.stderr && result.stderr.trim()) {
      lines.push(`stderr:\n${result.stderr.trim().slice(0, 2000)}`);
    }
  }
  return lines.join("\n");
}

// ---------- lossless edit ----------

function defaultLosslessOutputPath(inputPath, mode, container) {
  const inputExt = path.extname(inputPath);
  const stem = inputExt ? inputPath.slice(0, -inputExt.length) : inputPath;
  const suffix =
    mode === "trim"
      ? "trim"
      : mode === "extract-audio"
        ? "audio"
        : mode === "remove-audio"
          ? "no-audio"
          : "remux";
  return `${stem}.${suffix}.${container}`;
}

function buildLosslessEditArgs(options) {
  const overwriteArgs = options.replaceOutput ? ["-y"] : ["-n"];
  switch (options.mode) {
    case "trim": {
      const args = ["-hide_banner", "-nostdin", ...overwriteArgs];
      if (options.start) args.push("-ss", options.start);
      if (options.end) args.push("-to", options.end);
      args.push(
        "-i",
        options.inputPath,
        "-map",
        "0",
        "-c",
        "copy",
        options.outputPath,
      );
      return args;
    }
    case "extract-audio":
      return [
        "-hide_banner",
        "-nostdin",
        ...overwriteArgs,
        "-i",
        options.inputPath,
        "-vn",
        "-map",
        "0:a:0",
        "-c:a",
        "copy",
        options.outputPath,
      ];
    case "remove-audio":
      return [
        "-hide_banner",
        "-nostdin",
        ...overwriteArgs,
        "-i",
        options.inputPath,
        "-map",
        "0:v:0",
        "-c:v",
        "copy",
        "-an",
        options.outputPath,
      ];
    case "remux":
    default:
      return [
        "-hide_banner",
        "-nostdin",
        ...overwriteArgs,
        "-i",
        options.inputPath,
        "-map",
        "0",
        "-c",
        "copy",
        options.outputPath,
      ];
  }
}

async function editMediaLosslessly(params) {
  const inputPath = expandHome(params.input);
  if (!path.isAbsolute(inputPath))
    return `Error: input path must be absolute: ${inputPath}`;
  if (!(await pathExists(inputPath)))
    return `Error: input file does not exist: ${inputPath}`;

  const mode = [
    "open-gui",
    "trim",
    "remux",
    "extract-audio",
    "remove-audio",
  ].includes(params.mode)
    ? params.mode
    : "open-gui";
  const engine =
    params.engine && params.engine !== "auto"
      ? params.engine
      : mode === "open-gui"
        ? "losslesscut"
        : "ffmpeg-copy";
  const dryRun = params.dryRun !== false;
  const replaceOutput = params.replaceOutput === true;

  if (engine === "losslesscut" || mode === "open-gui") {
    const appPath = await findApplicationBundle("LosslessCut");
    if (!appPath) {
      return "Error: LosslessCut.app was not found in /Applications or ~/Applications.";
    }
    const args = ["-a", "LosslessCut", inputPath];
    if (dryRun) {
      return `Dry run: would open LosslessCut. To execute, call again with dryRun=false.\n${commandPreview("open", args)}`;
    }
    const result = await exec("open", args);
    return result.code === 0
      ? `Opened in LosslessCut: ${inputPath}`
      : `Failed to open LosslessCut.\n${result.stderr || result.stdout}`;
  }

  const ffmpegCheck = await exec("ffmpeg", ["-version"]);
  if (ffmpegCheck.code !== 0) return "Error: ffmpeg is not available.";
  if (
    mode === "trim" &&
    (!(params.start || "").trim() || !(params.end || "").trim())
  ) {
    return "Error: mode=trim requires both start and end timestamps.";
  }

  const container = ["mp4", "mkv", "mov", "m4a", "aac", "mp3"].includes(
    params.container,
  )
    ? params.container
    : mode === "extract-audio"
      ? "m4a"
      : path.extname(inputPath).replace(".", "") || "mp4";
  const outputPath =
    params.output && String(params.output).trim()
      ? expandHome(params.output)
      : defaultLosslessOutputPath(inputPath, mode, container);
  if (!path.isAbsolute(outputPath))
    return `Error: output path must be absolute: ${outputPath}`;
  if (!replaceOutput && (await pathExists(outputPath))) {
    return `Error: output already exists: ${outputPath}. Pass replaceOutput=true to overwrite.`;
  }

  const args = buildLosslessEditArgs({
    mode,
    inputPath,
    outputPath,
    start: params.start ? String(params.start).trim() : undefined,
    end: params.end ? String(params.end).trim() : undefined,
    replaceOutput,
  });
  if (dryRun) {
    return `Dry run: would run lossless ${mode}. To execute, call again with dryRun=false.\n${commandPreview("ffmpeg", args)}`;
  }
  const result = await exec("ffmpeg", args);
  return result.code === 0
    ? `Lossless ${mode} complete: ${outputPath}`
    : `Lossless ${mode} failed.\n${(result.stderr || result.stdout).slice(0, 4000)}`;
}

// ---------- discovery rules ----------

async function manageMediaDiscoveryRules(params) {
  const action = ["list", "add", "remove", "test"].includes(params.action)
    ? params.action
    : "list";
  const file = await loadMediaDiscoveryRules();

  if (action === "list") {
    if (file.rules.length === 0) {
      return `No custom media discovery rules configured. Rules file: ${DISCOVERY_RULES_FILE_PATH}`;
    }
    const items = file.rules.map(
      (rule) =>
        `- ${rule.name} [${rule.domain}${rule.urlPattern ? ` ${rule.urlPattern}` : ""}] fields=${Object.keys(rule.fields).join(",")}`,
    );
    return `Custom media discovery rules (${file.rules.length}), file ${DISCOVERY_RULES_FILE_PATH}:\\n${items.join("\\n")}`;
  }

  if (action === "test") {
    const testUrl = String(params.url || "").trim();
    if (!testUrl) return "Error: action=test requires url.";
    const matching = file.rules.filter((rule) =>
      discoveryRuleMatchesUrl(testUrl, rule),
    );
    if (!matching.length)
      return `No custom discovery rules configured for ${testUrl}.`;
    const html = await fetchMediaPageHtml(testUrl, params);
    if (!html) return `Error: could not fetch page HTML from ${testUrl}.`;
    const entries = extractConfiguredMediaEntries(
      html,
      testUrl,
      matching,
      DISCOVERY_RULE_MAX_ENTRIES,
    );
    if (!entries.length) {
      return "Rules matched the URL but no media entries were extracted. Check the entryPattern and fields.";
    }
    const sample = entries
      .slice(0, 3)
      .map(
        (entry) =>
          `${entry.title || "Untitled"} → ${entry.webpage_url}${entry.direct_url ? ` [media: ${entry.direct_url}]` : ""}`,
      )
      .join("\\n");
    return `Matched ${matching.length} rule(s); extracted ${entries.length} entr${entries.length === 1 ? "y" : "ies"} from ${testUrl}:\\n${sample}`;
  }

  if (action === "remove") {
    const requested = String(params.name || params.domain || "")
      .trim()
      .toLowerCase();
    if (!requested) return "Error: action=remove requires name or domain.";
    const remaining = file.rules.filter(
      (rule) =>
        rule.name.toLowerCase() !== requested && rule.domain !== requested,
    );
    if (remaining.length === file.rules.length) {
      return `No discovery rule found for ${requested}.`;
    }
    await saveMediaDiscoveryRules(remaining);
    return `Removed ${file.rules.length - remaining.length} discovery rule(s) for ${requested}.`;
  }

  const rawRule = {
    name: String(params.name || params.domain || "").trim(),
    domain: String(params.domain || "").trim(),
    urlPattern: String(params.urlPattern || "").trim(),
    entryPattern: String(params.entryPattern || "").trim(),
    fields: params.fields,
  };
  const rule = normalizeDiscoveryRule(rawRule);
  if (!rule) {
    return "Error: action=add requires domain, entryPattern, and fields containing url/webpageUrl or mediaUrl/file. Field values are regex strings with one capture group.";
  }
  const sampleUrl = String(params.url || "").trim();
  if (sampleUrl) {
    const html = await fetchMediaPageHtml(sampleUrl, params);
    if (!html) return `Error: could not fetch page HTML from ${sampleUrl}.`;
    const sampleEntries = extractConfiguredMediaEntries(
      html,
      sampleUrl,
      [rule],
      DISCOVERY_RULE_MAX_ENTRIES,
    );
    if (!sampleEntries.length) {
      return "Error: the rule did not extract any entries from the sample URL. Rule not saved.";
    }
    const filtered = file.rules.filter((item) => item.name !== rule.name);
    filtered.push(rule);
    await saveMediaDiscoveryRules(filtered);
    return `Discovery rule saved for ${rule.name}. Sample extraction found ${sampleEntries.length} entr${sampleEntries.length === 1 ? "y" : "ies"}. Rules file: ${DISCOVERY_RULES_FILE_PATH}`;
  }
  const filtered = file.rules.filter((item) => item.name !== rule.name);
  filtered.push(rule);
  await saveMediaDiscoveryRules(filtered);
  return `Discovery rule saved for ${rule.name}. Test it with action=test and url, or pass a sample url when adding it. Rules file: ${DISCOVERY_RULES_FILE_PATH}`;
}

// ---------- date rules ----------

async function manageDateRules(params) {
  const action = ["list", "add", "remove", "test"].includes(params.action)
    ? params.action
    : "list";
  const file = await loadRules();

  if (action === "list") {
    if (file.rules.length === 0) {
      return `No custom date rules configured. Rules file: ${RULES_FILE_PATH}`;
    }
    const items = file.rules.map(
      (rule) => `- ${rule.domain} [${rule.source}] :: ${rule.pattern}`,
    );
    return `Custom date rules (${file.rules.length}), file ${RULES_FILE_PATH}:\n${items.join("\n")}`;
  }

  if (action === "test") {
    const testUrl = String(params.url || "").trim();
    if (!testUrl) return "Error: action=test requires url.";
    const matchingRules = file.rules.filter((rule) =>
      matchesDomain(testUrl, rule.domain),
    );
    if (matchingRules.length === 0)
      return `No custom rules configured for ${testUrl}.`;
    let html;
    if (matchingRules.some((rule) => rule.source === "html")) {
      const page = await exec("curl", ["-sL", "--max-time", "20", testUrl]);
      if (page.code === 0 && page.stdout.trim().length > 0) html = page.stdout;
    }
    for (const rule of matchingRules) {
      const sourceText = rule.source === "url" ? testUrl : html;
      if (!sourceText) continue;
      const extracted = tryExtractWithRegex(sourceText, rule.pattern);
      if (extracted)
        return `Matched ${rule.domain} (${rule.source}) → ${extracted}`;
    }
    return "Rules matched the domain but no valid date was extracted.";
  }

  if (action === "remove") {
    const domain = String(params.domain || "").trim();
    if (!domain) return "Error: action=remove requires domain.";
    const remaining = file.rules.filter((rule) => rule.domain !== domain);
    if (remaining.length === file.rules.length) {
      return `No rules found for domain: ${domain}`;
    }
    await saveRulesFile({ version: 1, rules: remaining });
    return `Removed ${file.rules.length - remaining.length} rule(s) for ${domain}.`;
  }

  // action === "add"
  const domain = String(params.domain || "").trim();
  if (!domain)
    return "Error: action=add requires domain (e.g. example.com, no https://).";
  const source = params.source === "url" ? "url" : "html";
  let pattern = String(params.pattern || "").trim();
  const sampleUrl = String(params.url || "").trim();

  let sourceText;
  if (sampleUrl) {
    if (source === "html") {
      const page = await exec("curl", ["-sL", "--max-time", "20", sampleUrl]);
      if (page.code !== 0 || page.stdout.trim().length === 0) {
        return `Error: could not fetch page HTML from ${sampleUrl}.`;
      }
      sourceText = page.stdout;
    } else {
      sourceText = sampleUrl;
    }
  }

  if (!pattern) {
    if (!sourceText) {
      return "Error: action=add needs either pattern (a regex with one capture group) or url (a sample page to auto-detect a date pattern from).";
    }
    const candidates = makeRuleCandidates(source, sourceText);
    if (candidates.length === 0) {
      return `No date pattern auto-detected on the sample ${source === "html" ? "page" : "URL"}. Provide an explicit regex via pattern.`;
    }
    if (candidates.length > 1) {
      const list = candidates
        .map((c, i) => `${i + 1}. ${c.label}: ${c.pattern} → ${c.value}`)
        .join("\n");
      return `Multiple date patterns detected — ask the user which one to save, then call again with the chosen pattern:\n${list}`;
    }
    pattern = candidates[0].pattern;
  } else if (sourceText) {
    const extracted = tryExtractWithRegex(sourceText, pattern);
    if (!extracted) {
      return "Error: the provided regex did not extract a valid date from the sample. Rule not saved.";
    }
  }

  const filtered = file.rules.filter(
    (rule) => !(rule.domain === domain && rule.source === source),
  );
  filtered.push({ domain, source, pattern });
  await saveRulesFile({ version: 1, rules: filtered });
  const preview = sourceText
    ? tryExtractWithRegex(sourceText, pattern)
    : undefined;
  return `Rule saved for ${domain} [${source}] :: ${pattern}${preview ? ` (sample date: ${preview})` : ""}. Output format is always YYYY.MM.DD.`;
}

module.exports = {
  name: "media-tools",
  description:
    "yt-dlp downloads, selectable playlist previews, generic and configurable media discovery, FFmpeg/HandBrake transcodes, lossless edits, date rules.",
  version: "1.3.1",
  skills: [
    {
      name: "download_media_with_ytdlp",
      description:
        "Downloads audio or video from URLs (YouTube, podcasts, BBC, RTVE, and hundreds of other sites) using yt-dlp + ffmpeg. Use for media download requests instead of shell commands. Pass all user URLs in one call. Mode is optional: use audio for podcasts, radio, BBC Sounds, BBC radio programmes, and RTVE /play/audios URLs; use video only when the user explicitly requests video or TV content. If a URL could contain either audio or video and the user has not specified which, ask the user before calling this tool; never guess. When a URL is a playlist, series, collection, podcast feed, or list-like page, the tool first shows a structured selectable preview and downloads only entries explicitly selected in Dive; discovery never downloads media. It tries yt-dlp first, then safe generic HTML/JSON-LD/RSS extraction, then any matching local discovery rule. Set preview=true to force a preview for a list URL whose shape is not recognized automatically. playlistMode retains its ordinary yt-dlp meaning for direct calls. Filenames are automatically prefixed with the release date. destinationPath accepts ~/ paths; defaults to ~/Downloads. Video defaults to the mac-lg-tv profile (MP4/H.264/AAC); use compatibilityProfile='source' only when the user wants best source quality over compatibility. Never pre-create the destination folder; the tool does it. Use manage_media_discovery_rules (or /mediarules) to add a declarative site rule when generic extraction needs help.",
      parameters: {
        type: "object",
        properties: {
          urls: {
            type: "array",
            items: { type: "string" },
            description: "One or more media URLs to download",
          },
          mode: {
            type: "string",
            enum: ["audio", "video"],
            description:
              "Optional download mode. Use audio for podcasts, radio, BBC Sounds, BBC radio programmes, and RTVE /play/audios URLs; use video only when the user explicitly requests video or TV content. If the URL could contain either audio or video and the user has not specified which, ask before calling the tool; do not guess.",
          },
          destinationPath: {
            type: "string",
            description: "Destination folder. Omit for ~/Downloads",
          },
          audioFormat: {
            type: "string",
            enum: [
              "best",
              "aac",
              "alac",
              "flac",
              "m4a",
              "mp3",
              "opus",
              "vorbis",
              "wav",
            ],
            description:
              "Audio extension when mode=audio. Do NOT set this unless the user named a format themselves. Leaving it unset copies the source audio with no re-encode, which is what almost every request wants; mp3, opus and vorbis re-encode already-lossy audio a second time and permanently degrade it. Any value other than best is refused unless confirmAudioConversion is also true.",
          },
          confirmAudioConversion: {
            type: "boolean",
            description:
              "Set true ONLY after the user has explicitly asked for the non-default audioFormat, having been told it re-encodes. Never set this on your own initiative.",
          },
          tracklist: {
            type: "boolean",
            description:
              "Write a Markdown tracklist beside each downloaded BBC programme that publishes one. Defaults to true; set false only if the user asks for no tracklist.",
          },
          videoContainer: {
            type: "string",
            enum: ["mkv", "mp4", "webm", "mov"],
            description:
              "Video container when mode=video and compatibilityProfile=source (default mkv)",
          },
          playlistMode: {
            type: "string",
            enum: ["single", "playlist"],
            description:
              "How to handle playlist URLs during an ordinary download (default single)",
          },
          preview: {
            type: "boolean",
            description:
              "Show a structured selectable preview before downloading; list-like URLs are previewed automatically",
          },
          previewId: {
            type: "string",
            description:
              "Opaque media preview ID returned by the structured preview; use with selectedIndices for the download step",
          },
          selectedIndices: {
            type: "array",
            items: { type: "integer", minimum: 1 },
            description:
              "Explicit 1-based preview entry indices to download; an empty array cancels",
          },
          entryUrls: {
            type: "array",
            items: { type: "string" },
            description:
              "Fallback entry URLs used with selectedIndices if the preview ID is unavailable",
          },
          maxPlaylistEntries: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description:
              "Maximum entries to inspect in a structured preview (default 500)",
          },
          overwriteMode: {
            type: "string",
            enum: ["skip", "overwrite"],
            description: "Default skip",
          },
          cookiesFromBrowser: {
            type: "string",
            enum: [
              "none",
              "safari",
              "chrome",
              "chromium",
              "firefox",
              "edge",
              "brave",
              "vivaldi",
            ],
            description:
              "Load cookies from a local browser for age/login/captcha-restricted content",
          },
          cookiesProfile: {
            type: "string",
            description: "Optional browser profile name for cookiesFromBrowser",
          },
          cookiesFile: {
            type: "string",
            description: "Absolute path to a Netscape cookies.txt file",
          },
          continueOnErrors: {
            type: "boolean",
            description:
              "Continue playlist downloads when items fail (default true for playlists)",
          },
          playlistItems: {
            type: "string",
            description: "yt-dlp playlist item spec, e.g. '1-10' or '1,3,5'",
          },
          sleepRequests: {
            type: "number",
            description:
              "Seconds to sleep between HTTP requests (rate-limit pressure)",
          },
          compatibilityProfile: {
            type: "string",
            enum: ["source", "mac-lg-tv"],
            description: "Video profile. Default mac-lg-tv",
          },
        },
        required: ["urls"],
      },
      requiresConfirmation: true,
      timeoutMs: 45 * 60 * 1000,
      async execute(args, context) {
        return await executeDownloadMedia(args || {}, context || {});
      },
    },
    {
      name: "transcode_videos_with_ffmpeg",
      description:
        "Batch transcodes local video files with FFmpeg (or HandBrakeCLI) using safe temp-file replacement. Use for local video conversion requests, not downloads. Defaults to dryRun=true which returns the plan; call again with dryRun=false to execute. profile='mac-lg-tv-h264' is safest for Mac/LG TV playback; 'lg-tv-hevc' gives smaller files. Use replaceOriginals=true only when the user explicitly asks to replace originals.",
      parameters: {
        type: "object",
        properties: {
          roots: {
            type: "array",
            items: { type: "string" },
            description: "Folder paths to scan for video files",
          },
          recursive: {
            type: "boolean",
            description: "Scan subfolders (default true)",
          },
          dryRun: {
            type: "boolean",
            description: "Preview without transcoding (default true)",
          },
          replaceOriginals: {
            type: "boolean",
            description: "Replace originals after success (default false)",
          },
          outputNaming: {
            type: "string",
            enum: ["same-path", "mp4-extension"],
            description: "Default same-path when replacing, else mp4-extension",
          },
          engine: {
            type: "string",
            enum: ["auto", "ffmpeg", "handbrake"],
            description: "Default auto",
          },
          profile: {
            type: "string",
            enum: [
              "custom",
              "mac-lg-tv-h264",
              "lg-tv-hevc",
              "hevc-archive",
              "handbrake-fast-1080p30",
              "handbrake-hq-1080p30",
              "handbrake-hq-2160p60-4k-hevc",
              "handbrake-apple-compatible",
              "handbrake-lg-tv-compatible",
            ],
            description: "Conversion profile",
          },
          handbrakePreset: {
            type: "string",
            description: "Optional HandBrake preset name override",
          },
          videoCodec: { type: "string", enum: ["libx265", "libx264", "copy"] },
          crf: {
            type: "number",
            description: "0-51, default from profile (23 custom)",
          },
          preset: {
            type: "string",
            description: "x264/x265 preset, e.g. medium, slow",
          },
          audioMode: {
            type: "string",
            enum: ["copy-ac3-else-aac", "aac", "copy"],
          },
          audioBitrate: {
            type: "string",
            description: "AAC bitrate, default 320k",
          },
          audioChannels: {
            type: "number",
            description: "AAC channels, default 2",
          },
        },
        required: ["roots"],
      },
      requiresConfirmation: true,
      timeoutMs: 60 * 60 * 1000,
      async execute(args) {
        return await transcodeVideos(args || {});
      },
    },
    {
      name: "edit_media_losslessly",
      description:
        "Lossless media edits: trim/remux/extract-audio/remove-audio via FFmpeg stream copy (no re-encoding), or mode='open-gui' to open the file in LosslessCut for manual visual cutting. Defaults to dryRun=true (returns the command); call again with dryRun=false to execute. Lossless trim accuracy depends on keyframes; for frame-accurate cuts use transcode_videos_with_ffmpeg.",
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "Input media file path (absolute or ~/)",
          },
          mode: {
            type: "string",
            enum: [
              "open-gui",
              "trim",
              "remux",
              "extract-audio",
              "remove-audio",
            ],
          },
          engine: {
            type: "string",
            enum: ["auto", "ffmpeg-copy", "losslesscut"],
            description: "Default auto",
          },
          output: {
            type: "string",
            description: "Output path. Omit for automatic sibling naming",
          },
          start: {
            type: "string",
            description: "Trim start, e.g. 00:01:20 (required for trim)",
          },
          end: {
            type: "string",
            description: "Trim end, e.g. 00:24:00 (required for trim)",
          },
          container: {
            type: "string",
            enum: ["mp4", "mkv", "mov", "m4a", "aac", "mp3"],
            description: "Output container when output omitted",
          },
          dryRun: {
            type: "boolean",
            description: "Preview command (default true)",
          },
          replaceOutput: {
            type: "boolean",
            description: "Allow overwriting output (default false)",
          },
        },
        required: ["input", "mode"],
      },
      requiresConfirmation: true,
      timeoutMs: 15 * 60 * 1000,
      async execute(args) {
        return await editMediaLosslessly(args || {});
      },
    },
    {
      name: "inspect_media_capabilities",
      description:
        "Reports which local media tools are available (yt-dlp, ffmpeg, ffprobe, HandBrakeCLI, HandBrake GUI, LosslessCut GUI) with versions and workflow recommendations. Use before recommending HandBrake or LosslessCut workflows.",
      parameters: { type: "object", properties: {} },
      timeoutMs: 60 * 1000,
      async execute() {
        return await inspectCapabilities();
      },
    },
    {
      name: "manage_media_discovery_rules",
      description:
        "Creates and tests safe, declarative per-site media discovery rules for pages yt-dlp does not understand. Rules use a bounded entry regex plus field regexes to map episode/page URLs, direct media URLs, titles, dates, durations, thumbnails, and descriptions. Actions: list, add, remove, test. Rules are stored locally in Dive and are used automatically during structured previews.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "add", "remove", "test"] },
          name: {
            type: "string",
            description: "Stable local rule name, e.g. example-podcast",
          },
          domain: {
            type: "string",
            description: "Domain the rule applies to, e.g. example.com",
          },
          urlPattern: {
            type: "string",
            description:
              "Optional URL substring; prefix with re: for a regular expression",
          },
          entryPattern: {
            type: "string",
            description:
              "Regex matching each episode/card block; its first capture group is the block",
          },
          fields: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Regex fields with one capture group: url, webpageUrl, link, mediaUrl, file, title, date, duration, thumbnail, description, id",
          },
          url: {
            type: "string",
            description: "Sample page for add validation or the URL to test",
          },
        },
        required: ["action"],
      },
      timeoutMs: 45 * 1000,
      async execute(args) {
        return await manageMediaDiscoveryRules(args || {});
      },
    },
    {
      name: "manage_ytdlp_date_rules",
      description:
        "Manages custom per-domain date-extraction rules used to prefix downloaded media filenames with the correct release date (format YYYY.MM.DD). Actions: list; test (url); remove (domain); add (domain + source html|url + pattern regex with one capture group, or url to auto-detect a pattern from a sample page).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "add", "remove", "test"] },
          domain: {
            type: "string",
            description: "Domain the rule applies to, e.g. example.com",
          },
          source: {
            type: "string",
            enum: ["html", "url"],
            description: "Where to look for the date (default html)",
          },
          pattern: {
            type: "string",
            description: "Regex with one capture group for the date",
          },
          url: { type: "string", description: "Sample/test URL" },
        },
        required: ["action"],
      },
      timeoutMs: 30 * 1000,
      async execute(args) {
        return await manageDateRules(args || {});
      },
    },
  ],
  commands: {
    inspectmedia: "inspect_media_capabilities",
    ytdlprules: "manage_ytdlp_date_rules",
    mediarules: "manage_media_discovery_rules",
    mediadownload: "download_media_with_ytdlp",
  },
  __test: {
    isLikelyPlaylistUrl,
    isBbcProgrammePermalinkUrl,
    isBbcSoundsCollectionUrl,
    lossyAudioConversionRefusal,
    buildBbcTracklistMarkdown,
    bbcTracklistBasename,
    tracklistTimestamp,
    bbcSoundsKind,
    bbcPidFromUrl,
    bbcProgrammeUrl,
    bbcEpisodeIndexUrl,
    isPlausibleMediaEntryUrl,
    isResolvedSingleMedia,
    extractBbcBroadcastDate,
    mediaCandidateKey,
    isBbcEpisodeListUrl,
    isRtveSeriesUrl,
    isGenericMediaCollectionUrl,
    isMediaPlaylistUrl,
    shouldPreviewMediaUrls,
    isClearlyAudioMediaUrl,
    isClearlyVideoMediaUrl,
    resolveMediaMode,
    ambiguousMediaModeMessage,
    extractRtveSeriesEntries,
    extractGenericHtmlEntries,
    extractConfiguredMediaEntries,
    normalizeDiscoveryRule,
    formatMediaDuration,
    formatMediaDate,
    normalizeMediaCandidate,
    buildJobs,
  },
};
