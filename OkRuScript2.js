/*
 * GrayJay - OK.ru Source v4 (rapido, estilo YouTube)
 *
 * Por que YouTube encuentra y reproduce antes:
 *   - search y player son POST JSON (youtubei/v1), no un HTML de megabytes.
 *   - getContentDetails arma player + ficha en paralelo con http.batch().
 *   - el script entrega URLs firmadas y no vuelve a bajar el manifest.
 *   - no mete Cookie/Origin en el stream (el CDN ya firmo la URL).
 *
 * Que cambia aqui respecto a v38:
 *   1. Reproducir: POST chico a /dk?cmd=videoPlayerMetadata&mid=ID.
 *      Si trae videos[] o hlsManifestUrl, no se descarga la pagina.
 *   2. Si la API falla, http.batch() pide embed publico y embed con
 *      sesion a la vez (el tiempo es el del mas lento, no la suma).
 *   3. Buscar: una sola pagina autenticada y un solo recorrido del HTML.
 *      Antes habia 4 regex sobre todo el documento.
 *   4. Fuentes sin requestModifier (Cast y player). MP4 HD primero si
 *      la calidad es conocida: arranca como un itag directo de YouTube.
 *      HLS master queda de respaldo.
 *   5. Sugerencias ya no disparan una busqueda completa.
 */

const PLATFORM_NAME = "OK.ru";
const PLUGIN_ID = "62af0e2f-bfd9-489f-afe1-f66583d2f7d0";

const UA_DESKTOP =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/136.0.0.0 Safari/537.36";

const REGEX_VIDEO_URL = /ok\.ru\/(?:video|videoembed)\/(\d+)/i;
const SEARCH_URL_BASE =
    "https://m.ok.ru/dk?st.cmd=searchResult&st.mode=Movie&st.grmode=Groups&st.query=";

const MAX_HTML_SIZE = 900000;
const MAX_SOURCES = 8;
const MAX_SEARCH = 24;
const MAX_TITLE_CACHE = 300;
const DETAILS_CACHE_TTL = 180000;

const LOGIN_MSG = "Inicie sesion para encontrar videos";

let DEBUG = [];
let TITLE_CACHE = {};
let TITLE_CACHE_ORDER = [];
let DETAILS_CACHE = {};

function nowMs() {
    try { return Date.now(); } catch (_) { return 0; }
}

function addDebug(value) {
    try {
        let s = safeStr(value);
        if (!s) return;
        if (DEBUG.length >= 24) DEBUG.shift();
        DEBUG.push(s.length > 240 ? s.substring(0, 240) + "..." : s);
    } catch (_) {}
}

function resetDebug() { DEBUG = []; }
function debugText() { return DEBUG.join("\n"); }

function safeStr(v) {
    try {
        if (v === null || v === undefined) return "";
        if (typeof v === "string") return v;
        return String(v);
    } catch (_) { return ""; }
}

function safeObj(v) {
    return v !== null && typeof v === "object";
}

function htmlDecode(s) {
    s = safeStr(s);
    return s
        .replace(/"/gi, '"')
        .replace(/&#34;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/'/gi, "'")
        .replace(/&/gi, "&")
        .replace(/</gi, "<")
        .replace(/>/gi, ">")
        .replace(/&#x2F;/gi, "/")
        .replace(/&#47;/g, "/");
}

function stripTags(s) {
    return safeStr(s).replace(/<[^>]*>/g, " ");
}

function cleanText(s) {
    return htmlDecode(stripTags(s)).replace(/\s+/g, " ").trim();
}

function cleanUrl(s) {
    return htmlDecode(safeStr(s))
        .replace(/^["']+|["']+$/g, "")
        .replace(/\\\//g, "/")
        .replace(/\\u0026/gi, "&")
        .trim();
}

function normalizeUrl(s, base) {
    s = cleanUrl(s);
    if (!s) return "";
    if (s.indexOf("//") === 0) return "https:" + s;
    if (/^https?:\/\//i.test(s)) return s;
    if (base && s.indexOf("/") === 0) {
        let m = safeStr(base).match(/^(https?:\/\/[^/]+)/i);
        if (m) return m[1] + s;
    }
    return s;
}

function isHttpUrl(s) {
    return /^https?:\/\//i.test(cleanUrl(s));
}

function isM3u8Url(url) {
    return /\.m3u8(?:$|[?#])/i.test(cleanUrl(url));
}

function extractVideoId(url) {
    try {
        let m = safeStr(url).match(REGEX_VIDEO_URL);
        return m ? m[1] : "";
    } catch (_) { return ""; }
}

function makeErr(msg) {
    try { return new ScriptException(msg); } catch (_) { return new Error(msg); }
}

function readBody(r) {
    let body = "";
    if (!r) return body;
    try { body = r.body; } catch (_) {}
    if (!body) { try { body = r.getBody(); } catch (_) {} }
    body = safeStr(body);
    if (body.length > MAX_HTML_SIZE) body = body.substring(0, MAX_HTML_SIZE);
    return body;
}

function pageHeaders() {
    return {
        "User-Agent": UA_DESKTOP,
        "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://ok.ru/",
        "Origin": "https://ok.ru"
    };
}

function httpGet(url, headers, auth) {
    try {
        let r = auth ? http.GET(url, headers || pageHeaders(), true) : http.GET(url, headers || pageHeaders());
        return readBody(r);
    } catch (e) {
        addDebug("httpGet: " + e);
        return "";
    }
}

function httpPost(url, body, headers, auth) {
    try {
        let h = pageHeaders();
        h["Content-Type"] = "application/x-www-form-urlencoded";
        h["Accept"] = "application/json, text/plain, */*";
        if (headers) {
            for (let k in headers) h[k] = headers[k];
        }
        let r = auth ? http.POST(url, body || "", h, true) : http.POST(url, body || "", h);
        return readBody(r);
    } catch (e) {
        addDebug("httpPost: " + e);
        return "";
    }
}

function tryParseJson(value) {
    if (value === null || value === undefined) return null;
    if (safeObj(value)) return value;
    let s = safeStr(value).trim();
    if (!s || (s.charAt(0) !== "{" && s.charAt(0) !== "[" && s.charAt(0) !== '"')) return null;
    for (let pass = 0; pass < 3; pass++) {
        try { return JSON.parse(s); } catch (_) {}
        let decoded = htmlDecode(s);
        if (decoded !== s) { s = decoded; continue; }
        if ((s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') ||
            (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'")) {
            s = s.substring(1, s.length - 1);
            continue;
        }
        break;
    }
    return null;
}

function rememberTitle(id, title) {
    id = safeStr(id);
    title = cleanText(title);
    if (!id || !title || /^OK\.ru video\b/i.test(title) || /^\d+$/.test(title)) return;
    if (!(id in TITLE_CACHE) && TITLE_CACHE_ORDER.length >= MAX_TITLE_CACHE) {
        delete TITLE_CACHE[TITLE_CACHE_ORDER.shift()];
    }
    if (!(id in TITLE_CACHE)) TITLE_CACHE_ORDER.push(id);
    TITLE_CACHE[id] = title;
}

function recallTitle(id) {
    id = safeStr(id);
    return id && TITLE_CACHE[id] ? TITLE_CACHE[id] : "";
}

function extractTitleParam(url) {
    try {
        let m = safeStr(url).match(/[?&]t=([^&]+)/);
        if (m) return cleanText(decodeURIComponent(m[1]));
    } catch (_) {}
    return "";
}

function getCachedDetails(id) {
    try {
        let x = DETAILS_CACHE[id];
        if (!x) return null;
        if (nowMs() - x.time > DETAILS_CACHE_TTL) {
            delete DETAILS_CACHE[id];
            return null;
        }
        return x.value || null;
    } catch (_) { return null; }
}

function putCachedDetails(id, value) {
    try {
        if (id && value) DETAILS_CACHE[id] = { time: nowMs(), value: value };
    } catch (_) {}
}

function looksLikeLoginWall(html) {
    return /st\.cmd=anonym|anonymLogin|anonymMain|st\.email|st\.password|field_email|join ok|log in to ok|войти/i
        .test(safeStr(html));
}

/* ---------- metadata: API JSON primero (el equivalente al player de YT) ---------- */

function metaPlayable(meta) {
    if (!safeObj(meta) || meta.error) return false;
    if (isM3u8Url(meta.hlsManifestUrl || meta.hlsMasterPlaylistUrl || meta.ondemandHls || meta.playlistUrl || "")) return true;
    return Array.isArray(meta.videos) && meta.videos.length > 0 && meta.videos[0] && meta.videos[0].url;
}

function fetchMetadataApi(id, auth) {
    let url = "https://ok.ru/dk?cmd=videoPlayerMetadata&mid=" + id;
    let body = httpPost(url, "mid=" + encodeURIComponent(id), {
        "Referer": "https://ok.ru/videoembed/" + id
    }, auth);
    let meta = tryParseJson(body);
    if (metaPlayable(meta)) {
        addDebug("metadata API " + (auth ? "auth" : "public") + " OK");
        return meta;
    }
    body = httpGet(url, pageHeaders(), auth);
    meta = tryParseJson(body);
    if (metaPlayable(meta)) {
        addDebug("metadata API GET " + (auth ? "auth" : "public") + " OK");
        return meta;
    }
    return null;
}

function extractMetadataFromHtml(html) {
    html = safeStr(html);
    if (!html) return null;

    let i = html.indexOf("hlsManifestUrl");
    if (i >= 0) {
        let slice = htmlDecode(html.substring(i, i + 700)).replace(/\\\//g, "/");
        let mm = /hlsManifestUrl"\s*:\s*"([^"]+)"/i.exec(slice);
        if (mm && isM3u8Url(mm[1])) {
            addDebug("html plan B hlsManifestUrl");
            return { hlsManifestUrl: cleanUrl(mm[1]) };
        }
    }

    let marker = html.indexOf("flashvars");
    if (marker < 0) marker = html.indexOf("data-options");
    if (marker < 0) return null;

    let start = html.lastIndexOf("data-options", marker);
    if (start < 0) start = Math.max(0, marker - 200);
    let chunk = html.substring(start, Math.min(html.length, start + 120000));
    let m = /data-options\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(chunk);
    if (!m) return null;
    let raw = m[1] !== undefined ? m[1] : m[2];
    let o = tryParseJson(raw);
    let fv = o && o.flashvars;
    if (!fv) return null;

    let meta = fv.metadata;
    if (typeof meta === "string") meta = tryParseJson(meta);
    if (metaPlayable(meta) || safeObj(meta)) return meta;

    let metaUrl = fv.metadataUrl || fv.metadataURL;
    if (metaUrl) {
        let fullUrl = normalizeUrl(metaUrl, "https://ok.ru/");
        addDebug("metadataUrl fallback");
        let body = httpPost(fullUrl, "", pageHeaders(), false);
        meta = tryParseJson(body);
        if (meta) return meta;
        body = httpGet(fullUrl, pageHeaders(), false);
        meta = tryParseJson(body);
        if (meta) return meta;
    }
    return null;
}

function batchGet(urls, authFlags) {
    try {
        if (!http.batch) return null;
        let batch = http.batch();
        for (let i = 0; i < urls.length; i++) {
            batch = batch.GET(urls[i], pageHeaders(), !!authFlags[i]);
        }
        let res = batch.execute();
        if (!res || !res.length) return null;
        let out = [];
        for (let j = 0; j < res.length; j++) out.push(readBody(res[j]));
        return out;
    } catch (e) {
        addDebug("batch: " + e);
        return null;
    }
}

function loadMetadata(id, pageUrl) {
    let t0 = nowMs();
    let meta = fetchMetadataApi(id, false);
    if (metaPlayable(meta)) {
        addDebug("fast path API " + (nowMs() - t0) + "ms");
        return { meta: meta, html: "" };
    }

    meta = fetchMetadataApi(id, true);
    if (metaPlayable(meta)) {
        addDebug("fast path API auth " + (nowMs() - t0) + "ms");
        return { meta: meta, html: "" };
    }

    let embed = "https://ok.ru/videoembed/" + id;
    let page = pageUrl || ("https://ok.ru/video/" + id);
    let bodies = batchGet([embed, page], [false, true]);
    if (!bodies) {
        bodies = [
            httpGet(embed, pageHeaders(), false),
            httpGet(embed, pageHeaders(), true)
        ];
    }

    let html = "";
    for (let i = 0; i < bodies.length; i++) {
        if (!bodies[i]) continue;
        if (!html) html = bodies[i];
        let parsed = extractMetadataFromHtml(bodies[i]);
        if (metaPlayable(parsed)) {
            addDebug("html fallback playable " + (nowMs() - t0) + "ms");
            return { meta: parsed, html: bodies[i] };
        }
        if (parsed && !meta) meta = parsed;
    }
    addDebug("metadata slow path " + (nowMs() - t0) + "ms");
    return { meta: meta, html: html };
}

/* ---------- fuentes ---------- */

const QUALITY_RANK = {
    "ultra": { height: 2160, order: 100 },
    "highest": { height: 1440, order: 95 },
    "quad": { height: 1440, order: 90 },
    "higher": { height: 1080, order: 85 },
    "full": { height: 1080, order: 80 },
    "fullhd": { height: 1080, order: 80 },
    "hd": { height: 720, order: 70 },
    "hdp": { height: 720, order: 70 },
    "sd": { height: 480, order: 50 },
    "sdp": { height: 480, order: 50 },
    "low": { height: 360, order: 30 },
    "lq": { height: 360, order: 30 },
    "lowest": { height: 240, order: 10 },
    "mobile": { height: 144, order: 5 }
};

function qualityInfo(label) {
    label = safeStr(label).toLowerCase().trim();
    return QUALITY_RANK[label] || null;
}

function estimateBitrate(height) {
    if (height >= 2160) return 15000000;
    if (height >= 1440) return 9000000;
    if (height >= 1080) return 5000000;
    if (height >= 720) return 2500000;
    if (height >= 480) return 1200000;
    if (height >= 360) return 700000;
    return 400000;
}

function collectHlsUrls(meta) {
    if (!safeObj(meta)) return [];
    let hls = meta.hlsManifestUrl || meta.hlsMasterPlaylistUrl || meta.ondemandHls || meta.playlistUrl || "";
    let url = normalizeUrl(hls, "https://ok.ru/");
    return isM3u8Url(url) ? [url] : [];
}

function collectMp4Urls(meta) {
    let urls = [];
    if (!safeObj(meta) || !Array.isArray(meta.videos)) return urls;
    for (let i = 0; i < meta.videos.length; i++) {
        let v = meta.videos[i];
        if (!v || !v.url) continue;
        let url = normalizeUrl(v.url);
        if (!isHttpUrl(url)) continue;
        let dup = false;
        for (let j = 0; j < urls.length; j++) {
            if (urls[j].url === url) { dup = true; break; }
        }
        if (dup || urls.length >= MAX_SOURCES) continue;
        urls.push({ url: url, label: safeStr(v.name || "") });
    }
    urls.sort(function (a, b) {
        let qa = qualityInfo(a.label);
        let qb = qualityInfo(b.label);
        return (qb ? qb.order : -1) - (qa ? qa.order : -1);
    });
    return urls;
}

function firstValue(obj, keys) {
    if (!safeObj(obj)) return "";
    for (let i = 0; i < keys.length; i++) {
        try {
            let v = obj[keys[i]];
            if (v === undefined || v === null || typeof v === "object") continue;
            let s = safeStr(v);
            if (s) return s;
        } catch (_) {}
    }
    return "";
}

function getTitle(meta, fallback, id) {
    let v = "";
    if (safeObj(meta) && safeObj(meta.movie)) {
        v = cleanText(meta.movie.title || meta.movie.name || "");
    }
    if (!v) {
        v = cleanText(firstValue(meta, ["title", "name", "movieTitle", "videoTitle", "caption"]));
    }
    if (v && (/^\d+$/.test(v) || (id && v === safeStr(id)))) v = "";
    let wrapped = /see video\s+["«“'](.+?)["»”']/i.exec(v);
    if (wrapped) v = cleanText(wrapped[1]);
    let fb = cleanText(fallback);
    if (/see video|on ok\.?\s*video player/i.test(v) && fb && !/see video/i.test(fb)) return fb;
    return v || fb || "OK.ru video";
}

function getPoster(meta) {
    if (safeObj(meta) && safeObj(meta.movie) && meta.movie.poster) return safeStr(meta.movie.poster);
    return firstValue(meta, ["poster", "posterUrl", "thumbnail", "thumbnailUrl", "cover", "image", "preview"]);
}

function getDuration(meta) {
    let v = "";
    if (safeObj(meta) && safeObj(meta.movie)) {
        v = firstValue(meta.movie, ["duration", "durationMs", "durationSec"]);
    }
    if (!v) v = firstValue(meta, ["duration", "durationMs", "durationSec", "length"]);
    let n = parseFloat(v);
    if (!isFinite(n) || n <= 0) return 0;
    if (n > 100000) n = n / 1000;
    return Math.round(n);
}

function getAuthorName(meta) {
    let direct = cleanText(firstValue(meta, ["authorName", "author", "ownerName", "uploader", "userName"]));
    if (direct && typeof meta.author !== "object") return direct;
    if (direct && !safeObj(meta.author)) return direct;
    let containers = [meta.author, meta.owner, meta.user];
    for (let i = 0; i < containers.length; i++) {
        if (safeObj(containers[i])) {
            let n = firstValue(containers[i], ["name", "displayName", "fullName", "userName"]);
            if (n) return cleanText(n);
        }
    }
    return direct || "";
}

function getDescription(meta) {
    return cleanText(firstValue(meta, ["description", "desc", "text", "summary"]));
}

function makeHlsSource(url, duration) {
    try {
        return new HLSSource({
            name: "OK.ru Auto HLS",
            duration: duration || 0,
            url: url
        });
    } catch (e) {
        addDebug("HLSSource: " + e);
        return null;
    }
}

function makeMp4Source(url, duration, index, label) {
    try {
        let q = qualityInfo(label);
        let name = q
            ? ("OK.ru " + label.toUpperCase() + " (" + q.height + "p)")
            : ("OK.ru MP4 " + (index + 1));
        return new VideoUrlSource({
            width: q ? Math.round(q.height * 16 / 9) : 0,
            height: q ? q.height : 0,
            container: "video/mp4",
            codec: "",
            name: name,
            bitrate: q ? estimateBitrate(q.height) : 0,
            duration: duration || 0,
            url: url
        });
    } catch (e) {
        addDebug("VideoUrlSource: " + e);
        return null;
    }
}

function extractYouTubeId(value) {
    let x = safeStr(value).replace(/\\u002F/gi, "/").replace(/\\\//g, "/").replace(/&/gi, "&");
    let patterns = [
        /(?:youtube(?:-nocookie)?\.com\/(?:embed|shorts|live|v)\/)([A-Za-z0-9_-]{11})/i,
        /(?:youtube(?:-nocookie)?\.com\/watch\?(?:[^"'<>]*&)?v=)([A-Za-z0-9_-]{11})/i,
        /youtu\.be\/([A-Za-z0-9_-]{11})/i
    ];
    for (let i = 0; i < patterns.length; i++) {
        let m = x.match(patterns[i]);
        if (m) return m[1];
    }
    return "";
}

function extractExternalEmbed(value) {
    let yt = extractYouTubeId(value);
    if (yt) return { plugin: "YouTube", url: "https://www.youtube.com/watch?v=" + yt };
    return null;
}

function buildVideoDetails(meta, pageUrl, fallbackTitle, html) {
    if (!safeObj(meta)) throw new Error("No metadata");

    let id = extractVideoId(pageUrl);
    let title = getTitle(meta, fallbackTitle, id);
    let poster = normalizeUrl(getPoster(meta), pageUrl);
    let duration = getDuration(meta);
    let authorName = getAuthorName(meta) || "OK.ru";
    let hls = collectHlsUrls(meta);
    let mp4 = collectMp4Urls(meta);

    addDebug("sources hls=" + hls.length + " mp4=" + mp4.length);

    let sources = [];
    let best = mp4.length ? mp4[0] : null;
    let bestQ = best ? qualityInfo(best.label) : null;
    let mp4First = bestQ && bestQ.order >= 70;

    if (mp4First) {
        let src = makeMp4Source(best.url, duration, 0, best.label);
        if (src) sources.push(src);
    }
    for (let i = 0; i < hls.length && sources.length < MAX_SOURCES; i++) {
        let src = makeHlsSource(hls[i], duration);
        if (src) {
            src.name = "OK.ru Auto HLS";
            sources.push(src);
        }
    }
    for (let j = 0; j < mp4.length && sources.length < MAX_SOURCES; j++) {
        if (mp4First && j === 0) continue;
        let src = makeMp4Source(mp4[j].url, duration, j, mp4[j].label);
        if (src) sources.push(src);
    }

    if (!sources.length) {
        let ext = extractExternalEmbed(html) || extractExternalEmbed(safeStr(meta.provider));
        if (!ext) {
            try { ext = extractExternalEmbed(JSON.stringify(meta)); } catch (_) {}
        }
        if (ext) {
            throw makeErr("Este video esta en " + ext.plugin + ". Buscalo alla:\n" + ext.url);
        }
        throw makeErr("OK.ru: este video no expone fuentes reproducibles.\n" + debugText());
    }

    let thumbs = [];
    if (poster && isHttpUrl(poster)) {
        try { thumbs.push(new Thumbnail(poster, 0)); } catch (_) {}
    }
    let thumbnails;
    try { thumbnails = new Thumbnails(thumbs); } catch (_) { thumbnails = new Thumbnails([]); }

    let author = null;
    try {
        author = new PlatformAuthorLink(
            new PlatformID(PLATFORM_NAME, "", PLUGIN_ID),
            authorName,
            "https://ok.ru/",
            "",
            0
        );
    } catch (_) {}

    let descriptor = null;
    try {
        descriptor = new MuxVideoSourceDescriptor({ isUnMuxed: false, videoSources: sources });
    } catch (e) {
        try { descriptor = new VideoSourceDescriptor(sources); } catch (e2) {
            addDebug("descriptor: " + e2);
        }
    }
    if (!descriptor) throw new Error("No video source descriptor\n" + debugText());

    let firstHls = hls.length ? makeHlsSource(hls[0], duration) : null;

    return new PlatformVideoDetails({
        id: new PlatformID(PLATFORM_NAME, id || "0", PLUGIN_ID),
        name: title,
        thumbnails: thumbnails,
        author: author,
        uploadDate: 0,
        url: pageUrl,
        duration: duration,
        viewCount: 0,
        isLive: false,
        description: getDescription(meta),
        video: descriptor,
        dash: null,
        hls: firstHls,
        live: []
    });
}

/* ---------- busqueda: 1 request, 1 pasada ---------- */

function isGenericTitle(t) {
    t = cleanText(t || "").toLowerCase().replace(/[.\u2026:!]+$/g, "").trim();
    if (!t || t.length < 2) return true;
    if (/^[\d:\s]+$/.test(t)) return true;
    if (/^(view|views|ver|watch|play|reproducir|image|video|videos|more|next|previous|menu)$/.test(t)) return true;
    if (/^(view|ver|watch)(\s+video)?$/i.test(t)) return true;
    return false;
}

function titleNear(html, index) {
    let start = Math.max(0, index - 420);
    let end = Math.min(html.length, index + 520);
    let block = html.substring(start, end);
    let patterns = [
        /\btitle\s*=\s*["']([^"']{2,300})["']/i,
        /\baria-label\s*=\s*["']([^"']{2,300})["']/i,
        /\balt\s*=\s*["']([^"']{2,300})["']/i,
        /class=["'][^"']*(?:title|name|caption)[^"']*["'][^>]*>([^<]{2,300})</i
    ];
    for (let i = 0; i < patterns.length; i++) {
        let m = patterns[i].exec(block);
        if (!m) continue;
        let t = cleanText(m[1]);
        if (t && !isGenericTitle(t)) return { title: t, block: block };
    }
    return { title: "", block: block };
}

function posterNear(block) {
    let pm = /(?:src|data-src|data-lazy-src|poster)\s*=\s*["']([^"']+)["']/i.exec(block);
    if (pm) return normalizeUrl(pm[1]);
    return "";
}

function extractSearchResults(html) {
    let results = [];
    let seen = {};
    html = safeStr(html);
    let re = /\/(?:video|videoembed)\/(\d+)/gi;
    let m;
    while ((m = re.exec(html)) !== null && results.length < MAX_SEARCH) {
        let id = m[1];
        if (seen[id]) continue;
        seen[id] = true;
        let near = titleNear(html, m.index);
        if (/youtube\.com|youtu\.be/i.test(near.block) && extractYouTubeId(near.block)) continue;
        let title = near.title || ("OK.ru video " + id);
        rememberTitle(id, title);
        let url = "https://ok.ru/video/" + id;
        if (!/^OK\.ru video\b/i.test(title)) url += "?t=" + encodeURIComponent(title);
        results.push({
            id: id,
            url: url,
            title: title,
            thumbnail: posterNear(near.block),
            duration: 0
        });
    }
    return results;
}

function makeSearchVideo(r) {
    try { rememberTitle(r.id, r.title); } catch (_) {}
    let thumbs = [];
    if (isHttpUrl(r.thumbnail)) {
        try { thumbs.push(new Thumbnail(r.thumbnail, 0)); } catch (_) {}
    }
    let thumbnails;
    try { thumbnails = new Thumbnails(thumbs); } catch (_) { thumbnails = new Thumbnails([]); }
    let author = null;
    try {
        author = new PlatformAuthorLink(
            new PlatformID(PLATFORM_NAME, "", PLUGIN_ID),
            "OK.ru",
            "https://ok.ru/",
            "",
            0
        );
    } catch (_) {}
    try {
        return new PlatformVideo({
            id: new PlatformID(PLATFORM_NAME, r.id, PLUGIN_ID),
            name: r.title,
            thumbnails: thumbnails,
            author: author,
            uploadDate: 0,
            url: r.url,
            duration: r.duration || 0,
            viewCount: 0,
            isLive: false
        });
    } catch (_) { return null; }
}

function fetchSearchPage(query, page) {
    let url = SEARCH_URL_BASE + encodeURIComponent(safeStr(query));
    if (page > 1) url += "&st.page=" + page;
    let headers = pageHeaders();
    let html = "";
    try {
        html = readBody(http.GET(url, headers, true));
    } catch (e) {
        addDebug("search sin sesion: " + e);
        throw makeErr(LOGIN_MSG);
    }
    addDebug("search p" + page + " bytes=" + (html ? html.length : 0));
    let hasVideos = /\/(?:video|videoembed)\/\d+/i.test(html);
    if (!hasVideos && (page <= 1 || looksLikeLoginWall(html))) throw makeErr(LOGIN_MSG);
    return html || "";
}

function searchOk(query, continuationToken) {
    let page = 1;
    try {
        if (continuationToken && typeof continuationToken === "object") {
            page = Math.max(1, Number(continuationToken.page) || 1);
        } else if (continuationToken) {
            page = Math.max(1, Number(continuationToken) || 1);
        }
    } catch (_) {}

    let html = fetchSearchPage(query, page);
    if (!html) throw new Error("OK.ru search returned no data");
    let found = extractSearchResults(html);
    let out = [];
    for (let i = 0; i < found.length; i++) {
        let v = makeSearchVideo(found[i]);
        if (v) out.push(v);
    }
    return new OkSearchPager(out, found.length > 0, {
        query: safeStr(query),
        page: page + 1
    });
}

class OkSearchPager extends VideoPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
    }
    nextPage() {
        if (!this.hasMorePagers()) return this;
        return searchOk(this.context.query, this.context.page);
    }
}

function doDetails(url) {
    resetDebug();
    let tStart = nowMs();
    let id = extractVideoId(url);
    if (!id) throw new Error("Invalid OK.ru video URL");

    let cached = getCachedDetails(id);
    if (cached) {
        let requestedTitle = extractTitleParam(url);
        if (requestedTitle && !/^OK\.ru video\b/i.test(requestedTitle)) {
            try { cached.name = requestedTitle; rememberTitle(id, requestedTitle); } catch (_) {}
        }
        return cached;
    }

    let canonical = "https://ok.ru/video/" + id;
    let loaded = loadMetadata(id, canonical);
    if (!loaded.meta) {
        throw new Error("OK.ru metadata not found.\n" + debugText());
    }

    let fallbackTitle =
        extractTitleParam(url) ||
        recallTitle(id) ||
        ("OK.ru video " + id);

    let details = buildVideoDetails(loaded.meta, canonical, fallbackTitle, loaded.html);
    putCachedDetails(id, details);
    addDebug("doDetails " + (nowMs() - tStart) + "ms");
    return details;
}

/* ------------------------- GrayJay ------------------------- */

source.setSettings = function () {};
source.enable = function () { return true; };

source.getSearchCapabilities = function () {
    try { return new ResultCapabilities(["video"], [], []); }
    catch (_) { return { types: ["video"], sorts: [], filters: [] }; }
};

source.search = function (query, type, order, filters, continuationToken) {
    return searchOk(query, continuationToken);
};

source.searchSuggestions = function () {
    return [];
};

source.isContentDetailsUrl = function (url) {
    return REGEX_VIDEO_URL.test(safeStr(url));
};
source.isVideoDetailsUrl = function (url) {
    return REGEX_VIDEO_URL.test(safeStr(url));
};
source.getVideoDetails = function (url) { return doDetails(url); };
source.getContentDetails = function (url) { return doDetails(url); };

class OkHomePager extends VideoPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
    }
    nextPage() { return this; }
}

source.getHome = function () {
    return new OkHomePager([], false, {});
};
source.isChannelUrl = function () { return false; };
