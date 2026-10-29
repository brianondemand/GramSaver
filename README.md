# GramSaver

A userscript that saves photos, videos, reels, stories, highlights and profile pictures from Instagram, with a download queue, ZIP output and duplicate detection.

GramSaver doesn't scrape Instagram's page layout. It reads the data Instagram's own website already loads, so it breaks far less often when Instagram changes its design.

> **Disclaimer:** GramSaver is an independent project. It is not affiliated with, endorsed by, or connected to Instagram or Meta. See [Responsible use](#responsible-use).

---

## Features

- **Posts and reels:** download the current item, every item in a carousel, or open the original file in a new tab.
- **Stories and highlights:** download one story, a user's whole story set, or a full highlight.
- **All highlights on a profile:** one click saves every highlight into its own folder.
- **Whole-profile download:** the page scrolls itself to load posts. Filter by photos/videos, date range and maximum number of posts.
- **Profile pictures:** save the HD version when available.
- **Download queue:** parallel downloads, automatic retries, pause/resume, retry failed items, and a live status panel.
- **ZIP output:** bundle a carousel or a whole profile into a single ZIP (built in, no extra library).
- **Duplicate detection:** remembers what you've already downloaded and skips it in bulk actions, so re-running a profile download picks up where you stopped.
- **Folder and filename templates:** for example `{username}/{year}{month}{day}_{shortcode}_{index}`, with a live preview.
- **Metadata sidecar:** optionally save the caption and post details as a `.json` file next to each download.
- **Smart video quality:** merges Instagram's separate high-quality video and audio streams into one MP4 when that gives a higher resolution.
- **Gentle on your account:** API requests are paced, and GramSaver backs off automatically when Instagram rate-limits.
- **Diagnostics:** one-click report for bug reports, with no usernames or URLs in it.
- **Dark mode and keyboard friendly:** follows your system theme, and buttons are focusable and labelled.

---

## Installation

1. Install a userscript manager:
   - [Tampermonkey](https://www.tampermonkey.net/) (recommended; GramSaver is developed and tested with it)
2. Open the script file in this repository, `gramsaver.user.js`, and click **Raw**. Your userscript manager will offer to install it.
3. Open [instagram.com](https://www.instagram.com/) and log in.

**Tested on:** Firefox with Tampermonkey. Chrome and Edge should work but have had less testing, so please report anything odd.

---

## Usage

### The floating button

A round button sits in the bottom-right corner of every Instagram page. Click it to see actions that fit the page you're on:

| You are on | Actions available |
|---|---|
| A post or reel | Download this item, download all items, open original, download video thumbnail |
| A story | Download this story, download all stories, open original, download thumbnail |
| A highlight | Download this item, download the whole highlight |
| A profile | Download profile picture, download profile posts, download all highlights |

A badge on the button shows how many downloads are still pending.

### Buttons on posts

In the feed, each post gets a small button column with download, download-all, open-in-new-tab and (for videos) thumbnail buttons.

### Downloading a whole profile

1. Open the profile page.
2. Floating button → **Download profile posts…**
3. Choose photos and/or videos, an optional date range, and **Max posts** (raise it to cover the whole account).
4. Click **Start** and keep the tab open. The page scrolls on its own to load posts, then everything is queued.

For very large accounts, use the date filters to work in batches. Heavy bulk loading can trigger Instagram's rate limiting.

### Downloading all highlights

1. Open the profile and wait for the highlight circles to appear.
2. Floating button → **Download all highlights**.

Files are saved under `username/highlights/<highlight name>/`.

### Hotkeys

| Key | Action |
|---|---|
| `Alt` + `S` | Download the current item |
| `Alt` + `W` | Open/close the queue and settings panel |
| `Alt` + `Q` | Close the panel |

---

## Settings

Open the panel from the floating button (**Queue & settings**) or with `Alt` + `W`.

| Setting | What it does |
|---|---|
| File/folder template | Controls file names and folders. Tokens: `{username}` `{type}` `{shortcode}` `{id}` `{index}` `{year}` `{month}` `{day}` `{hour}` `{minute}` `{second}`. Use `/` for folders. |
| Save multi-item posts as one ZIP | Bundles carousels into one archive. |
| Also save caption & metadata | Writes a `.json` file per post. |
| Skip already-downloaded items | Used by bulk actions. Clicking "Download this item" always downloads. |
| Video quality | **Auto** merges higher-resolution streams when available. **Standard** always uses the normal file. |
| Parallel downloads | 1 to 5 at once. |
| Min delay between API requests | Increase this if you see rate-limit warnings. |
| Use Tampermonkey downloader | Needed for subfolders in file names. |
| Show buttons on posts / floating button | Hide parts of the interface you don't use. |

### About folders

Browsers normally don't let scripts choose download folders. Subfolders in your template only work when Tampermonkey's download mode is set to **Browser API** (Tampermonkey → Settings → Downloads). Otherwise the folder separators are flattened into the file name. Using the ZIP option avoids the issue entirely, since folders live inside the archive.

---

## How it works

1. **Capture.** GramSaver watches the responses Instagram's website already receives (and the data embedded in the page) and converts every format into one internal structure: posts, items, stories.
2. **Resolve.** When you click a button, it looks the post up in what it has already captured. Only if the data isn't there does it call Instagram's API, and those calls are paced and retried with backoff.
3. **Download.** Files go through a queue. Optional steps: merge video and audio streams, bundle into a ZIP, write a metadata file.

Because it relies on data Instagram sends rather than on page layout, it is much less affected by Instagram's constant class-name and layout changes than selector-based scripts.

---

## Troubleshooting

**Nothing happens, or I see a rate-limit message.**
Wait a few minutes and try again. Raise "Min delay between API requests" in settings. Already-downloaded items are skipped on retry.

**"No highlights found" or "No posts were captured".**
Reload the profile page, wait until the content (highlight circles, grid) has fully appeared, scroll once manually, then try again.

**Files land in one folder with underscores in the names.**
Folders need Tampermonkey's Browser API download mode. See [About folders](#about-folders).

**Wrong story or carousel item downloaded.**
Please report it with a diagnostic report (below).

**Reporting a bug**

1. Open the panel (`Alt` + `W`) → **Help** → **Copy diagnostic report**.
2. Paste it into a new GitHub issue and describe what you did.

The report contains the script version, browser, page type, counters, your settings (template hidden) and recent log lines. It has no usernames or URLs.

---

## Known limitations

- Works only with content your logged-in account can already see. It does not and will not bypass private accounts.
- Tagged and saved posts aren't supported yet.
- Expired stories can't be downloaded.
- ZIP files are built in memory, so avoid single ZIPs above roughly 500 files.
- Instagram changes its site often. If something breaks, open an issue with a diagnostic report.
- Stories and highlights support is newer than the post and profile features. Feedback is especially welcome there.

---

## Privacy

- Everything runs locally in your browser.
- GramSaver talks only to Instagram and its media servers (`cdninstagram.com`, `fbcdn.net`), plus the jsDelivr CDN once to load the video-merging library.
- It has no analytics, no tracking and no update-check requests.
- Settings and the downloaded-items index are stored by your userscript manager, on your machine.

---

## Responsible use

Use GramSaver to save content you own, or content you have permission to keep. Downloading other people's photos and videos may be restricted by copyright law and by Instagram's Terms of Use. Respect creators' rights, and don't republish content without permission. You are responsible for how you use this tool.

Heavy automated use can also lead Instagram to limit your account temporarily. The built-in pacing helps, but please use bulk features sensibly.

---

## Credits

GramSaver was inspired by [IG Helper](https://github.com/SN-Koarashi/ig-helper) by SN-Koarashi and follows its approach to merging separate DASH video and audio streams. GramSaver is a new codebase built around a different architecture.

Video merging uses [Mediabunny](https://www.npmjs.com/package/mediabunny).

---

## License

[GPL-3.0-only](LICENSE)
