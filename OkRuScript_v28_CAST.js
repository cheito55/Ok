/*
 * GrayJay - OK.ru Source v28 COOKIE EXTRACTION + CAST SIN COOKIE
 * - Cookie de sesión servida por un Worker de Cloudflare (COOKIE_WORKER_URL)
 *   en vez de estar hardcodeada, para no depender de republicar el plugin
 *   cada vez que vence (~30 días).
 * - Cookie de sesión usada SOLO en la búsqueda de videos.
 * - Extracción de página/metadata y reproducción HLS/MP4 SIN Cookie.
 * - requestModifier (Referer/User-Agent de ok.ru, sin cookie) en las
 *   fuentes HLS/MP4 para que el cast a Chromecast funcione.
 * - v28: se reactivó la expansión del master HLS en variantes con calidad
 *   explícita (estaba escrita pero nunca se llamaba) con fallback seguro
 *   al comportamiento anterior si la descarga del master vuelve vacía.
 * - v28: se detecta video embebido de YouTube (por metadata o por iframe
 *   en el HTML) y se avisa en vez de tirar un error genérico.
 *
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

// FIX: la cookie ya no vive hardcodeada acá (se vencía cada ~30 días y había
// que republicar el plugin a mano). Ahora se pide al Worker de Cloudflare
// que guarda la cookie vigente. Reemplazá esta URL por la de tu Worker
// desplegado (ver worker.js) y KEY por el mismo valor que pusiste como
// secret ADMIN_KEY en el Worker.
const COOKIE_WORKER_URL =
    "https://okru-cookie-worker.cheito55.workers.dev/cookie?key=LucasOkRu2026SecretoLargo987";

// Fallback de emergencia si el Worker no responde (por ejemplo, recién
// instalado el plugin y todavía no se cargó ninguna cookie). Se puede dejar
// vacío: sin cookie el plugin sigue funcionando en modo público (sin login).
const EMBEDDED_OK_COOKIE_FALLBACK = "";

// Cache en memoria para no pedirle la cookie al Worker en cada request
// individual dentro de la misma ejecución del script.
let _cachedCookie = null;
let _cookieFetched = false;

function nowMs() {
    try { return Date.now(); } catch (_) { return 0; }
}

function getOkCookie() {
    if (_cookieFetched) return _cachedCookie;
    _cookieFetched = true;
    _cachedCookie = EMBEDDED_OK_COOKIE_FALLBACK;
    let t0 = nowMs();

    try {
        if (COOKIE_WORKER_URL.indexOf("TU-SUBDOMINIO") >= 0) {
            addDebug("COOKIE_WORKER_URL sin configurar, usando fallback");
            return _cachedCookie;
        }

        let r = http.GET(COOKIE_WORKER_URL, { "Accept": "application/json" }, false);
        let body = "";
        if (r) {
            try { body = r.body; } catch (_) {}
            if (!body) { try { body = r.getBody(); } catch (_) {} }
        }

        let data = null;
        try { data = JSON.parse(safeStr(body)); } catch (_) {}

        if (data && data.cookie) {
            _cachedCookie = data.cookie;
            addDebug("Cookie obtenida del Worker (updatedAt=" + (data.updatedAt || "?") + ")");
        } else {
            addDebug("Worker sin cookie válida, usando fallback");
        }
    } catch (e) {
        addDebug("getOkCookie: " + e);
    } finally {
        addDebug("getOkCookie tiempo: " + (nowMs() - t0) + "ms");
    }

    return _cachedCookie;
}

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
const MAX_SOURCES = 12;
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

// GrayJay puede pedir getContentDetails() y getVideoDetails() seguidos.
// Cache corto para no volver a descargar y parsear la misma página.
const DETAILS_CACHE_TTL = 120000;
let DETAILS_CACHE = {};

function getCachedDetails(id) {
    try {
        let x = DETAILS_CACHE[id];
        if (!x) return null;
        if (nowMs() - x.time > DETAILS_CACHE_TTL) {
            delete DETAILS_CACHE[id];
            return null;
        }
        return x.value || null;
    } catch (_) {
        return null;
    }
}

function putCachedDetails(id, value) {
    try {
        if (id && value) DETAILS_CACHE[id] = { time: nowMs(), value: value };
    } catch (_) {}
}

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
        let headers = {
            "User-Agent": UA_DESKTOP,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "es-419,es;q=0.9,en;q=0.8",
            "Referer": "https://ok.ru/"
        };
        let cookie = getOkCookie();
        if (cookie && /(?:^|\.)ok\.ru$/i.test(host)) {
            headers["Cookie"] = cookie;
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
    // IMPORTANTE: desde esta versión la Cookie queda EXCLUSIVAMENTE para
    // la búsqueda de videos (fetchSearchPage/httpGetAuthenticated).
    // La página del video y todo el proceso de extracción se consulta sin
    // Cookie. Así las URLs que descubre el extractor quedan independientes
    // de la sesión y luego pueden reproducirse/castearse sin Cookie.
    let t0 = nowMs();
    let body = httpGet(url, {
        "User-Agent": UA_DESKTOP,
        "Referer": "https://ok.ru/",
        "Origin": "https://ok.ru"
    });
    addDebug("OK page public (no cookie): " + (nowMs() - t0) + "ms");
    return body || "";
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

        // metadataUrl forma parte de la EXTRACCIÓN y también debe ir sin
        // Cookie. La Cookie queda reservada únicamente a la búsqueda.
        let body = httpGet(url, {
            "User-Agent": UA_DESKTOP,
            "Referer": "https://ok.ru/",
            "Origin": "https://ok.ru"
        });

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
    let t0 = nowMs();
    let meta = extractMetadataFromHtml(html);
    addDebug("extractMetadataFromHtml: " + (nowMs() - t0) + "ms");

    if (!meta) return null;

    // Se probó pedir metadataUrl SIEMPRE (incluso con una fuente inline ya
    // jugable) para descartar que trajera más calidades. Con datos reales
    // se confirmó que no traía nada mejor y solo sumaba ~1.5s por request.
    // Se vuelve al comportamiento original: solo se pide de más si hace
    // falta.
    if (metaHasPlayableSource(meta)) return meta;

    let t1 = nowMs();
    let fetched = fetchMetadataUrl(meta, pageUrl);
    addDebug("fetchMetadataUrl: " + (nowMs() - t1) + "ms");

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
        // OK.ru sometimes serves signed media URLs without a .mp4 suffix.
        // Only accept those when the surrounding string clearly identifies
        // a media/file/video URL.
        if (/\.(?:mp4|m4v|mov|webm)(?:$|[?#])/i.test(u) ||
            /(?:^|[?&])(video|file|media|stream)=/i.test(u)) {
            pushUnique(arr, u);
        }
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

// FIX (calidad de cast): OK.ru suele exponer varias URLs de video con una
// etiqueta de calidad (name/type) como "low", "sd", "hd", "full", etc. El
// código anterior descartaba esa etiqueta y guardaba todas las fuentes con
// width/height/bitrate en 0, así que GrayJay no tenía ninguna señal para
// elegir la mejor y terminaba mandando a Cast la primera que encontraba
// (con frecuencia la de menor calidad). Ahora se mapean las etiquetas
// conocidas a una resolución/bitrate aproximados y se ordenan las fuentes
// de mayor a menor calidad.
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
    "lqp": { height: 360, order: 30 },
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

function pushUniqueQuality(arr, url, label) {
    url = normalizeUrl(url);
    if (!isHttpUrl(url)) return;
    for (let i = 0; i < arr.length; i++) {
        if (arr[i].url === url) return;
    }
    if (arr.length >= MAX_SOURCES) return;
    arr.push({ url: url, label: safeStr(label) });
}

function sortByQuality(items) {
    let ranked = items.map(function (item, idx) {
        let q = qualityInfo(item.label);
        return { item: item, order: q ? q.order : -1, idx: idx };
    });
    ranked.sort(function (a, b) {
        if (b.order !== a.order) return b.order - a.order;
        return a.idx - b.idx; // estable para calidades iguales/desconocidas
    });
    return ranked.map(function (r) { return r.item; });
}

function collectMp4Urls(meta) {
    let urls = [];

    // Known OK.ru layouts: metadata.videos / videos / files / streams can
    // contain objects such as {name:"hd", url:"..."} where the URL is signed
    // and may not expose a .mp4 extension.
    function collectKnown(obj, depth) {
        if (!safeObj(obj) || depth > MAX_JSON_DEPTH || urls.length >= MAX_SOURCES) return;

        if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) {
                collectKnown(obj[i], depth + 1);
                if (urls.length >= MAX_SOURCES) return;
            }
            return;
        }

        let isMediaContainer = false;
        try {
            isMediaContainer = /^(videos?|files?|streams?|sources?|media)$/i.test(
                safeStr(obj.type || obj.kind || obj.category)
            );
        } catch (_) {}

        // A media object with url/src/file is a direct candidate.
        if (obj.url || obj.src || obj.file || obj.downloadUrl || obj.download_url) {
            let candidates = [
                obj.url, obj.src, obj.file,
                obj.downloadUrl, obj.download_url
            ];
            let label = safeStr(obj.name || obj.type || obj.kind || obj.quality || "");
            for (let i = 0; i < candidates.length; i++) {
                let u = normalizeUrl(candidates[i]);
                if (!isHttpUrl(u)) continue;
                if (isM3u8Url(u) ||
                    /\.(?:mp4|m4v|mov|webm)(?:$|[?#])/i.test(u) ||
                    isMediaContainer ||
                    /(?:video|file|media|stream|playlist)/i.test(label)) {
                    pushUniqueQuality(urls, u, label);
                }
            }
        }

        try {
            for (let k in obj) {
                if (urls.length >= MAX_SOURCES) break;
                let v = obj[k];
                if (safeObj(v) || Array.isArray(v)) {
                    if (/videos?|files?|streams?|sources?|media|playlist/i.test(k)) {
                        collectKnown(v, depth + 1);
                    } else {
                        collectKnown(v, depth + 1);
                    }
                }
            }
        } catch (_) {}
    }

    collectKnown(meta, 0);

    // Generic fallback keeps compatibility with other OK.ru metadata shapes.
    // No trae etiqueta de calidad, así que queda al final del orden salvo
    // que sortByQuality identifique algo mejor entre las ya etiquetadas.
    let genericUrls = [];
    collectMp4UrlsFromObject(meta, genericUrls, 0);
    for (let i = 0; i < genericUrls.length; i++) {
        pushUniqueQuality(urls, genericUrls[i], "");
    }

    return sortByQuality(urls);
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

// FIX v28 (YouTube embebido): algunos videos de OK.ru en realidad son un
// embed de YouTube (el dueño de la cuenta subió el link, no el archivo).
// La búsqueda ya los descarta con containsExternalVideoEmbed(), pero si se
// llega al detalle por otra vía (favoritos, historial, un link pegado a
// mano) antes esto caía en "OK.ru metadata not found" o en un descriptor
// sin fuentes reproducibles. Ahora se detecta explícitamente y se avisa.
const YT_EMBED_FIELD_NAMES = [
    "externalVideoId", "externalVideo", "youtubeId", "youtubeVideoId",
    "ytVideoId", "youtube_id"
];

function extractYoutubeIdFromUrl(u) {
    u = safeStr(u);
    let m = u.match(
        /(?:youtube(?:-nocookie)?\.com\/(?:embed|watch|shorts|live|v)\/?(?:\?v=)?|youtu\.be\/)([A-Za-z0-9_-]{6,15})/i
    );
    if (m) return m[1];
    m = u.match(/[?&]v=([A-Za-z0-9_-]{6,15})/i);
    if (m) return m[1];
    if (/^[A-Za-z0-9_-]{6,15}$/.test(u)) return u;
    return "";
}

// Chequea SOLO dentro del objeto de metadata ya aislado del player (no la
// página entera), para no confundir un widget de "compartir en YouTube"
// en otra parte de la página con el video real.
function detectYoutubeFromMeta(meta, depth) {
    if (!safeObj(meta) || (depth || 0) > 4) return null;

    for (let i = 0; i < YT_EMBED_FIELD_NAMES.length; i++) {
        try {
            let v = meta[YT_EMBED_FIELD_NAMES[i]];
            if (v && typeof v !== "object") {
                let id = extractYoutubeIdFromUrl(safeStr(v));
                if (id) return { id: id, url: "https://www.youtube.com/watch?v=" + id };
            }
        } catch (_) {}
    }

    let containers = [meta.movie, meta.video, meta.flashvars, meta.data];
    for (let c = 0; c < containers.length; c++) {
        let found = detectYoutubeFromMeta(containers[c], (depth || 0) + 1);
        if (found) return found;
    }

    return null;
}

// Fallback cuando no hay metadata parseable: busca puntualmente un
// <iframe src="...youtube..."> en el HTML, señal mucho más confiable que
// un simple link "watch?v=" suelto en cualquier parte de la página.
function detectYoutubeFromHtml(html) {
    try {
        let m = safeStr(html).match(
            /<iframe[^>]+src=["']([^"']*(?:youtube(?:-nocookie)?\.com|youtu\.be)[^"']*)["']/i
        );
        if (m) {
            let src = cleanUrl(m[1]);
            let id = extractYoutubeIdFromUrl(src);
            return id
                ? { id: id, url: "https://www.youtube.com/watch?v=" + id }
                : { id: "", url: normalizeUrl(src) };
        }
    } catch (_) {}
    return null;
}

// FIX (cast): el intento anterior de sacar todo requestModifier partía de
// que agregar la Cookie de sesión al pedido del stream rompía la
// reproducción local (se quedaba en 00:00) -y eso es cierto, la cookie NO
// va acá-, pero de ahí se concluyó que no había que poner ningún header, y
// esa parte estaba mal: sin Referer, el CDN de OK.ru resuelve/permite la
// petición cuando la pide el propio reproductor de la app (que arma sus
// propios headers por default), pero cuando el link se manda directo al
// receptor de Cast (Chromecast), este pide el manifest/los segmentos sin
// ese contexto y el CDN lo bloquea o devuelve una respuesta vacía -por eso
// "funciona local pero no en cast". El extractor de OK.ru que ya probamos
// en PelisHub (exOkRu) resuelve esto poniéndole Referer/User-Agent/Origin
// de ok.ru a la fuente (sin cookie), y ahí el cast sí anda. Se porta la
// misma idea acá.
// Interruptor de diagnóstico: si al pasar esto a false los videos vuelven
// a arrancar, confirma que el problema es el requestModifier (algún header
// que el CDN de OK.ru no tolera en el player nativo). Si sigue sin arrancar
// en false también, el problema es otra cosa (la URL en sí, la cookie, etc.).
const ENABLE_SOURCE_HEADERS = true;
const SEND_COOKIE_TO_VIDEO_PLAYER = false;

function okRequestModifier() {
    // SEND_COOKIE_TO_VIDEO_PLAYER queda false deliberadamente para probar
    // si el CDN acepta las URLs firmadas sin sesión durante reproducción.
    let h = {
        "User-Agent": UA_DESKTOP,
        "Referer": "https://ok.ru/",
        "Origin": "https://ok.ru"
    };
    
    // IMPORTANTE: NO llamar getOkCookie() aquí.
    // La cookie queda reservada para extracción/metadata; las fuentes que
    // recibe el reproductor y Chromecast salen sin Cookie.

    return {
        headers: h,
        modifyRequest: function (url, headers) {
            headers = headers || {};
            for (let k in h) headers[k] = h[k];
            return { url: url, headers: headers };
        }
    };
}

function makeHlsSource(url, duration) {
    try {
        let opts = {
            name: "OK.ru HLS",
            duration: duration || 0,
            url: url
        };
        if (ENABLE_SOURCE_HEADERS) opts.requestModifier = okRequestModifier();
        return new HLSSource(opts);
    } catch (e) {
        addDebug("makeHlsSource EXCEPTION: " + e);
    }

    return null;
}

// FIX (calidad de cast): cuando el metadata solo trae UNA url .m3u8, en
// muchos casos es un MASTER playlist (adaptativo) con varias variantes
// adentro (#EXT-X-STREAM-INF). Dentro de la app, el player local sí sabe
// elegir la mejor variante del master, pero al castear a Chromecast el
// receptor puede terminar quedándose con la variante más baja. La forma
// confiable de evitar eso es bajar el master, leer sus variantes reales
// (BANDWIDTH/RESOLUTION) y ofrecerlas como fuentes HLS separadas y
// nombradas (ej. "OK.ru HLS 1080p"), de mayor a menor calidad, en vez de
// depender de que el receptor negocie bien el ABR del master.
function resolveM3u8Uri(uri, masterUrl) {
    uri = cleanUrl(uri);
    if (!uri) return "";
    if (/^https?:\/\//i.test(uri)) return uri;

    try {
        if (uri.indexOf("//") === 0) return "https:" + uri;

        if (uri.indexOf("/") === 0) {
            let m = safeStr(masterUrl).match(/^(https?:\/\/[^/]+)/i);
            return m ? m[1] + uri : uri;
        }

        let noQuery = safeStr(masterUrl).split("?")[0];
        let baseDir = noQuery.substring(0, noQuery.lastIndexOf("/") + 1);
        return baseDir + uri;
    } catch (_) {
        return normalizeUrl(uri, masterUrl);
    }
}

function fetchTextWithOkHeaders(url) {
    try {
        let headers = {
            "User-Agent": UA_DESKTOP,
            "Referer": "https://ok.ru/",
            "Origin": "https://ok.ru",
            "Accept": "*/*"
        };
        // Sin Cookie deliberadamente: esto es lectura del manifest durante
        // la extracción de variantes, no búsqueda.
        let r = http.GET(url, headers);
        if (!r) return "";
        let body = "";
        try { body = r.body; } catch (_) {}
        if (!body) { try { body = r.getBody(); } catch (_) {} }
        return safeStr(body);
    } catch (_) {
        return "";
    }
}

function expandHlsVariants(masterUrl) {
    let out = [];
    try {
        let body = fetchTextWithOkHeaders(masterUrl);
        addDebug("m3u8 fetch: len=" + (body ? body.length : 0) +
            " preview=" + safeStr(body).substring(0, 90).replace(/[\r\n]+/g, "\\n"));

        if (!body || body.indexOf("#EXT-X-STREAM-INF") < 0) {
            addDebug("expandHlsVariants: no es un master playlist (o vacío)");
            return out;
        }

        let lines = body.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            if (line.indexOf("#EXT-X-STREAM-INF") !== 0) continue;

            let uriLine = "";
            for (let j = i + 1; j < lines.length; j++) {
                let t = lines[j].trim();
                if (!t || t.charAt(0) === "#") continue;
                uriLine = t;
                break;
            }
            if (!uriLine) continue;

            let bandwidth = 0;
            let bm = line.match(/BANDWIDTH=(\d+)/i);
            if (bm) bandwidth = parseInt(bm[1], 10) || 0;

            let width = 0, height = 0;
            let rm = line.match(/RESOLUTION=(\d+)x(\d+)/i);
            if (rm) {
                width = parseInt(rm[1], 10) || 0;
                height = parseInt(rm[2], 10) || 0;
            }

            let variantUrl = resolveM3u8Uri(uriLine, masterUrl);
            if (!isHttpUrl(variantUrl)) continue;

            out.push({ url: variantUrl, width: width, height: height, bandwidth: bandwidth });
        }
    } catch (e) {
        addDebug("expandHlsVariants EXCEPTION: " + e);
    }

    out.sort(function (a, b) {
        if (b.height !== a.height) return b.height - a.height;
        return b.bandwidth - a.bandwidth;
    });

    return out;
}

function makeHlsVariantSource(variant, duration) {
    let src = makeHlsSource(variant.url, duration);
    if (!src) return null;
    try {
        let label = variant.height
            ? (variant.height + "p")
            : (variant.bandwidth ? Math.round(variant.bandwidth / 1000) + "kbps" : "?");
        src.name = "OK.ru HLS " + label;
    } catch (_) {}
    return src;
}

function makeMp4Source(url, duration, index, label) {
    try {
        let lower = safeStr(url).toLowerCase();
        let container = "mp4";

        if (/\.m4v(?:$|[?#])/.test(lower)) container = "m4v";
        else if (/\.webm(?:$|[?#])/.test(lower)) container = "webm";
        else if (/\.mov(?:$|[?#])/.test(lower)) container = "mov";

        let q = qualityInfo(label);
        let name = q
            ? "OK.ru " + label.toUpperCase() + " (" + q.height + "p)"
            : "OK.ru " + container.toUpperCase() + " " + (index + 1);

        let opts = {
            width: q ? Math.round(q.height * 16 / 9) : 0,
            height: q ? q.height : 0,
            container: container,
            codec: "",
            name: name,
            bitrate: q ? estimateBitrate(q.height) : 0,
            duration: duration || 0,
            url: url
        };
        if (ENABLE_SOURCE_HEADERS) opts.requestModifier = okRequestModifier();
        return new VideoUrlSource(opts);
    } catch (e) {
        addDebug("makeMp4Source EXCEPTION: " + e);
    }

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

    let mp4 = collectMp4Urls(meta); // [{url, label}], ya ordenado de mayor a menor calidad

    let mp4Labels = [];
    for (let i = 0; i < mp4.length; i++) mp4Labels.push(mp4[i].label || "?");
    addDebug("sources hls=" + hls.length + " mp4=" + mp4.length +
        (mp4.length ? " labels=[" + mp4Labels.join(",") + "]" : ""));
    if (hls.length > 0) addDebug("hls[0] url=" + hls[0]);

    /*
     * RUTA RÁPIDA:
     * No descargamos el master .m3u8 desde JS. Esa petición agrega latencia
     * y, según las pruebas ya documentadas en este archivo, suele responder
     * vacío desde el contexto del script mientras ExoPlayer/GrayJay sí puede
     * leer el master directamente.
     *
     * Para Cast, si OK.ru entregó un MP4 cuya calidad conocemos y es HD,
     * lo ponemos primero. Así el receptor recibe una fuente explícitamente
     * etiquetada con la mejor calidad conocida, en lugar de arrancar con ABR.
     * Si no hay MP4 HD conocido, mantenemos el HLS master como primera opción.
     */
    let sources = [];

    // FIX v28 (calidad de cast, automática): expandHlsVariants/makeHlsVariantSource
    // ya existían en el archivo pero nunca se llamaban desde acá, así que el
    // master siempre se ofrecía como única fuente HLS (ABR) y el cast quedaba
    // a merced de cómo el receptor de Chromecast negocia el bitrate. Se
    // reintenta la expansión acá. Si el master vuelve a devolver vacío desde
    // el contexto del script (como ya se documentó en pruebas anteriores),
    // hlsVariants queda en [] y se cae exactamente al comportamiento previo
    // (un solo master + MP4 con label conocida como primary) — no hay
    // regresión posible si la expansión no funciona en este entorno.
    let hlsVariants = [];
    if (hls.length > 0) {
        hlsVariants = expandHlsVariants(hls[0]);
        addDebug("HLS variants expandidos: " + hlsVariants.length);
    }

    if (hlsVariants.length > 0) {
        // Variantes con resolución/bandwidth conocidos, de mayor a menor
        // (expandHlsVariants ya las ordena así). La primera queda como
        // fuente primaria explícita para Cast, sin depender del ABR.
        for (let i = 0; i < hlsVariants.length && sources.length < MAX_SOURCES; i++) {
            let vsrc = makeHlsVariantSource(hlsVariants[i], duration);
            if (vsrc) sources.push(vsrc);
        }
        addDebug("CAST primary: HLS variant " +
            (hlsVariants[0].height ? hlsVariants[0].height + "p" : (hlsVariants[0].bandwidth || "?")));

        // El master queda de último recurso, por si algún dispositivo
        // puntual no aceptara la variante directa.
        if (sources.length < MAX_SOURCES) {
            let masterSrc = makeHlsSource(hls[0], duration);
            if (masterSrc) {
                masterSrc.name = "OK.ru Auto HLS (Master)";
                sources.push(masterSrc);
            }
        }
    } else {
        let bestMp4Index = -1;
        let bestMp4Order = -1;

        for (let j = 0; j < mp4.length; j++) {
            let q = qualityInfo(mp4[j].label);
            let order = q ? q.order : -1;
            if (order > bestMp4Order) {
                bestMp4Order = order;
                bestMp4Index = j;
            }
        }

        if (bestMp4Index >= 0 && bestMp4Order >= 70) {
            let bestSrc = makeMp4Source(
                mp4[bestMp4Index].url,
                duration,
                bestMp4Index,
                mp4[bestMp4Index].label
            );
            if (bestSrc) {
                sources.push(bestSrc);
                addDebug("CAST primary: MP4 " + (mp4[bestMp4Index].label || "?"));
            }
        }

        // HLS master directo, sin round-trip adicional (no se pudo expandir).
        for (let i = 0; i < hls.length && sources.length < MAX_SOURCES; i++) {
            let src = makeHlsSource(hls[i], duration);
            if (src) {
                src.name = i === 0 ? "OK.ru Auto HLS (Master)" : "OK.ru HLS " + (i + 1);
                sources.push(src);
            }
        }

        // El resto de MP4 queda como fallback.
        for (let j = 0; j < mp4.length && sources.length < MAX_SOURCES; j++) {
            if (j === bestMp4Index) continue;
            let src = makeMp4Source(mp4[j].url, duration, j, mp4[j].label);
            if (src) sources.push(src);
        }
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
        addDebug("primary HLS: " + hls[0]);
    } else if (mp4.length > 0) {
        addDebug("primary MP4 (" + (mp4[0].label || "?") + "): " + mp4[0].url);
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

    // OK.ru: en esta instalación la búsqueda necesita la sesión entregada
    // por el Worker para devolver los bloques de video completos.
    // Esta es la ÚNICA ruta que usa getOkCookie().
    let html = httpGetAuthenticated(url);
    if (!html) html = httpGet(url);

    addDebug("search page " + page + " bytes=" + (html ? html.length : 0));
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

    // FIX (velocidad): antes se traían 4 páginas (hasta 8 requests con
    // reintento autenticado/no autenticado) ANTES de devolver el primer
    // resultado a GrayJay, lo que explicaba el ~1min para "encontrar
    // videos". Ahora se trae 1 sola página por llamada; GrayJay pide la
    // siguiente automáticamente vía nextPage() cuando el usuario hace
    // scroll, así el primer resultado aparece mucho antes.
    let html = fetchSearchPage(query, page);
    if (!html) throw new Error("OK.ru search returned no data");

    let found = extractSearchResults(html);

    let raw = [];
    let seen = {};
    for (let i = 0; i < found.length; i++) {
        if (!seen[found[i].id]) {
            seen[found[i].id] = true;
            raw.push(found[i]);
        }
    }

    let out = [];
    for (let i = 0; i < raw.length; i++) {
        let v = makeSearchVideo(raw[i]);
        if (v) out.push(v);
    }

    // OK.ru no indica cuál es la última página; mientras la página traiga
    // resultados asumimos que puede haber más.
    let hasMore = raw.length > 0;
    let context = {
        query: safeStr(query),
        page: page + 1
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
    let tStart = nowMs();

    let id = extractVideoId(url);
    if (!id) throw new Error("Invalid OK.ru video URL");

    let cached = getCachedDetails(id);
    if (cached) {
        addDebug("details cache HIT: " + id);
        return cached;
    }

    let canonical =
        "https://ok.ru/video/" + id;

    addDebug("Video ID: " + id);

    let tLoad = nowMs();
    let html = loadOkPage(canonical);
    addDebug("loadOkPage TOTAL: " + (nowMs() - tLoad) + "ms");

    if (!html) {
        throw new Error("Unable to load OK.ru video page");
    }

    let meta = parseMetadata(html, canonical);

    // Si no hay metadata parseable, o si la hay pero no trae ninguna fuente
    // reproducible, chequeamos si en realidad es un embed de YouTube antes
    // de tirar el error genérico de "metadata not found".
    if (!meta || !metaHasPlayableSource(meta)) {
        let ytInfo = meta ? detectYoutubeFromMeta(meta, 0) : null;
        if (!ytInfo) ytInfo = detectYoutubeFromHtml(html);

        if (ytInfo) {
            addDebug("YouTube embed detectado: " + (ytInfo.url || ytInfo.id));
            throw new Error(
                "Video embebido de YouTube" +
                (ytInfo.url ? " (" + ytInfo.url + ")" : "") +
                ". No se reproduce desde OK.ru: buscalo directamente en YouTube."
            );
        }
    }

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

    let details = buildVideoDetails(meta, canonical, fallbackTitle, html);

    putCachedDetails(id, details);
    addDebug("doDetails TOTAL: " + (nowMs() - tStart) + "ms");

    return details;
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
