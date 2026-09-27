/*
 * GrayJay - OK.ru Source v23
 *
 * OK.ru público:
 *  - NO usa cookies incrustadas
 *  - NO requiere login del usuario
 *  - Busca directamente en OK.ru
 *  - Extrae videos públicos de los resultados
 *  - /videoembed/<id> -> data-options -> metadata
 *  - metadataUrl como fallback
 *  - HLS preferido
 *  - MP4 por calidad como fallback
 *  - Sin player pages como fuentes
 *
 * Compatible con ES5.
 */

var PLATFORM_NAME = "OK.ru";
var PLUGIN_ID = "62af0e2f-bfd9-489f-afe1-f66583d2f7d0";

var UA_DESKTOP =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/136.0.0.0 Safari/537.36";

var UA_MOBILE =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/136.0.0.0 Mobile Safari/537.36";

var OK_RANK = {
    "ultra": 7,
    "quad": 6,
    "full": 5,
    "hd": 4,
    "sd": 3,
    "low": 2,
    "lowest": 1,
    "mobile": 0
};

var OK_LABEL = {
    "ultra": "2160p",
    "quad": "1440p",
    "full": "1080p",
    "hd": "720p",
    "sd": "480p",
    "low": "360p",
    "lowest": "240p",
    "mobile": "144p"
};

var REGEX_VIDEO_URL =
    /ok\.ru\/(?:video|videoembed|live)\/(\d+)/i;

var SEARCH_URL_BASE =
    "https://ok.ru/search/content?q=";

var MAX_HTML_SIZE = 5000000;
var MAX_RESULTS = 96;
var MAX_SOURCES = 30;
var MAX_DEBUG = 50;
var MAX_JSON_DEPTH = 12;

var DEBUG = [];

function safeStr(v) {
    try {
        if (v === null || v === undefined) return "";
        return String(v);
    } catch (_) {
        return "";
    }
}

function safeObj(v) {
    return v !== null && typeof v === "object";
}

function logDebug(v) {
    try {
        var s = safeStr(v);
        if (!s) return;

        if (DEBUG.length >= MAX_DEBUG) {
            DEBUG.shift();
        }

        DEBUG.push(
            s.length > 500
                ? s.substring(0, 500) + "..."
                : s
        );
    } catch (_) {}
}

function resetDebug() {
    DEBUG = [];
}

function htmlUnescape(s) {
    return safeStr(s)
        .replace(/&quot;/gi, '"')
        .replace(/&#34;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#x2F;/gi, "/")
        .replace(/&#47;/g, "/");
}

function cleanText(s) {
    return htmlUnescape(safeStr(s))
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function cleanUrl(s) {
    return htmlUnescape(safeStr(s))
        .replace(/\\\//g, "/")
        .replace(/^["']+|["']+$/g, "")
        .trim();
}

function normalizeUrl(s, base) {
    s = cleanUrl(s);

    if (!s) return "";

    if (s.indexOf("//") === 0) {
        return "https:" + s;
    }

    if (/^https?:\/\//i.test(s)) {
        return s;
    }

    if (base && s.charAt(0) === "/") {
        var m = safeStr(base).match(
            /^(https?:\/\/[^\/]+)/i
        );

        if (m) {
            return m[1] + s;
        }
    }

    return s;
}

function isHttpUrl(s) {
    return /^https?:\/\//i.test(cleanUrl(s));
}

function isM3u8Url(s) {
    return /\.m3u8(?:$|[?#])/i.test(
        cleanUrl(s)
    );
}

function getHost(url) {
    try {
        var m = safeStr(url).match(
            /^https?:\/\/([^\/]+)/i
        );

        return m ? m[1].toLowerCase() : "";
    } catch (_) {
        return "";
    }
}

function httpGet(url, ref) {
    try {
        var headers = {
            "User-Agent": UA_DESKTOP,
            "Accept":
                "text/html,application/xhtml+xml," +
                "application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache"
        };

        if (ref) {
            headers["Referer"] = ref;
        }

        var r = http.GET(url, headers);

        if (!r) return "";

        var body = "";

        try {
            body = r.body;
        } catch (_) {}

        if (!body) {
            try {
                body = r.getBody();
            } catch (_) {}
        }

        body = safeStr(body);

        if (body.length > MAX_HTML_SIZE) {
            body = body.substring(0, MAX_HTML_SIZE);
        }

        return body;
    } catch (e) {
        logDebug("GET: " + e);
        return "";
    }
}

function httpGetMobile(url, ref) {
    try {
        var headers = {
            "User-Agent": UA_MOBILE,
            "Accept":
                "text/html,application/xhtml+xml," +
                "application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9"
        };

        if (ref) {
            headers["Referer"] = ref;
        }

        var r = http.GET(url, headers);

        if (!r) return "";

        var body = "";

        try {
            body = r.body;
        } catch (_) {}

        if (!body) {
            try {
                body = r.getBody();
            } catch (_) {}
        }

        body = safeStr(body);

        if (body.length > MAX_HTML_SIZE) {
            body = body.substring(0, MAX_HTML_SIZE);
        }

        return body;
    } catch (_) {
        return "";
    }
}

function loadPage(url) {
    var body = httpGet(url, "https://ok.ru/");

    if (body && body.length > 300) {
        return body;
    }

    body = httpGetMobile(
        url,
        "https://ok.ru/"
    );

    return body || "";
}

function tryParseJson(value) {
    if (value === null || value === undefined) {
        return null;
    }

    if (safeObj(value)) {
        return value;
    }

    var s = safeStr(value).trim();

    if (!s) return null;

    for (var i = 0; i < 5; i++) {
        try {
            return JSON.parse(s);
        } catch (_) {}

        var decoded = htmlUnescape(s);

        if (decoded !== s) {
            s = decoded;
            continue;
        }

        if (
            (s.charAt(0) === '"' &&
                s.charAt(s.length - 1) === '"') ||
            (s.charAt(0) === "'" &&
                s.charAt(s.length - 1) === "'")
        ) {
            s = s.substring(1, s.length - 1);
            continue;
        }

        var unescaped = s
            .replace(/\\"/g, '"')
            .replace(/\\'/g, "'")
            .replace(/\\\\/g, "\\");

        if (unescaped !== s) {
            s = unescaped;
            continue;
        }

        break;
    }

    return null;
}

function extractVideoId(url) {
    var m = safeStr(url).match(
        REGEX_VIDEO_URL
    );

    if (m) return m[1];

    m = safeStr(url).match(
        /[?&](?:id|mid)=(\d+)/i
    );

    return m ? m[1] : "";
}

function extractDataOptions(html) {
    var result = [];

    var re =
        /(?:data-options|data-options-json)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

    var m;

    while (
        (m = re.exec(html || "")) !== null &&
        result.length < 20
    ) {
        var raw =
            m[1] !== undefined
                ? m[1]
                : m[2];

        var obj = tryParseJson(raw);

        if (obj) {
            result.push(obj);
        }
    }

    return result;
}

function findMetadata(root, depth) {
    if (!safeObj(root)) return null;

    if (depth > MAX_JSON_DEPTH) {
        return null;
    }

    if (Array.isArray(root)) {
        for (var i = 0; i < root.length; i++) {
            var a = findMetadata(
                root[i],
                depth + 1
            );

            if (a) return a;
        }

        return null;
    }

    var preferred = [
        "metadata",
        "flashvars",
        "video",
        "movie",
        "movieData",
        "data",
        "result"
    ];

    for (var p = 0; p < preferred.length; p++) {
        var key = preferred[p];

        try {
            if (root[key] !== undefined) {
                if (
                    key === "metadata" &&
                    safeObj(root[key])
                ) {
                    return root[key];
                }

                var found = findMetadata(
                    root[key],
                    depth + 1
                );

                if (found) {
                    return found;
                }
            }
        } catch (_) {}
    }

    try {
        if (
            root.metadataUrl ||
            root.metadataURL
        ) {
            return root;
        }
    } catch (_) {}

    try {
        for (var k in root) {
            if (
                /metadata|flashvar|video|movie|media|stream|playlist/i
                    .test(k)
            ) {
                var f = findMetadata(
                    root[k],
                    depth + 1
                );

                if (f) return f;
            }
        }
    } catch (_) {}

    return null;
}

function extractMetadata(html) {
    html = safeStr(html);

    var options =
        extractDataOptions(html);

    for (var i = 0; i < options.length; i++) {
        var found = findMetadata(
            options[i],
            0
        );

        if (found) {
            return found;
        }
    }

    /*
     * Fallback directo:
     * buscar hlsManifestUrl en la página.
     */
    var decoded = htmlUnescape(html)
        .replace(/\\\\u0026/g, "&")
        .replace(/\\u0026/g, "&")
        .replace(/\\\\\//g, "/")
        .replace(/\\\//g, "/")
        .replace(/\\"/g, '"');

    var hls =
        decoded.match(
            /"hlsManifestUrl"\s*:\s*"([^"]+)"/i
        );

    if (hls) {
        return {
            hlsManifestUrl: hls[1]
        };
    }

    var hls2 =
        decoded.match(
            /"hlsMasterPlaylistUrl"\s*:\s*"([^"]+)"/i
        );

    if (hls2) {
        return {
            hlsMasterPlaylistUrl: hls2[1]
        };
    }

    return null;
}

function fetchMetadataUrl(meta, pageUrl) {
    if (!safeObj(meta)) {
        return null;
    }

    var candidates = [];

    if (meta.metadataUrl) {
        candidates.push(meta.metadataUrl);
    }

    if (meta.metadataURL) {
        candidates.push(meta.metadataURL);
    }

    if (
        meta.flashvars &&
        meta.flashvars.metadataUrl
    ) {
        candidates.push(
            meta.flashvars.metadataUrl
        );
    }

    if (
        meta.flashvars &&
        meta.flashvars.metadataURL
    ) {
        candidates.push(
            meta.flashvars.metadataURL
        );
    }

    for (var i = 0; i < candidates.length; i++) {
        var url = normalizeUrl(
            candidates[i],
            pageUrl
        );

        if (!isHttpUrl(url)) {
            continue;
        }

        logDebug(
            "metadataUrl: " + url
        );

        var body = httpGet(
            url,
            pageUrl
        );

        if (!body) {
            body = httpGetMobile(
                url,
                pageUrl
            );
        }

        var obj = tryParseJson(body);

        if (obj) {
            return (
                findMetadata(obj, 0) ||
                obj
            );
        }
    }

    return null;
}

function parseMetadata(html, pageUrl) {
    var meta =
        extractMetadata(html);

    if (!meta) {
        return null;
    }

    /*
     * Si ya tenemos HLS o videos[] no necesitamos
     * otra petición.
     */
    if (
        meta.hlsManifestUrl ||
        meta.hlsMasterPlaylistUrl ||
        meta.ondemandHls ||
        (
            Array.isArray(meta.videos) &&
            meta.videos.length
        )
    ) {
        return meta;
    }

    var fetched =
        fetchMetadataUrl(
            meta,
            pageUrl
        );

    return fetched || meta;
}

function firstValue(obj, keys) {
    if (!safeObj(obj)) {
        return "";
    }

    for (var i = 0; i < keys.length; i++) {
        try {
            var v = obj[keys[i]];

            if (
                v === undefined ||
                v === null ||
                typeof v === "object"
            ) {
                continue;
            }

            var s = safeStr(v);

            if (s) return s;
        } catch (_) {}
    }

    return "";
}

function addUniqueSource(
    out,
    src
) {
    if (!src) return;

    src = normalizeUrl(src);

    if (!isHttpUrl(src)) {
        return;
    }

    for (var i = 0; i < out.length; i++) {
        if (out[i] === src) {
            return;
        }
    }

    if (out.length < MAX_SOURCES) {
        out.push(src);
    }
}

function getDuration(meta) {
    var v = firstValue(
        meta,
        [
            "duration",
            "durationMs",
            "durationSec",
            "length",
            "videoDuration"
        ]
    );

    var n = parseFloat(v);

    if (!isFinite(n) || n <= 0) {
        return 0;
    }

    if (n > 1000) {
        n = n / 1000;
    }

    return Math.round(n);
}

function getTitle(meta, html, id) {
    var title = firstValue(
        meta,
        [
            "title",
            "name",
            "movieTitle",
            "videoTitle",
            "caption"
        ]
    );

    title = cleanText(title);

    if (
        !title ||
        /^\d+$/.test(title) ||
        title === id
    ) {
        title = "";
    }

    if (!title) {
        var m =
            safeStr(html).match(
                /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
            );

        if (m) {
            title = cleanText(m[1]);
        }
    }

    if (!title) {
        m =
            safeStr(html).match(
                /<title[^>]*>([\s\S]*?)<\/title>/i
            );

        if (m) {
            title = cleanText(m[1])
                .replace(
                    /\s*[|\-–]\s*OK\.?RU.*$/i,
                    ""
                )
                .trim();
        }
    }

    return (
        title ||
        "OK.ru video " + id
    );
}

function getPoster(meta, html) {
    var poster = firstValue(
        meta,
        [
            "poster",
            "posterUrl",
            "thumbnail",
            "thumbnailUrl",
            "cover",
            "coverUrl",
            "image",
            "imageUrl",
            "preview"
        ]
    );

    if (poster) {
        return normalizeUrl(poster);
    }

    var m =
        safeStr(html).match(
            /property=["']og:image["'][^>]+content=["']([^"']+)["']/i
        );

    return m
        ? normalizeUrl(m[1])
        : "";
}

function collectHls(meta) {
    var out = [];

    var direct = [
        meta.hlsManifestUrl,
        meta.hlsMasterPlaylistUrl,
        meta.ondemandHls,
        meta.hlsUrl,
        meta.playlistUrl,
        meta.manifestUrl
    ];

    for (var i = 0; i < direct.length; i++) {
        if (isM3u8Url(direct[i])) {
            addUniqueSource(
                out,
                direct[i]
            );
        }
    }

    return out;
}

function collectVideos(meta) {
    var out = [];

    if (
        !safeObj(meta) ||
        !Array.isArray(meta.videos)
    ) {
        return out;
    }

    var vids =
        meta.videos.slice(0);

    vids.sort(
        function (a, b) {
            return (
                (OK_RANK[b.name] || 0) -
                (OK_RANK[a.name] || 0)
            );
        }
    );

    for (
        var i = 0;
        i < vids.length;
        i++
    ) {
        if (
            vids[i] &&
            vids[i].url
        ) {
            addUniqueSource(
                out,
                vids[i].url
            );
        }
    }

    return out;
}

function makeHlsSource(
    url,
    duration
) {
    try {
        return new HLSSource({
            name: "OK.ru HLS",
            duration: duration || 0,
            url: normalizeUrl(url)
        });
    } catch (_) {}

    return null;
}

function makeMp4Source(
    url,
    duration,
    label,
    index
) {
    try {
        var name =
            "OK.ru " +
            (label || "MP4");

        return new VideoUrlSource({
            width: 0,
            height: 0,
            container: "mp4",
            codec: "",
            name: name,
            bitrate: 0,
            duration: duration || 0,
            url: normalizeUrl(url)
        });
    } catch (_) {}

    return null;
}

function buildDetails(
    meta,
    pageUrl,
    html
) {
    var id =
        extractVideoId(pageUrl);

    var title =
        getTitle(
            meta,
            html,
            id
        );

    var poster =
        getPoster(
            meta,
            html
        );

    var duration =
        getDuration(meta);

    var hls =
        collectHls(meta);

    var mp4 =
        collectVideos(meta);

    logDebug(
        "OK.ru sources: HLS=" +
        hls.length +
        " MP4=" +
        mp4.length
    );

    var sources = [];

    /*
     * HLS primero.
     */
    for (
        var i = 0;
        i < hls.length &&
        sources.length < MAX_SOURCES;
        i++
    ) {
        var hs =
            makeHlsSource(
                hls[i],
                duration
            );

        if (hs) {
            sources.push(hs);
        }
    }

    /*
     * MP4 como fallback.
     */
    for (
        var j = 0;
        j < mp4.length &&
        sources.length < MAX_SOURCES;
        j++
    ) {
        var label =
            "MP4 " + (j + 1);

        var ms =
            makeMp4Source(
                mp4[j],
                duration,
                label,
                j
            );

        if (ms) {
            sources.push(ms);
        }
    }

    if (!sources.length) {
        throw new Error(
            "OK.ru no devolvió una fuente HLS/MP4.\n" +
            DEBUG.join("\n")
        );
    }

    var thumbs = [];

    if (poster && isHttpUrl(poster)) {
        try {
            thumbs.push(
                new Thumbnail(
                    poster,
                    0
                )
            );
        } catch (_) {}
    }

    var thumbnails;

    try {
        thumbnails =
            new Thumbnails(
                thumbs
            );
    } catch (_) {
        thumbnails =
            new Thumbnails([]);
    }

    var author = null;

    try {
        author =
            new PlatformAuthorLink(
                new PlatformID(
                    PLATFORM_NAME,
                    "",
                    PLUGIN_ID
                ),
                "OK.ru",
                "https://ok.ru/",
                "",
                0
            );
    } catch (_) {}

    var descriptor = null;

    try {
        descriptor =
            new MuxVideoSourceDescriptor({
                isUnMuxed: false,
                videoSources: sources
            });
    } catch (_) {
        try {
            descriptor =
                new VideoSourceDescriptor(
                    sources
                );
        } catch (__) {}
    }

    if (!descriptor) {
        throw new Error(
            "No se pudo crear VideoSourceDescriptor"
        );
    }

    var firstHls = null;

    if (hls.length) {
        firstHls =
            makeHlsSource(
                hls[0],
                duration
            );
    }

    return new PlatformVideoDetails({
        id: new PlatformID(
            PLATFORM_NAME,
            id,
            PLUGIN_ID
        ),
        name: title,
        thumbnails: thumbnails,
        author: author,
        uploadDate: 0,
        url: pageUrl,
        duration: duration,
        viewCount: 0,
        isLive: false,
        description: "",
        video: descriptor,
        dash: null,
        hls: firstHls,
        live: []
    });
}

/* =========================================================
 * OK.ru SEARCH
 * ========================================================= */

function extractSearchTitle(block) {
    var patterns = [
        /data-title\s*=\s*["']([^"']{2,500})["']/i,
        /data-name\s*=\s*["']([^"']{2,500})["']/i,
        /title\s*=\s*["']([^"']{2,500})["']/i,
        /<span[^>]*class=["'][^"']*(?:title|caption)[^"']*["'][^>]*>([\s\S]{1,500}?)<\/span>/i
    ];

    for (
        var i = 0;
        i < patterns.length;
        i++
    ) {
        var m =
            safeStr(block).match(
                patterns[i]
            );

        if (m) {
            var t =
                cleanText(m[1]);

            if (
                t &&
                !/^(image|video|play|menu|more|next|previous)$/i.test(t)
            ) {
                return t;
            }
        }
    }

    return "";
}

function extractSearchPoster(block) {
    var m =
        safeStr(block).match(
            /<(?:img|source)[^>]+(?:src|data-src|data-lazy-src|poster)\s*=\s*["']([^"']+)["']/i
        );

    if (m) {
        return normalizeUrl(
            m[1]
        );
    }

    return "";
}

function addSearchResult(
    results,
    seen,
    id,
    block,
    explicitTitle
) {
    if (!id) return;

    if (seen[id]) return;

    if (
        results.length >= MAX_RESULTS
    ) {
        return;
    }

    var title =
        cleanText(
            explicitTitle || ""
        );

    if (!title) {
        title =
            extractSearchTitle(
                block
            );
    }

    if (!title) {
        title =
            "OK.ru video " + id;
    }

    /*
     * No agregamos embeds externos.
     */
    if (
        /youtube(?:-nocookie)?\.com|youtu\.be|vimeo\.com/i.test(
            block
        )
    ) {
        return;
    }

    seen[id] = true;

    results.push({
        id: id,
        title: title,
        url:
            "https://ok.ru/video/" +
            id,
        thumbnail:
            extractSearchPoster(block),
        duration: 0
    });
}

function extractSearchResults(
    html
) {
    var results = [];
    var seen = {};

    html = safeStr(html);

    var m;

    /*
     * 1. Links directos a /video/ID
     */
    var re =
        /<a\b([^>]*?href\s*=\s*["'](?:https?:\/\/[^"']+)?\/(?:video|videoembed)\/(\d+)(?:[?#][^"']*)?["'][^>]*)>([\s\S]*?)<\/a>/gi;

    while (
        (m = re.exec(html)) !== null &&
        results.length < MAX_RESULTS
    ) {
        var start =
            Math.max(
                0,
                m.index - 500
            );

        var end =
            Math.min(
                html.length,
                re.lastIndex + 600
            );

        addSearchResult(
            results,
            seen,
            m[2],
            html.substring(
                start,
                end
            ),
            m[3]
        );
    }

    /*
     * 2. data-video-id
     */
    var re2 =
        /(?:data-video-id|data-movie-id|data-content-id)\s*=\s*["']?(\d+)["']?/gi;

    while (
        (m = re2.exec(html)) !== null &&
        results.length < MAX_RESULTS
    ) {
        var s2 =
            Math.max(
                0,
                m.index - 500
            );

        var e2 =
            Math.min(
                html.length,
                re2.lastIndex + 700
            );

        addSearchResult(
            results,
            seen,
            m[1],
            html.substring(
                s2,
                e2
            ),
            ""
        );
    }

    /*
     * 3. URLs escapadas dentro de JSON.
     */
    var re3 =
        /(?:https?:)?\\?\/\\?\/(?:www\.)?ok\.ru\\?\/(?:video|videoembed)\\?\/(\d+)/gi;

    while (
        (m = re3.exec(html)) !== null &&
        results.length < MAX_RESULTS
    ) {
        var s3 =
            Math.max(
                0,
                m.index - 500
            );

        var e3 =
            Math.min(
                html.length,
                re3.lastIndex + 600
            );

        addSearchResult(
            results,
            seen,
            m[1],
            html.substring(
                s3,
                e3
            ),
            ""
        );
    }

    /*
     * 4. /video/ID suelto.
     */
    var re4 =
        /(?:^|["'(\s])\/video\/(\d+)(?:[?#"'()\s]|$)/gi;

    while (
        (m = re4.exec(html)) !== null &&
        results.length < MAX_RESULTS
    ) {
        var s4 =
            Math.max(
                0,
                m.index - 500
            );

        var e4 =
            Math.min(
                html.length,
                re4.lastIndex + 600
            );

        addSearchResult(
            results,
            seen,
            m[1],
            html.substring(
                s4,
                e4
            ),
            ""
        );
    }

    return results;
}

function makeSearchVideo(
    item
) {
    var thumbs = [];

    if (
        item.thumbnail &&
        isHttpUrl(item.thumbnail)
    ) {
        try {
            thumbs.push(
                new Thumbnail(
                    item.thumbnail,
                    0
                )
            );
        } catch (_) {}
    }

    var thumbnails;

    try {
        thumbnails =
            new Thumbnails(
                thumbs
            );
    } catch (_) {
        thumbnails =
            new Thumbnails([]);
    }

    var author = null;

    try {
        author =
            new PlatformAuthorLink(
                new PlatformID(
                    PLATFORM_NAME,
                    "",
                    PLUGIN_ID
                ),
                "OK.ru",
                "https://ok.ru/",
                "",
                0
            );
    } catch (_) {}

    try {
        return new PlatformVideo({
            id: new PlatformID(
                PLATFORM_NAME,
                item.id,
                PLUGIN_ID
            ),
            name: item.title,
            thumbnails: thumbnails,
            author: author,
            uploadDate: 0,
            url: item.url,
            duration: item.duration || 0,
            viewCount: 0,
            isLive: false
        });
    } catch (_) {
        return null;
    }
}

function searchOk(
    query,
    continuationToken
) {
    var page = 1;

    try {
        if (
            continuationToken &&
            typeof continuationToken === "object"
        ) {
            page =
                Number(
                    continuationToken.page
                ) || 1;
        } else if (
            continuationToken
        ) {
            page =
                Number(
                    continuationToken
                ) || 1;
        }
    } catch (_) {}

    var url =
        SEARCH_URL_BASE +
        encodeURIComponent(
            safeStr(query)
        );

    /*
     * OK.ru usa diferentes variantes
     * del buscador. Intentamos primero
     * content search y luego searchResult.
     */
    var html =
        loadPage(url);

    if (!html) {
        var fallback =
            "https://ok.ru/dk?st.cmd=searchResult" +
            "&st.mode=Movie" +
            "&st.grmode=Groups" +
            "&st.query=" +
            encodeURIComponent(
                safeStr(query)
            );

        html =
            loadPage(fallback);
    }

    if (!html) {
        throw new Error(
            "OK.ru no devolvió resultados de búsqueda"
        );
    }

    var raw =
        extractSearchResults(
            html
        );

    var out = [];

    for (
        var i = 0;
        i < raw.length;
        i++
    ) {
        var v =
            makeSearchVideo(
                raw[i]
            );

        if (v) {
            out.push(v);
        }
    }

    /*
     * Como OK puede cambiar el HTML
     * del buscador, no inventamos paginación.
     * Si encontramos resultados suficientes,
     * permitimos pedir otra página.
     */
    var hasMore =
        raw.length >= 20;

    return new OkSearchPager(
        out,
        hasMore,
        {
            query: safeStr(query),
            page: page + 1
        }
    );
}

class OkSearchPager
    extends VideoPager {

    constructor(
        results,
        hasMore,
        context
    ) {
        super(
            results,
            hasMore,
            context
        );
    }

    nextPage() {
        if (
            !this.hasMorePagers()
        ) {
            return this;
        }

        return searchOk(
            this.context.query,
            this.context.page
        );
    }
}

/* =========================================================
 * VIDEO DETAILS
 * ========================================================= */

function doDetails(url) {
    resetDebug();

    var id =
        extractVideoId(url);

    if (!id) {
        throw new Error(
            "URL OK.ru inválida"
        );
    }

    /*
     * Siempre canonicalizamos.
     */
    var canonical =
        "https://ok.ru/video/" +
        id;

    /*
     * Primero videoembed porque suele
     * contener directamente data-options.
     */
    var embed =
        "https://ok.ru/videoembed/" +
        id;

    var html =
        loadPage(embed);

    if (!html) {
        html =
            loadPage(canonical);
    }

    if (!html) {
        throw new Error(
            "No se pudo cargar el video público de OK.ru"
        );
    }

    logDebug(
        "OK.ru video ID=" + id
    );

    var meta =
        parseMetadata(
            html,
            embed
        );

    if (!meta) {
        /*
         * Último intento directamente sobre
         * /video/.
         */
        html =
            loadPage(canonical);

        if (html) {
            meta =
                parseMetadata(
                    html,
                    canonical
                );
        }
    }

    if (!meta) {
        throw new Error(
            "OK.ru no entregó metadata reproducible\n" +
            DEBUG.join("\n")
        );
    }

    return buildDetails(
        meta,
        canonical,
        html
    );
}

/* =========================================================
 * GRAYJAY
 * ========================================================= */

source.setSettings =
    function (settings) {
        /*
         * No requiere sesión,
         * cookie ni configuración.
         */
    };

source.enable =
    function () {
        return true;
    };

source.getSearchCapabilities =
    function () {
        try {
            return new ResultCapabilities(
                ["video"],
                [],
                []
            );
        } catch (_) {
            return {
                types: ["video"],
                sorts: [],
                filters: []
            };
        }
    };

source.search =
    function (
        query,
        type,
        order,
        filters,
        continuationToken
    ) {
        return searchOk(
            query,
            continuationToken
        );
    };

source.searchSuggestions =
    function (query) {
        var out = [];

        try {
            var pager =
                searchOk(query);

            for (
                var i = 0;
                i < pager.results.length &&
                out.length < 10;
                i++
            ) {
                var title =
                    pager.results[i].name;

                if (title) {
                    out.push(title);
                }
            }
        } catch (_) {}

        return out;
    };

source.isContentDetailsUrl =
    function (url) {
        return REGEX_VIDEO_URL.test(
            safeStr(url)
        );
    };

source.isVideoDetailsUrl =
    function (url) {
        return REGEX_VIDEO_URL.test(
            safeStr(url)
        );
    };

source.getVideoDetails =
    function (url) {
        return doDetails(url);
    };

source.getContentDetails =
    function (url) {
        return doDetails(url);
    };

class OkHomePager
    extends VideoPager {

    constructor() {
        super([], false, {});
    }

    nextPage() {
        return this;
    }
}

source.getHome =
    function () {
        return new OkHomePager();
    };

source.isChannelUrl =
    function () {
        return false;
    };
