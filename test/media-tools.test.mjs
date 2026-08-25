// Run with:  node --test test/media-tools.test.mjs
//
// These cover the pure, host-independent helpers the plugin exports on __test,
// so they run without Dive.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const {
  isMediaPlaylistUrl,
  isGenericMediaCollectionUrl,
  isBbcProgrammePermalinkUrl,
  isBbcSoundsCollectionUrl,
  bbcSoundsKind,
  bbcPidFromUrl,
  bbcProgrammeUrl,
  bbcEpisodeIndexUrl,
  isPlausibleMediaEntryUrl,
  isResolvedSingleMedia,
  extractBbcBroadcastDate,
  mediaCandidateKey,
  lossyAudioConversionRefusal,
  buildBbcTracklistMarkdown,
  bbcTracklistBasename,
  tracklistTimestamp,
} = require(join(here, "..", "index.js")).__test;

const plugin = require(join(here, "..", "index.js"));
const downloadSkill = plugin.skills.find(
  (skill) => skill.name === "download_media_with_ytdlp",
);

const EPISODE = "https://www.bbc.co.uk/programmes/m00302xq";
const SOUNDS_EPISODE = "https://www.bbc.co.uk/sounds/play/m00302xq";
const SOUNDS_BRAND = "https://www.bbc.co.uk/sounds/brand/m0008w2m";
const SOUNDS_SERIES = "https://www.bbc.co.uk/sounds/series/m0008w2m";
const EPISODE_INDEX =
  "https://www.bbc.co.uk/programmes/m0008w2m/episodes/player";

// --- routing: which URLs deserve the selectable picker -----------------------

test("single BBC episode URLs are not treated as collections", () => {
  for (const url of [EPISODE, SOUNDS_EPISODE]) {
    assert.equal(
      isGenericMediaCollectionUrl(url),
      false,
      `${url} must not look like a collection`,
    );
    assert.equal(
      isMediaPlaylistUrl(url),
      false,
      `${url} must not open the picker`,
    );
  }
});

test("BBC collection URLs still route to the picker", () => {
  for (const url of [SOUNDS_BRAND, SOUNDS_SERIES, EPISODE_INDEX]) {
    assert.equal(isMediaPlaylistUrl(url), true, `${url} should be a playlist`);
  }
});

test("ordinary collection URLs are unaffected by the BBC guard", () => {
  for (const url of [
    "https://example.test/podcasts/",
    "https://example.test/feed/",
    "https://www.youtube.com/playlist?list=abc",
    "https://example.test/archive",
  ]) {
    assert.equal(isMediaPlaylistUrl(url), true, `${url} should be a playlist`);
  }
});

test("the BBC guard does not change non-BBC classification", () => {
  // Long-standing behaviour: a generic /podcast/<slug> is treated as a show
  // page. The guard added for BBC permalinks is scoped to bbc.co.uk only.
  assert.equal(
    isMediaPlaylistUrl("https://example.test/podcast/one-episode"),
    true,
  );
  assert.equal(isMediaPlaylistUrl("https://example.test/watch/12345"), false);
});

// --- BBC URL shapes ---------------------------------------------------------

test("Sounds paths are classified by kind", () => {
  assert.equal(bbcSoundsKind(SOUNDS_EPISODE), "episode");
  assert.equal(bbcSoundsKind(SOUNDS_BRAND), "collection");
  assert.equal(bbcSoundsKind(SOUNDS_SERIES), "collection");
  assert.equal(bbcSoundsKind(EPISODE), "");
  assert.equal(bbcSoundsKind("https://example.test/sounds/play/m00302xq"), "");
  assert.equal(bbcSoundsKind("https://www.bbc.co.uk/sounds/play/nope"), "");
});

test("permalink detection accepts both programme and Sounds episode shapes", () => {
  assert.equal(isBbcProgrammePermalinkUrl(EPISODE), true);
  assert.equal(isBbcProgrammePermalinkUrl(SOUNDS_EPISODE), true);
  assert.equal(isBbcProgrammePermalinkUrl(SOUNDS_BRAND), false);
  assert.equal(isBbcProgrammePermalinkUrl(EPISODE_INDEX), false);
  assert.equal(isBbcSoundsCollectionUrl(SOUNDS_BRAND), true);
  assert.equal(isBbcSoundsCollectionUrl(SOUNDS_EPISODE), false);
});

test("pids are extracted and rewritten to the form yt-dlp accepts", () => {
  assert.equal(bbcPidFromUrl(SOUNDS_EPISODE), "m00302xq");
  assert.equal(bbcPidFromUrl(EPISODE), "m00302xq");
  assert.equal(bbcPidFromUrl("https://www.bbc.co.uk/programmes/"), "");
  assert.equal(bbcProgrammeUrl(SOUNDS_EPISODE), EPISODE);
  assert.equal(bbcEpisodeIndexUrl(SOUNDS_BRAND), EPISODE_INDEX);
  assert.equal(bbcProgrammeUrl("not a url"), "");
});

// --- scraped-entry filtering ------------------------------------------------

test("in-page anchors and site navigation are rejected as entries", () => {
  const source = EPISODE;
  // "Skip to content" resolves to the source page plus a fragment.
  assert.equal(isPlausibleMediaEntryUrl(`${EPISODE}#main-content`, source), false);
  for (const nav of [
    "https://www.bbc.co.uk/sounds/podcasts",
    "https://www.bbc.co.uk/programmes",
    "https://www.bbc.co.uk/sounds/categories",
    "https://www.bbc.co.uk/help",
  ]) {
    assert.equal(
      isPlausibleMediaEntryUrl(nav, source),
      false,
      `${nav} is navigation, not an entry`,
    );
  }
});

test("real episode links are still accepted as entries", () => {
  assert.equal(
    isPlausibleMediaEntryUrl(
      "https://www.bbc.co.uk/programmes/m003029l",
      EPISODE,
    ),
    true,
  );
  assert.equal(
    isPlausibleMediaEntryUrl(
      "https://example.test/podcast/real-episode",
      "https://example.test/podcasts/",
    ),
    true,
  );
});

test("cross-origin links are never entries", () => {
  assert.equal(
    isPlausibleMediaEntryUrl("https://elsewhere.test/episode/1", EPISODE),
    false,
  );
});

// --- trusting yt-dlp's own resolution ---------------------------------------

test("a resolved single item is recognised, a playlist is not", () => {
  assert.equal(
    isResolvedSingleMedia({ id: "x", title: "T", formats: [{ ext: "m4a" }] }),
    true,
  );
  assert.equal(isResolvedSingleMedia({ id: "x", title: "T", url: "u" }), true);
  assert.equal(
    isResolvedSingleMedia({ _type: "playlist", id: "x", title: "T", entries: [] }),
    false,
  );
  assert.equal(isResolvedSingleMedia({ entries: [{ id: "a" }] }), false);
  assert.equal(isResolvedSingleMedia({ id: "x", title: "T" }), false);
  assert.equal(isResolvedSingleMedia(null), false);
  assert.equal(isResolvedSingleMedia("nope"), false);
});

// --- BBC broadcast date -----------------------------------------------------

test("the original broadcast date wins over a repeat or an expiry", () => {
  // A real programme page carries all of these; only datePublished is the
  // original broadcast. "Last on" is the most recent repeat.
  const html = `
    <script type="application/ld+json">{"@type":"RadioEpisode","datePublished":"2026-08-17"}</script>
    <h2>Last on</h2><div><meta content="2026-09-11T22:30:00+00:00"></div>`;
  assert.equal(extractBbcBroadcastDate(html), "2026.08.17");
});

test("without datePublished the previous behaviour still applies", () => {
  const html = `<h2>Last on</h2><div><meta content="2026-09-11T22:30:00+00:00"></div>`;
  assert.equal(extractBbcBroadcastDate(html), "2026.09.11");
});

// --- candidate de-duplication -----------------------------------------------

test("http/https and trailing-slash variants collapse to one key", () => {
  const canonical = mediaCandidateKey(EPISODE);
  assert.equal(mediaCandidateKey(EPISODE.replace("https://", "http://")), canonical);
  assert.equal(mediaCandidateKey(`${EPISODE}/`), canonical);
  assert.equal(
    mediaCandidateKey("https://bbc.co.uk/programmes/m00302xq"),
    canonical,
  );
  assert.notEqual(mediaCandidateKey("https://www.bbc.co.uk/programmes/other"), canonical);
  assert.equal(mediaCandidateKey(""), "");
});

test("path words are not mistaken for programme ids", () => {
  // /^[bmpw][0-9a-z]{7,}$/i also matches "programmes" and "podcasts", so the
  // pid must be read from its position, not from the last path segment.
  assert.equal(bbcPidFromUrl("https://www.bbc.co.uk/programmes/"), "");
  assert.equal(bbcPidFromUrl("https://www.bbc.co.uk/sounds/podcasts"), "");
  assert.equal(bbcPidFromUrl("https://elsewhere.test/programmes/m00302xq"), "");
  // The last segment of an episode index is "player"; the pid sits earlier.
  assert.equal(bbcPidFromUrl(EPISODE_INDEX), "m0008w2m");
  assert.equal(bbcEpisodeIndexUrl(EPISODE_INDEX), EPISODE_INDEX);
});

// --- audio is never silently re-encoded ------------------------------------

test("a lossy audioFormat is refused rather than run", async () => {
  const out = await downloadSkill.execute(
    {
      urls: ["https://example.test/watch/12345"],
      mode: "audio",
      audioFormat: "mp3",
      // A path that must never be created, proving nothing executed.
      destinationPath: "/tmp/dive-guard-must-not-run",
    },
    { dataDir: "/tmp" },
  );
  assert.match(out, /^Refused: audioFormat="mp3" was not run\./);
  assert.match(out, /re-encodes already-lossy audio/);
  assert.match(out, /confirmAudioConversion=true/);
});

test("the refusal distinguishes lossy from lossless targets", () => {
  assert.match(lossyAudioConversionRefusal("mp3"), /already-lossy audio/);
  assert.match(lossyAudioConversionRefusal("opus"), /already-lossy audio/);
  assert.match(lossyAudioConversionRefusal("flac"), /no quality and produces much larger files|gains no quality/);
  assert.match(lossyAudioConversionRefusal("wav"), /gains no quality/);
});

test("the download skill still asks Dive to confirm before running", () => {
  assert.equal(downloadSkill.requiresConfirmation, true);
});

// --- tracklists -------------------------------------------------------------

const trackProgramme = {
  title: "Harmonious music for nighttime listening",
  first_broadcast_date: "2026-08-17T22:00:00+01:00",
  ownership: { service: { title: "BBC Radio 3" } },
  parent: { programme: { title: "Night Tracks" } },
};

const trackEvents = [
  {
    position: 1,
    version_offset: 0,
    segment: {
      type: "music",
      artist: "F.S. Blumm",
      track_title: "Di Lei",
      release_title: "Torre",
      record_label: "Leiter",
    },
  },
  {
    position: 2,
    version_offset: 3906,
    segment: { type: "music", artist: "Ola Gjeilo", track_title: "Northern Lights" },
  },
];

test("timestamps roll over into hours correctly", () => {
  assert.equal(tracklistTimestamp(0), "0:00");
  assert.equal(tracklistTimestamp(306), "5:06");
  assert.equal(tracklistTimestamp(3906), "1:05:06");
  assert.equal(tracklistTimestamp(-1), "");
  assert.equal(tracklistTimestamp("nope"), "");
});

test("the tracklist filename matches the audio filename", () => {
  assert.equal(
    bbcTracklistBasename(trackProgramme),
    "2026.08.17 \u2014 Night Tracks, Harmonious music for nighttime listening",
  );
  assert.equal(bbcTracklistBasename({ title: "" }), "");
  assert.match(bbcTracklistBasename({ title: "No date" }), /^UnknownDate/);
  // Path separators must not survive into a filename.
  assert.doesNotMatch(bbcTracklistBasename({ title: "a/b:c" }), /[/:]/);
});

test("the tracklist renders every music track and nothing else", () => {
  const md = buildBbcTracklistMarkdown(trackProgramme, trackEvents, "m00302xq");
  assert.match(md, /^# Night Tracks \u2014 Harmonious music for nighttime listening$/m);
  assert.match(md, /\*\*Broadcast\*\* 2026-08-17/);
  assert.match(md, /## Tracklist \(2\)/);
  assert.match(md, /\| 1 \| 0:00 \| F\.S\. Blumm \| Di Lei \| Torre \| Leiter \|/);
  assert.match(md, /\| 2 \| 1:05:06 \| Ola Gjeilo \| Northern Lights \|/);
});

test("a programme with no music produces no file at all", () => {
  assert.equal(
    buildBbcTracklistMarkdown(trackProgramme, [{ segment: { type: "speech" } }], "x"),
    "",
  );
  assert.equal(buildBbcTracklistMarkdown(trackProgramme, [], "x"), "");
});
