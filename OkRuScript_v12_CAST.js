/*
 * GrayJay - OK.ru Source v22
 * Hybrid: original v5 search/details contract + explicit GrayJay session auth.
 *
 *
 * Stable OK.ru video extraction with:
 *  - desktop/mobile page fallback
 *  - authenticated request fallback
 *  - data-options / metadata / metadataUrl parsing
 *  - recursive HLS/MP4 discovery
 *  - defensive URL normalization/deduplication
 *  - direct HLS preference for casting
 *  - Xuper-compatible metadata fallback
 *  - bounded debugging
 *
 * Important:
 * The Xuper APK contains fields such as play_params, verificationToken,
 * playlistUrl and signdata. This source deliberately does NOT invent a
 * signing algorithm or a private Xuper endpoint. If OK metadata exposes a
 * valid playlistUrl/playable URL, it is consumed directly. Otherwise the
 * normal OK.ru HLS path is used. This avoids returning an intermediate
 * player page to Cast.
 */

const PLATFORM_NAME = "OK.ru";
const PLUGIN_ID = "62af0e2f-bfd9-489f-afe1-f66583d2f7d0";

// Cookie local de OK.ru. Sustituye el placeholder por tu propia cookie.
const EMBEDDED_OK_COOKIE = "JSESSIONID=8e2c2999590bc859a0a2b753ba3c4a76dab8f7a5fde5d9bf.43f3c308; AUTHCODE=1t0LE3mgF-zTAiOgD7sZg4QFTJxWbjmY8dLFMhs_HGlGNUiPiuOaEc_Ntmp_L9oJozni2j31wNG_TRo5Cvn-V7kZaoqJmPBhARjHjQtjt6K9Wxdmbae1wwTJphr9uwl7F-MnOPRWhD8YRC5euQ_5;";

// FIX: esta constante faltaba y provocaba el ReferenceError al construir
// las cabeceras de las fuentes de video ("UA_DESKTOP is not defined").
const UA_DESKTOP =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/136.0.0.0 Safari/537.36";

const REGEX_VIDEO_URL = /ok\.ru\/(?:video|videoembed)\/(\d+)/i;
const SEARCH_URL_BASE =
    "https://ok.ru/dk?st.cmd=searchResult&st.mode=Movie&st.grmode=Groups&st.query=";

const MAX_HTML_SIZE = 5000000;
const MAX_JSON_DEPTH = 12;
const MAX_SOURCES = 30;
const MAX_DEBUG = 50;
const MAX_TITLE_CACHE = 300;

let DEBUG = [];

// FIX: la búsqueda ya conoce el título real (ej. "Historia de Evan") pero
// getContentDetails/getVideoDetails es una llamada aparte que no lo recibe;
// si el metadata o el <title> de la página no traen nada útil, terminaba
// mostrando "OK.ru video <id>". Guardamos acá lo que ya vimos en la búsqueda
// para poder recuperarlo como fallback antes de caer al ID.
let TITLE_CACHE = {};
let TITLE_CACHE_ORDER = [];

function rememberTitle(id, title) {
    id = safeStr(id);
    title = cleanText(title);
    if (!id || !title) return;
    if (/^OK\.ru video\b/i.test(title)) return; // no guardar títulos genéricos

    if (!(id in TITLE_CACHE) && TITLE_CACHE_ORDER.length >= MAX_TITLE_CACHE) {
        let oldest = TITLE_CACHE_ORDER.shift();
        delete TITLE_CACHE[oldest];
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

function addDebug(value) {
    try {
        let s = safeStr(value);
        if (!s) return;
        if (DEBUG.length >= MAX_DEBUG) DEBUG.shift();
        DEBUG.push(s.length > 600 ? s.substring(0, 600) + "…" : s);
    } catch (_) {}
}

function resetDebug() {
    DEBUG = [];
}

function debugText() {
    return DEBUG.join("\n");
}

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
        .replace(/&#47;/g, "/");
}

function stripTags(s) {
    return safeStr(s).replace(/<[^>]*>/g, " ");
}

function cleanText(s) {
    return htmlDecode(stripTags(s))
        .replace(/\s+/g, " ")
        .trim();
}

function cleanUrl(s) {
    return htmlDecode(safeStr(s))
        .replace(/^["']+|["']+$/g, "")
        .replace(/\\\//g, "/")
        .trim();
}

function normalizeUrl(s, base) {
    s = cleanUrl(s);
    if (!s) return "";

    if (s.indexOf("//") === 0) return "https:" + s;

    if (/^https?:\/\//i.test(s)) return s;

    if (base) {
        try {
            if (s.indexOf("/") === 0) {
                let m = safeStr(base).match(/^(https?:\/\/[^/]+)/i);
                if (m) return m[1] + s;
            }
        } catch (_) {}
    }

    return s;
}

function isHttpUrl(s) {
    return /^https?:\/\//i.test(cleanUrl(s));
}

function getHost(url) {
    try {
        let m = safeStr(url).match(/^https?:\/\/([^/]+)/i);
        return m ? m[1].toLowerCase() : "";
    } catch (_) {
        return "";
    }
}

function isExternalProvider(url) {
    let h = getHost(url);
    if (!h) return false;
    return /youtube\.com|youtu\.be|vimeo\.com/i.test(h);
}



function containsExternalVideoEmbed(value) {
    let x = safeStr(value)
        .replace(/\\u002F/gi, "/")
        .replace(/\\\//g, "/")
        .replace(/&amp;/gi, "&");

    return /(?:youtube(?:-nocookie)?\.com|youtu\.be|vimeo\.com)/i.test(x) &&
           /(?:iframe|embed|externalVideo|externalVideoId|youtubeId|youtubeVideoId|playerResponse|watch\?v=|youtube(?:-nocookie)?\.com\/(?:embed|watch|shorts|live|v)|youtu\.be\/)/i.test(x);
}

function isM3u8Url(url) {
    return /\.m3u8(?:$|[?#])/i.test(cleanUrl(url));
}

function extractVideoId(url) {
    try {
        let m = safeStr(url).match(REGEX_VIDEO_URL);
        return m ? m[1] : "";
    } catch (_) {
        return "";
    }
}

function mergeHeaders(target, extra) {
    target = target || {};
    if (!extra) return target;

    try {
        for (let k in extra) {
            if (extra[k] !== null && extra[k] !== undefined) {
                target[k] = safeStr(extra[k]);
            }
        }
    } catch (_) {}

    return target;
}

function httpGet(url, headers) {
    try {
        let h = {
            "User-Agent": UA_DESKTOP,
            "Accept":
                "text/html,application/xhtml+xml,application/xml;q=0.9," +
                "image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache"
        };

        mergeHeaders(h, headers);

        let r = http.GET(url, h);
        if (!r) return "";

        let body = "";
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
            addDebug("HTTP body capped: " + body.length);
            body = body.substring(0, MAX_HTML_SIZE);
        }

        return body;
    } catch (e) {
        addDebug("httpGet: " + e);
        return "";
    }
}

function httpGetAuthenticated(url) {
    try {
        let host = getHost(url);
        let headers = {"Accept-Language":"en-US"};
        if (EMBEDDED_OK_COOKIE &&
            EMBEDDED_OK_COOKIE.indexOf("REPLACE_WITH_") !== 0 &&
            /(?:^|\.)ok\.ru$/i.test(host)) {
            headers["Cookie"] = EMBEDDED_OK_COOKIE;
        }
        // Keep the request independent from GrayJay account login.
        let r = http.GET(url, headers, false);
        if (!r) return "";

        let body = "";
        try {
            body = r.body;
        } catch (_) {}

        if (!body) {
            try {
                body = r.getBody();
            } catch (_) {}
        }

        body = safeStr(body);
        if (body.length > MAX_HTML_SIZE) body = body.substring(0, MAX_HTML_SIZE);
        return body;
    } catch (e) {
        addDebug("authenticated GET: " + e);
        return "";
    }
}

function loadOkPage(url) {
    let desktop = {
        "User-Agent": UA_DESKTOP
    };

    let mobile = {
        "User-Agent":
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/136.0.0.0 Mobile Safari/537.36"
    };

    // FIX: antes se repetía la misma request autenticada dos veces
    // (misma URL, misma cookie -> mismo resultado). Se saca el duplicado
    // para no sumar un round-trip inútil al tiempo de carga.
    let attempts = [
        function () { return httpGetAuthenticated(url); },
        function () { return httpGet(url, desktop); },
        function () { return httpGet(url, mobile); }
    ];

    for (let i = 0; i < attempts.length; i++) {
        try {
            let body = attempts[i]();
            if (body && body.length > 300) {
                addDebug("OK page loaded via attempt " + i);
                return body;
            }
        } catch (_) {}
    }

    return "";
}

function tryParseJson(value) {
    if (value === null || value === undefined) return null;

    if (safeObj(value)) return value;

    let s = safeStr(value).trim();
    if (!s) return null;

    for (let pass = 0; pass < 4; pass++) {
        try {
            let v = JSON.parse(s);
            return v;
        } catch (_) {}

        let decoded = htmlDecode(s);
        if (decoded !== s) {
            s = decoded;
            continue;
        }

        if (
            (s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') ||
            (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'")
        ) {
            s = s.substring(1, s.length - 1);
            continue;
        }

        let unescaped = s
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

function extractDataOptions(html) {
    let out = [];
    let re =
        /(?:data-options|data-options-json)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

    let m;
    while ((m = re.exec(html || "")) !== null && out.length < 20) {
        let raw = m[1] !== undefined ? m[1] : m[2];
        let obj = tryParseJson(raw);
        if (obj) out.push(obj);
    }

    return out;
}

function findMetadataInObject(root, depth) {
    if (!safeObj(root) || depth > MAX_JSON_DEPTH) return null;

    if (Array.isArray(root)) {
        for (let i = 0; i < root.length; i++) {
            let found = findMetadataInObject(root[i], depth + 1);
            if (found) return found;
        }
        return null;
    }

    let preferred = [
        "metadata",
        "flashvars",
        "video",
        "movie",
        "movieData",
        "data",
        "result"
    ];

    for (let i = 0; i < preferred.length; i++) {
        let k = preferred[i];
        try {
            if (root[k] !== undefined) {
                if (k === "metadata" && safeObj(root[k])) return root[k];

                let found = findMetadataInObject(root[k], depth + 1);
                if (found) return found;
            }
        } catch (_) {}
    }

    try {
        if (root.metadataUrl || root.metadataURL) {
            return root;
        }
    } catch (_) {}

    try {
        for (let key in root) {
            if (depth >= MAX_JSON_DEPTH) break;
            let value = root[key];

            if (
                /metadata|flashvar|video|movie|media|stream|playlist/i.test(
                    key
                )
            ) {
                let found = findMetadataInObject(value, depth + 1);
                if (found) return found;
            }
        }
    } catch (_) {}

    return null;
}

function extractMetadataFromHtml(html) {
    html = safeStr(html);
    if (!html) return null;

    let options = extractDataOptions(html);
    for (let i = 0; i < options.length; i++) {
        let found = findMetadataInObject(options[i], 0);
        if (found) return found;
    }

    let patterns = [
        /(?:^|["'])metadata["']?\s*:\s*(\{[\s\S]{20,200000}\})/i,
        /(?:^|["'])flashvars["']?\s*:\s*(\{[\s\S]{20,200000}\})/i,
        /(?:^|["'])video["']?\s*:\s*(\{[\s\S]{20,200000}\})/i
    ];

    for (let i = 0; i < patterns.length; i++) {
        try {
            let m = html.match(patterns[i]);
            if (m) {
                let obj = tryParseJson(m[1]);
                if (obj) {
                    let found = findMetadataInObject(obj, 0);
                    if (found) return found;
                    return obj;
                }
            }
        } catch (_) {}
    }

    // Last-resort JSON candidate scan.
    let starts = [];
    for (let i = 0; i < html.length && starts.length < 80; i++) {
        if (html.charAt(i) === "{") starts.push(i);
    }

    for (let i = 0; i < starts.length; i++) {
        let start = starts[i];
        let end = Math.min(html.length, start + 200000);
        let candidate = html.substring(start, end);

        let obj = tryParseJson(candidate);
        if (obj) {
            let found = findMetadataInObject(obj, 0);
            if (found) return found;
        }
    }

    return null;
}

function fetchMetadataUrl(meta, baseUrl) {
    if (!safeObj(meta)) return null;

    let candidates = [
        meta.metadataUrl,
        meta.metadataURL,
        meta.flashvars && meta.flashvars.metadataUrl,
        meta.flashvars && meta.flashvars.metadataURL
    ];

    for (let i = 0; i < candidates.length; i++) {
        let url = normalizeUrl(candidates[i], baseUrl);
        if (!isHttpUrl(url)) continue;

        addDebug("metadataUrl: " + url);

        let body = httpGetAuthenticated(url);
        if (!body) body = httpGet(url);

        let obj = tryParseJson(body);
        if (obj) return findMetadataInObject(obj, 0) || obj;
    }

    return null;
}

function metaHasPlayableSource(meta) {
    // Chequeo rápido: si el metadata inline ya trae HLS o MP4 usable,
    // no vale la pena pagar otro round-trip de red por metadataUrl.
    try {
        if (collectHlsUrls(meta).length > 0) return true;
        if (collectMp4Urls(meta).length > 0) return true;
        if (isM3u8Url(xuperResolve(meta))) return true;
    } catch (_) {}
    return false;
}

function parseMetadata(html, pageUrl) {
    let meta = extractMetadataFromHtml(html);

    if (!meta) return null;

    // FIX: antes se pedía metadataUrl siempre, aunque el metadata inline
    // ya tuviera fuentes reproducibles. Ahora solo se pide de más si hace falta,
    // lo que ahorra una request y acorta el tiempo hasta que arranca el video.
    if (metaHasPlayableSource(meta)) return meta;

    let fetched = fetchMetadataUrl(meta, pageUrl);
    if (fetched) return fetched;

    return meta;
}

function pushUnique(arr, value) {
    value = normalizeUrl(value);
    if (!isHttpUrl(value)) return;
    if (arr.indexOf(value) >= 0) return;
    if (arr.length >= MAX_SOURCES) return;
    arr.push(value);
}

function collectUrlsFromString(s, arr) {
    s = safeStr(s);
    if (!s) return;

    let decoded = htmlDecode(s)
        .replace(/\\\//g, "/")
        .replace(/&amp;/g, "&");

    let abs =
        /https?:\/\/[^\s"'<>\\]+/gi;

    let m;
    while ((m = abs.exec(decoded)) !== null) {
        let u = cleanUrl(m[0]);
        if (isM3u8Url(u)) pushUnique(arr, u);
    }

    let proto = /\/\/[^\s"'<>\\]+/g;
    while ((m = proto.exec(decoded)) !== null) {
        let u = "https:" + cleanUrl(m[0]);
        if (isM3u8Url(u)) pushUnique(arr, u);
    }

    if (isM3u8Url(decoded.trim())) {
        pushUnique(arr, decoded.trim());
    }
}

function collectUrlsFromObject(obj, arr, depth) {
    if (!safeObj(obj) || depth > MAX_JSON_DEPTH || arr.length >= MAX_SOURCES) {
        return;
    }

    if (typeof obj === "string") {
        collectUrlsFromString(obj, arr);
        return;
    }

    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            collectUrlsFromObject(obj[i], arr, depth + 1);
            if (arr.length >= MAX_SOURCES) break;
        }
        return;
    }

    try {
        for (let key in obj) {
            let value = obj[key];

            if (
                /hls|m3u8|manifest|playlist|stream|video|file|url/i.test(key)
            ) {
                collectUrlsFromObject(value, arr, depth + 1);
            }

            if (safeObj(value)) {
                collectUrlsFromObject(value, arr, depth + 1);
            } else if (typeof value === "string") {
                collectUrlsFromString(value, arr);
            }

            if (arr.length >= MAX_SOURCES) break;
        }
    } catch (_) {}
}

function collectMp4UrlsFromString(s, arr) {
    s = safeStr(s);
    if (!s) return;

    let re = /https?:\/\/[^\s"'<>\\]+/gi;
    let m;

    while ((m = re.exec(s)) !== null) {
        let u = cleanUrl(m[0]);
        if (/\.(?:mp4|m4v|mov)(?:$|[?#])/i.test(u)) pushUnique(arr, u);
    }
}

function collectMp4UrlsFromObject(obj, arr, depth) {
    if (!safeObj(obj) || depth > MAX_JSON_DEPTH || arr.length >= MAX_SOURCES) {
        return;
    }

    if (typeof obj === "string") {
        collectMp4UrlsFromString(obj, arr);
        return;
    }

    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            collectMp4UrlsFromObject(obj[i], arr, depth + 1);
        }
        return;
    }

    try {
        for (let key in obj) {
            let v = obj[key];

            if (typeof v === "string") {
                collectMp4UrlsFromString(v, arr);
            } else if (safeObj(v)) {
                collectMp4UrlsFromObject(v, arr, depth + 1);
            }

            if (arr.length >= MAX_SOURCES) break;
        }
    } catch (_) {}
}

function collectHlsUrls(meta) {
    let urls = [];

    let preferred = [
        "hlsMasterPlaylistUrl",
        "hlsManifestUrl",
        "hlsUrl",
        "hls_playlist",
        "hls",
        "hlsUrlMobile",
        "playlistUrl",
        "manifestUrl",
        "streamUrl",
        "videoUrl",
        "url",
        "file"
    ];

    function walk(obj, depth) {
        if (!safeObj(obj) || depth > MAX_JSON_DEPTH) return;

        if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) {
                walk(obj[i], depth + 1);
                if (urls.length >= MAX_SOURCES) return;
            }
            return;
        }

        for (let i = 0; i < preferred.length; i++) {
            let key = preferred[i];

            try {
                if (obj[key] !== undefined) {
                    if (typeof obj[key] === "string") {
                        collectUrlsFromString(obj[key], urls);
                        if (isM3u8Url(obj[key])) pushUnique(urls, obj[key]);
                    } else {
                        collectUrlsFromObject(obj[key], urls, depth + 1);
                    }
                }
            } catch (_) {}
        }

        try {
            for (let key in obj) {
                let v = obj[key];

                if (/hls|m3u8|playlist|manifest/i.test(key)) {
                    if (typeof v === "string") {
                        collectUrlsFromString(v, urls);
                        if (isM3u8Url(v)) pushUnique(urls, v);
                    } else {
                        collectUrlsFromObject(v, urls, depth + 1);
                    }
                }

                if (urls.length >= MAX_SOURCES) return;
            }
        } catch (_) {}
    }

    walk(meta, 0);

    return urls;
}

function collectMp4Urls(meta) {
    let urls = [];
    collectMp4UrlsFromObject(meta, urls, 0);
    return urls;
}

function firstValue(obj, keys) {
    if (!safeObj(obj)) return "";

    for (let i = 0; i < keys.length; i++) {
        let k = keys[i];

        try {
            let v = obj[k];
            if (v === undefined || v === null) continue;
            if (typeof v === "object") continue; // evita "[object Object]"
            let s = safeStr(v);
            if (s) return s;
        } catch (_) {}
    }

    return "";
}

function getTitle(meta, fallback, id) {
    let v = cleanText(firstValue(meta, [
        "title",
        "name",
        "movieTitle",
        "videoTitle",
        "caption"
    ]));

    // FIX: cuando el video no tiene título propio, OK.ru a veces devuelve
    // en "title"/"name" el mismo ID numérico del video en vez de dejarlo
    // vacío. Eso pisaba el título recordado de la búsqueda (ej. "Historia
    // de Evan") con algo como "9132112939654". Si el valor es puramente
    // numérico, o es exactamente el ID, se descarta y se usa el fallback.
    if (v && (/^\d+$/.test(v) || (id && v === safeStr(id)))) {
        v = "";
    }

    return v || cleanText(fallback) || "OK.ru video";
}

function getPoster(meta) {
    return firstValue(meta, [
        "poster",
        "posterUrl",
        "thumbnail",
        "thumbnailUrl",
        "cover",
        "coverUrl",
        "image",
        "imageUrl",
        "preview"
    ]);
}

function getDuration(meta) {
    let v = firstValue(meta, [
        "duration",
        "durationMs",
        "durationSec",
        "length",
        "videoDuration"
    ]);

    let n = parseFloat(v);
    if (!isFinite(n) || n <= 0) return 0;

    // GrayJay commonly expects seconds.
    if (n > 100000) n = n / 1000;
    else if (n > 1000 && n < 100000) n = n / 1000;

    return Math.round(n);
}

function getAuthorName(meta) {
    let direct = cleanText(
        firstValue(meta, [
            "authorName",
            "author",
            "ownerName",
            "uploader",
            "userName",
            "username"
        ])
    );

    if (direct) return direct;

    let containers = [meta.author, meta.owner, meta.user, meta.uploader];

    for (let i = 0; i < containers.length; i++) {
        if (safeObj(containers[i])) {
            let n = firstValue(containers[i], [
                "name",
                "displayName",
                "fullName",
                "userName",
                "username",
                "nickName"
            ]);
            if (n) return cleanText(n);
        }
    }

    return "";
}

function getDescription(meta) {
    return cleanText(
        firstValue(meta, [
            "description",
            "desc",
            "text",
            "summary"
        ])
    );
}

/*
 * Xuper-compatible fallback.
 *
 * Verified APK field names include:
 *   play_params
 *   verificationToken / verification_token
 *   playlistUrl
 *   signdata
 *
 * We only consume a playlist URL that is already present in metadata.
 * We intentionally do not fabricate a signer, token generator, or private
 * Xuper endpoint because those are implementation-specific.
 */
function xuperGetPlayParams(meta) {
    return firstValue(meta, ["play_params", "playParams"]);
}

function xuperGetVerificationToken(meta) {
    return firstValue(meta, ["verificationToken", "verification_token"]);
}

function xuperGetPlaylistUrl(meta) {
    return firstValue(meta, ["playlistUrl", "playlist_url"]);
}

function xuperGetSignature(meta) {
    return firstValue(meta, ["signdata", "signature", "sign"]);
}

function xuperResolve(meta) {
    if (!safeObj(meta)) return "";

    let direct = xuperGetPlaylistUrl(meta);
    if (isM3u8Url(direct)) return normalizeUrl(direct);

    // Some responses nest the Xuper fields.
    let containers = [
        meta.xuper,
        meta.data,
        meta.result,
        meta.auth,
        meta.player,
        meta.flashvars
    ];

    for (let i = 0; i < containers.length; i++) {
        if (!safeObj(containers[i])) continue;

        let u = xuperGetPlaylistUrl(containers[i]);
        if (isM3u8Url(u)) return normalizeUrl(u);
    }

    return "";
}

// FIX: esto se armaba pero nunca se conectaba a ninguna fuente (dead code).
// Además "new RequestModifier()" no es el patrón que usan los plugins que sí
// funcionan (Odysee, Dailymotion): ahí requestModifier es un objeto plano
// { headers, options }, no una clase instanciada. Se deja como objeto simple
// FIX (definitivo): se saca headers/requestModifier de las fuentes de video.
// Comparando con plugins reales (Rumble, SoundCloud) que también extraen un
// link de video desde una página con anti-bot fuerte: NINGUNO le pone
// headers a HLSSource/VideoUrlSource. El link de video en sí ya viene
// autorizado/firmado por el CDN; la protección/cookie de sesión aplica solo
// a la carga de la página HTML (loadOkPage), no al stream. Meterle la cookie
// de sesión al pedido del segmento de video fue lo que rompió la
// reproducción (se quedaba en 00:00). Menos es más acá.
function makeHlsSource(url, duration) {
    try {
        return new HLSSource({
            name: "OK.ru HLS",
            duration: duration || 0,
            url: url
        });
    } catch (_) {}

    return null;
}

function makeMp4Source(url, duration, index) {
    try {
        let lower = safeStr(url).toLowerCase();
        let container = "mp4";

        if (/\.m4v(?:$|[?#])/.test(lower)) container = "m4v";
        else if (/\.webm(?:$|[?#])/.test(lower)) container = "webm";
        else if (/\.mov(?:$|[?#])/.test(lower)) container = "mov";

        return new VideoUrlSource({
            width: 0,
            height: 0,
            container: container,
            codec: "",
            name: "OK.ru " + container.toUpperCase() + " " + (index + 1),
            bitrate: 0,
            duration: duration || 0,
            url: url
        });
    } catch (_) {}

    return null;
}


function buildVideoDetails(meta, pageUrl, fallbackTitle, html) {
    if (!safeObj(meta)) throw new Error("No metadata");

    let title = getTitle(meta, fallbackTitle, extractVideoId(pageUrl));
    let poster = normalizeUrl(getPoster(meta), pageUrl);
    let duration = getDuration(meta);
    let authorName = getAuthorName(meta) || "OK.ru";

    let hls = [];
    let xuperPlaylist = xuperResolve(meta);

    if (isM3u8Url(xuperPlaylist)) {
        pushUnique(hls, xuperPlaylist);
    }

    let normalHls = collectHlsUrls(meta);
    for (let i = 0; i < normalHls.length; i++) {
        pushUnique(hls, normalHls[i]);
    }

    let mp4 = collectMp4Urls(meta);

    addDebug("sources hls=" + hls.length + " mp4=" + mp4.length);

    let sources = [];

    // HLS first. These are direct media URLs, not player pages.
    for (let i = 0; i < hls.length && sources.length < MAX_SOURCES; i++) {
        let src = makeHlsSource(hls[i], duration);
        if (src) sources.push(src);
    }

    // Keep MP4/M4V as a real fallback.
    for (let j = 0; j < mp4.length && sources.length < MAX_SOURCES; j++) {
        let src = makeMp4Source(mp4[j], duration, j);
        if (src) sources.push(src);
    }

    if (sources.length === 0) {
        if (containsExternalVideoEmbed(html)) {
            throw new Error(
                "Este video es un embed de YouTube, búscalo por su plugin"
            );
        }
        throw new Error(
            "No playable direct HLS/MP4 source found\n" + debugText()
        );
    }

    let thumbs = [];
    if (poster && isHttpUrl(poster)) {
        try {
            thumbs.push(new Thumbnail(poster, 0));
        } catch (_) {}
    }

    let thumbnails;
    try {
        thumbnails = new Thumbnails(thumbs);
    } catch (_) {
        thumbnails = new Thumbnails([]);
    }

    let author = null;
    try {
        // FIX: usar el nombre de autor/canal real cuando esté disponible
        // en lugar de mostrar siempre "OK.ru" como autor.
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
        descriptor = new MuxVideoSourceDescriptor({
            isUnMuxed: false,
            videoSources: sources
        });
    } catch (e) {
        addDebug("MuxVideoSourceDescriptor: " + e);

        try {
            descriptor = new VideoSourceDescriptor(sources);
        } catch (e2) {
            addDebug("VideoSourceDescriptor: " + e2);
        }
    }

    if (!descriptor) {
        throw new Error("No video source descriptor available\n" + debugText());
    }

    let firstHls = null;
    if (hls.length > 0) {
        firstHls = makeHlsSource(hls[0], duration);
    }

    return new PlatformVideoDetails({
        id: new PlatformID(PLATFORM_NAME, extractVideoId(pageUrl) || "0", PLUGIN_ID),
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


function parseDurationText(value) {
    let parts = cleanText(value).split(":");
    if (parts.length === 2) {
        return (parseInt(parts[0], 10) || 0) * 60 +
               (parseInt(parts[1], 10) || 0);
    }
    if (parts.length === 3) {
        return (parseInt(parts[0], 10) || 0) * 3600 +
               (parseInt(parts[1], 10) || 0) * 60 +
               (parseInt(parts[2], 10) || 0);
    }
    return 0;
}

function addSearchCandidate(results, seen, id, block, anchorTitle) {
    if (!id || seen[id] || results.length >= 96) return;
    block = safeStr(block);

    // Do not expose an OK.ru item whose actual player is an external provider.
    if (containsExternalVideoEmbed(block)) return;

    let title = cleanText(anchorTitle || "");

    if (!title || title.length < 2) {
        let tm = block.match(
            /(?:data-title|data-name|title)\s*=\s*["']([^"']{2,500})["']/i
        );
        if (tm) title = cleanText(tm[1]);
    }

    if (!title) {
        let tm = block.match(
            /<(?:span|div|a)[^>]*class=["'][^"']*(?:title|name|caption)[^"']*["'][^>]*>([\s\S]{1,700}?)<\/(?:span|div|a)>/i
        );
        if (tm) title = cleanText(tm[1]);
    }

    if (!title) title = "OK.ru video " + id;

    if (/^(image|video|more|next|previous|menu|play)$/i.test(title)) return;

    let poster = "";
    let pm = block.match(
        /<(?:img|source)[^>]+(?:src|data-src|data-lazy-src|poster)\s*=\s*["']([^"']+)["']/i
    );
    if (pm) poster = normalizeUrl(pm[1]);

    if (!poster) {
        let pm2 = block.match(
            /(?:poster|thumbnail|thumbnailUrl|cover|preview)\s*[:=]\s*["']([^"']+)["']/i
        );
        if (pm2) poster = normalizeUrl(pm2[1]);
    }

    let duration = 0;
    let dm = block.match(
        /(?:duration|movie-duration|video-duration)[^>:\n]{0,100}[:=]?\s*["']?([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)["']?/i
    );
    if (dm) duration = parseDurationText(dm[1]);

    seen[id] = true;
    rememberTitle(id, title);

    // FIX real: no dar por sentado que el motor de GrayJay mantiene el
    // estado de este script (TITLE_CACHE) entre la llamada a search() y la
    // llamada posterior a getContentDetails(). Para no depender de eso, el
    // título viaja directamente adentro de la URL que se le entrega a
    // GrayJay; es la misma URL que después vuelve en getContentDetails(url).
    let urlWithTitle =
        "https://ok.ru/video/" + id +
        (!/^OK\.ru video\b/i.test(title)
            ? "?t=" + encodeURIComponent(title)
            : "");

    results.push({
        id: id,
        url: urlWithTitle,
        title: title,
        thumbnail: poster,
        duration: duration
    });
}

function extractSearchResults(html) {
    let results = [];
    let seen = {};
    html = safeStr(html);

    // 1) Normal anchors.
    let re = /<a\b([^>]*?href\s*=\s*["'](?:https?:\/\/[^"']+)?\/(?:video|videoembed)\/(\d+)(?:[?#][^"']*)?["'][^>]*)>([\s\S]*?)<\/a>/gi;
    let m;

    while ((m = re.exec(html)) !== null && results.length < 96) {
        let start = Math.max(0, m.index - 400);
        let end = Math.min(html.length, re.lastIndex + 400);
        addSearchCandidate(
            results, seen, m[2],
            html.substring(start, end),
            m[3]
        );
    }

    // 2) data-movie-id / data-video-id blocks.
    let re2 = /(?:data-movie-id|data-video-id|data-content-id)\s*=\s*["']?(\d+)["']?/gi;
    while ((m = re2.exec(html)) !== null && results.length < 96) {
        let start = Math.max(0, m.index - 400);
        let end = Math.min(html.length, re2.lastIndex + 600);
        addSearchCandidate(
            results, seen, m[1],
            html.substring(start, end),
            ""
        );
    }

    // 3) JSON/escaped OK.ru video URLs.
    let re3 = /(?:https?:)?\\?\/\\?\/(?:www\.)?ok\.ru\\?\/(?:video|videoembed)\\?\/(\d+)/gi;
    while ((m = re3.exec(html)) !== null && results.length < 96) {
        let start = Math.max(0, m.index - 400);
        let end = Math.min(html.length, re3.lastIndex + 400);
        addSearchCandidate(
            results, seen, m[1],
            html.substring(start, end),
            ""
        );
    }

    // 4) Raw /video/<id> references.
    let re4 = /(?:^|["'(\s])\/video\/(\d+)(?:[?#"'()\s]|$)/gi;
    while ((m = re4.exec(html)) !== null && results.length < 96) {
        let start = Math.max(0, m.index - 400);
        let end = Math.min(html.length, re4.lastIndex + 400);
        addSearchCandidate(
            results, seen, m[1],
            html.substring(start, end),
            ""
        );
    }

    return results;
}

function makeSearchVideo(r) {
    let thumbs = [];
    if (isHttpUrl(r.thumbnail)) {
        try { thumbs.push(new Thumbnail(r.thumbnail, 0)); } catch (_) {}
    }

    let thumbnails;
    try { thumbnails = new Thumbnails(thumbs); }
    catch (_) { thumbnails = new Thumbnails([]); }

    let author = null;
    try {
        // Consistente con getContentDetails: mostrar un autor en vez de null
        // para que la tarjeta de resultados también muestre algo en "autor".
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
    } catch (_) {
        return null;
    }
}

function fetchSearchPage(query, page) {
    let url = SEARCH_URL_BASE + encodeURIComponent(safeStr(query));
    if (page > 1) url += "&st.page=" + page;

    let html = httpGetAuthenticated(url);
    if (!html) html = httpGet(url);
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

    let raw = [];
    let seen = {};

    // Pull several result pages so the source is not limited to the first 24.
    for (let p = page; p < page + 4 && raw.length < 96; p++) {
        let html = fetchSearchPage(query, p);
        if (!html) {
            if (p === page) throw new Error("OK.ru search returned no data");
            break;
        }

        let found = extractSearchResults(html);
        if (!found.length && p > page) break;

        for (let i = 0; i < found.length && raw.length < 96; i++) {
            if (!seen[found[i].id]) {
                seen[found[i].id] = true;
                raw.push(found[i]);
            }
        }
    }

    let out = [];
    for (let i = 0; i < raw.length; i++) {
        let v = makeSearchVideo(raw[i]);
        if (v) out.push(v);
    }

    let hasMore = raw.length >= 96;
    let context = {
        query: safeStr(query),
        page: page + 4
    };

    return new OkSearchPager(out, hasMore, context);
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

function searchSuggestions(query) {
    let results = [];

    try {
        let found = searchOk(query);
        for (let i = 0; i < found.length && results.length < 10; i++) {
            let r = found[i];
            let title = r.title || "";

            if (r.details) {
                try {
                    title = r.details.title || title;
                } catch (_) {}
            }

            if (title) results.push(title);
        }
    } catch (e) {
        addDebug("suggestions: " + e);
    }

    return results;
}

function isGenericSiteTitle(t) {
    let s = cleanText(t).toLowerCase();
    return !s || s === "ok" || s === "ok.ru" || s === "ok.ru — social network";
}

function extractPageTitle(html) {
    let m = safeStr(html).match(/<title[^>]*>([^<]+)<\/title>/i);
    if (m) {
        let t = cleanText(m[1])
            .replace(/\s*[|\-–]\s*OK\.?RU.*$/i, "")
            .trim();
        if (!isGenericSiteTitle(t)) return t;
    }

    m = safeStr(html).match(
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
    );
    if (m) {
        let t = cleanText(m[1]);
        if (!isGenericSiteTitle(t)) return t;
    }

    return "";
}

function doDetails(url) {
    resetDebug();

    let id = extractVideoId(url);
    if (!id) throw new Error("Invalid OK.ru video URL");

    let canonical =
        "https://ok.ru/video/" + id;

    addDebug("Video ID: " + id);

    let html = loadOkPage(canonical);

    if (!html) {
        throw new Error("Unable to load OK.ru video page");
    }

    let meta = parseMetadata(html, canonical);

    if (!meta) {
        throw new Error(
            "OK.ru metadata not found. Debug:\n" + debugText()
        );
    }

    addDebug(
        "Xuper fields: play_params=" +
        (xuperGetPlayParams(meta) ? "yes" : "no") +
        ", verificationToken=" +
        (xuperGetVerificationToken(meta) ? "yes" : "no") +
        ", playlistUrl=" +
        (xuperGetPlaylistUrl(meta) ? "yes" : "no") +
        ", signdata=" +
        (xuperGetSignature(meta) ? "yes" : "no")
    );

    // Orden de confianza: título embebido en la URL que llegó (viaja desde
    // la búsqueda sin depender de estado en memoria) > título recordado en
    // memoria (por si el motor sí conserva el contexto) > título de la
    // página > genérico con el ID como último recurso.
    let fallbackTitle =
        extractTitleParam(url) ||
        recallTitle(id) ||
        extractPageTitle(html) ||
        ("OK.ru video " + id);

    return buildVideoDetails(meta, canonical, fallbackTitle, html);
}

/* ------------------------- GrayJay bindings ------------------------- */

source.setSettings = function (settings) {
    // Kept for compatibility with GrayJay versions that expect setSettings.
};

source.enable = function () {
    return true;
};

source.getSearchCapabilities = function () {
    try {
        return new ResultCapabilities(["video"], [], []);
    } catch (_) {
        return {
            types: ["video"],
            sorts: [],
            filters: []
        };
    }
};

source.search = function (query, type, order, filters, continuationToken) {
    return searchOk(query, continuationToken);
};

source.searchSuggestions = function (query) {
    return searchSuggestions(query);
};

source.isContentDetailsUrl = function (url) {
    return REGEX_VIDEO_URL.test(safeStr(url));
};

source.isVideoDetailsUrl = function (url) {
    return REGEX_VIDEO_URL.test(safeStr(url));
};

source.getVideoDetails = function (url) {
    return doDetails(url);
};

source.getContentDetails = function (url) {
    return doDetails(url);
};

class OkHomePager extends VideoPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
    }
    nextPage() {
        return this;
    }
}

source.getHome = function () {
    return new OkHomePager([], false, {});
};

source.isChannelUrl = function (url) {
    return false;
};
