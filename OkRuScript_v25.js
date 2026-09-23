/*
 * GrayJay - OK.ru Source v11
 *
 * Objetivos:
 *  - Extraccion robusta OK.ru desktop/mobile.
 *  - HLS primero, con varias alternativas reales cuando OK.ru las expone.
 *  - MP4/M4V como fallback real, no como URL inventada.
 *  - Fuentes construidas con la API actual de GrayJay (objetos).
 *  - URLs directas: evita entregar paginas intermedias a Cast.
 *  - Busqueda y sugerencias.
 *  - Parseo tolerante de JSON, data-options, flashvars y metadataUrl.
 *  - Reconocimiento de los campos encontrados en el APK de XuperTv.
 *
 * IMPORTANTE SOBRE XUPER:
 * El APK real contiene los modelos/campos play_params, playlistUrl,
 * verificationToken y signdata. El analisis DEX muestra que son datos de
 * beans de request/result y que /startPlayVOD forma parte del flujo de VOD.
 * No se debe inventar una firma local ni un endpoint privado. Este plugin
 * consume playlistUrl/play_url/media_url cuando OK.ru o los metadatos ya los
 * entregan. El resolver privado no se simula.
 */

var PLATFORM_NAME = "OK.ru";
var PLUGIN_ID = "62af0e2f-bfd9-489f-afe1-f66583d2f7d0";
var REGEX_VIDEO_URL = /ok\.ru\/(?:video|videoembed)\/(\d+)/i;
var SEARCH_URL_BASES = [
    "https://ok.ru/video/search?st.cmd=anonymVideo&st.ft=search&st.gsq=",
    "https://ok.ru/dk?st.cmd=searchResult&st.mode=Movie&st.grmode=Groups&st.query="
];

var MAX_HTML_SIZE = 5000000;
var MAX_JSON_DEPTH = 14;
var MAX_SOURCES = 32;
var MAX_SEARCH = 24;
var MAX_DEBUG = 60;

var UA_DESKTOP =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
var UA_MOBILE =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36";

var DEBUG = [];

function safeStr(v) {
    try {
        if (v === null || v === undefined) return "";
        if (typeof v === "string") return v;
        return String(v);
    } catch (_) {
        return "";
    }
}

function safeObj(v) {
    return v !== null && typeof v === "object";
}

function addDebug(v) {
    try {
        var s = safeStr(v);
        if (!s) return;
        if (s.length > 700) s = s.substring(0, 700) + "…";
        if (DEBUG.length >= MAX_DEBUG) DEBUG.shift();
        DEBUG.push(s);
    } catch (_) {}
}

function resetDebug() {
    DEBUG = [];
}

function debugText() {
    return DEBUG.join("\n");
}

function htmlDecode(s) {
    s = safeStr(s);
    return s
        .replace(/&quot;/gi, '"')
        .replace(/&#34;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#x2F;/gi, "/")
        .replace(/&#47;/g, "/")
        .replace(/&#x3D;/gi, "=")
        .replace(/&#61;/g, "=");
}

function cleanText(s) {
    return htmlDecode(safeStr(s).replace(/<[^>]*>/g, " "))
        .replace(/\\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function cleanUrl(s) {
    return htmlDecode(safeStr(s))
        .replace(/^\s*["']+|["']+\s*$/g, "")
        .replace(/\\\//g, "/")
        .replace(/\\u002F/gi, "/")
        .replace(/\\u003A/gi, ":")
        .replace(/\\u003D/gi, "=")
        .trim();
}

function normalizeUrl(s, base) {
    s = cleanUrl(s);
    if (!s) return "";
    if (s.indexOf("//") === 0) return "https:" + s;
    if (/^https?:\/\//i.test(s)) return s;
    if (base && s.charAt(0) === "/") {
        var m = safeStr(base).match(/^(https?:\/\/[^/]+)/i);
        if (m) return m[1] + s;
    }
    return s;
}

function isHttpUrl(s) {
    return /^https?:\/\//i.test(cleanUrl(s));
}

function isHlsUrl(s) {
    var u = cleanUrl(s);
    if (/\.m3u8(?:$|[?#])/i.test(u)) return true;
    /* OK.ru commonly exposes signed HLS manifests as:
       https://vdXXX.okcdn.ru/.../type/5/.../video/
       or https://vdXXX.mycdn.me/.../video/
       They are HLS even though the URL has no .m3u8 suffix. */
    if (/^https?:\/\/(?:vd\d+\.)?(?:okcdn\.ru|mycdn\.me)(?:\/|$)/i.test(u) &&
        /(?:\/video\/?(?:$|[?#])|[?&](?:type|streamType)=5(?:&|$))/i.test(u)) return true;
    return false;
}

function isMp4Url(s) {
    return /\.(?:mp4|m4v|mov|webm)(?:$|[?#])/i.test(cleanUrl(s));
}

function hostOf(url) {
    var m = safeStr(url).match(/^https?:\/\/([^/]+)/i);
    return m ? m[1].toLowerCase() : "";
}

function isExternalProvider(url) {
    var h = hostOf(url);
    return !!h && /(?:youtube(?:-nocookie)?\.com|youtu\.be|vimeo\.com)$/i.test(h);
}

function extractVideoId(url) {
    var m = safeStr(url).match(REGEX_VIDEO_URL);
    return m ? m[1] : "";
}

function mergeHeaders(dst, src) {
    dst = dst || {};
    if (!safeObj(src)) return dst;
    try {
        for (var k in src) {
            if (src[k] !== null && src[k] !== undefined) {
                var v = safeStr(src[k]);
                if (v) dst[k] = v;
            }
        }
    } catch (_) {}
    return dst;
}

function httpGet(url, extraHeaders) {
    try {
        var headers = {
            "User-Agent": UA_DESKTOP,
            "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache"
        };
        mergeHeaders(headers, extraHeaders);

        var r = http.GET(url, headers);
        if (!r) return "";

        var body = "";
        try { body = r.body; } catch (_) {}
        if (!body) {
            try { body = r.getBody(); } catch (_) {}
        }
        body = safeStr(body);
        if (body.length > MAX_HTML_SIZE) body = body.substring(0, MAX_HTML_SIZE);
        return body;
    } catch (e) {
        addDebug("GET: " + e);
        return "";
    }
}

function httpGetAuth(url, extraHeaders) {
    // En GrayJay, http.GET utiliza el cliente autenticado cuando el plugin
    // esta habilitado. Se mantiene separado para poder cambiar la estrategia
    // sin duplicar el parser.
    return httpGet(url, extraHeaders);
}

function loadOkPage(url) {
    var id = extractVideoId(url);
    var urls = [
        url,
        id ? "https://m.ok.ru/video/" + id : "",
        id ? "https://ok.ru/videoembed/" + id : ""
    ];
    var uas = [UA_DESKTOP, UA_MOBILE];
    for (var i = 0; i < urls.length; i++) {
        if (!urls[i]) continue;
        for (var j = 0; j < uas.length; j++) {
            try {
                var body = httpGetAuth(urls[i], { "User-Agent": uas[j] });
                if (body && body.length > 250) {
                    addDebug("page=" + i + ",ua=" + j + ",len=" + body.length);
                    return body;
                }
            } catch (_) {}
        }
    }
    return "";
}

function tryParseJson(value) {
    if (safeObj(value)) return value;
    var s = cleanUrl(value);
    if (!s) return null;

    for (var i = 0; i < 6; i++) {
        try { return JSON.parse(s); } catch (_) {}

        var d = htmlDecode(s);
        if (d !== s) {
            s = d;
            continue;
        }

        if ((s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') ||
            (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'")) {
            s = s.substring(1, s.length - 1);
            continue;
        }

        var u = s
            .replace(/\\"/g, '"')
            .replace(/\\'/g, "'")
            .replace(/\\\\/g, "\\");
        if (u !== s) {
            s = u;
            continue;
        }
        break;
    }
    return null;
}

function extractDataOptions(html) {
    var out = [];
    var re = /data-options\s*=\s*["']([\s\S]*?)["']/gi;
    var m;
    while ((m = re.exec(html)) !== null && out.length < 20) {
        var o = tryParseJson(m[1]);
        if (o) out.push(o);
    }
    return out;
}

function looksLikeVideoObject(o) {
    if (!safeObj(o)) return false;
    var keys = [
        "hls", "hlsUrl", "hlsManifestUrl", "hlsMasterPlaylistUrl",
        "playlistUrl", "manifestUrl", "videoUrl", "video_url",
        "play_url", "media_url", "source_url", "file", "url",
        "play_params", "playParams", "verificationToken", "signdata"
    ];
    for (var i = 0; i < keys.length; i++) {
        try {
            if (o[keys[i]] !== undefined && o[keys[i]] !== null) return true;
        } catch (_) {}
    }
    return false;
}

function findMetadataInObject(root, depth) {
    if (!safeObj(root) || depth > MAX_JSON_DEPTH) return null;
    if (looksLikeVideoObject(root)) return root;

    if (Array.isArray(root)) {
        for (var i = 0; i < root.length; i++) {
            var found = findMetadataInObject(root[i], depth + 1);
            if (found) return found;
        }
        return null;
    }

    try {
        var preferred = ["video", "movie", "player", "flashvars", "data", "result", "response", "media", "content"];
        for (var i = 0; i < preferred.length; i++) {
            if (root[preferred[i]] !== undefined) {
                var found = findMetadataInObject(root[preferred[i]], depth + 1);
                if (found) return found;
            }
        }

        for (var k in root) {
            var v = root[k];
            if (safeObj(v)) {
                var found = findMetadataInObject(v, depth + 1);
                if (found) return found;
            } else if (typeof v === "string") {
                var parsed = tryParseJson(v);
                if (parsed) {
                    var found2 = findMetadataInObject(parsed, depth + 1);
                    if (found2) return found2;
                }
            }
        }
    } catch (_) {}
    return null;
}

function extractJsonObjectsFromHtml(html) {
    var out = [];
    var patterns = [
        /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
        /<script[^>]*>([\s\S]*?\{[\s\S]*?\}[\s\S]*?)<\/script>/gi
    ];

    for (var p = 0; p < patterns.length; p++) {
        var re = patterns[p], m;
        while ((m = re.exec(html)) !== null && out.length < 40) {
            var o = tryParseJson(m[1]);
            if (o) out.push(o);
        }
    }
    return out;
}

function extractMetadataFromHtml(html) {
    var dataOptions = extractDataOptions(html);
    for (var i = 0; i < dataOptions.length; i++) {
        var found = findMetadataInObject(dataOptions[i], 0);
        if (found) return found;
    }

    var jsons = extractJsonObjectsFromHtml(html);
    for (var i = 0; i < jsons.length; i++) {
        var found2 = findMetadataInObject(jsons[i], 0);
        if (found2) return found2;
    }

    // OK.ru changes its markup frequently. A media-bearing object is useful,
    // but a page-wide URL scan below is the final playback fallback.
    var attrs = ["flashvars", "data-player", "data-options", "data-video", "data-json"];
    for (var i = 0; i < attrs.length; i++) {
        var re = new RegExp(attrs[i] + "\\s*=\\s*(?:\"([\\s\\S]*?)\"|\'([\\s\\S]*?)\')", "i");
        var m = html.match(re);
        if (m) {
            var o = tryParseJson(m[1] || m[2]);
            if (o) return findMetadataInObject(o, 0) || o;
        }
    }
    return {};
}

function collectMediaFromHtml(html, baseUrl) {
    var result = { hls: [], mp4: [] };
    scanStringForUrls(html, result.hls, result.mp4, baseUrl);

    // Also catch escaped/encoded URLs whose extension is split by markup.
    var normalized = htmlDecode(safeStr(html))
        .replace(/\\\//g, "/")
        .replace(/\\u002f/gi, "/")
        .replace(/\\u003a/gi, ":")
        .replace(/\\u003d/gi, "=");
    scanStringForUrls(normalized, result.hls, result.mp4, baseUrl);
    return result;
}

function fetchMetadataUrl(meta, baseUrl) {
    if (!safeObj(meta)) return null;

    var keys = [
        "metadataUrl", "metadata_url", "metaUrl", "metadataURL",
        "playerMetadataUrl", "videoMetadataUrl"
    ];

    var urls = [];
    for (var i = 0; i < keys.length; i++) {
        try {
            if (meta[keys[i]]) urls.push(normalizeUrl(meta[keys[i]], baseUrl));
        } catch (_) {}
    }

    for (var i = 0; i < urls.length; i++) {
        if (!isHttpUrl(urls[i])) continue;
        var body = httpGetAuth(urls[i]);
        if (!body) body = httpGet(urls[i]);
        var o = tryParseJson(body);
        if (o) return findMetadataInObject(o, 0) || o;
    }
    return null;
}

function parseMetadata(html, pageUrl) {
    var meta = extractMetadataFromHtml(html);
    if (!meta) return null;
    var remote = fetchMetadataUrl(meta, pageUrl);
    return remote || meta;
}

function pushUnique(arr, url, base) {
    url = normalizeUrl(url, base);
    if (!isHttpUrl(url)) return;
    if (arr.indexOf(url) >= 0) return;
    if (arr.length >= MAX_SOURCES) return;
    arr.push(url);
}

function scanStringForUrls(s, hls, mp4, base) {
    s = safeStr(s);
    if (!s) return;

    var d = cleanUrl(s);
    var abs = /https?:\/\/[^\s"'<>\\]+/gi;
    var m;
    while ((m = abs.exec(d)) !== null) {
        var u = cleanUrl(m[0]);
        if (isHlsUrl(u)) pushUnique(hls, u, base);
        else if (isMp4Url(u)) pushUnique(mp4, u, base);
    }

    var proto = /\/\/[^\s"'<>\\]+/g;
    while ((m = proto.exec(d)) !== null) {
        var u2 = "https:" + cleanUrl(m[0]);
        if (isHlsUrl(u2)) pushUnique(hls, u2, base);
        else if (isMp4Url(u2)) pushUnique(mp4, u2, base);
    }

    if (isHlsUrl(d)) pushUnique(hls, d, base);
    if (isMp4Url(d)) pushUnique(mp4, d, base);
}

function collectMedia(meta, baseUrl) {
    var result = { hls: [], mp4: [] };

    function walk(obj, depth) {
        if (depth > MAX_JSON_DEPTH || result.hls.length + result.mp4.length >= MAX_SOURCES) return;

        if (typeof obj === "string") {
            scanStringForUrls(obj, result.hls, result.mp4, baseUrl);
            var parsed = tryParseJson(obj);
            if (parsed) walk(parsed, depth + 1);
            return;
        }
        if (!safeObj(obj)) return;

        if (Array.isArray(obj)) {
            for (var i = 0; i < obj.length; i++) walk(obj[i], depth + 1);
            return;
        }

        try {
            for (var k in obj) {
                var v = obj[k];
                var key = safeStr(k).toLowerCase();

                if (typeof v === "string") {
                    if (/hls|m3u8|playlist|manifest|stream|source|video|media|file|url|play_url|media_url/.test(key)) {
                        scanStringForUrls(v, result.hls, result.mp4, baseUrl);
                    } else if (isHlsUrl(v) || isMp4Url(v)) {
                        scanStringForUrls(v, result.hls, result.mp4, baseUrl);
                    }
                } else if (safeObj(v)) {
                    walk(v, depth + 1);
                }

                if (result.hls.length + result.mp4.length >= MAX_SOURCES) break;
            }
        } catch (_) {}
    }

    walk(meta, 0);
    return result;
}

function firstValue(obj, keys) {
    if (!safeObj(obj)) return "";
    for (var i = 0; i < keys.length; i++) {
        try {
            var v = obj[keys[i]];
            if (v !== undefined && v !== null) {
                var s = safeStr(v);
                if (s) return s;
            }
        } catch (_) {}
    }
    return "";
}

function recursiveValue(root, keys, depth) {
    if (!safeObj(root) || depth > MAX_JSON_DEPTH) return "";
    var direct = firstValue(root, keys);
    if (direct) return direct;

    if (Array.isArray(root)) {
        for (var i = 0; i < root.length; i++) {
            var v = recursiveValue(root[i], keys, depth + 1);
            if (v) return v;
        }
        return "";
    }

    try {
        for (var k in root) {
            var v = root[k];
            if (safeObj(v)) {
                var found = recursiveValue(v, keys, depth + 1);
                if (found) return found;
            }
        }
    } catch (_) {}
    return "";
}

function getTitle(meta, fallback) {
    return cleanText(firstValue(meta, [
        "title", "name", "movieTitle", "videoTitle", "caption", "contentTitle", "ogTitle", "pageTitle"
    ])) || cleanText(fallback) || "OK.ru video";
}

function getDescription(meta) {
    return cleanText(firstValue(meta, ["description", "desc", "text", "summary"]));
}

function getPoster(meta, baseUrl) {
    return normalizeUrl(firstValue(meta, [
        "poster", "posterUrl", "thumbnail", "thumbnailUrl", "cover", "coverUrl",
        "image", "imageUrl", "preview", "previewUrl", "ogImage", "__ok_poster"
    ]), baseUrl);
}

function getDuration(meta) {
    var v = firstValue(meta, [
        "duration", "durationMs", "durationSec", "length", "videoDuration", "mediaDuration"
    ]);
    var n = parseFloat(v);
    if (!isFinite(n) || n <= 0) return 0;
    if (n > 1000) n = n / 1000;
    return Math.round(n);
}

function getAuthorName(meta) {
    return cleanText(firstValue(meta, [
        "authorName", "author", "ownerName", "uploader", "userName", "username", "owner"
    ]));
}


/* -------------------- External embeds -------------------- */

function extractYouTubeIdFromString(value) {
    var s = cleanUrl(value)
        .replace(/\\\//g, "/")
        .replace(/&amp;/gi, "&");
    var patterns = [
        /(?:youtube(?:-nocookie)?\.com\/embed\/)([A-Za-z0-9_-]{6,20})/i,
        /(?:youtube(?:-nocookie)?\.com\/watch\?(?:[^#\s"']*?&)?v=)([A-Za-z0-9_-]{6,20})/i,
        /(?:youtu\.be\/)([A-Za-z0-9_-]{6,20})/i,
        /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{6,20})/i,
        /(?:youtube\.com\/live\/)([A-Za-z0-9_-]{6,20})/i,
        /(?:youtube(?:-nocookie)?\.com\/v\/)([A-Za-z0-9_-]{6,20})/i
    ];
    for (var i = 0; i < patterns.length; i++) {
        var m = s.match(patterns[i]);
        if (m) return m[1];
    }
    return "";
}

function findYouTubeEmbed(html) {
    var s = safeStr(html)
        .replace(/\\u002F/gi, "/")
        .replace(/\\\//g, "/")
        .replace(/&amp;/gi, "&");

    var patterns = [
        /<iframe[^>]+(?:src|data-src)\s*=\s*["']([^"']+)["'][^>]*>/gi,
        /(?:youtube(?:-nocookie)?\.com|youtu\.be)[^\s"'<>]+/gi,
        /(?:playerResponse|videoData|externalVideo|embedUrl)[^\n]{0,1000}/gi
    ];

    for (var p = 0; p < patterns.length; p++) {
        var re = patterns[p], m;
        while ((m = re.exec(s)) !== null) {
            var candidate = m[1] || m[0] || "";
            var id = extractYouTubeIdFromString(candidate);
            if (id) {
                return {
                    id: id,
                    url: "https://www.youtube.com/watch?v=" + id,
                    embedUrl: "https://www.youtube.com/embed/" + id
                };
            }
        }
    }
    return null;
}


function extractJsonObjectAfterMarker(text, marker) {
    var s = safeStr(text);
    var pos = s.indexOf(marker);
    if (pos < 0) return null;
    var start = s.indexOf("{", pos + marker.length);
    if (start < 0) return null;
    var depth = 0, quote = false, esc = false;
    for (var i = start; i < s.length && i < start + 3000000; i++) {
        var c = s.charAt(i);
        if (quote) {
            if (esc) esc = false;
            else if (c === "\\") esc = true;
            else if (c === '"') quote = false;
            continue;
        }
        if (c === '"') { quote = true; continue; }
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(s.substring(start, i + 1)); } catch (_) { return null; }
            }
        }
    }
    return null;
}

function collectYouTubeDirectMedia(videoId) {
    var out = { hls: [], mp4: [] };
    if (!videoId) return out;
    try {
        var url = "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId);
        var html = httpGet(url);
        if (!html) return out;

        var pr = extractJsonObjectAfterMarker(html, "ytInitialPlayerResponse =");
        if (!pr) pr = extractJsonObjectAfterMarker(html, "var ytInitialPlayerResponse =");
        if (!pr) return out;

        var sd = pr.streamingData || {};
        if (isHttpUrl(sd.hlsManifestUrl)) pushUnique(out.hls, sd.hlsManifestUrl, url);

        var lists = [];
        if (Array.isArray(sd.formats)) lists = lists.concat(sd.formats);
        if (Array.isArray(sd.adaptiveFormats)) lists = lists.concat(sd.adaptiveFormats);

        for (var i = 0; i < lists.length && out.mp4.length < 24; i++) {
            var f = lists[i] || {};
            // Only use URLs already resolved by YouTube. Do not attempt to
            // invent/decode signature ciphers here; the official YT plugin
            // has its own cipher/UMP implementation.
            if (!isHttpUrl(f.url)) continue;
            var mime = safeStr(f.mimeType).toLowerCase();
            if (mime.indexOf("video/") < 0) continue;
            out.mp4.push(f.url);
        }
        addDebug("youtube direct hls=" + out.hls.length + " mp4=" + out.mp4.length);
    } catch (e) {
        addDebug("youtube resolver=" + e);
    }
    return out;
}


function collectYouTubePlayerApiMedia(videoId) {
    var out = { hls: [], mp4: [] };
    if (!videoId) return out;

    /*
     * Fallback ligero usando el endpoint player de YouTube.
     * No intenta resolver signatureCipher ni n-cipher: solo acepta URLs
     * que YouTube ya haya entregado completamente resueltas.
     *
     * Esto mejora especialmente embeds donde watch HTML no contiene
     * streamingData utilizable.
     */
    var endpoints = [
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
        "https://m.youtube.com/youtubei/v1/player?prettyPrint=false"
    ];

    var bodies = [
        JSON.stringify({
            context: {
                client: {
                    clientName: "ANDROID",
                    clientVersion: "19.44.38",
                    androidSdkVersion: 34,
                    hl: "en",
                    gl: "US"
                }
            },
            videoId: videoId,
            contentCheckOk: true,
            racyCheckOk: true
        }),
        JSON.stringify({
            context: {
                client: {
                    clientName: "WEB",
                    clientVersion: "2.20260901.01.00",
                    hl: "en",
                    gl: "US"
                }
            },
            videoId: videoId,
            contentCheckOk: true,
            racyCheckOk: true
        })
    ];

    for (var i = 0; i < endpoints.length; i++) {
        try {
            var headers = {
                "User-Agent": UA_MOBILE,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Origin": "https://www.youtube.com",
                "Referer": "https://www.youtube.com/"
            };
            var r = http.POST(endpoints[i], bodies[i], headers);
            if (!r) continue;

            var body = "";
            try { body = r.body; } catch (_) {}
            if (!body) {
                try { body = r.getBody(); } catch (_) {}
            }
            body = safeStr(body);
            if (!body) continue;

            var data = null;
            try { data = JSON.parse(body); } catch (_) { continue; }
            if (!data) continue;

            var sd = data.streamingData || {};
            if (isHttpUrl(sd.hlsManifestUrl)) {
                pushUnique(out.hls, sd.hlsManifestUrl, "https://www.youtube.com/watch?v=" + videoId);
            }

            var lists = [];
            if (Array.isArray(sd.formats)) lists = lists.concat(sd.formats);
            if (Array.isArray(sd.adaptiveFormats)) lists = lists.concat(sd.adaptiveFormats);

            for (var j = 0; j < lists.length && out.mp4.length < 24; j++) {
                var f = lists[j] || {};
                if (!isHttpUrl(f.url)) continue;

                var mime = safeStr(f.mimeType).toLowerCase();
                if (mime.indexOf("video/mp4") !== 0) continue;

                /*
                 * Prefer progressive MP4 (has audio) for Cast/player fallback.
                 * Adaptive video-only MP4 is retained only when no progressive
                 * source exists, because a standalone video stream may have no
                 * audio on ordinary VideoUrlSource playback.
                 */
                var hasAudio = !!f.audioQuality ||
                    /audio\/mp4/i.test(safeStr(f.mimeType)) ||
                    safeStr(f.audioSampleRate) !== "";

                if (f.audioQuality || safeStr(f.audioSampleRate)) {
                    out.mp4.push(f.url);
                } else if (out.mp4.length === 0) {
                    out.mp4.push(f.url);
                }
            }

            if (out.hls.length || out.mp4.length) break;
        } catch (e) {
            addDebug("youtube player api[" + i + "]=" + e);
        }
    }

    addDebug("youtube player-api hls=" + out.hls.length +
        " mp4=" + out.mp4.length);
    return out;
}

function mergeMediaLists(dst, src, baseUrl) {
    if (!dst || !src) return;
    var h = Array.isArray(src.hls) ? src.hls : [];
    var m = Array.isArray(src.mp4) ? src.mp4 : [];

    for (var i = 0; i < h.length; i++) {
        pushUnique(dst.hls, h[i], baseUrl);
    }
    for (var i = 0; i < m.length; i++) {
        pushUnique(dst.mp4, m[i], baseUrl);
    }
}

function makeEmptyDescriptor() {
    try { return new MuxVideoSourceDescriptor({ isUnMuxed: false, videoSources: [] }); } catch (_) {}
    try { return new VideoSourceDescriptor([]); } catch (_) {}
    return null;
}

/* -------------------- Comment extraction -------------------- */

function parseCommentDate(value) {
    if (value === null || value === undefined || value === "") return 0;
    var s = safeStr(value).trim();
    var n = Number(s);
    if (isFinite(n) && n > 0) {
        if (n > 100000000000) n = n / 1000;
        return Math.round(n);
    }
    var t = Date.parse(s);
    return isNaN(t) ? 0 : Math.round(t / 1000);
}

function findCommentMessage(obj) {
    return cleanText(firstValue(obj, [
        "message", "text", "body", "content", "commentText", "comment_text",
        "msg", "textHtml", "text_html"
    ]));
}

function findCommentAuthor(obj) {
    if (!safeObj(obj)) return { name: "", id: "0", url: "", thumbnail: "" };
    var author = obj.author || obj.user || obj.profile || obj.owner || obj.userInfo || obj.authorInfo;
    if (!safeObj(author)) author = obj;
    return {
        name: cleanText(firstValue(author, ["name", "displayName", "fullName", "userName", "username", "nickName"])),
        id: safeStr(firstValue(author, ["id", "userId", "uid", "user_id", "profileId"])),
        url: normalizeUrl(firstValue(author, ["url", "profileUrl", "link"]), "https://ok.ru/"),
        thumbnail: normalizeUrl(firstValue(author, ["avatar", "avatarUrl", "photo", "photoUrl", "thumbnail"]), "https://ok.ru/")
    };
}

function isCommentObject(obj) {
    if (!safeObj(obj) || Array.isArray(obj)) return false;
    var msg = findCommentMessage(obj);
    if (!msg) return false;
    var hasCommentKey = false;
    try {
        for (var k in obj) {
            if (/comment|message|reply/i.test(k)) { hasCommentKey = true; break; }
        }
    } catch (_) {}
    return hasCommentKey || !!obj.author || !!obj.user || !!obj.commentId || !!obj.comment_id;
}

function collectCommentObjects(root, out, depth) {
    if (!safeObj(root) || depth > MAX_JSON_DEPTH || out.length >= 200) return;
    if (Array.isArray(root)) {
        for (var i = 0; i < root.length && out.length < 200; i++) {
            collectCommentObjects(root[i], out, depth + 1);
        }
        return;
    }
    if (isCommentObject(root)) out.push(root);
    try {
        for (var k in root) {
            var v = root[k];
            if (safeObj(v)) collectCommentObjects(v, out, depth + 1);
            else if (typeof v === "string" && v.length > 20) {
                var parsed = tryParseJson(v);
                if (parsed) collectCommentObjects(parsed, out, depth + 1);
            }
            if (out.length >= 200) break;
        }
    } catch (_) {}
}

function extractCommentsFromHtml(html, videoUrl) {
    var objects = [];
    var jsons = extractJsonObjectsFromHtml(html);
    for (var i = 0; i < jsons.length; i++) collectCommentObjects(jsons[i], objects, 0);

    // Also inspect data-* attributes commonly used by OK's comment widgets.
    var attrRe = /(?:data-comment|data-comment-data|data-comments|data-options|data-json)\s*=\s*["']([\s\S]*?)["']/gi;
    var am;
    while ((am = attrRe.exec(html)) !== null && objects.length < 200) {
        var parsed = tryParseJson(am[1]);
        if (parsed) collectCommentObjects(parsed, objects, 0);
    }

    // Server-rendered comment DOM fallback.
    try {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var nodes = doc.querySelectorAll(
            "[data-comment-id], .comment, .comments-item, .comments__item, .ucard-comment, [class*='comment']"
        );
        for (var i = 0; i < nodes.length && objects.length < 200; i++) {
            var node = nodes[i];
            var text = cleanText(node.textContent || node.innerText || "");
            if (!text || text.length > 4000) continue;
            var id = "";
            try { id = node.getAttribute("data-comment-id") || node.getAttribute("data-id") || ""; } catch (_) {}
            objects.push({ commentId: id, message: text });
        }
    } catch (e) {
        addDebug("comment DOM=" + e);
    }

    var out = [];
    var seen = {};
    for (var i = 0; i < objects.length; i++) {
        var o = objects[i];
        var message = findCommentMessage(o);
        if (!message) continue;
        var a = findCommentAuthor(o);
        var cid = safeStr(firstValue(o, ["commentId", "comment_id", "id"])) || ("c" + i);
        var key = cid + "|" + message.substring(0, 120);
        if (seen[key]) continue;
        seen[key] = true;

        var author = null;
        try {
            author = new PlatformAuthorLink(
                new PlatformID(PLATFORM_NAME, a.id || "0", PLUGIN_ID),
                a.name || "OK.ru user",
                a.url || "https://ok.ru/",
                a.thumbnail || "",
                0
            );
        } catch (_) {}

        var replies = Number(firstValue(o, ["replyCount", "repliesCount", "reply_count", "replies"]));
        if (!isFinite(replies) || replies < 0) replies = 0;

        var context = {
            videoUrl: videoUrl,
            commentId: cid,
            raw: o
        };

        try {
            out.push(new Comment({
                contextUrl: videoUrl,
                author: author,
                message: message,
                rating: new RatingLikes(0),
                date: parseCommentDate(firstValue(o, ["date", "timestamp", "createdAt", "created_at", "time"])),
                replyCount: Math.round(replies),
                context: context
            }));
        } catch (_) {}
    }
    return out;
}

function makeCommentPager(results, hasMore, context) {
    try { return new CommentPager(results, hasMore, context); }
    catch (_) { return { results: results, hasMore: hasMore, context: context }; }
}

function discoverCommentUrls(html, videoId) {
    var out = [];
    var s = safeStr(html).replace(/\\\//g, "/").replace(/&amp;/gi, "&");
    var re = /https?:\/\/[^\s"'<>\\]+/gi;
    var m;
    while ((m = re.exec(s)) !== null && out.length < 12) {
        var u = cleanUrl(m[0]);
        if (!isHttpUrl(u)) continue;
        if (/ok\.ru/i.test(hostOf(u)) && /comment|comments|discussion|discussions|widget/i.test(u)) {
            if (out.indexOf(u) < 0) out.push(u);
        }
    }
    var rel = /(?:href|src|data-url|data-endpoint)\s*=\s*["']([^"']*(?:comment|discussion|widget)[^"']*)["']/gi;
    while ((m = rel.exec(s)) !== null && out.length < 12) {
        var u2 = normalizeUrl(m[1], "https://ok.ru/video/" + videoId);
        if (isHttpUrl(u2) && out.indexOf(u2) < 0) out.push(u2);
    }
    return out;
}

function extractCommentsFromBodies(bodies, videoUrl) {
    var all = [];
    for (var i = 0; i < bodies.length; i++) {
        var body = bodies[i];
        if (!body) continue;
        var parsed = tryParseJson(body);
        if (parsed) {
            var objects = [];
            collectCommentObjects(parsed, objects, 0);
            all = all.concat(objects);
        }
        all = all.concat(extractCommentsFromHtml(body, videoUrl));
        if (all.length >= 200) break;
    }
    return all;
}

function getCommentsOk(url, continuationToken) {
    var id = extractVideoId(url);
    if (!id) return makeCommentPager([], false, { url: url, offset: 0 });

    var canonical = "https://ok.ru/video/" + id;
    var html = loadOkPage(canonical);
    if (!html) return makeCommentPager([], false, { url: url, offset: 0 });

    var all = extractCommentsFromHtml(html, canonical);

    // OK.ru may lazy-load comments after the initial page. When the page
    // exposes a comment/discussion/widget URL, fetch those endpoints with
    // the same authenticated HTTP client. No cookie values are read or logged.
    if (all.length === 0) {
        var endpoints = discoverCommentUrls(html, id);
        var bodies = [];
        for (var i = 0; i < endpoints.length && bodies.length < 6; i++) {
            var body = httpGetAuth(endpoints[i], {
                "Referer": canonical,
                "Accept": "application/json,text/html,*/*;q=0.8"
            });
            if (body) bodies.push(body);
        }
        if (bodies.length) all = extractCommentsFromBodies(bodies, canonical);
    }

    var offset = 0;
    try {
        if (continuationToken && typeof continuationToken === "object") offset = Number(continuationToken.offset) || 0;
        else if (continuationToken) offset = Number(continuationToken) || 0;
    } catch (_) {}

    var pageSize = 20;
    var page = all.slice(offset, offset + pageSize);
    var next = offset + page.length;
    var hasMore = next < all.length;
    return makeCommentPager(page, hasMore, { url: url, offset: next });
}

/* -------------------- Xuper APK findings -------------------- */

function xuperGetPlayParams(meta) {
    return recursiveValue(meta, ["play_params", "playParams"], 0);
}

function xuperGetVerificationToken(meta) {
    return recursiveValue(meta, ["verificationToken", "verification_token"], 0);
}

function xuperGetPlaylistUrl(meta) {
    return recursiveValue(meta, ["playlistUrl", "playlist_url"], 0);
}

function xuperGetSigndata(meta) {
    return recursiveValue(meta, ["signdata", "signature", "sign"], 0);
}

function xuperDirectPlaylist(meta, baseUrl) {
    var candidates = [
        xuperGetPlaylistUrl(meta),
        recursiveValue(meta, ["play_url", "playUrl", "media_url", "mediaUrl", "source_url", "sourceUrl"], 0)
    ];

    for (var i = 0; i < candidates.length; i++) {
        var u = normalizeUrl(candidates[i], baseUrl);
        if (isHlsUrl(u)) return u;
    }
    return "";
}

/*
 * No se implementa un firmador Xuper inventado.
 * Si el sitio entrega playlistUrl, se usa. Si no, se utiliza el flujo normal
 * de OK.ru. Esto evita fabricar tokens que produzcan URLs invalidas y evita
 * enviar a Cast una URL de pagina intermedia.
 */

function makeHlsSource(url, duration) {
    try {
        return new HLSSource({
            name: "OK.ru HLS",
            duration: duration || 0,
            url: url,
            priority: true
        });
    } catch (_) {
        return null;
    }
}

function makeMp4Source(url, duration, index) {
    try {
        return new VideoUrlSource({
            width: 0,
            height: 0,
            container: /\.m4v(?:$|[?#])/i.test(url) ? "m4v" :
                /\.webm(?:$|[?#])/i.test(url) ? "webm" : "mp4",
            codec: "",
            name: "OK.ru MP4 " + (index + 1),
            bitrate: 0,
            duration: duration || 0,
            url: url
        });
    } catch (_) {
        return null;
    }
}

function makeDescriptor(sources) {
    /* VideoSourceDescriptor(Array) es la forma documentada y más compatible
       con GrayJay para una lista mixta de HLSSource/VideoUrlSource. */
    try {
        return new VideoSourceDescriptor(sources);
    } catch (_) {}
    try {
        return new MuxVideoSourceDescriptor({
            isUnMuxed: false,
            videoSources: sources
        });
    } catch (_) {}
    return null;
}

function makeThumbnailList(poster) {
    var out = [];
    if (!isHttpUrl(poster)) return out;
    try { out.push(new Thumbnail(poster, 720)); } catch (_) {}
    return out;
}

function makeAuthor(name, id) {
    if (!name) return null;
    try {
        return new PlatformAuthorLink(
            new PlatformID(PLATFORM_NAME, id || "0", PLUGIN_ID),
            name,
            "https://ok.ru/",
            "",
            0
        );
    } catch (_) {}
    return null;
}

function buildDetails(meta, pageUrl, videoId) {
    var title = getTitle(meta, "OK.ru video " + videoId);
    var description = getDescription(meta);
    var poster = getPoster(meta, pageUrl);
    var duration = getDuration(meta);
    var authorName = getAuthorName(meta);

    var media = { hls: [], mp4: [] };
    if (Array.isArray(meta.__ok_hls)) media.hls = meta.__ok_hls.slice(0);
    if (Array.isArray(meta.__ok_mp4)) media.mp4 = meta.__ok_mp4.slice(0);
    if (media.hls.length === 0 && media.mp4.length === 0) media = collectMedia(meta, pageUrl);
    var xuper = xuperDirectPlaylist(meta, pageUrl);
    if (xuper && media.hls.indexOf(xuper) < 0) media.hls.unshift(xuper);

    addDebug("media hls=" + media.hls.length + " mp4=" + media.mp4.length);
    addDebug("xuper play_params=" + (xuperGetPlayParams(meta) ? "yes" : "no") +
        " verificationToken=" + (xuperGetVerificationToken(meta) ? "yes" : "no") +
        " playlistUrl=" + (xuperGetPlaylistUrl(meta) ? "yes" : "no") +
        " signdata=" + (xuperGetSigndata(meta) ? "yes" : "no"));

    var sources = [];

    // 1) HLS: primero y sin RequestModifier. La URL directa es mucho mas
    // compatible con FCast/Chromecast que una fuente que dependa de headers
    // del plugin que el receptor puede no conocer.
    for (var i = 0; i < media.hls.length && sources.length < MAX_SOURCES; i++) {
        var hls = makeHlsSource(media.hls[i], duration);
        if (hls) sources.push(hls);
    }

    // 2) MP4: se conserva como fallback real incluso cuando existe HLS.
    // Esto permite que SourceAuto tenga una alternativa si el receptor/player
    // no acepta una variante HLS concreta.
    for (var j = 0; j < media.mp4.length && sources.length < MAX_SOURCES; j++) {
        var mp4 = makeMp4Source(media.mp4[j], duration, j);
        if (mp4) sources.push(mp4);
    }

    if (sources.length === 0) {
        throw new Error("No playable direct HLS/MP4 source found\n" + debugText());
    }

    var thumbs = makeThumbnailList(poster);
    var author = makeAuthor(authorName, videoId);
    var descriptor = makeDescriptor(sources);
    if (!descriptor) throw new Error("GrayJay VideoSourceDescriptor unavailable");

    var firstHls = null;
    if (media.hls.length > 0) firstHls = makeHlsSource(media.hls[0], duration);

    var obj = {
        id: new PlatformID(PLATFORM_NAME, videoId, PLUGIN_ID),
        name: title,
        thumbnails: new Thumbnails(thumbs),
        author: author,
        uploadDate: 0,
        url: pageUrl,
        duration: duration,
        viewCount: 0,
        isLive: false,
        description: description,
        video: descriptor,
        dash: null,
        hls: firstHls,
        live: []
    };

    try {
        return new PlatformVideoDetails(obj);
    } catch (e) {
        // Fallback minimo para runtimes que no aceptan campos opcionales null.
        var minimal = {
            id: obj.id,
            name: obj.name,
            thumbnails: obj.thumbnails,
            author: obj.author,
            uploadDate: 0,
            url: obj.url,
            duration: obj.duration,
            viewCount: 0,
            isLive: false,
            description: obj.description,
            video: obj.video,
            live: []
        };
        return new PlatformVideoDetails(minimal);
    }
}

/* -------------------- Search -------------------- */

function parseDurationText(s) {
    s = cleanText(s);
    var p = s.split(":");
    if (p.length === 2) return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
    if (p.length === 3) return (parseInt(p[0], 10) || 0) * 3600 +
        (parseInt(p[1], 10) || 0) * 60 + (parseInt(p[2], 10) || 0);
    return 0;
}

function extractSearchResults(html) {
    var results = [];
    var seen = {};
    html = safeStr(html);
    var m;

    /* OK.ru cambia frecuentemente el HTML de la búsqueda. */
    var idRe = /(?:https?:\/\/[^"'<>\s]+)?(?:www\.|m\.)?ok\.ru\/(?:video|videoembed)\/(\d+)/gi;
    while ((m = idRe.exec(html)) !== null && results.length < MAX_SEARCH) {
        var id = m[1];
        if (!id || seen[id]) continue;

        var blockStart = Math.max(0, m.index - 3500);
        var blockEnd = Math.min(html.length, idRe.lastIndex + 4500);
        var block = html.substring(blockStart, blockEnd);
        var title = "";
        var poster = "";
        var duration = 0;

        var tm = block.match(/(?:data-title|data-video-title|video-title|movie-title|content-title|title)\s*=\s*["']([^"']{2,500})["']/i);
        if (tm) title = cleanText(tm[1]);
        if (!title) {
            tm = block.match(/<(?:span|div|a|h[1-6])[^>]*class=["'][^"']*(?:title|name|video_name|video-title)[^"']*["'][^>]*>([\s\S]{2,500}?)<\/(?:span|div|a|h[1-6])>/i);
            if (tm) title = cleanText(tm[1]);
        }

        /* Intentar obtener el texto de la etiqueta <a> que contiene el ID. */
        if (!title) {
            var localRe;
            try {
                localRe = new RegExp("<a\\b[^>]*href=[\\\"'](?:https?:\\/\\/[^\\\"']+)?(?:www\\.|m\\.)?ok\\.ru\\/(?:video|videoembed)\\/" + id + "(?:[?#][^\\\"']*)?[\\\"][^>]*>([\\s\\S]{2,1000}?)<\\/a>", "i");
                tm = block.match(localRe);
                if (tm) title = cleanText(tm[1]);
            } catch (_) {}
        }

        var pm = block.match(/(?:poster|thumbnail|data-poster|og:image|data-image|preview|cover)[^>:=]{0,100}[=:]\s*["']([^"']+)["']/i);
        if (pm) poster = normalizeUrl(pm[1]);
        if (!poster) {
            var im = block.match(/<img[^>]+(?:src|data-src|data-lazy-src|data-original)\s*=\s*["']([^"']+)["']/i);
            if (im) poster = normalizeUrl(im[1]);
        }

        var dm = block.match(/(?:duration|movie-duration|video-duration)[^>:=]{0,100}[=:>\s]+["']?([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)/i);
        if (dm) duration = parseDurationText(dm[1]);

        seen[id] = true;
        results.push({
            id: id,
            url: "https://ok.ru/video/" + id,
            title: title || "OK.ru video " + id,
            thumbnail: poster,
            duration: duration
        });
    }

    /* Compatibilidad con el markup antiguo. */
    if (results.length === 0) {
        var re = /data-movie-id\s*=\s*["']?(\d+)["']?([\s\S]{0,7000}?)(?=data-movie-id|$)/gi;
        while ((m = re.exec(html)) !== null && results.length < MAX_SEARCH) {
            var oldId = m[1];
            if (!oldId || seen[oldId]) continue;
            var oldBlock = m[2] || "";
            var oldTitle = "";
            var oldPoster = "";
            var oldDuration = 0;
            var ot = oldBlock.match(/(?:data-title|data-video-title|title)\s*=\s*["']([^"']+)["']/i);
            if (ot) oldTitle = cleanText(ot[1]);
            if (!oldTitle) {
                ot = oldBlock.match(/<(?:span|div|a)[^>]*class=["'][^"']*(?:title|name)[^"']*["'][^>]*>([\s\S]{1,500}?)<\/(?:span|div|a)>/i);
                if (ot) oldTitle = cleanText(ot[1]);
            }
            var op = oldBlock.match(/(?:poster|thumbnail|data-poster|data-options)[^>:=]{0,100}[=:]\s*["']([^"']+)["']/i);
            if (op) oldPoster = normalizeUrl(op[1]);
            var od = oldBlock.match(/(?:duration|movie-duration)[^>]*>([^<]{1,30})</i);
            if (od) oldDuration = parseDurationText(od[1]);
            seen[oldId] = true;
            results.push({id: oldId, url: "https://ok.ru/video/" + oldId,
                title: oldTitle || "OK.ru video " + oldId,
                thumbnail: oldPoster, duration: oldDuration});
        }
    }
    return results;
}

function extractPageTitlePoster(html, pageUrl) {
    var out = { title: "", poster: "", duration: 0 };
    html = safeStr(html);
    var m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i);
    if (!m) m = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i);
    if (m) out.title = cleanText(m[1]);
    if (!out.title) {
        m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (m) out.title = cleanText(m[1]);
    }
    m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
    if (!m) m = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i);
    if (!m) m = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
    if (m) out.poster = normalizeUrl(m[1], pageUrl);
    return out;
}

function enrichSearchResult(r) {
    if (!r || !r.url) return r;
    try {
        var pageHtml = loadOkPage(r.url);
        if (!pageHtml) return r;
        var page = extractPageTitlePoster(pageHtml, r.url);
        var meta = parseMetadata(pageHtml, r.url) || {};
        var title = page.title || getTitle(meta, "");
        var poster = page.poster || getPoster(meta, r.url);
        var duration = r.duration || getDuration(meta);
        if (title && !/^OK\.ru video \d+$/i.test(title)) r.title = title;
        if (poster) r.thumbnail = poster;
        if (duration) r.duration = duration;
    } catch (e) { addDebug("search enrich " + r.id + "=" + e); }
    return r;
}

function makeSearchVideo(r) {
    var thumbs = makeThumbnailList(r.thumbnail);
    try {
        return new PlatformVideo({
            id: new PlatformID(PLATFORM_NAME, r.id, PLUGIN_ID),
            name: r.title,
            thumbnails: new Thumbnails(thumbs),
            author: null, uploadDate: 0, url: r.url,
            duration: r.duration || 0, viewCount: 0, isLive: false
        });
    } catch (_) { return null; }
}

function searchOk(query) {
    var q = safeStr(query).trim();
    if (!q) return new VideoPager([], false, null);

    for (var endpoint = 0; endpoint < SEARCH_URL_BASES.length; endpoint++) {
        var url = SEARCH_URL_BASES[endpoint] + encodeURIComponent(q);
        var html = httpGetAuth(url);
        if (!html) html = httpGet(url);
        if (!html || html.length < 200) continue;

        addDebug("search endpoint=" + endpoint + " len=" + html.length);
        var raw = extractSearchResults(html);
        if (!raw.length) continue;

        var out = [];
        for (var i = 0; i < raw.length && i < MAX_SEARCH; i++) {
            var r = raw[i];
            if (!r.title || /^OK\.ru video \d+$/i.test(r.title) || !r.thumbnail) enrichSearchResult(r);
            var v = makeSearchVideo(r);
            if (v) out.push(v);
        }
        if (out.length) return new VideoPager(out, false, null);
    }
    throw new Error("OK.ru search returned no video results\n" + debugText());
}

function searchSuggestions(query) {
    var q = safeStr(query).trim();
    if (!q) return [];
    var out = [];
    try {
        for (var endpoint = 0; endpoint < SEARCH_URL_BASES.length && out.length < 10; endpoint++) {
            var url = SEARCH_URL_BASES[endpoint] + encodeURIComponent(q);
            var html = httpGetAuth(url);
            if (!html) html = httpGet(url);
            if (!html) continue;
            var raw = extractSearchResults(html);
            for (var i = 0; i < raw.length && out.length < 10; i++) {
                if (raw[i].title && out.indexOf(raw[i].title) < 0) out.push(raw[i].title);
            }
            if (out.length) break;
        }
    } catch (e) { addDebug("suggestions=" + e); }
    return out;
}

/* -------------------- Details -------------------- */

function waitMs(ms) {
    try {
        if (typeof Utilities !== "undefined" && Utilities && typeof Utilities.sleep === "function") {
            Utilities.sleep(ms);
            return true;
        }
    } catch (_) {}
    return false;
}

function getVideoDetails(url) {
    resetDebug();
    var id = extractVideoId(url);
    if (!id) throw new Error("Invalid OK.ru video URL");

    var canonical = "https://ok.ru/video/" + id;
    var delays = [0, 500, 1000, 2000, 3000];
    var lastMeta = {};
    var external = null;

    for (var attempt = 0; attempt < delays.length; attempt++) {
        if (delays[attempt] > 0) waitMs(delays[attempt]);

        var html = loadOkPage(canonical);
        if (!html) {
            addDebug("attempt " + attempt + ": page unavailable");
            continue;
        }

        external = findYouTubeEmbed(html);
        if (external) addDebug("YouTube embed=" + external.id);

        var meta = parseMetadata(html, canonical) || {};
        var pageMedia = collectMediaFromHtml(html, canonical);
        var objectMedia = collectMedia(meta, canonical);
        var merged = { hls: [], mp4: [] };

        // If OK.ru hosts a YouTube embed and the YouTube page exposes already
        // resolved media URLs, use those direct URLs. Ciphered formats are
        // deliberately left to the official YouTube plugin/native UMP path.
        if (external) {
            var ytMedia = collectYouTubeDirectMedia(external.id);
            mergeMediaLists(merged, ytMedia, canonical);

            /*
             * Second YouTube route: youtubei/player. It is only a fallback
             * and only contributes fully resolved URLs, so it does not
             * interfere with the normal OK.ru path.
             */
            if (merged.hls.length === 0 && merged.mp4.length === 0) {
                var ytApiMedia = collectYouTubePlayerApiMedia(external.id);
                mergeMediaLists(merged, ytApiMedia, canonical);
            }
        }

        for (var i = 0; i < objectMedia.hls.length; i++) pushUnique(merged.hls, objectMedia.hls[i], canonical);
        for (var i = 0; i < pageMedia.hls.length; i++) pushUnique(merged.hls, pageMedia.hls[i], canonical);
        for (var i = 0; i < objectMedia.mp4.length; i++) pushUnique(merged.mp4, objectMedia.mp4[i], canonical);
        for (var i = 0; i < pageMedia.mp4.length; i++) pushUnique(merged.mp4, pageMedia.mp4[i], canonical);

        merged.hls.sort(function(a, b) { return scoreMediaUrl(b) - scoreMediaUrl(a); });
        merged.mp4.sort(function(a, b) { return scoreMediaUrl(b) - scoreMediaUrl(a); });

        lastMeta = meta;
        addDebug("attempt=" + attempt + " hls=" + merged.hls.length + " mp4=" + merged.mp4.length);

        if (merged.hls.length || merged.mp4.length) {
            meta.__ok_hls = merged.hls;
            meta.__ok_mp4 = merged.mp4;
            return buildDetails(meta, canonical, id);
        }
    }

    // Do not throw the misleading old "YouTube embed" exception. The embed
    // is reported as an external reference. GrayJay's JS source API does not
    // expose a supported way to invoke another installed plugin from here,
    // so we cannot honestly fabricate a playable YouTube stream URL.
    if (external) {
        var title = getTitle(lastMeta, "YouTube video " + external.id);
        var poster = getPoster(lastMeta, canonical);
        var thumbs = makeThumbnailList(poster);
        var descriptor = makeEmptyDescriptor();
        var obj = {
            id: new PlatformID(PLATFORM_NAME, id, PLUGIN_ID),
            name: title,
            thumbnails: new Thumbnails(thumbs),
            author: null,
            uploadDate: 0,
            url: external.url,
            duration: getDuration(lastMeta),
            viewCount: 0,
            isLive: false,
            description: "Video de YouTube embebido en OK.ru. Se intentan fuentes directas cuando YouTube las expone; si requiere cipher/UMP, la resolucion queda fuera de este plugin. URL: " + external.url,
            video: descriptor || {},
            dash: null,
            hls: null,
            live: []
        };
        try { return new PlatformVideoDetails(obj); }
        catch (_) {
            return new PlatformVideoDetails({
                id: obj.id, name: obj.name, thumbnails: obj.thumbnails,
                author: null, uploadDate: 0, url: obj.url, duration: obj.duration,
                viewCount: 0, isLive: false, description: obj.description,
                video: descriptor || {}, live: []
            });
        }
    }

    throw new Error("No playable direct HLS/MP4 source found after retries\n" + debugText());
}

function scoreMediaUrl(url) {
    var s = safeStr(url).toLowerCase();
    var score = 0;
    if (s.indexOf("master") >= 0) score += 1000;
    if (s.indexOf("m3u8") >= 0) score += 500;
    var m = s.match(/(?:^|[^0-9])(2160|1440|1080|900|720|576|540|480|360|240)(?:p)?(?:[^0-9]|$)/);
    if (m) score += parseInt(m[1], 10);
    return score;
}

/* -------------------- GrayJay API -------------------- */

source.setSettings = function (settings) {
    // No requiere ajustes privados.
};

source.enable = function (config) {
    return true;
};

source.disable = function () {};

source.getHome = function () {
    return new VideoPager([], false, null);
};

source.getSearchCapabilities = function () {
    try {
        return new ResultCapabilities(
            ["video"],
            [],
            []
        );
    } catch (_) {
        return { supportsSearch: true, supportsSuggestions: true };
    }
};

source.search = function (query, type, order, filters) {
    return searchOk(query);
};

source.searchSuggestions = function (query) {
    return searchSuggestions(query);
};

source.isVideoDetailsUrl = function (url) {
    return REGEX_VIDEO_URL.test(safeStr(url));
};

source.isContentDetailsUrl = function (url) {
    return REGEX_VIDEO_URL.test(safeStr(url));
};

source.getVideoDetails = function (url) {
    return getVideoDetails(url);
};

source.getContentDetails = function (url) {
    return getVideoDetails(url);
};

source.getComments = function (url, continuationToken) {
    return getCommentsOk(url, continuationToken);
};

source.getSubComments = function (comment) {
    // OK.ru does not expose a stable public replies endpoint through the
    // plugin API. Return an empty pager instead of throwing after playback.
    return makeCommentPager([], false, { comment: comment });
};

source.isChannelUrl = function (url) {
    return false;
};

source.getChannelCapabilities = function () {
    try { return new ResultCapabilities([], [], []); } catch (_) { return null; }
};

