/*
 * GrayJay - OK.ru Source v30 (PRUEBA: extractor simple estilo exOkRu)
 *
 * A partir de v29, se reemplazó todo el recorrido genérico de árbol JSON
 * (findMetadataInObject, collectUrlsFromObject/String, etc.) por la
 * lógica directa del extractor exOkRu de PelisHub/PlayPelis_simple:
 *   - se lee el primer data-options de la página (videoembed primero,
 *     con fallback a /video/<id>)
 *   - se toma flashvars.metadata (parseando si viene como string) o,
 *     si no vino inline, se pide flashvars.metadataUrl
 *   - el HLS es directo: meta.hlsManifestUrl / hlsMasterPlaylistUrl / ondemandHls
 *   - el MP4 es directo: meta.videos = [{name, url}, ...]
 * Se mantiene todo lo demás de v29 (búsqueda con sesión, extractor,
 * requestModifier con Referer/UA de ok.ru sin cookie para que funcione
 * el cast, ranking de calidad QUALITY_RANK, bindings de GrayJay).
 *
 * - Sesión: login nativo de GrayJay (bloque authentication del config).
 *   http.GET(..., true) usa la cookie del usuario. Sin Worker.
 * - Cookie de sesión usada SOLO en la búsqueda de videos.
 * - Extracción de página/metadata y reproducción HLS/MP4 SIN Cookie.
 * - requestModifier (Referer/User-Agent de ok.ru, sin cookie) en las
 *   fuentes HLS/MP4 para que el cast a Chromecast funcione.
 *
 * Hybrid: original v5 search/details contract + explicit GrayJay session auth.
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

function nowMs() {
    try { return Date.now(); } catch (_) { return 0; }
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
    return !!extractYouTubeId(value);
}

function extractYouTubeId(value) {
    let x = safeStr(value)
        .replace(/\\u002F/gi, "/")
        .replace(/\\\//g, "/")
        .replace(/&amp;/gi, "&");

    // Evitar falsos positivos del player de OK ("paths":{"youtube"...}).
    let patterns = [
        /(?:youtube(?:-nocookie)?\.com\/(?:embed|shorts|live|v)\/)([A-Za-z0-9_-]{11})/i,
        /(?:youtube(?:-nocookie)?\.com\/watch\?(?:[^"'<>]*&)?v=)([A-Za-z0-9_-]{11})/i,
        /youtu\.be\/([A-Za-z0-9_-]{11})/i,
        /(?:externalVideoId|youtubeId|youtubeVideoId)\s*[:=]\s*["']([A-Za-z0-9_-]{11})["']/i
    ];
    for (let i = 0; i < patterns.length; i++) {
        let m = x.match(patterns[i]);
        if (m) return m[1];
    }
    return "";
}

function youtubeWatchUrl(id) {
    id = safeStr(id);
    return id ? ("https://www.youtube.com/watch?v=" + id) : "";
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

        // false = sin sesión. La cookie de GrayJay solo se usa en la búsqueda.
        let r = http.GET(url, h, false);
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

function httpPost(url, body, headers) {
    try {
        let h = {
            "User-Agent": UA_DESKTOP,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "*/*"
        };
        mergeHeaders(h, headers);

        let r = http.POST(url, body || "", h, false);
        if (!r) return "";

        let respBody = "";
        try { respBody = r.body; } catch (_) {}
        if (!respBody) { try { respBody = r.getBody(); } catch (_) {} }

        respBody = safeStr(respBody);
        if (respBody.length > MAX_HTML_SIZE) respBody = respBody.substring(0, MAX_HTML_SIZE);
        return respBody;
    } catch (e) {
        addDebug("httpPost: " + e);
        return "";
    }
}

function httpGetAuthenticated(url) {
    try {
        let headers = {
            "User-Agent": UA_DESKTOP,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "es-419,es;q=0.9,en;q=0.8",
            "Referer": "https://ok.ru/"
        };
        // true = sesión del usuario en GrayJay (Login de la fuente).
        let r = http.GET(url, headers, true);
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

function loadOkPage(url, id) {
    // IMPORTANTE: desde esta versión la Cookie queda EXCLUSIVAMENTE para
    // la búsqueda de videos (fetchSearchPage/httpGetAuthenticated).
    // La página del video y todo el proceso de extracción se consulta sin
    // Cookie. Así las URLs que descubre el extractor quedan independientes
    // de la sesión y luego pueden reproducirse/castearse sin Cookie.
    //
    // PRUEBA (v30): igual que exOkRu del simple, se prueba primero
    // /videoembed/<id> (donde el data-options suele venir más directo) y
    // si no responde nada se cae a /video/<id> (la url "canonical" de v29).
    let t0 = nowMs();
    let headers = {
        "User-Agent": UA_DESKTOP,
        "Referer": "https://ok.ru/",
        "Origin": "https://ok.ru"
    };

    let body = "";
    if (id) {
        body = httpGet("https://ok.ru/videoembed/" + id, headers);
    }
    if (!body) {
        body = httpGet(url, headers);
    }

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

/*
 * PRUEBA (v30): extractor de metadata reemplazado por la lógica simple y
 * directa de exOkRu (PelisHub/PlayPelis_simple), en vez del recorrido
 * genérico de árbol que tenía v29 (findMetadataInObject + escaneo de
 * candidatos JSON). Misma idea que el simple: leer el primer
 * data-options de la página, sacar flashvars.metadata (parseando si es
 * string, o pidiendo metadataUrl si no vino inline), y devolver eso tal
 * cual. Si no hay data-options/metadata, plan B: buscar "hlsManifestUrl"
 * directo en el texto de la página.
 */
function extractMetadataFromHtml(html) {
    html = safeStr(html);
    if (!html) return null;

    let m = /data-options\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(html);
    if (m) {
        let raw = m[1] !== undefined ? m[1] : m[2];
        let o = tryParseJson(raw);
        let fv = o && o.flashvars;
        if (fv) {
            let meta = fv.metadata;
            if (typeof meta === "string") meta = tryParseJson(meta);
            if (meta) return meta;

            let metaUrl = fv.metadataUrl || fv.metadataURL;
            if (metaUrl) {
                addDebug("metadataUrl: " + metaUrl);
                let body = httpGet(normalizeUrl(metaUrl, "https://ok.ru/"), {
                    "User-Agent": UA_DESKTOP,
                    "Referer": "https://ok.ru/",
                    "Origin": "https://ok.ru"
                });
                meta = tryParseJson(body);
                if (meta) return meta;
                body = httpPost(normalizeUrl(metaUrl, "https://ok.ru/"), "", {
                    "User-Agent": UA_DESKTOP,
                    "Referer": "https://ok.ru/",
                    "Origin": "https://ok.ru"
                });
                meta = tryParseJson(body);
                if (meta) return meta;
            }
        }
        addDebug("data-options presente pero sin metadata utilizable");
    } else {
        addDebug("sin data-options en la página");
    }

    // Plan B: buscar la clave directo en el texto (sin pasar por JSON.parse
    // del data-options completo).
    let t = htmlDecode(html).replace(/\\\//g, "/");
    let mm = /"hlsManifestUrl"\s*:\s*"([^"]+)"/i.exec(t);
    if (mm) {
        addDebug("plan B: hlsManifestUrl encontrado directo en el HTML");
        return { hlsManifestUrl: cleanUrl(mm[1]) };
    }

    return null;
}

function parseMetadata(html, pageUrl) {
    let t0 = nowMs();
    let meta = extractMetadataFromHtml(html);
    addDebug("extractMetadataFromHtml: " + (nowMs() - t0) + "ms");
    return meta;
}

function pushUnique(arr, value) {
    value = normalizeUrl(value);
    if (!isHttpUrl(value)) return;
    if (arr.indexOf(value) >= 0) return;
    if (arr.length >= MAX_SOURCES) return;
    arr.push(value);
}

/*
 * PRUEBA (v30): igual que exOkRu del simple - el HLS es directo,
 * meta.hlsManifestUrl (o los alias que tambien usa OK.ru), sin recorrido
 * de arbol ni regex sobre todo el JSON.
 */
function collectHlsUrls(meta) {
    if (!safeObj(meta)) return [];
    let hls = meta.hlsManifestUrl || meta.hlsMasterPlaylistUrl || meta.ondemandHls || "";
    let url = normalizeUrl(hls, "https://ok.ru/");
    return isM3u8Url(url) ? [url] : [];
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

/*
 * PRUEBA (v30): igual que exOkRu del simple - meta.videos es directamente
 * el array [{name, url}] que manda OK.ru, sin recorrido genérico del resto
 * del JSON. El label queda como el "name" crudo (hd, sd, full...) para que
 * qualityInfo()/QUALITY_RANK (ya definidos arriba) sigan pudiendo mapearlo
 * a resolución/orden y las fuentes salgan ordenadas de mayor a menor calidad.
 */
function collectMp4Urls(meta) {
    let urls = [];
    if (!safeObj(meta)) return urls;

    let vids = Array.isArray(meta.videos) ? meta.videos.slice(0) : [];
    for (let i = 0; i < vids.length; i++) {
        let v = vids[i];
        if (!v || !v.url) continue;
        pushUniqueQuality(urls, v.url, v.name || "");
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
    // En este tipo de video el nombre viene en meta.movie.title,
    // no en meta.title (que a veces está vacío o es el wrapper).
    let v = "";
    if (safeObj(meta) && safeObj(meta.movie)) {
        v = cleanText(meta.movie.title || meta.movie.name || "");
    }
    if (!v) {
        v = cleanText(firstValue(meta, [
            "title",
            "name",
            "movieTitle",
            "videoTitle",
            "caption"
        ]));
    }

    // FIX: cuando el video no tiene título propio, OK.ru a veces devuelve
    // en "title"/"name" el mismo ID numérico del video en vez de dejarlo
    // vacío. Eso pisaba el título recordado de la búsqueda (ej. "Historia
    // de Evan") con algo como "9132112939654". Si el valor es puramente
    // numérico, o es exactamente el ID, se descarta y se usa el fallback.
    if (v && (/^\d+$/.test(v) || (id && v === safeStr(id)))) {
        v = "";
    }

    let fb = cleanText(fallback);

    // OK.ru manda title = See video "Nombre" on OK. Video Player
    // Eso no tiene que ver con la cookie. Preferimos el nombre de la búsqueda.
    let wrapped = /see video\s+["«“'](.+?)["»”']/i.exec(v);
    if (wrapped) v = cleanText(wrapped[1]);
    if (/see video|on ok\.?\s*video player/i.test(v) && fb && !/see video/i.test(fb)) {
        return fb;
    }

    return v || fb || "OK.ru video";
}

function getPoster(meta) {
    if (safeObj(meta) && safeObj(meta.movie) && meta.movie.poster) {
        return safeStr(meta.movie.poster);
    }
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
    let v = "";
    if (safeObj(meta) && safeObj(meta.movie)) {
        v = firstValue(meta.movie, ["duration", "durationMs", "durationSec"]);
    }
    if (!v) {
        v = firstValue(meta, [
            "duration",
            "durationMs",
            "durationSec",
            "length",
            "videoDuration"
        ]);
    }

    let n = parseFloat(v);
    if (!isFinite(n) || n <= 0) return 0;

    // GrayJay expects seconds. OK.ru movie.duration ya viene en segundos
    // (ej. 1037 = 17 min). Solo ms si es un número enorme.
    if (n > 100000) n = n / 1000;

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
    
    // IMPORTANTE: no mandar la sesión al player / Chromecast.
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
        let r = http.GET(url, headers, false);
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
        else if (/okcdn\.ru/i.test(lower)) container = "mp4";

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

    // HLS primero: en videos como 9132112939654 el MP4 de okcdn no tiene
    // .mp4 y pesa cientos de MB; el player lista calidades y no arranca.
    for (let i = 0; i < hls.length && sources.length < MAX_SOURCES; i++) {
        let src = makeHlsSource(hls[i], duration);
        if (src) {
            src.name = i === 0 ? "OK.ru Auto HLS (Master)" : "OK.ru HLS " + (i + 1);
            sources.push(src);
        }
    }

    // Variantes HLS con URL absoluta: Chromecast suele trabarse con el
    // master (paths relativas /expires/.../video/).
    if (hls.length > 0) {
        try {
            let variants = expandHlsVariants(hls[0]);
            for (let v = 0; v < variants.length && sources.length < MAX_SOURCES; v++) {
                let vs = makeHlsVariantSource(variants[v], duration);
                if (vs) sources.push(vs);
            }
        } catch (e) {
            addDebug("expandHlsVariants: " + e);
        }
    }

    for (let j = 0; j < mp4.length && sources.length < MAX_SOURCES; j++) {
        let src = makeMp4Source(mp4[j].url, duration, j, mp4[j].label);
        if (src) sources.push(src);
    }

    if (!sources.length) {
        let yt = extractYouTubeId(html);
        if (!yt) {
            try { yt = extractYouTubeId(JSON.stringify(meta)); } catch (_) {}
        }
        if (yt) {
            throw new Error(
                "Este item es un embed de YouTube. Abrilo con la fuente YouTube:\n" +
                youtubeWatchUrl(yt)
            );
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

let SEARCH_TITLES = {};
let SEARCH_YT = {};

function jsonUnquote(s) {
    s = safeStr(s);
    try {
        return JSON.parse("\"" + s.replace(/^"|"$/g, "") + "\"");
    } catch (_) {}
    return s
        .replace(/\\"/g, '"')
        .replace(/\\u002F/gi, "/")
        .replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) {
            try { return String.fromCharCode(parseInt(h, 16)); } catch (e) { return ""; }
        });
}

function isWeakSearchTitle(t) {
    t = cleanText(t);
    if (!t || t.length < 2) return true;
    if (/^OK\.ru video\b/i.test(t)) return true;
    if (/^\d+$/.test(t)) return true;
    return /^(image|video|more|next|previous|menu|play|ok|ok\.ru)$/i.test(t);
}

function collectSearchJsonMeta(html) {
    SEARCH_TITLES = {};
    SEARCH_YT = {};
    html = safeStr(html);
    if (!html) return;

    function remember(id, title) {
        id = safeStr(id);
        title = cleanText(title);
        let w = /see video\s+["«“'](.+?)["»”']/i.exec(title);
        if (w) title = cleanText(w[1]);
        if (!id || isWeakSearchTitle(title)) return;
        if (!SEARCH_TITLES[id]) SEARCH_TITLES[id] = title;
    }

    let reTitleAfterId = /"(?:movieId|ownerMovieId|contentId|movie_id|id)"\s*:\s*"?(\d{6,})"[\s\S]{0,900}?"title"\s*:\s*"((?:\\.|[^"\\])*)"/gi;
    let m;
    while ((m = reTitleAfterId.exec(html)) !== null) remember(m[1], jsonUnquote(m[2]));

    let reTitleBeforeId = /"title"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,900}?"(?:movieId|ownerMovieId|contentId|movie_id|id)"\s*:\s*"?(\d{6,})"/gi;
    while ((m = reTitleBeforeId.exec(html)) !== null) remember(m[2], jsonUnquote(m[1]));

    let reYt = /"(?:externalVideoId|youtubeId|youtubeVideoId)"\s*:\s*"([A-Za-z0-9_-]{11})"/gi;
    while ((m = reYt.exec(html)) !== null) {
        let start = Math.max(0, m.index - 500);
        let chunk = html.substring(start, Math.min(html.length, m.index + 200));
        let idm = chunk.match(/"(?:movieId|ownerMovieId|contentId|id)"\s*:\s*"?(\d{6,})"/);
        if (idm) SEARCH_YT[idm[1]] = m[1];
    }
}

function addSearchCandidate(results, seen, id, block, anchorTitle) {
    if (!id || seen[id] || results.length >= 96) return;
    block = safeStr(block);

    let youtubeId = extractYouTubeId(block) || SEARCH_YT[id] || "";

    let title = cleanText(anchorTitle || "");

    if (isWeakSearchTitle(title)) {
        let tm = block.match(
            /(?:data-title|data-name|data-video-title|aria-label)\s*=\s*["']([^"']{2,500})["']/i
        );
        if (tm) title = cleanText(tm[1]);
    }

    if (isWeakSearchTitle(title)) {
        let tm = block.match(
            /<(?:span|div|a)[^>]*class=["'][^"']*(?:video-card_n|movie-name|vid-card_n|title|name|caption)[^"']*["'][^>]*>([\s\S]{1,700}?)<\/(?:span|div|a)>/i
        );
        if (tm) title = cleanText(tm[1]);
    }

    if (isWeakSearchTitle(title) && SEARCH_TITLES[id]) {
        title = SEARCH_TITLES[id];
    }

    if (isWeakSearchTitle(title)) title = "OK.ru video " + id;

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
    let urlWithTitle = youtubeId
        ? youtubeWatchUrl(youtubeId)
        : ("https://ok.ru/video/" + id +
            (!/^OK\.ru video\b/i.test(title)
                ? "?t=" + encodeURIComponent(title)
                : ""));

    results.push({
        id: youtubeId ? ("yt:" + youtubeId) : id,
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
    collectSearchJsonMeta(html);

    // 1) Normal anchors.
    let re = /<a\b([^>]*?href\s*=\s*["'](?:https?:\/\/[^"']+)?\/(?:video|videoembed)\/(\d+)(?:[?#][^"']*)?["'][^>]*)>([\s\S]*?)<\/a>/gi;
    let m;

    while ((m = re.exec(html)) !== null && results.length < 96) {
        let start = Math.max(0, m.index - 800);
        let end = Math.min(html.length, re.lastIndex + 1200);
        addSearchCandidate(
            results, seen, m[2],
            html.substring(start, end),
            m[3]
        );
    }

    // 2) data-movie-id / data-video-id blocks.
    let re2 = /(?:data-movie-id|data-video-id|data-content-id)\s*=\s*["']?(\d+)["']?/gi;
    while ((m = re2.exec(html)) !== null && results.length < 96) {
        let start = Math.max(0, m.index - 800);
        let end = Math.min(html.length, re2.lastIndex + 1200);
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

    // OK.ru: la búsqueda usa la sesión del Login de GrayJay.
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
            .replace(/^(?:see|watch|ver)\s+video\s+["«“'](.+?)["»”']\s+on\s+ok.*$/i, "$1")
            .replace(/\s*[|\-–]\s*OK\.?RU.*$/i, "")
            .replace(/\s+on\s+OK\.?\s*Video Player\s*$/i, "")
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
    let html = loadOkPage(canonical, id);
    addDebug("loadOkPage TOTAL: " + (nowMs() - tLoad) + "ms");

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
