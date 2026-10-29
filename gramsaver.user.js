// ==UserScript==
// @name         GramSaver
// @namespace    https://github.com/YOUR-USERNAME/GramSaver
// @version      1.2.0
// @description  Download Instagram photos, videos, reels, stories, highlights and profile pictures. Reads Instagram's own network responses (no fragile DOM scraping), with a download queue, ZIP output, duplicate detection, adaptive API pacing and a diagnostics report.
// @match        https://www.instagram.com/*
// @grant        unsafeWindow
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      cdninstagram.com
// @connect      fbcdn.net
// @require      https://cdn.jsdelivr.net/npm/mediabunny@1.34.5/dist/bundles/mediabunny.min.cjs#sha256-wUFR+x2bDvpqgMAVGy2CvGvULyjTGvGy4UUAm8rae5U=
// @run-at       document-start
// @license      GPL-3.0-only
// ==/UserScript==

/*
 * GramSaver - Created By Brian0day
 * A ground-up rewrite inspired by "IG Helper" by SN-Koarashi (GPL-3.0).
 * The DASH parsing/muxing approach follows the original script's idea.
 *
 * Layout of this file (each section is independent, split into files if you add a build step):
 *   1. Utils            6. Resolver (store first, API fallback)
 *   2. Settings         7. Download queue, ZIP writer, DASH mux
 *   3. Diagnostics      8. Actions (what a click does)
 *   4. Normalizer+Store 9. UI: injector, floating button, panel, dialogs
 *   5. Interceptor+Api  10. Boot
 */
(function () {
    'use strict';

    const VERSION = '5.1.0';
    const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const nativeFetch = W.fetch.bind(W); // keep an untouched fetch for our own calls

    /* ==================================================================
     * 1. UTILS
     * ================================================================== */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pad = (n, l = 2) => String(n).padStart(l, '0');

    function h(tag, attrs = {}, ...kids) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === 'class') e.className = v;
            else if (k === 'value' || k === 'checked') e[k] = v;
            else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
            else e.setAttribute(k, v === true ? '' : v);
        }
        for (const c of kids.flat()) {
            if (c == null || c === false) continue;
            e.append(c.nodeType ? c : document.createTextNode(String(c)));
        }
        return e;
    }

    const ICON = {
        download: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>',
        all: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 13v8l-4-4"/><path d="m12 21 4-4"/><path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284"/></svg>',
        open: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
        thumb: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>',
        close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    };

    const baseName = (u) => { try { return new URL(u).pathname.split('/').pop(); } catch { return ''; } };
    const extOf = (url, type) => {
        try {
            const m = new URL(url).pathname.match(/\.([a-z0-9]{2,4})$/i);
            if (m) return m[1].toLowerCase();
        } catch { /* ignore */ }
        return type === 'video' ? 'mp4' : 'jpg';
    };

    /* ==================================================================
     * 2. SETTINGS
     * ================================================================== */
    const DEFAULTS = {
        template: '{username}/{year}{month}{day}_{hour}{minute}{second}_{shortcode}_{index}',
        zipMulti: false,
        sidecar: false,
        skipDuplicates: true,
        videoQuality: 'auto',
        concurrency: 2,
        minDelayMs: 400,
        useGmDownload: true,
        showFab: true,
        showPostButtons: true
    };

    const Settings = {
        data: Object.assign({}, DEFAULTS, GM_getValue('settings', {})),
        get(k) { return this.data[k]; },
        set(k, v) { this.data[k] = v; GM_setValue('settings', this.data); }
    };

    /* ==================================================================
     * 3. DIAGNOSTICS
     * ================================================================== */
    const Diag = {
        log: [],
        push(level, area, msg) {
            const clean = String(msg).replace(/https?:\/\/\S+/g, '<url>');
            this.log.push({ t: new Date().toISOString(), level, area, msg: clean });
            if (this.log.length > 300) this.log.splice(0, 100);
            if (level === 'error') console.warn('[GramSaver]', area, clean);
        },
        report() {
            const q = {};
            Queue.jobs.forEach((j) => { q[j.status] = (q[j.status] || 0) + 1; });
            return JSON.stringify({
                version: VERSION,
                userAgent: navigator.userAgent,
                routeKind: route().kind,
                store: { items: Store.byId.size, reels: Store.reels.size, sources: Store.sources },
                injector: Injector.stats,
                queue: q,
                settings: Object.assign({}, Settings.data, { template: '(redacted)' }),
                log: this.log.slice(-80)
            }, null, 2);
        }
    };

    /* ==================================================================
     * 4. NORMALIZER + STORE
     *    Every Instagram response shape is converted to one Post type:
     *    { id, code, kind, username, userId, takenAt, caption, items: [Item] }
     *    Item: { id, type, url, width, height, thumb, names, dash, hasAudio }
     * ================================================================== */
    const area = (o) => (o.width || 0) * (o.height || 0);

    function toItem(n) {
        const imgs = ((n.image_versions2 && n.image_versions2.candidates) || []).slice().sort((a, b) => area(b) - area(a));
        const vids = (n.video_versions || []).slice().sort((a, b) => area(b) - area(a));
        const isVideo = vids.length > 0;
        const best = isVideo ? vids[0] : imgs[0];
        return {
            id: String(n.pk || String(n.id || '').split('_')[0]),
            type: isVideo ? 'video' : 'image',
            url: best && best.url,
            width: best ? best.width : 0,
            height: best ? best.height : 0,
            thumb: imgs[0] && imgs[0].url,
            names: imgs.map((c) => baseName(c.url)),
            dash: n.video_dash_manifest || null,
            hasAudio: n.has_audio !== false
        };
    }

    function toPost(n, ctx) {
        const user = n.user || n.owner || ctx.user || {};
        const kids = Array.isArray(n.carousel_media) ? n.carousel_media : [n];
        return {
            id: String(n.pk || String(n.id || '').split('_')[0]),
            code: n.code || null,
            kind: !n.code ? 'story' : (n.product_type === 'clips' ? 'reel' : 'post'),
            username: user.username || 'unknown',
            userId: user.pk || user.id || null,
            takenAt: n.taken_at || n.taken_at_timestamp || 0,
            caption: (n.caption && n.caption.text) || '',
            items: kids.map(toItem).filter((i) => i.url)
        };
    }

    // Legacy GraphQL shape (query_hash era), kept as a fallback.
    function legacyPost(n, ctx) {
        const user = n.owner || ctx.user || {};
        const kids = n.edge_sidecar_to_children ? n.edge_sidecar_to_children.edges.map((e) => e.node) : [n];
        const items = kids.map((k) => {
            const res = (k.display_resources || []).slice().sort((a, b) => b.config_width - a.config_width);
            return {
                id: String(k.id), type: k.is_video ? 'video' : 'image',
                url: k.is_video ? k.video_url : ((res[0] && res[0].src) || k.display_url),
                width: res[0] ? res[0].config_width : 0, height: res[0] ? res[0].config_height : 0,
                thumb: k.display_url, names: [], dash: k.video_dash_manifest || null, hasAudio: true
            };
        });
        return {
            id: String(n.id), code: n.shortcode, kind: n.product_type === 'clips' ? 'reel' : 'post',
            username: user.username || 'unknown', userId: user.id || null,
            takenAt: n.taken_at_timestamp || 0,
            caption: (n.edge_media_to_caption && n.edge_media_to_caption.edges[0] && n.edge_media_to_caption.edges[0].node.text) || '',
            items: items.filter((i) => i.url)
        };
    }

    // Legacy GraphQL story item (GraphStoryImage / GraphStoryVideo).
    function legacyStory(n, ctx) {
        const user = n.owner || ctx.user || {};
        const res = (n.display_resources || []).slice().sort((a, b) => b.config_width - a.config_width);
        const vids = (n.video_resources || []).slice().sort((a, b) => (b.config_width || 0) - (a.config_width || 0));
        const isV = !!n.is_video;
        const url = isV ? (vids[0] && vids[0].src) : ((res[0] && res[0].src) || n.display_url);
        return {
            id: String(n.id), code: null, kind: 'story', username: user.username || 'unknown', userId: user.id || null,
            takenAt: n.taken_at_timestamp || 0, caption: '',
            items: [{
                id: String(n.id), type: isV ? 'video' : 'image', url,
                width: res[0] ? res[0].config_width : 0, height: res[0] ? res[0].config_height : 0,
                thumb: n.display_url || (res[0] && res[0].src), names: [], dash: null, hasAudio: true
            }].filter((i) => i.url)
        };
    }

    const Store = {
        byId: new Map(),
        byCode: new Map(),
        reels: new Map(), // reelId -> Post[] (stories / highlights)
        highlights: new Map(), // 'highlight:123' -> { id, title, username, page }
        sources: {},

        add(p, ctx) {
            const old = this.byId.get(p.id);
            if (old && old.items.length > p.items.length) return;
            this.byId.set(p.id, p);
            if (p.code) this.byCode.set(p.code, p);
            if (p.kind === 'story' && ctx.reelId) {
                let r = this.reels.get(ctx.reelId);
                if (!r) { r = []; this.reels.set(ctx.reelId, r); }
                const i = r.findIndex((x) => x.id === p.id);
                if (i < 0) r.push(p); else r[i] = p;
            }
            if (this.byId.size > 3000) {
                const keys = [...this.byId.keys()].slice(0, 500);
                keys.forEach((k) => { const v = this.byId.get(k); if (v && v.code) this.byCode.delete(v.code); this.byId.delete(k); });
            }
        },

        storiesOf(username) {
            for (const list of this.reels.values()) {
                if (list.length && list[0].username.toLowerCase() === username.toLowerCase()) {
                    return list.slice().sort((a, b) => a.takenAt - b.takenAt);
                }
            }
            return null;
        },

        ingest(json, source) {
            const out = [];
            try { walk(json, {}, 0, out); } catch (e) { Diag.push('error', 'ingest', e.message); }
            if (out.length) this.sources[source] = (this.sources[source] || 0) + out.length;
            return out;
        }
    };

    function walk(node, ctx, depth, out) {
        if (!node || typeof node !== 'object' || depth > 30) return;
        if (Array.isArray(node)) { for (const x of node) walk(x, ctx, depth + 1, out); return; }

        if (typeof node.id === 'string' && /^highlight:\d+$/.test(node.id)) {
            const hu = (node.user && node.user.username) || (node.owner && node.owner.username) || (ctx.user && ctx.user.username) || null;
            const prev = Store.highlights.get(node.id) || {};
            Store.highlights.set(node.id, { id: node.id, title: node.title || prev.title || '', username: hu || prev.username || null, page: prev.page || location.pathname });
        }

        if (node.image_versions2 || node.video_versions || node.carousel_media) {
            const p = toPost(node, ctx);
            if (p.items.length) { Store.add(p, ctx); out.push(p); }
            return;
        }
        if (node.shortcode && (node.display_url || node.display_resources)) {
            const p = legacyPost(node, ctx);
            if (p.items.length) { Store.add(p, ctx); out.push(p); }
            return;
        }
        if (node.display_resources && /^GraphStory/.test(node.__typename || '')) {
            const p = legacyStory(node, ctx);
            if (p.items.length) { Store.add(p, ctx); out.push(p); }
            return;
        }

        let c = ctx;
        const u = node.user && node.user.username ? node.user : (node.owner && node.owner.username ? node.owner : null);
        if (u) c = Object.assign({}, c, { user: u });
        if (Array.isArray(node.items) && node.id != null && (node.reel_type || node.user || node.owner)) {
            c = Object.assign({}, c, { reelId: String(node.id) });
        }
        for (const k in node) {
            const v = node[k];
            if (v && typeof v === 'object') walk(v, c, depth + 1, out);
        }
    }

    function parseMaybeMulti(text) {
        text = String(text).replace(/^for \(;;\);/, '');
        try { return [JSON.parse(text)]; } catch { /* maybe NDJSON */ }
        const res = [];
        for (const line of text.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            try { res.push(JSON.parse(t)); } catch { /* ignore */ }
        }
        return res;
    }

    const embeddedSeen = new WeakSet();
    function scanEmbedded() {
        document.querySelectorAll('script[type="application/json"]').forEach((s) => {
            if (embeddedSeen.has(s)) return;
            embeddedSeen.add(s);
            const t = s.textContent;
            if (t && t.length > 200 && (t.includes('image_versions2') || t.includes('video_versions') || t.includes('display_url'))) {
                try { Store.ingest(JSON.parse(t), 'embedded'); } catch { /* ignore */ }
            }
        });
    }

    /* ==================================================================
     * 5. INTERCEPTOR + API
     * ================================================================== */
    const API_RE = /\/(api\/graphql|graphql\/query|api\/v1\/)/;

    function installInterceptor() {
        try {
            W.fetch = function (...args) {
                const p = nativeFetch(...args);
                try {
                    const req = args[0];
                    const url = typeof req === 'string' ? req : (req && req.url) || '';
                    if (API_RE.test(url)) {
                        p.then((res) => res.clone().text())
                            .then((t) => parseMaybeMulti(t).forEach((j) => Store.ingest(j, 'fetch')))
                            .catch(() => { });
                    }
                } catch { /* never break the page */ }
                return p;
            };

            const proto = W.XMLHttpRequest.prototype;
            const origOpen = proto.open;
            proto.open = function (method, url, ...rest) {
                try {
                    if (API_RE.test(String(url))) {
                        this.addEventListener('load', () => {
                            try {
                                if (this.responseType === '' || this.responseType === 'text') {
                                    parseMaybeMulti(this.responseText).forEach((j) => Store.ingest(j, 'xhr'));
                                }
                            } catch { /* ignore */ }
                        });
                    }
                } catch { /* ignore */ }
                return origOpen.call(this, method, url, ...rest);
            };
            Diag.push('info', 'interceptor', 'installed');
        } catch (e) {
            Diag.push('error', 'interceptor', 'install failed: ' + e.message);
        }
    }

    let appIdCache = null;
    function appId() {
        if (appIdCache) return appIdCache;
        for (const s of document.querySelectorAll('script[type="application/json"]')) {
            const m = s.textContent.match(/"APP_ID":"(\d+)"/);
            if (m) { appIdCache = m[1]; return appIdCache; }
        }
        return '936619743392459'; // public web app id, used as a fallback
    }

    const endpointLabel = (path) => path.split('?')[0].split('/').filter((x) => x && !/^\d+$/.test(x) && !x.includes(':')).slice(-2).join('/');

    // All Instagram API calls go through here: serialized, paced, with backoff.
    const Api = {
        chain: Promise.resolve(),
        last: 0,
        backoff: 0,
        get(path) {
            const run = () => this._get(path);
            this.chain = this.chain.catch(() => { }).then(run);
            return this.chain;
        },
        async _get(path) {
            for (let attempt = 0; attempt < 4; attempt++) {
                const wait = this.last + Settings.get('minDelayMs') + this.backoff - Date.now();
                if (wait > 0) await sleep(wait);
                this.last = Date.now();
                let res;
                try {
                    res = await nativeFetch(path, {
                        credentials: 'include',
                        headers: { 'X-IG-App-ID': appId(), 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' }
                    });
                } catch (e) {
                    Diag.push('error', 'api', 'network error: ' + e.message);
                    this.backoff = Math.min(60000, (this.backoff || 1000) * 2);
                    continue;
                }
                if (res.status === 429 || res.status === 560) {
                    this.backoff = Math.min(60000, (this.backoff || 2000) * 2);
                    Diag.push('warn', 'api', 'throttled (' + res.status + '), backoff ' + this.backoff + 'ms');
                    toast('Instagram is rate-limiting requests. Slowing down…', 'warn');
                    continue;
                }
                if (res.status === 401 || res.redirected && /\/accounts\/login/.test(res.url)) {
                    throw new Error('You need to be logged in to Instagram.');
                }
                if (!res.ok) throw new Error('Instagram API returned HTTP ' + res.status + ' (' + endpointLabel(path) + ')');
                const json = await res.json();
                if (json && json.status === 'fail' && /wait|limit|try again/i.test(String(json.message))) {
                    this.backoff = Math.min(60000, (this.backoff || 2000) * 2);
                    Diag.push('warn', 'api', 'soft throttle: ' + json.message);
                    continue;
                }
                this.backoff = Math.floor(this.backoff / 2);
                return json;
            }
            throw new Error('Instagram API kept failing or throttling. Try again in a few minutes.');
        }
    };

    /* ==================================================================
     * 6. RESOLVER: store first, API only on a miss
     * ================================================================== */
    function shortcodeToId(code) {
        const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        let id = 0n;
        for (const ch of code.slice(0, 11)) id = id * 64n + BigInt(A.indexOf(ch));
        return id.toString();
    }

    const userIdCache = new Map();
    const Resolver = {
        async byCode(code) {
            let p = Store.byCode.get(code);
            if (p) return p;
            scanEmbedded();
            p = Store.byCode.get(code);
            if (p) return p;
            Diag.push('info', 'resolve', 'post not in store, using API');
            Store.ingest(await Api.get('/api/v1/media/' + shortcodeToId(code) + '/info/'), 'api');
            p = Store.byCode.get(code);
            if (!p) throw new Error('Instagram did not return media for this post.');
            return p;
        },
        async userId(username) {
            if (userIdCache.has(username)) return userIdCache.get(username);
            const j = await Api.get('/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username));
            const u = j && j.data && j.data.user;
            if (!u) throw new Error('Could not look up that user.');
            userIdCache.set(username, u);
            return u;
        },
        async reel(key) {
            let list = Store.reels.get(key);
            if (!list || !list.length) {
                const isHl = key.startsWith('highlight:');
                const gql = '/graphql/query/?query_hash=' + (isHl ? '45246d3fe16ccc6577e0bd297a5db1ab' : '15463e8449a83d3d60b06be7e90627c7') +
                    '&variables=' + encodeURIComponent(JSON.stringify(isHl ? { highlight_reel_ids: [key.slice(10)], precomposed_overlay: false } : { reel_ids: [key], precomposed_overlay: false }));
                const attempts = [
                    ['v1-encoded', '/api/v1/feed/reels_media/?reel_ids=' + encodeURIComponent(key)],
                    ['v1-plain', '/api/v1/feed/reels_media/?reel_ids=' + key],
                    ['graphql', gql]
                ];
                let lastErr;
                for (const [label, path] of attempts) {
                    try {
                        const found = Store.ingest(await Api.get(path), 'api').filter((p) => p.kind === 'story');
                        list = Store.reels.get(key);
                        if ((!list || !list.length) && found.length) { list = found; Store.reels.set(key, found); }
                        if (list && list.length) { Diag.push('info', 'reel', 'resolved via ' + label); break; }
                    } catch (e) {
                        lastErr = e;
                        Diag.push('warn', 'reel', label + ' failed: ' + e.message);
                    }
                }
                if (!list || !list.length) throw lastErr || new Error('No stories found (they may have expired).');
            }
            return list.slice().sort((a, b) => a.takenAt - b.takenAt);
        },
        async userStories(username) {
            const cached = Store.storiesOf(username);
            if (cached) return cached;
            const u = await this.userId(username);
            return this.reel(String(u.id));
        },
        async avatar(username) {
            const u = await this.userId(username);
            const url = u.profile_pic_url_hd || u.profile_pic_url;
            return {
                id: 'avatar_' + u.id, code: 'avatar', kind: 'avatar', username, userId: u.id,
                takenAt: Math.floor(Date.now() / 1000), caption: '',
                items: [{ id: 'avatar_' + u.id, type: 'image', url, width: 0, height: 0, thumb: url, names: [], dash: null, hasAudio: false }]
            };
        }
    };

    /* ==================================================================
     * 7. DOWNLOAD QUEUE, NAMING, ZIP, DASH
     * ================================================================== */
    const Downloaded = {
        data: GM_getValue('downloaded', {}),
        timer: null,
        has(id) { return Object.prototype.hasOwnProperty.call(this.data, id); },
        add(id) {
            this.data[id] = Date.now();
            clearTimeout(this.timer);
            this.timer = setTimeout(() => GM_setValue('downloaded', this.data), 1000);
        },
        clear() { this.data = {}; GM_setValue('downloaded', {}); }
    };

    const sanitize = (s) => String(s).replace(/[\\:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();

    function buildName(post, item, index, ext, templateOverride) {
        const d = new Date((post.takenAt || Date.now() / 1000) * 1000);
        const tokens = {
            username: post.username, type: post.kind, shortcode: post.code || post.id, id: item.id,
            index: pad(index + 1), year: String(d.getFullYear()), month: pad(d.getMonth() + 1), day: pad(d.getDate()),
            hour: pad(d.getHours()), minute: pad(d.getMinutes()), second: pad(d.getSeconds())
        };
        const tpl = templateOverride || Settings.get('template');
        let name = tpl.replace(/\{(\w+)\}/g, (m, k) => (k in tokens ? tokens[k] : m))
            .split('/').map(sanitize).filter(Boolean).join('/');
        if (post.folder) {
            const leaf = name.split('/').pop();
            name = [sanitize(post.username)].concat(post.folder.split('/').map(sanitize)).filter(Boolean).join('/') + '/' + leaf;
        }
        return (name || 'instagram_' + item.id) + '.' + ext;
    }

    async function fetchBlob(url) {
        try {
            const r = await nativeFetch(url);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await r.blob();
        } catch (e) {
            Diag.push('warn', 'download', 'fetch failed (' + e.message + '), trying GM_xmlhttpRequest');
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET', url, responseType: 'blob',
                    onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r.response) : reject(new Error('HTTP ' + r.status))),
                    onerror: () => reject(new Error('Network error while downloading'))
                });
            });
        }
    }

    function parseDash(xmlText) {
        try {
            const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
            if (xml.querySelector('parsererror')) return {};
            const reps = [...xml.querySelectorAll('Representation')].map((rep) => {
                const url = rep.querySelector('BaseURL') && rep.querySelector('BaseURL').textContent.trim();
                if (!url) return null;
                const set = rep.closest('AdaptationSet');
                const mime = rep.getAttribute('mimeType') || (set && set.getAttribute('mimeType')) || '';
                const ctype = (set && set.getAttribute('contentType')) || '';
                return {
                    url, video: mime.startsWith('video') || ctype.includes('video'), audio: mime.startsWith('audio') || ctype.includes('audio'),
                    bandwidth: parseInt(rep.getAttribute('bandwidth') || '0', 10), width: parseInt(rep.getAttribute('width') || '0', 10),
                    height: parseInt(rep.getAttribute('height') || '0', 10)
                };
            }).filter(Boolean);
            return {
                video: reps.filter((r) => r.video).sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))[0],
                audio: reps.filter((r) => r.audio).sort((a, b) => b.bandwidth - a.bandwidth)[0]
            };
        } catch { return {}; }
    }

    async function muxDash(videoBuf, audioBuf) {
        const MB = Mediabunny;
        const vIn = new MB.Input({ formats: [MB.MP4], source: new MB.BufferSource(videoBuf) });
        const aIn = new MB.Input({ formats: [MB.MP4], source: new MB.BufferSource(audioBuf) });
        const vTrack = await vIn.getPrimaryVideoTrack();
        const aTrack = await aIn.getPrimaryAudioTrack();
        if (!vTrack || !vTrack.codec || !aTrack || !aTrack.codec) throw new Error('Missing track');
        const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
        const vSrc = new MB.EncodedVideoPacketSource(vTrack.codec);
        const aSrc = new MB.EncodedAudioPacketSource(aTrack.codec);
        output.addVideoTrack(vSrc, { rotation: vTrack.rotation || 0 });
        output.addAudioTrack(aSrc);
        await output.start();
        const vCfg = await vTrack.getDecoderConfig();
        const aCfg = await aTrack.getDecoderConfig();
        const vIter = new MB.EncodedPacketSink(vTrack).packets();
        const aIter = new MB.EncodedPacketSink(aTrack).packets();
        let vn = await vIter.next(), an = await aIter.next(), vMeta = false, aMeta = false;
        while (!vn.done || !an.done) {
            const takeV = vn.done ? false : (an.done ? true : vn.value.timestamp <= an.value.timestamp);
            if (takeV) { await vSrc.add(vn.value, vMeta || !vCfg ? undefined : { decoderConfig: vCfg }); vMeta = true; vn = await vIter.next(); }
            else { await aSrc.add(an.value, aMeta || !aCfg ? undefined : { decoderConfig: aCfg }); aMeta = true; an = await aIter.next(); }
        }
        await output.finalize();
        return output.target.buffer;
    }

    // Smart quality: use DASH (video+audio merged) only when it is actually higher resolution.
    async function fetchMedia(item) {
        if (item.type === 'video' && Settings.get('videoQuality') === 'auto' && item.dash && typeof Mediabunny !== 'undefined') {
            const best = parseDash(item.dash);
            if (best.video && best.audio && best.video.height > (item.height || 0)) {
                try {
                    const [vb, ab] = await Promise.all([fetchBlob(best.video.url), fetchBlob(best.audio.url)]);
                    const merged = await muxDash(await vb.arrayBuffer(), await ab.arrayBuffer());
                    return { blob: new Blob([merged], { type: 'video/mp4' }), ext: 'mp4' };
                } catch (e) {
                    Diag.push('warn', 'dash', 'merge failed, using progressive: ' + e.message);
                }
            }
        }
        return { blob: await fetchBlob(item.url), ext: extOf(item.url, item.type) };
    }

    function saveBlob(blob, name) {
        return new Promise((resolve) => {
            const url = URL.createObjectURL(blob);
            const done = () => { setTimeout(() => URL.revokeObjectURL(url), 15000); resolve(); };
            const viaAnchor = () => {
                const a = h('a', { href: url, download: name.replace(/\//g, '_'), rel: 'noopener', style: 'display:none' });
                document.body.append(a); a.click(); a.remove(); done();
            };
            if (Settings.get('useGmDownload') && typeof GM_download === 'function') {
                try {
                    GM_download({
                        url, name, onload: done,
                        onerror: (e) => { Diag.push('warn', 'save', 'GM_download failed: ' + (e && e.error)); viaAnchor(); }
                    });
                    return;
                } catch { /* fall through */ }
            }
            viaAnchor();
        });
    }

    // Minimal ZIP writer (store, no compression: photos/videos are already compressed).
    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
        return t;
    })();
    function crc32(buf) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }
    function makeZip(files) {
        const enc = new TextEncoder();
        const parts = [], central = [];
        let offset = 0;
        const dt = new Date();
        const dTime = (dt.getHours() << 11) | (dt.getMinutes() << 5) | (dt.getSeconds() >> 1);
        const dDate = ((dt.getFullYear() - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
        for (const f of files) {
            const nameB = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
            const lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
            lh.setUint16(10, dTime, true); lh.setUint16(12, dDate, true); lh.setUint32(14, crc, true);
            lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, nameB.length, true);
            parts.push(lh.buffer, nameB, f.data);
            const ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
            ch.setUint16(12, dTime, true); ch.setUint16(14, dDate, true); ch.setUint32(16, crc, true);
            ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, nameB.length, true);
            ch.setUint32(42, offset, true);
            central.push(ch.buffer, nameB);
            offset += 30 + nameB.length + size;
        }
        const cdSize = central.reduce((s, b) => s + (b.byteLength !== undefined ? b.byteLength : b.length), 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
        end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
        return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
    }

    function sidecarFor(post) {
        return new TextEncoder().encode(JSON.stringify({
            id: post.id, shortcode: post.code, url: post.code ? 'https://www.instagram.com/p/' + post.code + '/' : null,
            type: post.kind, username: post.username, takenAt: post.takenAt ? new Date(post.takenAt * 1000).toISOString() : null,
            caption: post.caption, items: post.items.map((i) => ({ id: i.id, type: i.type, width: i.width, height: i.height }))
        }, null, 2));
    }

    const Queue = {
        jobs: [], active: 0, paused: false, seq: 0, wasBusy: false, raf: 0, sidecarsSaved: new Set(),

        newGroup(name) { return { name, files: [], names: new Set(), sidecars: new Set(), total: 0, finished: 0, sealed: false, done: false }; },
        seal(g) { g.sealed = true; this.maybeFinish(g); },

        enqueue(post, entries, opts = {}) {
            for (const e of entries) {
                this.jobs.push({ id: ++this.seq, post, item: e.item, index: e.index, force: !!opts.force, group: opts.group || null, status: 'queued', error: null });
                if (opts.group) opts.group.total++;
            }
            this.changed();
            this.pump();
        },

        pump() {
            if (this.paused) return;
            const max = Settings.get('concurrency');
            while (this.active < max) {
                const j = this.jobs.find((x) => x.status === 'queued');
                if (!j) break;
                this.active++;
                this.run(j).finally(() => { this.active--; this.changed(); this.pump(); });
            }
        },

        async run(j) {
            j.status = 'active';
            this.changed();
            try {
                if (!j.force && Settings.get('skipDuplicates') && Downloaded.has(j.item.id)) { j.status = 'skipped'; return; }
                let result, lastErr;
                for (let t = 0; t < 3; t++) {
                    try { result = await fetchMedia(j.item); break; } catch (e) { lastErr = e; await sleep(1500 * (t + 1)); }
                }
                if (!result) throw lastErr || new Error('Download failed');

                const name = buildName(j.post, j.item, j.index, result.ext);
                if (j.group) {
                    let n = name, i = 1;
                    while (j.group.names.has(n)) n = name.replace(/(\.\w+)$/, '_' + (i++) + '$1');
                    j.group.names.add(n);
                    j.group.files.push({ name: n, data: new Uint8Array(await result.blob.arrayBuffer()) });
                    if (Settings.get('sidecar') && !j.group.sidecars.has(j.post.id)) {
                        j.group.sidecars.add(j.post.id);
                        j.group.files.push({ name: buildName(j.post, j.item, 0, 'json'), data: sidecarFor(j.post) });
                    }
                } else {
                    await saveBlob(result.blob, name);
                    if (Settings.get('sidecar') && !this.sidecarsSaved.has(j.post.id)) {
                        this.sidecarsSaved.add(j.post.id);
                        await saveBlob(new Blob([sidecarFor(j.post)], { type: 'application/json' }), buildName(j.post, j.item, 0, 'json'));
                    }
                }
                Downloaded.add(j.item.id);
                j.status = 'done';
                await sleep(150);
            } catch (e) {
                j.status = 'failed';
                j.error = e && e.message ? e.message : String(e);
                Diag.push('error', 'download', j.error);
            } finally {
                if (j.group) { j.group.finished++; this.maybeFinish(j.group); }
            }
        },

        async maybeFinish(g) {
            if (g.done || !g.sealed || g.finished < g.total) return;
            g.done = true;
            if (!g.files.length) return;
            try {
                toast('Building ZIP (' + g.files.length + ' files)…');
                await saveBlob(makeZip(g.files), sanitize(g.name) + '.zip');
                g.files = [];
            } catch (e) {
                Diag.push('error', 'zip', e.message);
                toast('ZIP failed: ' + e.message, 'error');
            }
        },

        retryFailed() {
            this.jobs.forEach((j) => { if (j.status === 'failed') { j.status = 'queued'; j.error = null; j.group = null; j.force = true; } });
            this.changed(); this.pump();
        },
        clearFinished() { this.jobs = this.jobs.filter((j) => j.status === 'queued' || j.status === 'active'); this.changed(); },
        togglePause() { this.paused = !this.paused; this.changed(); this.pump(); },

        changed() {
            if (this.raf) return;
            this.raf = requestAnimationFrame(() => {
                this.raf = 0;
                const busy = this.jobs.some((j) => j.status === 'queued' || j.status === 'active');
                if (this.wasBusy && !busy) {
                    const c = (s) => this.jobs.filter((j) => j.status === s).length;
                    toast('Finished: ' + c('done') + ' saved, ' + c('skipped') + ' skipped, ' + c('failed') + ' failed', c('failed') ? 'warn' : 'ok');
                }
                this.wasBusy = busy;
                Panel.onQueue();
                Fab.badge();
            });
        }
    };

    /* ==================================================================
     * 8. ACTIONS
     * ================================================================== */
    const RESERVED = new Set(['explore', 'direct', 'accounts', 'reels', 'stories', 'p', 'reel', 'tv', 'about', 'legal', 'api', 'challenge', 'emails', 'web', 'developer', 'directory', 'session', 'privacy', 'your_activity', 'settings', 'notifications', 'create', 'login', 'nametag', 'topics']);
    function route() {
        const p = location.pathname.split('/').filter(Boolean);
        if (!p.length) return { kind: 'home' };
        const i = p.findIndex((s, ix) => ix < 2 && (s === 'p' || s === 'reel' || s === 'reels' || s === 'tv'));
        if (i >= 0 && p[i + 1]) return { kind: 'post', code: p[i + 1] };
        if (p[0] === 'reels') return { kind: 'reelsFeed' };
        if (p[0] === 'stories') {
            if (p[1] === 'highlights' && p[2]) return { kind: 'highlight', id: p[2] };
            if (p[1]) return { kind: 'story', username: p[1], id: p[2] || null };
        }
        if (!RESERVED.has(p[0])) return { kind: 'profile', username: p[0] };
        return { kind: 'other' };
    }

    function codeFromRoot(root) {
        for (const a of root.querySelectorAll('a[href]')) {
            const m = a.getAttribute('href').match(/\/(?:p|reel|tv)\/([\w-]+)/);
            if (m) return m[1];
        }
        return null;
    }

    // Which carousel slide is on screen? Match visible <img> filenames against known candidates,
    // fall back to the slide's translateX offset.
    function visibleIndex(root, post) {
        if (post.items.length < 2) return 0;
        const rr = root.getBoundingClientRect();
        let bestEl = null, bestArea = 0;
        root.querySelectorAll('li img, li video').forEach((el) => {
            const r = el.getBoundingClientRect();
            const w = Math.min(r.right, rr.right) - Math.max(r.left, rr.left);
            const hgt = Math.min(r.bottom, rr.bottom) - Math.max(r.top, rr.top);
            if (w > 0 && hgt > 0 && w * hgt > bestArea) { bestArea = w * hgt; bestEl = el; }
        });
        if (!bestEl) return 0;
        if (bestEl.tagName === 'IMG') {
            const n = baseName(bestEl.currentSrc || bestEl.src);
            const idx = post.items.findIndex((i) => i.names.includes(n));
            if (idx >= 0) return idx;
        } else {
            const vids = post.items.map((i, ix) => (i.type === 'video' ? ix : -1)).filter((x) => x >= 0);
            if (vids.length === 1) return vids[0];
        }
        const li = bestEl.closest('li');
        const m = li && (li.getAttribute('style') || '').match(/translateX\((-?[\d.]+)px\)/);
        if (m && li.offsetWidth) return Math.max(0, Math.min(post.items.length - 1, Math.round(parseFloat(m[1]) / li.offsetWidth)));
        return 0;
    }

    function matchByVisibleTime(posts) {
        const t = [...document.querySelectorAll('section time[datetime], main time[datetime]')]
            .find((el) => el.offsetParent !== null && !el.closest('a[href*="/stories/highlights/"]'));
        if (!t) return posts[0];
        const ts = Date.parse(t.getAttribute('datetime')) / 1000;
        let best = posts[0], diff = Infinity;
        posts.forEach((p) => { const d = Math.abs(p.takenAt - ts); if (d < diff) { diff = d; best = p; } });
        return best;
    }

    // A "target" is { posts: Post[], current: { post, index } }
    async function currentTarget(root) {
        const r = route();
        if (root || r.kind === 'post' || r.kind === 'reelsFeed') {
            let el = root;
            if (!el && r.kind === 'post') {
                el = [...document.querySelectorAll('article')].find((a) => codeFromRoot(a) === r.code) || null;
            }
            const code = (el && codeFromRoot(el)) || (r.kind === 'post' ? r.code : null);
            if (!code) throw new Error('Could not tell which post this is. Open the post/reel directly.');
            const post = await Resolver.byCode(code);
            return { posts: [post], current: { post, index: el ? visibleIndex(el, post) : 0 } };
        }
        if (r.kind === 'story') {
            const posts = await Resolver.userStories(r.username);
            const byUrl = r.id && posts.find((p) => p.id === r.id);
            return { posts, current: { post: byUrl || matchByVisibleTime(posts), index: 0 } };
        }
        if (r.kind === 'highlight') {
            const posts = await Resolver.reel('highlight:' + r.id);
            return { posts, current: { post: matchByVisibleTime(posts), index: 0 } };
        }
        throw new Error('Nothing downloadable on this page. Open a post, reel, story or highlight.');
    }

    async function perform(action, t) {
        const { post, index } = t.current;
        const item = post.items[Math.min(index, post.items.length - 1)];
        if (action === 'open') { window.open(item.url, '_blank', 'noopener'); return; }
        if (action === 'thumb') {
            if (!item.thumb) throw new Error('No thumbnail available.');
            const it = Object.assign({}, item, { id: item.id + '_thumb', type: 'image', url: item.thumb, dash: null });
            Queue.enqueue(post, [{ item: it, index }], { force: true });
            toast('Thumbnail queued');
            return;
        }
        if (action === 'current') {
            Queue.enqueue(post, [{ item, index }], { force: true });
            toast('Queued 1 file');
            return;
        }
        if (action === 'all') {
            const total = t.posts.reduce((s, p) => s + p.items.length, 0);
            if (t.posts.length === 1 && Settings.get('zipMulti') && post.items.length > 1) {
                const g = Queue.newGroup(post.username + '_' + (post.code || post.id));
                Queue.enqueue(post, post.items.map((it, i) => ({ item: it, index: i })), { group: g });
                Queue.seal(g);
            } else {
                t.posts.forEach((p) => Queue.enqueue(p, p.items.map((it, i) => ({ item: it, index: i })), {}));
            }
            toast('Queued ' + total + ' file' + (total === 1 ? '' : 's'));
        }
    }

    async function downloadAvatar(username) {
        let p;
        try {
            p = await Resolver.avatar(username);
        } catch (e) {
            Diag.push('warn', 'avatar', 'API failed, using the on-page image: ' + e.message);
            const img = document.querySelector('header img[alt*="rofile"], header img');
            if (!img || !img.src) throw e;
            p = {
                id: 'avatar_page_' + username, code: 'avatar', kind: 'avatar', username, userId: null,
                takenAt: Math.floor(Date.now() / 1000), caption: '',
                items: [{ id: 'avatar_page_' + username, type: 'image', url: img.src, width: 0, height: 0, thumb: img.src, names: [], dash: null, hasAudio: false }]
            };
            toast('Instagram blocked the HD lookup, saving the on-page (lower resolution) picture', 'warn');
        }
        Queue.enqueue(p, [{ item: p.items[0], index: 0 }], { force: true });
        toast('Profile picture queued');
    }

    // Scroll-and-capture: let Instagram's own pagination load the grid while the
    // interceptor records every response. No custom endpoint, so nothing extra to get blocked.
    async function downloadProfile(username, o) {
        const group = o.zip ? Queue.newGroup(username + '_profile') : null;
        const from = o.from ? Date.parse(o.from) / 1000 : 0;
        const to = o.to ? Date.parse(o.to) / 1000 + 86399 : Infinity;
        const mine = (p) => p.username === 'unknown' || p.username.toLowerCase() === username.toLowerCase();
        const sniff = () => [...Store.byId.values()].filter((p) => p.kind !== 'story' && p.code && mine(p));

        toast('Scrolling the profile to load posts. Keep this tab open.');
        let stagnant = 0, last = sniff().length, rounds = 0;
        while (stagnant < 5 && last < o.max) {
            window.scrollTo(0, document.documentElement.scrollHeight);
            await sleep(1800);
            const n = sniff().length;
            stagnant = n > last ? 0 : stagnant + 1;
            last = n;
            if (++rounds % 5 === 0) toast('Loaded ' + n + ' posts so far…');
            // stop early once we have scrolled past the "from" date
            if (from && sniff().some((p) => p.takenAt && p.takenAt < from)) break;
        }
        Diag.push('info', 'profile', 'scroll finished, posts in store: ' + last + ', rounds: ' + rounds);

        const posts = sniff().sort((a, b) => b.takenAt - a.takenAt)
            .filter((p) => !(p.takenAt && (p.takenAt > to || p.takenAt < from)))
            .slice(0, o.max);
        let files = 0, count = 0;
        for (const p of posts) {
            if (p.username === 'unknown') p.username = username;
            const entries = p.items.map((it, i) => ({ item: it, index: i }))
                .filter((e) => (e.item.type === 'video' ? o.videos : o.images));
            if (!entries.length) continue;
            count++; files += entries.length;
            Queue.enqueue(p, entries, { group });
        }
        if (group) Queue.seal(group);
        if (!files) throw new Error('No posts were captured. Reload the profile page, scroll once manually, then try again.');
        toast('Queued ' + files + ' files from ' + count + ' posts', 'ok');
    }

    async function downloadAllHighlights(username) {
        const lower = username.toLowerCase();
        const fromStore = () => [...Store.highlights.values()].filter((x) => (x.username ? x.username.toLowerCase() === lower : x.page === location.pathname));
        let tray = fromStore();
        if (!tray.length) {
            let uid = userIdCache.get(username) && userIdCache.get(username).id;
            if (!uid) for (const p of Store.byId.values()) { if (p.userId && p.username.toLowerCase() === lower) { uid = p.userId; break; } }
            if (uid) {
                try { Store.ingest(await Api.get('/api/v1/highlights/' + uid + '/highlights_tray/'), 'api'); } catch (e) { Diag.push('warn', 'highlights', 'tray lookup failed: ' + e.message); }
                tray = fromStore();
            }
        }
        if (!tray.length) throw new Error('No highlights found. Reload the profile, wait for the highlight circles to appear, then try again.');
        toast('Found ' + tray.length + ' highlights. Loading them one by one…');
        let files = 0, ok = 0;
        for (const hl of tray) {
            try {
                const posts = await Resolver.reel(hl.id);
                const folder = 'highlights/' + (hl.title || hl.id.replace('highlight:', ''));
                posts.forEach((p) => {
                    const q = Object.assign({}, p, { folder, username: p.username === 'unknown' ? username : p.username });
                    Queue.enqueue(q, q.items.map((it, i) => ({ item: it, index: i })), {});
                    files += q.items.length;
                });
                ok++;
            } catch (e) {
                Diag.push('error', 'highlights', e.message);
                toast('Skipped one highlight: ' + e.message, 'warn');
            }
            await sleep(1500);
        }
        if (!files) throw new Error('Could not load any highlight. Copy the diagnostic report and send it over.');
        toast('Queued ' + files + ' files from ' + ok + ' highlights', 'ok');
    }

    const safe = (fn) => Promise.resolve().then(fn).catch((e) => {
        Diag.push('error', 'action', e && e.message);
        toast(e && e.message ? e.message : 'Something went wrong', 'error');
    });

    /* ==================================================================
     * 9. UI
     * ================================================================== */
    GM_addStyle(`
    :root{--igh-bg:#fff;--igh-fg:#111;--igh-mut:#6b7280;--igh-bd:#e5e7eb;--igh-ac:#4f46e5}
    @media (prefers-color-scheme:dark){:root{--igh-bg:#1c1c1e;--igh-fg:#f3f4f6;--igh-mut:#9ca3af;--igh-bd:#3a3a3c;--igh-ac:#818cf8}}
    .igh-bar{position:absolute;top:60px;right:8px;display:flex;flex-direction:column;gap:6px;z-index:5;opacity:.55;transition:opacity .15s}
    article:hover .igh-bar,.igh-bar:focus-within{opacity:1}
    .igh-btn{width:32px;height:32px;border-radius:50%;border:0;background:rgba(0,0,0,.65);color:#fff;display:grid;place-items:center;cursor:pointer;padding:0}
    .igh-btn:hover,.igh-btn:focus-visible{background:var(--igh-ac);outline:none}
    .igh-btn[hidden]{display:none}
    html.igh-no-bars .igh-bar{display:none}
    .igh-fab{position:fixed;right:16px;bottom:16px;z-index:2147483000;font:14px system-ui,sans-serif;color:var(--igh-fg)}
    .igh-fab-main{width:44px;height:44px;border-radius:50%;border:0;background:var(--igh-ac);color:#fff;cursor:pointer;display:grid;place-items:center;position:relative;box-shadow:0 2px 10px rgba(0,0,0,.3)}
    .igh-badge{position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;border-radius:9px;font-size:11px;min-width:18px;height:18px;line-height:18px;text-align:center}
    .igh-menu{position:absolute;right:0;bottom:52px;background:var(--igh-bg);border:1px solid var(--igh-bd);border-radius:10px;padding:6px;min-width:210px;box-shadow:0 6px 24px rgba(0,0,0,.25)}
    .igh-menu button{display:flex;gap:8px;align-items:center;width:100%;background:none;border:0;color:inherit;padding:8px 10px;border-radius:6px;cursor:pointer;text-align:left;font:inherit}
    .igh-menu button:hover,.igh-menu button:focus-visible{background:var(--igh-bd);outline:none}
    .igh-panel{position:fixed;right:16px;bottom:72px;width:400px;max-width:calc(100vw - 32px);max-height:70vh;overflow:auto;background:var(--igh-bg);color:var(--igh-fg);border:1px solid var(--igh-bd);border-radius:12px;z-index:2147483001;font:13px system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.35)}
    .igh-ph{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--igh-bd);position:sticky;top:0;background:var(--igh-bg)}
    .igh-ph b{flex:1}
    .igh-tab{background:none;border:0;color:var(--igh-mut);cursor:pointer;padding:4px 8px;border-radius:6px;font:inherit}
    .igh-tab[aria-selected=true]{color:var(--igh-fg);background:var(--igh-bd)}
    .igh-pb{padding:10px 12px;display:flex;flex-direction:column;gap:8px}
    .igh-row{display:flex;gap:8px;align-items:center;justify-content:space-between}
    .igh-row label{flex:1}
    .igh-row input[type=text],.igh-row input[type=number],.igh-row select,.igh-modal input[type=date],.igh-modal input[type=number]{background:var(--igh-bg);color:var(--igh-fg);border:1px solid var(--igh-bd);border-radius:6px;padding:4px 6px;font:inherit}
    .igh-help{color:var(--igh-mut);font-size:12px}
    .igh-act{background:var(--igh-ac);color:#fff;border:0;border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit}
    .igh-act.sec{background:var(--igh-bd);color:var(--igh-fg)}
    .igh-job{display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--igh-bd);padding:4px 0}
    .igh-job span.t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .igh-chip{font-size:11px;padding:1px 6px;border-radius:8px;background:var(--igh-bd)}
    .igh-chip.done{background:#16a34a;color:#fff}.igh-chip.failed{background:#dc2626;color:#fff}.igh-chip.active{background:var(--igh-ac);color:#fff}
    .igh-toasts{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483002;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}
    .igh-toast{background:#111;color:#fff;padding:8px 14px;border-radius:8px;font:13px system-ui,sans-serif;transition:opacity .3s;box-shadow:0 2px 10px rgba(0,0,0,.4)}
    .igh-toast.error{background:#b91c1c}.igh-toast.warn{background:#b45309}.igh-toast.ok{background:#15803d}
    .igh-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483003;display:grid;place-items:center}
    .igh-modal{background:var(--igh-bg);color:var(--igh-fg);border-radius:12px;padding:16px;width:360px;max-width:calc(100vw - 32px);font:13px system-ui,sans-serif;display:flex;flex-direction:column;gap:10px}
    @media (prefers-reduced-motion:reduce){.igh-bar,.igh-toast{transition:none}}
    `);

    // ---- toasts
    let toastHost = null;
    function toast(msg, type) {
        const mk = () => {
            if (!toastHost) { toastHost = h('div', { class: 'igh-toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastHost); }
            const t = h('div', { class: 'igh-toast ' + (type || '') }, msg);
            toastHost.append(t);
            setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4000);
        };
        if (document.body) mk(); else document.addEventListener('DOMContentLoaded', mk, { once: true });
    }

    // ---- resilient per-post button injector
    const Injector = {
        stats: { articles: 0, attached: 0, noCode: 0 },
        pending: false,
        start() {
            new MutationObserver(() => this.schedule()).observe(document.body, { childList: true, subtree: true });
            this.scan();
        },
        schedule() {
            if (this.pending) return;
            this.pending = true;
            setTimeout(() => { this.pending = false; this.scan(); }, 250);
        },
        scan() {
            const s = { articles: 0, attached: 0, noCode: 0 };
            document.querySelectorAll('article').forEach((a) => {
                s.articles++;
                if (a.hasAttribute('data-igh')) { s.attached++; return; }
                if (!codeFromRoot(a)) { s.noCode++; return; }
                this.attach(a);
                s.attached++;
            });
            this.stats = s;
        },
        attach(a) {
            a.setAttribute('data-igh', '1');
            if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
            const mk = (icon, label, action) => {
                const b = h('button', {
                    class: 'igh-btn', type: 'button', title: label, 'aria-label': label,
                    onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); safe(async () => perform(action, await currentTarget(a))); }
                });
                b.innerHTML = ICON[icon];
                return b;
            };
            const thumb = mk('thumb', 'Download video thumbnail', 'thumb'); thumb.hidden = true;
            const all = mk('all', 'Download all items in this post', 'all');
            const bar = h('div', { class: 'igh-bar' }, mk('download', 'Download this item', 'current'), all, mk('open', 'Open original in new tab', 'open'), thumb);
            bar.addEventListener('mouseenter', () => {
                const code = codeFromRoot(a);
                const p = code && Store.byCode.get(code);
                if (p) {
                    all.hidden = p.items.length < 2;
                    const it = p.items[visibleIndex(a, p)];
                    thumb.hidden = !(it && it.type === 'video');
                }
            });
            a.append(bar);
        }
    };

    // ---- floating button (works on every page layout, never depends on selectors)
    const Fab = {
        el: null, menu: null, badgeEl: null,
        build() {
            this.badgeEl = h('span', { class: 'igh-badge', hidden: true });
            const main = h('button', { class: 'igh-fab-main', type: 'button', title: 'GramSaver', 'aria-label': 'GramSaver menu', onclick: () => this.toggle() });
            main.innerHTML = ICON.download.replace('width="18" height="18"', 'width="22" height="22"');
            main.append(this.badgeEl);
            this.el = h('div', { class: 'igh-fab' }, main);
            document.body.append(this.el);
            this.apply();
        },
        apply() { if (this.el) this.el.style.display = Settings.get('showFab') ? '' : 'none'; },
        badge() {
            if (!this.badgeEl) return;
            const n = Queue.jobs.filter((j) => j.status === 'queued' || j.status === 'active').length;
            this.badgeEl.hidden = n === 0;
            this.badgeEl.textContent = n;
        },
        toggle() {
            if (this.menu) { this.menu.remove(); this.menu = null; return; }
            const r = route();
            const items = [];
            if (['post', 'reelsFeed', 'story', 'highlight'].includes(r.kind)) {
                items.push(['download', 'Download this item', () => safe(async () => perform('current', await currentTarget()))]);
                items.push(['all', r.kind === 'post' || r.kind === 'reelsFeed' ? 'Download all items' : 'Download all stories', () => safe(async () => perform('all', await currentTarget()))]);
                items.push(['open', 'Open original in new tab', () => safe(async () => perform('open', await currentTarget()))]);
                items.push(['thumb', 'Download video thumbnail', () => safe(async () => perform('thumb', await currentTarget()))]);
            }
            if (r.kind === 'profile') {
                items.push(['download', 'Download profile picture', () => safe(() => downloadAvatar(r.username))]);
                items.push(['all', 'Download profile posts…', () => profileDialog(r.username)]);
                items.push(['all', 'Download all highlights', () => safe(() => downloadAllHighlights(r.username))]);
            }
            items.push(['open', 'Queue & settings', () => Panel.open('queue')]);
            this.menu = h('div', { class: 'igh-menu', role: 'menu' }, items.map(([icon, label, fn]) => {
                const b = h('button', { type: 'button', role: 'menuitem', onclick: () => { this.toggle(); fn(); } }, label);
                b.prepend(h('span', { innerHTML: '' }));
                b.firstChild.innerHTML = ICON[icon];
                return b;
            }));
            this.el.append(this.menu);
        }
    };

    // ---- panel: queue / settings / help
    const FIELDS = [
        { k: 'template', label: 'File/folder template', type: 'text', help: 'Tokens: {username} {type} {shortcode} {id} {index} {year} {month} {day} {hour} {minute} {second}. Use "/" for folders (needs Tampermonkey "Browser API" download mode, otherwise folders are flattened).' },
        { k: 'zipMulti', label: 'Save multi-item posts as one ZIP', type: 'bool' },
        { k: 'sidecar', label: 'Also save caption & metadata (.json)', type: 'bool' },
        { k: 'skipDuplicates', label: 'Skip already-downloaded items in bulk actions', type: 'bool' },
        { k: 'videoQuality', label: 'Video quality', type: 'select', options: [['auto', 'Auto (merge DASH when higher resolution)'], ['progressive', 'Always use the standard file']] },
        { k: 'concurrency', label: 'Parallel downloads', type: 'number', min: 1, max: 5 },
        { k: 'minDelayMs', label: 'Min delay between API requests (ms)', type: 'number', min: 0, max: 5000 },
        { k: 'useGmDownload', label: 'Use Tampermonkey downloader (allows folders)', type: 'bool' },
        { k: 'showPostButtons', label: 'Show buttons on posts', type: 'bool' },
        { k: 'showFab', label: 'Show floating button', type: 'bool' }
    ];

    function applyUiSettings() {
        document.documentElement.classList.toggle('igh-no-bars', !Settings.get('showPostButtons'));
        Fab.apply();
    }

    const Panel = {
        el: null, tab: 'queue', body: null,
        open(tab) {
            this.tab = tab || this.tab;
            if (!this.el) { this.el = h('div', { class: 'igh-panel', role: 'dialog', 'aria-label': 'GramSaver' }); document.body.append(this.el); }
            this.render();
        },
        close() { if (this.el) { this.el.remove(); this.el = null; } },
        toggle() { if (this.el) this.close(); else this.open('queue'); },
        onQueue() { if (this.el && this.tab === 'queue') this.renderBody(); },
        render() {
            if (!this.el) return;
            const tabBtn = (id, label) => h('button', { class: 'igh-tab', type: 'button', 'aria-selected': this.tab === id ? 'true' : 'false', onclick: () => { this.tab = id; this.render(); } }, label);
            const close = h('button', { class: 'igh-tab', type: 'button', 'aria-label': 'Close', onclick: () => this.close() });
            close.innerHTML = ICON.close;
            this.body = h('div', { class: 'igh-pb' });
            this.el.replaceChildren(h('div', { class: 'igh-ph' }, h('b', {}, 'GramSaver v' + VERSION), tabBtn('queue', 'Queue'), tabBtn('settings', 'Settings'), tabBtn('help', 'Help'), close), this.body);
            this.renderBody();
        },
        renderBody() {
            if (!this.body) return;
            if (this.tab === 'queue') this.body.replaceChildren(...this.queueView());
            else if (this.tab === 'settings') this.body.replaceChildren(...this.settingsView());
            else this.body.replaceChildren(...this.helpView());
        },
        queueView() {
            const js = Queue.jobs;
            const c = (s) => js.filter((j) => j.status === s).length;
            const head = h('div', { class: 'igh-row' },
                h('span', {}, c('queued') + c('active') + ' pending · ' + c('done') + ' done · ' + c('skipped') + ' skipped · ' + c('failed') + ' failed'),
                h('span', {},
                    h('button', { class: 'igh-act sec', type: 'button', onclick: () => Queue.togglePause() }, Queue.paused ? 'Resume' : 'Pause'), ' ',
                    h('button', { class: 'igh-act sec', type: 'button', onclick: () => Queue.retryFailed() }, 'Retry failed'), ' ',
                    h('button', { class: 'igh-act sec', type: 'button', onclick: () => Queue.clearFinished() }, 'Clear')));
            if (!js.length) return [head, h('div', { class: 'igh-help' }, 'Nothing queued yet. Use the buttons on a post, or the floating button.')];
            const rows = js.slice(-60).reverse().map((j) => h('div', { class: 'igh-job', title: j.error || '' },
                h('span', { class: 't' }, j.post.username + ' · ' + (j.post.code || j.post.kind) + ' #' + (j.index + 1)),
                h('span', { class: 'igh-chip ' + j.status }, j.status)));
            return [head, ...rows];
        },
        settingsView() {
            const preview = h('div', { class: 'igh-help' });
            const upd = () => {
                const sp = { username: 'someone', kind: 'post', code: 'AbC123', id: '1', takenAt: 1735732800 };
                preview.textContent = 'Preview: ' + buildName(sp, { id: '1' }, 0, 'jpg');
            };
            const rows = FIELDS.map((f) => {
                let input;
                if (f.type === 'bool') input = h('input', { type: 'checkbox', checked: !!Settings.get(f.k), onchange: (e) => { Settings.set(f.k, e.target.checked); applyUiSettings(); } });
                else if (f.type === 'select') input = h('select', { onchange: (e) => Settings.set(f.k, e.target.value) }, f.options.map(([v, l]) => { const o = h('option', { value: v }, l); if (Settings.get(f.k) === v) o.selected = true; return o; }));
                else if (f.type === 'number') input = h('input', { type: 'number', min: f.min, max: f.max, value: Settings.get(f.k), style: 'width:80px', onchange: (e) => { const v = Math.max(f.min, Math.min(f.max, parseInt(e.target.value, 10) || f.min)); e.target.value = v; Settings.set(f.k, v); } });
                else input = h('input', { type: 'text', value: Settings.get(f.k), style: 'width:100%', onchange: (e) => { Settings.set(f.k, e.target.value || DEFAULTS.template); upd(); } });
                if (f.type === 'text') return h('div', {}, h('label', {}, f.label), input, f.help && h('div', { class: 'igh-help' }, f.help));
                return h('div', { class: 'igh-row' }, h('label', {}, f.label), input);
            });
            upd();
            return [...rows, preview];
        },
        helpView() {
            return [
                h('div', { class: 'igh-help' }, 'Hotkeys: Alt+S download current item · Alt+W toggle this panel · Alt+Q close.'),
                h('div', { class: 'igh-help' }, 'Downloaded-items index: ' + Object.keys(Downloaded.data).length + ' entries.'),
                h('div', { class: 'igh-row' },
                    h('button', { class: 'igh-act', type: 'button', onclick: () => { GM_setClipboard(Diag.report(), 'text'); toast('Diagnostic report copied', 'ok'); } }, 'Copy diagnostic report'),
                    h('button', { class: 'igh-act sec', type: 'button', onclick: () => { if (confirm('Forget all downloaded items?')) { Downloaded.clear(); this.renderBody(); } } }, 'Clear downloaded index')),
                h('div', { class: 'igh-help' }, 'The report has no usernames or URLs: only version, page type, counters, settings and recent log lines.')
            ];
        }
    };

    function profileDialog(username) {
        const chk = (id, label, on) => h('label', {}, h('input', { type: 'checkbox', id, checked: on }), ' ' + label);
        const bg = h('div', { class: 'igh-modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } },
            h('div', { class: 'igh-modal', role: 'dialog', 'aria-label': 'Download profile' },
                h('b', {}, 'Download posts from this profile'),
                h('div', { class: 'igh-help' }, 'The page will scroll by itself to load posts (keep the tab open). Only content you can already see. Already-downloaded items are skipped, so re-running resumes where you stopped.'),
                chk('igh-img', 'Photos', true), chk('igh-vid', 'Videos', true),
                h('div', { class: 'igh-row' }, h('label', {}, 'From'), h('input', { type: 'date', id: 'igh-from' })),
                h('div', { class: 'igh-row' }, h('label', {}, 'To'), h('input', { type: 'date', id: 'igh-to' })),
                h('div', { class: 'igh-row' }, h('label', {}, 'Max posts'), h('input', { type: 'number', id: 'igh-max', min: 1, max: 5000, value: 50, style: 'width:90px' })),
                chk('igh-zip', 'Bundle everything into one ZIP (uses a lot of memory above ~500 files)', false),
                h('div', { class: 'igh-row' },
                    h('button', { class: 'igh-act sec', type: 'button', onclick: () => bg.remove() }, 'Cancel'),
                    h('button', {
                        class: 'igh-act', type: 'button', onclick: () => {
                            const g = (id) => bg.querySelector('#' + id);
                            const o = { images: g('igh-img').checked, videos: g('igh-vid').checked, from: g('igh-from').value, to: g('igh-to').value, max: Math.max(1, parseInt(g('igh-max').value, 10) || 50), zip: g('igh-zip').checked };
                            bg.remove();
                            safe(() => downloadProfile(username, o));
                        }
                    }, 'Start'))));
        document.body.append(bg);
    }

    /* ==================================================================
     * 10. BOOT
     * ================================================================== */
    installInterceptor();

    GM_registerMenuCommand('Open queue & settings', () => Panel.open('queue'));
    GM_registerMenuCommand('Copy diagnostic report', () => { GM_setClipboard(Diag.report(), 'text'); toast('Diagnostic report copied', 'ok'); });

    function boot() {
        scanEmbedded();
        Fab.build();
        applyUiSettings();
        Injector.start();
        window.addEventListener('load', scanEmbedded);

        window.addEventListener('keydown', (e) => {
            if (!e.altKey) return;
            const k = e.key.toLowerCase();
            if (k === 'q') { Panel.close(); e.preventDefault(); }
            else if (k === 'w') { Panel.toggle(); e.preventDefault(); }
            else if (k === 's') { safe(async () => perform('current', await currentTarget())); e.preventDefault(); }
        });
        Diag.push('info', 'boot', 'ready v' + VERSION);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
