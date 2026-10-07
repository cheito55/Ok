/*
 * GrayJay - OK.ru Source v50 (enlaces de canal por ALIAS: el autor se busca por nombre de enlace, no solo /profile|/group)
 *
 * Por qué PlayPelis “sí” y aquí a veces “no” (mismos links ok.ru):
 *   PlayPelis pide HTML + master HLS + segmentos en el MISMO proceso HTTP.
 *   GrayJay solo entrega URLs al player/Cast; el script NO puede tocar
 *   okcdn.ru (whitelist). El CDN ya firma la URL; no hace falta cookie
 *   ni Origin en el stream. Meter requestModifier en HLSSource fue lo que
 *   dejaba 00:00 o rompía Chromecast (lección de v12_CAST).
 *
 * v38:
 *   - Fuentes HLS/MP4 SIN headers/requestModifier (igual que CAST que castea).
 *   - HLS master primero (mejor para Cast); MP4 como fallback.
 *   - Sesión GrayJay solo para buscar; extracción pública + fallback sesión
 *     solo para metadata (cookie nunca al player/Cast).
 *   - Títulos: filtra "View"/"Ver"/"Watch"/etc.; ?t= en la URL.
 *   - Sin HLS_PROBE (falla siempre por whitelist de okcdn.ru).
 *
 * Important: no se inventa firma Xuper; se usa playlistUrl/HLS/MP4 del metadata.
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
    let x = safeStr(value)
        .replace(/\\u002F/gi, "/")
        .replace(/\\\//g, "/")
        .replace(/&amp;/gi, "&");

    return /(?:youtube(?:-nocookie)?\.com|youtu\.be|vimeo\.com)/i.test(x) &&
           /(?:iframe|embed|externalVideo|externalVideoId|youtubeId|youtubeVideoId|playerResponse|watch\?v=|youtube(?:-nocookie)?\.com\/(?:embed|watch|shorts|live|v)|youtu\.be\/)/i.test(x);
}

function extractYouTubeId(value) {
    let x = safeStr(value)
        .replace(/\\u002F/gi, "/")
        .replace(/\\\//g, "/")
        .replace(/&amp;/gi, "&");
    // Patrones estrictos: evita falsos positivos del player de OK ("paths":{"youtube"...}).
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

// Plataformas externas embebidas en OK.ru -> plugin al que se deriva.
function extractExternalEmbed(value) {
    let x = safeStr(value)
        .replace(/\\u002F/gi, "/")
        .replace(/\\\//g, "/")
        .replace(/&amp;/gi, "&");

    let yt = extractYouTubeId(x);
    if (yt) return { plugin: "YouTube", id: yt, url: youtubeWatchUrl(yt) };

    let m = x.match(/player\.vimeo\.com\/video\/(\d{5,12})|vimeo\.com\/(?:video\/)?(\d{5,12})/i);
    if (m) {
        let id = m[1] || m[2];
        return { plugin: "Vimeo", id: id, url: "https://vimeo.com/" + id };
    }

    m = x.match(/dailymotion\.com\/(?:embed\/)?video\/([A-Za-z0-9]{5,10})|dai\.ly\/([A-Za-z0-9]{5,10})/i);
    if (m) {
        let id = m[1] || m[2];
        return { plugin: "Dailymotion", id: id, url: "https://www.dailymotion.com/video/" + id };
    }

    m = x.match(/rutube\.ru\/(?:play\/embed|video)\/([a-f0-9]{32})/i);
    if (m) {
        return { plugin: "Rutube", id: m[1], url: "https://rutube.ru/video/" + m[1] + "/" };
    }

    return null;
}

function installPluginMessage(ext) {
    return "Este video está alojado en " + ext.plugin + ".\nGrayJay no permite salto automático desde esta pantalla. Copie el enlace o búsquelo en la plataforma original:\n" + ext.url;
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

function httpPost(url, body, headers) {
    try {
        let h = {
            "User-Agent": UA_DESKTOP,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "*/*"
        };
        mergeHeaders(h, headers);

        let r = http.POST(url, body || "", h);
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

function looksLikeSearchResults(html) {
    return /\/(?:video|videoembed)\/\d+/i.test(safeStr(html));
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

function makeErr(msg) {
    try { return new ScriptException(msg); } catch (_) { return new Error(msg); }
}

var LOGIN_MSG = "Inicie sesión para encontrar videos";

function looksLikeLoginWall(html) {
    return /st\.cmd=anonym|anonymLogin|anonymMain|st\.email|st\.password|field_email|unite a ok|únete a ok|join ok|log in to ok|войти в одноклассники/i
        .test(safeStr(html));
}

// Solo sesión del Login nativo de GrayJay. Lanza LOGIN_MSG si no hay sesión.
function httpGetAuthenticated(url) {
    let headers = {
        "User-Agent": UA_DESKTOP,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-419,es;q=0.9,en;q=0.8",
        "Referer": "https://ok.ru/"
    };
    let r;
    try {
        r = http.GET(url, headers, true);
    } catch (e) {
        addDebug("search: sesión GrayJay no disponible: " + e);
        throw makeErr(LOGIN_MSG);
    }
    return readBody(r);
}

function loadOkPage(url, id) {
    // v33: la extracción intenta primero la página pública, pero si ésta
    // entrega una página incompleta/bloqueada o metadata sin una fuente
    // reproducible, se repite con la sesión nativa de GrayJay.
    // IMPORTANTE: esta cookie SOLO se usa aquí para EXTRAER metadata.
    // Nunca se copia a las fuentes de reproducción.
    let t0 = nowMs();
    let headers = {
        "User-Agent": UA_DESKTOP,
        "Referer": "https://ok.ru/",
        "Origin": "https://ok.ru"
    };

    let publicBody = "";
    if (id) publicBody = httpGet("https://ok.ru/videoembed/" + id, headers);
    if (!publicBody) publicBody = httpGet(url, headers);

    if (publicBody) {
        try {
            let publicMeta = parseMetadata(publicBody, url);
            if (publicMeta && (collectHlsUrls(publicMeta).length > 0 ||
                collectMp4Urls(publicMeta).length > 0 ||
                isM3u8Url(xuperResolve(publicMeta)))) {
                addDebug("OK page public usable (no cookie): " + (nowMs() - t0) + "ms");
                LAST_PAGE_MODE = "pública (sin sesión)";
                return publicBody;
            }
            addDebug("OK public metadata sin fuente reproducible; pruebo sesión");
        } catch (e) {
            addDebug("OK public metadata parse fallback: " + e);
        }
    }

    // Fallback autenticado: primero el embed (igual que exOkRu), luego la
    // página completa. Se devuelve la primera que traiga fuentes reproducibles.
    function playable(body) {
        try {
            let mt = parseMetadata(body, url);
            if (!mt) return false;
            if (mt.error) addDebug("OK meta.error: " + mt.error);
            return collectHlsUrls(mt).length > 0 ||
                collectMp4Urls(mt).length > 0 ||
                isM3u8Url(xuperResolve(mt));
        } catch (_) { return false; }
    }
    let authFirst = "";
    let targets = [];
    if (id) targets.push("https://ok.ru/videoembed/" + id);
    targets.push(url);
    for (let ti = 0; ti < targets.length; ti++) {
        try {
            let authBody = httpGetAuthenticated(targets[ti]);
            if (!authBody) continue;
            if (!authFirst) authFirst = authBody;
            if (playable(authBody)) {
                addDebug("OK auth playable via " + targets[ti] + ": " + (nowMs() - t0) + "ms");
                LAST_PAGE_MODE = "CON sesión (" + targets[ti] + ")";
                return authBody;
            }
            addDebug("OK auth sin fuentes en " + targets[ti]);
        } catch (e2) {
            addDebug("OK authenticated extraction failed: " + e2);
            break;
        }
    }
    if (authFirst) { LAST_PAGE_MODE = "con sesión, sin fuentes"; return authFirst; }

    LAST_PAGE_MODE = "pública, sin fuentes";
    addDebug("OK page public fallback: " + (nowMs() - t0) + "ms");
    return publicBody || "";
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

    let m = null;
    {
        let reAll = /data-options\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
        let cand, firstAny = null;
        while ((cand = reAll.exec(html)) !== null) {
            if (!firstAny) firstAny = cand;
            let rawc = cand[1] !== undefined ? cand[1] : cand[2];
            if (rawc && rawc.indexOf("flashvars") >= 0) { m = cand; break; }
        }
        if (!m) m = firstAny;
    }
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
                let fullUrl = normalizeUrl(metaUrl, "https://ok.ru/");
                let headers = {
                    "User-Agent": UA_DESKTOP,
                    "Referer": "https://ok.ru/",
                    "Origin": "https://ok.ru"
                };

                // OPTIMIZACIÓN: POST primero
                let body = httpPost(fullUrl, "", headers);
                meta = tryParseJson(body);
                if (meta) return meta;

                // Fallback a GET
                body = httpGet(fullUrl, headers);
                meta = tryParseJson(body);
                if (meta) return meta;
            }
        }
        addDebug("data-options presente pero sin metadata utilizable");
    } else {
        addDebug("sin data-options en la página");
    }

    // Plan B: buscar la clave directo en el texto
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
    // En muchos videos el nombre viene en meta.movie.title.
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

    // OK.ru a veces manda: See video "Nombre" on OK. Video Player
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

    // GrayJay espera segundos. movie.duration de OK.ru ya viene en segundos
    // (ej. 1037 = 17 min); solo se divide si es un número enorme (ms).
    if (n > 100000) n = n / 1000;

    return Math.round(n);
}

// Etiquetas que OK.ru usa para calidades/formatos y que NO son nombres de autor
// (así se colaba "sd" como autor).
const JUNK_NAME = /^(?:sd|hd|hdp|sdp|low|lowest|lq|lqp|mobile|full|fullhd|high|higher|highest|medium|ultra|quad|mp4|hls|dash|auto|default|unknown|null|undefined|true|false|ok|ok\.ru|video|name|title|\d{1,4}p?)$/i;

function isJunkName(n) {
    n = cleanText(n);
    return !n || JUNK_NAME.test(n);
}

function getAuthorName(meta) {
    let direct = cleanText(
        firstValue(meta, [
            "authorName",
            "ownerName",
            "uploader",
            "userName",
            "username"
        ])
    );

    if (direct) return direct;

    let containers = [meta && meta.author, meta && meta.owner, meta && meta.user, meta && meta.uploader];

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

// Devuelve la identidad completa del autor/canal. OK.ru normalmente expone
// author.name + author.profile en el metadata del video. También soportamos
// author.id/uid y grupos para no perder el enlace cuando el video pertenece a
// una comunidad.
function getAuthorInfo(meta) {
    let info = { name: "", id: "", url: "", thumbnail: "", subscribers: 0 };
    if (!safeObj(meta)) return info;

    let a = safeObj(meta.author) ? meta.author :
            (safeObj(meta.owner) ? meta.owner :
            (safeObj(meta.user) ? meta.user :
            (safeObj(meta.uploader) ? meta.uploader : null)));

    if (a) {
        info.name = cleanText(firstValue(a, ["name", "displayName", "fullName", "userName", "username", "nickName"]));
        info.id = safeStr(firstValue(a, ["id", "userId", "uid", "profileId"]));
        if (!/^\d{4,}$/.test(info.id)) info.id = "";
        let profileValue = firstValue(a, ["profile", "profileUrl", "url", "href"]);
        if (safeObj(profileValue)) profileValue = firstValue(profileValue, ["url", "href", "profile"]);
        info.url = normalizeUrl(profileValue, "https://ok.ru/");
        if (info.url && !isChannelLikeUrl(info.url)) info.url = "";
        info.explicit = !!info.url;
        info.thumbnail = normalizeUrl(firstValue(a, ["thumbnail", "avatar", "avatarUrl", "photo", "photoUrl", "pic", "picUrl", "pic190x190", "pic128x128", "pic50x50", "picBase", "image", "imageUrl"]), "https://ok.ru/");
        let sub = firstValue(a, ["subscribers", "subscriberCount", "followers", "followersCount"]);
        if (sub) info.subscribers = parseInt(sub, 10) || 0;
    }

    if (!info.name) info.name = getAuthorName(meta);

    // Si el video es de un grupo/comunidad, groupId suele ser más fiable que
    // inventar un /profile/<id>.
    let movie = safeObj(meta.movie) ? meta.movie : null;
    let groupId = movie ? firstValue(movie, ["groupId", "groupID", "group_id"]) : "";
    groupId = /^\d{4,}$/.test(safeStr(groupId)) ? safeStr(groupId) : "";
    if (groupId && (!info.url || /\/profile\//i.test(info.url) === false && /\/group\//i.test(info.url) === false)) {
        // Conservamos el autor individual si ya vino explícitamente.
    }

    if (!info.url && groupId) {
        info.id = safeStr(groupId);
        info.url = "https://ok.ru/group/" + encodeURIComponent(safeStr(groupId)) + "/";
        if (!info.name) {
            info.name = cleanText(firstValue(meta, ["groupName", "groupTitle", "communityName"]));
        }
    }

    // Si solo tenemos el ID del usuario, construir el perfil estándar.
    if (!info.url && info.id) {
        info.url = "https://ok.ru/profile/" + encodeURIComponent(info.id);
    }

    // Evitar enlaces basura como ok.ru/ o strings no-URL.
    if (!isHttpUrl(info.url) || /^https?:\/\/ok\.ru\/?$/i.test(info.url)) info.url = "";
    if (isJunkName(info.name)) info.name = "";
    if (info.url && !isChannelLikeUrl(info.url)) { info.url = ""; info.explicit = false; }
    return info;
}

// Busca la identidad del autor dentro del bloque HTML de resultados. Esto
// permite mostrar el nombre y hacer click en él SIN descargar los detalles
// completos de cada video de la búsqueda.
function extractAuthorFromBlock(block, strict) {
    block = safeStr(block);
    let out = { name: "", id: "", url: "", thumbnail: "", subscribers: 0 };
    if (!block) return out;

    // OK.ru mezcla HTML, JSON escapado y entidades HTML en los resultados.
    // Normalizamos las tres variantes antes de buscar la identidad.
    let src = block;
    try { src = htmlDecode(src); } catch (_) {}
    src = src.replace(/\\(["'])/g, "$1");

    // 1) Objeto author / owner / uploader en JSON.
    let m = src.match(/(?:["']?(?:author|owner|uploader|creator)["']?\s*:\s*)\{([\s\S]{0,6000})\}/i);
    let hasObj = !!m;
    let obj = m ? m[1] : src;

    // Modo estricto (página de detalle del video): sin un objeto author
    // explícito, "name"/"id"/"url" sueltos en la ventana de HTML pueden ser
    // de cualquier cosa (calidad de video, otro video, etc.). Se ignoran.
    let loose = !m && strict;
    if (loose) obj = "";

    let nmRe = /(?:["']?(?:name|displayName|fullName|userName|username|nickName)["']?)\s*:\s*["']([^"']{2,300})["']/ig;
    let nmM;
    while (obj && (nmM = nmRe.exec(obj)) !== null) {
        let cand = cleanText(nmM[1]);
        if (!isJunkName(cand)) { out.name = cand; break; }
    }

    let im = obj.match(/(?:["']?(?:id|userId|uid|profileId|user_id)["']?)\s*:\s*["']?([A-Za-z0-9_-]{3,80})["']?/i);
    if (im && /^\d{4,}$/.test(im[1])) out.id = cleanText(im[1]);

    let um = obj.match(/(?:["']?(?:profile|profileUrl|url|href)["']?)\s*:\s*["']([^"']{5,1000})["']/i);
    if (um) out.url = normalizeUrl(um[1], "https://ok.ru/");

    let tm = obj.match(/(?:["']?(?:thumbnail|avatar|avatarUrl|photo|photoUrl|pic|picUrl|pic190x190|pic128x128|pic50x50|picBase|imageUrl)["']?)\s*:\s*["']([^"']{5,1000})["']/i);
    if (tm) out.thumbnail = normalizeUrl(tm[1], "https://ok.ru/");

    let sm = obj.match(/(?:["']?(?:subscribers|subscriberCount|followers|followersCount)["']?)\s*:\s*["']?(\d+)/i);
    if (sm) out.subscribers = parseInt(sm[1], 10) || 0;

    // 2) Enlace explícito al perfil/grupo (absoluto O relativo: href="/group/123"),
    // incluso si el objeto author no existe. Se elige el más cercano al centro
    // de la ventana, que es donde está el video de esta tarjeta.
    let linkFound = false;
    {
        let linkRe = /(?:https?:\\?\/\\?\/(?:www\.|m\.)?ok\.ru)?\\?\/(profile|group)\\?\/([A-Za-z0-9_.-]{3,80})(?=[\/?#"'\s<>\\&]|$)/ig;
        let center = Math.floor(src.length / 2);
        let best = null, bestDist = 1e9, lm;
        while ((lm = linkRe.exec(src)) !== null) {
            let d = Math.abs(lm.index - center);
            if (d < bestDist) { bestDist = d; best = { kind: lm[1].toLowerCase(), id: lm[2], end: lm.index + lm[0].length }; }
        }
        // v47: un enlace lejos del centro de la ventana suele ser de OTRA tarjeta
        // (nombre de un autor, canal de otro). Mejor sin enlace que uno ajeno.
        if (best && bestDist > 500) best = null;
        if (best) {
            linkFound = true;
            out.url = "https://ok.ru/" + best.kind + "/" + best.id;
            out.id = best.id;
            // Texto del <a> como nombre si todavía no hay uno.
            if (!out.name) {
                let am = src.substring(best.end, best.end + 500).match(/^[^>]*>([^<]{2,300})<\/a>/i);
                if (am) {
                    let an = cleanText(am[1]);
                    if (!isJunkName(an)) out.name = an;
                }
            }
        }
    }

    // 2b) v50: si el autor tiene nombre, su enlace es el ancla con ESE texto
    // (puede ser un alias, que el paso 2 no reconoce). Pisa al "más cercano".
    if (out.name) {
        try {
            let nl = channelLinkByName(src, [out.name]);
            if (nl) {
                out.url = nl.url;
                out.id = extractChannelId(nl.url) || (nl.url.match(/ok\.ru\/([^\/?#]+)/i) || [])[1] || "";
                linkFound = true;
            }
        } catch (_) {}
    }

    // 3) data-* y clases HTML usadas por las tarjetas.
    if (!out.name) {
        m = src.match(/(?:data-author-name|data-owner-name|data-uploader-name|data-creator-name)\s*=\s*["']([^"']{2,300})["']/i);
        if (m) out.name = cleanText(m[1]);
    }
    if (!out.name) {
        m = src.match(/class=["'][^"']*(?:ucard_name|ucard-name|author-name|authorName|owner-name|entity-name)[^"']*["'][^>]*>([\s\S]{1,500}?)<\//i);
        if (m) out.name = cleanText(m[1]);
    }

    // 4) Identidad de comunidad/grupo. Para estos videos el canal correcto
    // es /group/<id>/video/all, NO /profile/<id>.
    let groupSet = false;
    let gm = linkFound ? null : src.match(/(?:["']?(?:groupId|groupID|group_id|group\.id)["']?)\s*:\s*["']?([A-Za-z0-9_-]{3,80})["']?/i);
    if (gm && !/^\d{5,}$/.test(gm[1])) gm = null;
    if (gm) {
        let gid = cleanText(gm[1]);
        let gname = "";
        let gn = src.match(/(?:["']?(?:groupName|groupTitle|communityName|communityTitle)["']?)\s*:\s*["']([^"']{2,300})["']/i);
        if (gn) gname = cleanText(gn[1]);
        if (!/\/profile\//i.test(out.url)) {
            out.id = gid;
            out.url = "https://ok.ru/group/" + encodeURIComponent(gid) + "/video/all";
            if (gname) out.name = gname;
            groupSet = true;
        }
    }

    // Un "id" suelto de la ventana (sin objeto author ni enlace) no es fiable:
    // era lo que producía canales inexistentes (/profile/<número cualquiera>).
    if (!hasObj && !linkFound && !groupSet) {
        out.id = "";
        if (!isChannelLikeUrl(out.url)) out.url = "";
    }

    // Si el ID es de perfil y todavía no hay URL, construir la ruta de videos.
    if (out.id && !out.url) out.url = "https://ok.ru/profile/" + encodeURIComponent(out.id) + "/video";

    if (!isHttpUrl(out.url) || /^https?:\/\/ok\.ru\/?$/i.test(out.url)) out.url = "";
    if (out.url && !isChannelLikeUrl(out.url)) out.url = "";
    return out;
}

// ------------------------- Nombres de autor en español -------------------------
// Traduce al español los nombres de autor/canal que vienen en alfabetos no
// latinos (cirílico, etc.). Usa translate.googleapis.com (agregar a allowUrls
// en OkRuConfig.json). Hay caché en memoria y la búsqueda traduce todos los
// nombres de una página en UNA sola petición.
const AUTHOR_ES_CACHE = {};

function needsSpanishName(name) {
    // Letras de alfabetos no latinos (cirílico, griego, árabe, CJK, etc.)
    return /[\u0370-\u03FF\u0400-\u052F\u0590-\u06FF\u0900-\u0DFF\u0E00-\u0EFF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(safeStr(name));
}

function translateRaw(text) {
    try {
        let url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=" + encodeURIComponent(text);
        let r = http.GET(url, { "User-Agent": "Mozilla/5.0" });
        let body = "";
        try { body = r.body; } catch (_) {}
        if (!body) { try { body = r.getBody(); } catch (_) {} }
        let j = JSON.parse(safeStr(body));
        let out = "";
        if (j && j[0]) for (let i = 0; i < j[0].length; i++) out += safeStr(j[0][i] && j[0][i][0]);
        return out;
    } catch (e) {
        addDebug("translateRaw: " + e);
        return "";
    }
}

function prefetchSpanishNames(names) {
    let pending = [];
    let seen = {};
    for (let i = 0; i < names.length; i++) {
        let n = cleanText(names[i]);
        if (n && needsSpanishName(n) && !AUTHOR_ES_CACHE[n] && !seen[n]) {
            seen[n] = true;
            pending.push(n);
        }
    }
    if (!pending.length) return;
    pending = pending.slice(0, 40);

    let joined = translateRaw(pending.join("\n"));
    let parts = joined ? joined.split("\n") : [];
    if (parts.length === pending.length) {
        for (let i = 0; i < pending.length; i++) {
            let t = cleanText(parts[i]);
            AUTHOR_ES_CACHE[pending[i]] = t || pending[i];
        }
        return;
    }
    // Respaldo: de a uno (máx. 8) si el lote no volvió alineado.
    for (let i = 0; i < pending.length && i < 8; i++) {
        let t = cleanText(translateRaw(pending[i]));
        AUTHOR_ES_CACHE[pending[i]] = t || pending[i];
    }
}

function toSpanishName(name) {
    name = cleanText(name);
    if (!name || !needsSpanishName(name)) return name;
    if (!AUTHOR_ES_CACHE[name]) prefetchSpanishNames([name]);
    return AUTHOR_ES_CACHE[name] || name;
}

function prefetchResultAuthors(raw) {
    // Nombres por canal visto en esta misma lista (una tarjeta puede venir sin
    // nombre y otra del mismo canal con él).
    let byKey = {};
    for (let i = 0; i < raw.length; i++) {
        let ai = raw[i] && raw[i].authorInfo;
        if (ai && ai.url && ai.name && !isJunkName(ai.name)) byKey[chanKey(ai.url)] = ai.name;
    }
    for (let i = 0; i < raw.length; i++) {
        let ai = raw[i] && raw[i].authorInfo;
        if (!ai) continue;
        if (isJunkName(ai.name)) ai.name = "";
        if (!ai.name && ai.url) {
            let k = chanKey(ai.url);
            if (byKey[k]) ai.name = byKey[k];
            else if (CHANNEL_ORIG_NAMES[k]) ai.name = CHANNEL_ORIG_NAMES[k];
        }
    }

    let names = [];
    for (let i = 0; i < raw.length; i++) {
        let ai = raw[i] && raw[i].authorInfo;
        if (ai && ai.name) names.push(ai.name);
    }
    prefetchSpanishNames(names);
}

// Rutas de ok.ru que NO son un canal/alias de usuario.
const OK_RESERVED = /^(?:video|videoembed|videos|search|dk|feed|games|music|live|settings|apphook|profile|group|mobile|help|about|vkp|cdn|market|events|friends|messages|notifications|dkstatic|api|static|web-api|r|st|logout|anonymMain|post|photo|album|topic|statuses|discussions|sports)$/i;

// URL "canónica" del autor/canal: https://ok.ru/profile/<id>, https://ok.ru/group/<id>
// o https://ok.ru/<alias>, SIN /video ni /video/all. El sufijo se agrega solo
// al descargar la página, así el enlace del autor, isChannelUrl y
// PlatformChannel.url coinciden siempre.
function bareChannelUrl(url) {
    let u = safeStr(url).trim();
    let m = u.match(/^(?:https?:\/\/)?(?:www\.|m\.)?ok\.ru\/(profile|group)\/([^\/?#]+)/i);
    if (m) return "https://ok.ru/" + m[1].toLowerCase() + "/" + m[2];
    let v = u.match(/^(?:https?:\/\/)?(?:www\.|m\.)?ok\.ru\/([A-Za-z0-9_.-]{2,})(?:\/video(?:\/all)?)?\/?(?:[?#].*)?$/i);
    if (v && !OK_RESERVED.test(v[1])) return "https://ok.ru/" + v[1];
    return u;
}

// Nombres de canal ya vistos en enlaces de autor (más fiables que el <title>
// de la página de videos del canal, que suele ser genérico).
const CHANNEL_NAMES = {};        // nombre mostrado (traducido) por id de canal
const CHANNEL_ORIG_NAMES = {};   // nombre original (sin traducir), para buscar
const CHANNEL_AVATARS = {};      // foto de perfil/canal por id de canal

// Clave de caché: el ID numérico/alias, para que /profile/<id> y /group/<id>
// compartan nombre y foto aunque el enlace del autor use la variante equivocada.
function chanKey(url) {
    let m = safeStr(url).match(/ok\.ru\/(?:(?:profile|group)\/)?([^\/?#]+)/i);
    return m ? m[1] : safeStr(url);
}

function validImageUrl(u) {
    u = safeStr(u);
    return /^(?:https?:)?\/\//i.test(u) && !/^data:/i.test(u);
}

// Foto de perfil junto al enlace del autor en el HTML del video.
function findAvatarNearLink(html, url) {
    let m = safeStr(url).match(/\/(profile|group)\/([^\/?#]+)/i);
    if (!m) return "";
    let esc = m[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
        let re = new RegExp("<a[^>]+href=[\"'][^\"']*/" + m[1] + "/" + esc + "[^\"']*[\"'][\\s\\S]{0,700}?<img[^>]+(?:src|data-src)=[\"']([^\"']+)[\"']", "i");
        let mm = safeStr(html).match(re);
        if (mm) {
            let u = normalizeUrl(mm[1], "https://ok.ru/");
            if (validImageUrl(u)) return u;
        }
    } catch (_) {}
    return "";
}

// Autor visto en la búsqueda, por id de video, para completar el detalle si
// la página del reproductor no trae el perfil.
let AUTHOR_CACHE = {};
let AUTHOR_CACHE_COUNT = 0;

function emptyAuthor() {
    return { name: "", id: "", url: "", thumbnail: "", subscribers: 0 };
}

function authorComplete(a) {
    return !!(a && a.name && a.url);
}

function mergeAuthorInfo(a, b) {
    a = a || emptyAuthor();
    if (!b) return a;
    if (!a.name && b.name && !isJunkName(b.name)) a.name = b.name;
    if (!a.url && b.url) { a.url = b.url; if (b.id) a.id = b.id; }
    if (!a.id && b.id) a.id = b.id;
    if (!a.thumbnail && b.thumbnail) a.thumbnail = b.thumbnail;
    if (!a.subscribers && b.subscribers) a.subscribers = b.subscribers;
    return a;
}

function withAuthorParams(url, ai) {
    try {
        url = safeStr(url);
        if (!/ok\.ru\/video\/\d+/i.test(url) || !ai) return url;
        let parts = [];
        let nm = cleanText(ai.name);
        if (nm && !isJunkName(nm)) parts.push("an=" + encodeURIComponent(nm));
        if (ai.url && isChannelLikeUrl(ai.url)) parts.push("au=" + encodeURIComponent(bareChannelUrl(ai.url)));
        if (validImageUrl(ai.thumbnail) && safeStr(ai.thumbnail).length < 400) parts.push("ap=" + encodeURIComponent(ai.thumbnail));
        if (!parts.length) return url;
        return url + (url.indexOf("?") >= 0 ? "&" : "?") + parts.join("&");
    } catch (_) {
        return url;
    }
}

function extractAuthorParams(url) {
    let out = emptyAuthor();
    try {
        let g = function (k) {
            let m = safeStr(url).match(new RegExp("[?&]" + k + "=([^&#]+)"));
            return m ? decodeURIComponent(m[1]) : "";
        };
        out.name = cleanText(g("an"));
        out.url = g("au");
        out.thumbnail = g("ap");
        if (out.url && !isChannelLikeUrl(out.url)) out.url = "";
        let im = out.url.match(/ok\.ru\/(?:(?:profile|group)\/)?([^\/?#]+)/i);
        if (im) out.id = im[1];
    } catch (_) {}
    return out;
}

function rememberAuthor(videoId, info) {
    try {
        videoId = safeStr(videoId);
        if (!videoId || !info || (!info.name && !info.url)) return;
        if (AUTHOR_CACHE_COUNT > 400) { AUTHOR_CACHE = {}; AUTHOR_CACHE_COUNT = 0; }
        if (!(videoId in AUTHOR_CACHE)) AUTHOR_CACHE_COUNT++;
        AUTHOR_CACHE[videoId] = info;
    } catch (_) {}
}

function recallAuthor(videoId) {
    videoId = safeStr(videoId);
    return videoId && AUTHOR_CACHE[videoId] ? AUTHOR_CACHE[videoId] : null;
}

// IDs que NO son un canal real ("null" salía de un groupId: null en el JSON).
function badChannelId(id) {
    id = safeStr(id).trim();
    return !id || /^(?:null|undefined|nan|none|false|true|0|-1)$/i.test(id);
}

function isChannelLikeUrl(u) {
    u = safeStr(u);
    let m = u.match(/ok\.ru\/(?:profile|group)\/([^\/?#]+)/i);
    if (m) return !badChannelId(m[1]);
    return isOkChannelUrl(u) && !/ok\.ru\/?$/i.test(u);
}

// v50: muchos canales de OK.ru usan ALIAS (ok.ru/elbuencine) en vez de
// /group/<id>. Los extractores anteriores solo reconocían /profile|group/<id>,
// así que el enlace propio del autor se perdía y se tomaba el de una tarjeta
// vecina. Acá se busca el enlace por el TEXTO del ancla = nombre del autor.
function normName(s) {
    return cleanText(s).toLowerCase()
        .replace(/[\s\-_.,:;'"()\[\]!¡?¿|\/\\&]+/g, " ").trim();
}

function nameMatches(a, b) {
    a = normName(a); b = normName(b);
    if (!a || !b) return false;
    if (a === b) return true;
    let sh = a.length < b.length ? a : b;
    let lo = a.length < b.length ? b : a;
    return sh.length >= 6 && lo.indexOf(sh) === 0 && sh.length / lo.length >= 0.7;
}

// Canal (profile/group/alias) de un href, o "" si no es un canal.
function channelFromHref(href) {
    let u = normalizeUrl(href, "https://ok.ru/");
    if (!/^https?:\/\/(?:www\.|m\.)?ok\.ru\//i.test(u)) return "";
    u = u.replace(/^https?:\/\/(?:www\.|m\.)?ok\.ru/i, "https://ok.ru");
    let bare = bareChannelUrl(u.replace(/[?#].*$/, ""));
    if (!isOkChannelUrl(bare) || isPseudoAuthorUrl(bare)) return "";
    if (/^https?:\/\/ok\.ru\/?$/i.test(bare)) return "";
    return bare;
}

function eachChannelAnchor(html, fn) {
    html = safeStr(html);
    let re = /<a\b([^>]*?)>([\s\S]{0,400}?)<\/a>/gi;
    let m, n = 0;
    while ((m = re.exec(html)) !== null && n++ < 4000) {
        let attrs = m[1];
        let hm = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
        if (!hm) continue;
        let ch = channelFromHref(hm[1]);
        if (!ch) continue;
        let texts = [cleanText(m[2])];
        let tm = attrs.match(/(?:title|aria-label|data-title)\s*=\s*["']([^"']+)["']/i);
        if (tm) texts.push(cleanText(tm[1]));
        if (fn(ch, texts, m.index)) return;
    }
}

// Enlace de canal cuyo texto coincide con el nombre del autor.
function channelLinkByName(html, names) {
    let want = [];
    for (let i = 0; i < (names || []).length; i++) {
        let n = cleanText(names[i]);
        if (n && !isJunkName(n)) want.push(n);
    }
    if (!want.length) return null;
    let found = null;
    let srcs = [safeStr(html)];
    try {
        let dec = htmlDecode(srcs[0]).replace(/\\\//g, "/");
        if (dec !== srcs[0]) srcs.push(dec);
    } catch (_) {}
    for (let k = 0; k < srcs.length && !found; k++) {
        eachChannelAnchor(srcs[k], function (ch, texts) {
            for (let t = 0; t < texts.length; t++) {
                for (let w = 0; w < want.length; w++) {
                    if (texts[t] && nameMatches(texts[t], want[w])) {
                        found = { url: ch, name: want[w] };
                        return true;
                    }
                }
            }
            return false;
        });
    }
    return found;
}

// Diagnóstico: qué enlaces de canal trae realmente la página.
function describeChannelAnchors(html, names) {
    let out = [];
    try {
        eachChannelAnchor(html, function (ch, texts) {
            out.push(ch.replace("https://ok.ru", "") + " «" + safeStr(texts[0]).substring(0, 28) + "»");
            return out.length >= 6;
        });
    } catch (_) {}
    let low = safeStr(html).toLowerCase();
    let seen = [];
    for (let i = 0; i < (names || []).length; i++) {
        let n = cleanText(names[i]).toLowerCase();
        if (n) seen.push("'" + n.substring(0, 20) + "' x" + (low.split(n).length - 1));
    }
    return "len=" + safeStr(html).length + " nombre:" + (seen.join(",") || "-") + " enlaces:" + (out.join(" | ") || "ninguno");
}

// Último recurso: buscar el canal por nombre en el buscador de grupos/personas.
function searchChannelByName(names) {
    for (let i = 0; i < names.length && i < 2; i++) {
        let modes = ["Groups", "Users"];
        for (let k = 0; k < modes.length; k++) {
            let u = "https://ok.ru/dk?st.cmd=searchResult&st.mode=" + modes[k] +
                    "&st.query=" + encodeURIComponent(names[i]);
            let h = "";
            try { h = httpGetAuthenticated(u); } catch (e) { addDebug("buscar canal: " + e); }
            if (!h) continue;
            let r = channelLinkByName(h, [names[i]]);
            addDebug("buscar canal " + modes[k] + " '" + names[i] + "' bytes=" + h.length + " => " + (r ? r.url : "no"));
            if (r) return r;
        }
    }
    return null;
}

// Respaldo más fiable cuando OK.ru muestra el nombre del autor pero no
// publica el enlace del canal en la página del video. El buscador global de
// videos suele conservar authorInfo completo porque las tarjetas sí conocen
// al autor. Solo se usa después de que Groups/Users no hayan encontrado nada.
function searchChannelByVideoAuthor(names) {
    for (let i = 0; i < names.length && i < 2; i++) {
        let name = cleanText(names[i]);
        if (!name || isJunkName(name)) continue;
        let h = "";
        try { h = fetchSearchPage(name, 1); } catch (e) { addDebug("buscar canal global: " + e); }
        if (!h) continue;
        let found = [];
        try { found = extractSearchResults(h); } catch (_) { found = []; }
        for (let j = 0; j < found.length; j++) {
            let ai = found[j].authorInfo || {};
            if (!ai.url || !isChannelLikeUrl(ai.url)) continue;
            if (!ai.name || !nameMatches(ai.name, name)) continue;
            addDebug("buscar canal global '" + name + "' => " + ai.url);
            return { url: ai.url, name: ai.name || name };
        }
        addDebug("buscar canal global '" + name + "' resultados=" + found.length + " => no");
    }
    return null;
}

// Busca el autor en la página del video (JSON-LD, microdatos y, como último
// recurso, la ventana de HTML alrededor del id del video).
function extractAuthorFromVideoPage(html, videoId, names) {
    let out = emptyAuthor();
    html = safeStr(html);
    if (!html) return out;

    // 1) JSON-LD (schema.org VideoObject)
    try {
        let re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
            let j = tryParseJson(m[1]);
            let arr = (j && j.length !== undefined && typeof j !== "string") ? j : [j];
            for (let i = 0; i < arr.length; i++) {
                let o = arr[i];
                if (!o) continue;
                let a = o.author || o.creator || o.publisher;
                if (a && a.length !== undefined && typeof a !== "string") a = a[0];
                if (a && typeof a === "object") {
                    let nm = cleanText(a.name);
                    let url = normalizeUrl(a.url || a["@id"] || "", "https://ok.ru/");
                    if (nm) out.name = nm;
                    if (isChannelLikeUrl(url)) out.url = url;
                    if (authorComplete(out)) return out;
                }
            }
        }
    } catch (_) {}

    // 2) Microdatos itemprop="author"
    try {
        let m = html.match(/itemprop\s*=\s*["'](?:author|creator)["'][\s\S]{0,900}/i);
        if (m) {
            let blk = m[0];
            let hm = blk.match(/href\s*=\s*["']((?:https?:\/\/(?:www\.|m\.)?ok\.ru)?\/(?:profile|group)\/[^"'#?]+)/i);
            if (hm && !out.url) out.url = normalizeUrl(hm[1], "https://ok.ru/");
            let nm = blk.match(/itemprop\s*=\s*["']name["'][^>]*content\s*=\s*["']([^"']{2,300})["']/i) ||
                     blk.match(/content\s*=\s*["']([^"']{2,300})["'][^>]*itemprop\s*=\s*["']name["']/i) ||
                     blk.match(/itemprop\s*=\s*["']name["'][^>]*>([^<]{2,300})</i);
            if (nm && !out.name) out.name = cleanText(nm[1]);
            if (authorComplete(out)) return out;
        }
    } catch (_) {}

    // 2b) v50: enlace (perfil, grupo o ALIAS) cuyo texto es el nombre del autor.
    try {
        if (!out.url) {
            let nl = channelLinkByName(html, (names || []).concat([out.name]));
            if (nl) { out.url = nl.url; if (!out.name) out.name = nl.name; }
        }
    } catch (_) {}

    // 3) Ventana alrededor del id del video (extractor ya existente).
    try {
        if (!out.url && videoId) {
            let w = extractAuthorForVideoInHtml(html, videoId, true);
            if (w) mergeAuthorInfo(out, w);
        }
    } catch (_) {}

    if (out.url && !isChannelLikeUrl(out.url)) out.url = "";
    return out;
}

// Completa la identidad del autor desde varias fuentes. El reproductor
// (/videoembed/<id>) muchas veces trae el nombre pero no el perfil; entonces
// se usa lo visto en la búsqueda y, si hace falta, la página completa del video.
let AUTHOR_FETCH_TRIED = {};

function resolveAuthorInfo(info, videoId, html) {
    let wasExplicit = !!(info && info.explicit);
    info = mergeAuthorInfo(emptyAuthor(), info);
    info.explicit = wasExplicit;
    let src = "meta";
    try {
        let nm0 = [info.name];
        let rem0 = recallAuthor(videoId);
        if (rem0) nm0.push(rem0.name);
        // v47: primero lo que dice la propia página del video (JSON-LD, microdatos);
        // solo si el metadata no trajo un enlace explícito.
        if (!info.explicit && html) {
            let pg = extractAuthorFromVideoPage(html, videoId, nm0);
            if (pg && pg.url) {
                info.url = pg.url;
                if (pg.id) info.id = pg.id;
                info.explicit = true;
                src += "+html";
            }
            mergeAuthorInfo(info, pg);
        }
        // Autor visto en la tarjeta (viaja en la URL ?an=&au=&ap=): ya no pisa
        // un enlace obtenido de la página del video.
        let rem = recallAuthor(videoId);
        if (rem) {
            if (rem.url && !info.explicit) {
                info.url = rem.url;
                if (rem.id) info.id = rem.id;
            }
            mergeAuthorInfo(info, rem);
            src += "+busqueda";
        }
        if (!authorComplete(info) && html) {
            mergeAuthorInfo(info, extractAuthorFromVideoPage(html, videoId, nm0));
            src += "+html";
        }
        if (!authorComplete(info) && videoId && /^\d+$/.test(safeStr(videoId)) && !AUTHOR_FETCH_TRIED[videoId]) {
            AUTHOR_FETCH_TRIED[videoId] = true;
            let full = httpGet("https://ok.ru/video/" + videoId, { "Referer": "https://ok.ru/" });
            if (!full) full = httpGetAuthenticated("https://ok.ru/video/" + videoId);
            if (full) {
                try {
                    let fm = extractMetadataFromHtml(full);
                    if (fm) mergeAuthorInfo(info, getAuthorInfo(fm));
                } catch (_) {}
                if (!authorComplete(info)) mergeAuthorInfo(info, extractAuthorFromVideoPage(full, videoId, nm0));
                src += "+pagina";
            }
        }
    } catch (e) {
        addDebug("resolveAuthorInfo: " + e);
    }
    try {
        if (!info.thumbnail && info.url) {
            let bu = bareChannelUrl(info.url);
            if (CHANNEL_AVATARS[chanKey(bu)]) info.thumbnail = CHANNEL_AVATARS[chanKey(bu)];
            else if (html) info.thumbnail = findAvatarNearLink(html, info.url);
        }
    } catch (_) {}
    addDebug("author [" + src + "] name=" + info.name + " id=" + info.id + " url=" + info.url + " foto=" + (info.thumbnail ? "si" : "no"));
    return info;
}

function makeAuthorLink(info, videoId, forceDeferred) {
    info = info || {};
    let rawName = isJunkName(info.name) ? "" : cleanText(info.name);
    let url = isHttpUrl(info.url) ? info.url : "";
    let id = safeStr(info.id);
    if (badChannelId(id)) id = "";
    if (url && !isChannelLikeUrl(url)) url = "";

    if (!id && url) {
        let m = url.match(/\/(?:profile|group)\/([^/?#]+)/i);
        if (m) id = m[1];
    }

    // Nombre + ID sin URL: el ID permite crear un enlace real al perfil
    // (si en realidad es un grupo, getChannel prueba también /group/<id>).
    if (!url && /^\d{4,}$/.test(id)) url = "https://ok.ru/profile/" + encodeURIComponent(id);

    if (url) url = bareChannelUrl(url);

    // v48: autor con nombre pero SIN enlace -> antes salía un enlace vacío y
    // GrayJay mostraba "No hay fuente habilitada para admitir este canal ()".
    // Se entrega un enlace diferido que se resuelve al abrir el canal.
    let pseudo = false;
    if (!url && /^\d{6,}$/.test(safeStr(videoId))) {
        url = pseudoAuthorUrl(videoId);
        id = "author-" + safeStr(videoId);
        pseudo = true;
    }

    // Mismo canal visto antes con nombre (otra tarjeta, otro video, la página
    // del canal): reutilizarlo en vez de mostrar "OK.ru".
    if (!rawName && url && !pseudo && CHANNEL_ORIG_NAMES[chanKey(url)]) rawName = CHANNEL_ORIG_NAMES[chanKey(url)];
    let name = toSpanishName(rawName);

    // Hay enlace pero no nombre: mejor mostrar "OK.ru" clickeable que "Unknown".
    if (!name && url) name = "OK.ru";
    if (!name) return null;

    if (!id) {
        let m2 = url.match(/ok\.ru\/(?:(?:profile|group)\/)?([^/?#]+)/i);
        id = m2 ? m2[1] : name;
    }

    if (url && !pseudo && name !== "OK.ru") {
        CHANNEL_NAMES[chanKey(url)] = name;
        let orig = cleanText(info.name);
        if (orig && !isJunkName(orig)) CHANNEL_ORIG_NAMES[chanKey(url)] = orig;
    }
    let thumb = validImageUrl(info.thumbnail) ? safeStr(info.thumbnail) : (url && !pseudo && CHANNEL_AVATARS[chanKey(url)]) || "";

    try {
        return new PlatformAuthorLink(
            new PlatformID(PLATFORM_NAME, id, PLUGIN_ID),
            name,
            url,
            thumb,
            info.subscribers || 0
        );
    } catch (_) {
        return null;
    }
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

// CAST / PlayPelis vs GrayJay:
// - PlayPelis descarga el master/segmentos en el mismo proceso que parsea HTML.
// - GrayJay: el script solo entrega URLs; ExoPlayer/Chromecast las pide aparte.
//   La cookie de sesión aplica a la página HTML, NO al CDN firmado (okcdn.ru).
// - Plugins reales (Rumble, etc.) no ponen requestModifier en HLSSource.
// - Con Origin/Referer/Cookie en el stream: a menudo 00:00 en player o Cast roto.
// - ENABLE_SOURCE_HEADERS=false = mismo comportamiento que OkRuScript_v12_CAST.
const ENABLE_SOURCE_HEADERS = true; // CAST: headers en el stream rompen Chromecast y a veces el player
// Orden de fuentes. false = comportamiento worker-cast (MP4 HD primero si la
// calidad es conocida, luego HLS). true = HLS master primero (útil si algún
// video con MP4 enorme no arranca).
const PREFER_HLS_FIRST = true; // CAST: master HLS primero; MP4 como fallback
const HLS_DIAG = false;
const HLS_PROBE = false;
let LAST_PAGE_MODE = "";
// Origin no es necesario para el reproductor y algunos CDN de OK.ru lo
// rechazan en determinadas URLs firmadas. Referer/UA se conservan.
const SEND_ORIGIN_TO_PLAYER = true; // solo para HLS
const SEND_COOKIE_TO_VIDEO_PLAYER = false;

function okRequestModifier(withOrigin) {
    let h = {
        "User-Agent": UA_DESKTOP
        // Se elimina Referer y Origin. Cast falla por políticas CORS 
        // si se incluyen, y OK.ru solo bloquea el User-Agent de ExoPlayer.
    };
    
    return {
        headers: h,
        modifyRequest: function (url, headers) {
            headers = headers || {};
            for (let k in h) headers[k] = h[k];
            return { url: url, headers: headers };
        }
    };
}

function makeHlsSource(url, duration, mode) {
    // mode: undefined/"full" = UA+Referer+Origin; "noorigin"; "none" = sin requestModifier
    try {
        let opts = {
            name: "OK.ru HLS",
            duration: duration || 0,
            url: url
        };
        if (ENABLE_SOURCE_HEADERS && mode !== "none") {
            opts.requestModifier = okRequestModifier(mode === "noorigin" ? false : SEND_ORIGIN_TO_PLAYER);
        }
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
            container: container === "mp4" ? "video/mp4" : "video/" + container,
            codec: "",
            name: name,
            bitrate: q ? estimateBitrate(q.height) : 0,
            duration: duration || 0,
            url: url
        };
        if (ENABLE_SOURCE_HEADERS) opts.requestModifier = okRequestModifier(false);
        return new VideoUrlSource(opts);
    } catch (e) {
        addDebug("makeMp4Source EXCEPTION: " + e);
    }

    return null;
}


function probeShort(body) {
    return safeStr(body).substring(0, 70).replace(/[^\x20-\x7e]+/g, " ").trim();
}

function probeMaskUrl(url) {
    url = safeStr(url);
    let host = getHost(url);
    let keep = [];
    let names = ["type", "ct", "clientType", "srcAg", "pr", "expires"];
    for (let i = 0; i < names.length; i++) {
        let m = url.match(new RegExp("[?&]" + names[i] + "=([^&]*)", "i"));
        if (m) keep.push(names[i] + "=" + m[1]);
    }
    let path = url.replace(/^https?:\/\/[^/]+/i, "").split("?")[0];
    return host + path + " ?" + keep.join("&") + (/[?&]sig=/i.test(url) ? " &sig=…" : " (SIN sig)");
}

function probeGet(url, headers, auth, range) {
    let h = {};
    for (let k in headers) h[k] = headers[k];
    if (range) h["Range"] = "bytes=0-1023";
    let r;
    try {
        r = auth ? http.GET(url, h, true) : http.GET(url, h);
    } catch (e) {
        return { code: "ERR", body: "", note: safeStr(e).substring(0, 60) };
    }
    let code = "?";
    try { code = r.code; } catch (_) {}
    let body = readBody(r);
    return { code: code, body: body, note: "" };
}

function probeHls(masterUrl) {
    let lines = [];
    lines.push("[DIAG HLS v36] página: " + (LAST_PAGE_MODE || "?"));
    lines.push("master: " + probeMaskUrl(masterUrl));

    let base = { "User-Agent": UA_DESKTOP, "Referer": "https://ok.ru/", "Accept": "*/*" };
    let withOrigin = { "User-Agent": UA_DESKTOP, "Referer": "https://ok.ru/", "Origin": "https://ok.ru", "Accept": "*/*" };
    let tests = [
        { n: "sin sesión, UA+Ref+Origin", h: withOrigin, a: false },
        { n: "sin sesión, UA+Ref", h: base, a: false },
        { n: "sin sesión, sin headers", h: {}, a: false },
        { n: "CON sesión, UA+Ref", h: base, a: true }
    ];

    let best = null;
    for (let i = 0; i < tests.length; i++) {
        let t = tests[i];
        let res = probeGet(masterUrl, t.h, t.a, false);
        let isM3u = safeStr(res.body).indexOf("#EXTM3U") >= 0;
        lines.push("master " + t.n + ": HTTP " + res.code + " len=" + safeStr(res.body).length +
            (isM3u ? " M3U8-OK" : "") + " [" + probeShort(res.body) + "]" + (res.note ? " " + res.note : ""));
        if (isM3u && !best) best = { body: res.body, t: t };
    }

    if (!best) {
        lines.push("=> el master no se puede leer desde JS en ninguna variante");
        return lines.join("\n");
    }

    // Primera línea de URL (variante o segmento).
    let bl = best.body.split(/\r?\n/);
    let next = "";
    for (let i = 0; i < bl.length; i++) {
        let l = bl[i].trim();
        if (l && l.charAt(0) !== "#") { next = l; break; }
    }
    if (!next) { lines.push("master sin URIs"); return lines.join("\n"); }

    let nextUrl = resolveM3u8Uri(next, masterUrl);
    lines.push("sub-URL: " + probeMaskUrl(nextUrl));
    let r2 = probeGet(nextUrl, best.t.h, best.t.a, false);
    let isM3u2 = safeStr(r2.body).indexOf("#EXTM3U") >= 0;
    lines.push("variante: HTTP " + r2.code + " len=" + safeStr(r2.body).length + (isM3u2 ? " M3U8-OK" : "") +
        " [" + probeShort(r2.body) + "]");

    if (isM3u2) {
        let sl = r2.body.split(/\r?\n/);
        let seg = "";
        for (let i = 0; i < sl.length; i++) {
            let l = sl[i].trim();
            if (l && l.charAt(0) !== "#") { seg = l; break; }
        }
        if (seg) {
            let segUrl = resolveM3u8Uri(seg, nextUrl);
            lines.push("segmento: " + probeMaskUrl(segUrl));
            let r3 = probeGet(segUrl, best.t.h, best.t.a, true);
            lines.push("segmento (Range 1KB): HTTP " + r3.code + " len=" + safeStr(r3.body).length);
        }
    }
    return lines.join("\n");
}

function buildVideoDetails(meta, pageUrl, fallbackTitle, html) {
    if (!safeObj(meta)) throw new Error("No metadata");

    let title = getTitle(meta, fallbackTitle, extractVideoId(pageUrl));
    let poster = normalizeUrl(getPoster(meta), pageUrl);
    let duration = getDuration(meta);
    let authorInfo = getAuthorInfo(meta);
    authorInfo = resolveAuthorInfo(authorInfo, extractVideoId(pageUrl), html);
    let authorName = authorInfo.name || "OK.ru";

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

    let probeText = "";
    if (HLS_PROBE && hls.length > 0) {
        try { probeText = probeHls(hls[0]); } catch (pe) { probeText = "[DIAG HLS] error: " + pe; }
    }

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

    // v33: HLS primero. En v32 se priorizaba un MP4 HD si existía; en
    // determinados videos esa URL directa existe pero no inicia en el player
    // o en Cast, mientras que el HLS firmado sí funciona. Dejamos MP4 como
    // fallback para no perder compatibilidad.
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

    if (bestMp4Index < 0 && mp4.length > 0) bestMp4Index = 0;

    if (PREFER_HLS_FIRST) {
        addDebug("v33 source order: HLS first; MP4 fallback");
    } else if (bestMp4Index >= 0) {
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

    // HLS master directo, sin round-trip adicional.
    for (let i = 0; i < hls.length && sources.length < MAX_SOURCES; i++) {
        let src = makeHlsSource(hls[i], duration);
        if (src) {
            src.name = i === 0 ? "OK.ru Auto HLS (Master)" : "OK.ru HLS " + (i + 1);
            sources.push(src);
        }
        if (HLS_DIAG && i === 0) {
            let d1 = makeHlsSource(hls[i], duration, "noorigin");
            if (d1) { d1.name = "OK.ru HLS diag: sin Origin"; sources.push(d1); }
            let d2 = makeHlsSource(hls[i], duration, "none");
            if (d2) { d2.name = "OK.ru HLS diag: sin headers"; sources.push(d2); }
        }
    }

    // El resto de MP4 queda como fallback.
    for (let j = 0; j < mp4.length && sources.length < MAX_SOURCES; j++) {
        if (j === bestMp4Index) continue;
        let src = makeMp4Source(mp4[j].url, duration, j, mp4[j].label);
        if (src) sources.push(src);
    }

    // Sin fuentes propias: si es un embed de otra plataforma, pedir el plugin.
    if (!sources.length) {
        let ext = extractExternalEmbed(html);
        if (!ext) {
            try { ext = extractExternalEmbed(JSON.stringify(meta)); } catch (_) {}
        }
        if (ext) throw makeErr(installPluginMessage(ext));
    }

    if (!sources.length) {
        throw makeErr("OK.ru: este video no expone fuentes reproducibles.\n" + debugText());
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
        // FIX: nombre + ID + URL reales del autor/canal. GrayJay convierte
        // este PlatformAuthorLink en un elemento clickeable.
        if (!authorInfo.name) authorInfo.name = authorName;
        author = makeAuthorLink(authorInfo, extractVideoId(pageUrl));
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

function isGenericTitle(t) {
    t = cleanText(t || "").toLowerCase().replace(/[.\u2026:!]+$/g, "").trim();
    if (!t || t.length < 2) return true;
    // Solo duración / números
    if (/^[\d:\s]+$/.test(t)) return true;
    if (/^(image|video|videos|more|next|previous|menu|play|share|like|comment)$/.test(t)) return true;
    // "View", "View video", "Views 1.2K", "Ver", "Watch", "Смотреть", "Открыть"...
    if (/^(view|views|ver|watch|play|reproducir|смотреть|посмотреть|просмотр|просмотры|открыть)\b/.test(t) && t.length <= 28) return true;
    // Solo "View" / "Ver video" cortos del UI de OK
    if (/^(view|ver|watch)(\s+video)?$/i.test(t)) return true;
    return false;
}

function bestAnchorTitle(attrs, inner) {
    attrs = safeStr(attrs);
    inner = safeStr(inner);
    let cands = [];
    let am = attrs.match(/\btitle\s*=\s*["']([^"']{2,500})["']/i);
    if (am) cands.push(am[1]);
    am = attrs.match(/\baria-label\s*=\s*["']([^"']{2,500})["']/i);
    if (am) cands.push(am[1]);
    let im = inner.match(/\balt\s*=\s*["']([^"']{2,500})["']/i);
    if (im) cands.push(im[1]);
    cands.push(inner);
    for (let i = 0; i < cands.length; i++) {
        let c = cleanText(cands[i]);
        if (c && !isGenericTitle(c)) return c;
    }
    return "";
}

function upgradeSearchTitle(results, idx, id, anchorTitle, anchorAttrs) {
    let r = results[idx];
    if (!r || !/^OK\.ru video\b/i.test(r.title)) return;
    if (r.url.indexOf("https://ok.ru/video/") !== 0) return;
    let t = bestAnchorTitle(anchorAttrs, anchorTitle);
    if (!t) return;
    r.title = t;
    r.url = "https://ok.ru/video/" + id + "?t=" + encodeURIComponent(t);
    rememberTitle(id, t);
}

function addSearchCandidate(results, seen, id, block, anchorTitle, anchorAttrs) {
    if (!id) return;
    if (seen[id]) { upgradeSearchTitle(results, seen[id] - 1, id, anchorTitle, anchorAttrs); return; }
    if (results.length >= 96) return;
    block = safeStr(block);

    // Embeds de YouTube: se entregan con la URL de YouTube para que los abra
    // el plugin de YouTube. Otros proveedores externos (vimeo, etc.) se omiten.
    let ext = extractExternalEmbed(block);
    if (!ext && containsExternalVideoEmbed(block)) return;

    let title = bestAnchorTitle(anchorAttrs, anchorTitle);

    if (!title || title.length < 2) {
        let tm = block.match(
            /(?:data-title|data-name|title)\s*=\s*["']([^"']{2,500})["']/i
        );
        if (tm) title = cleanText(tm[1]);
    }
    if (isGenericTitle(title)) title = "";

    if (!title) {
        let tm = block.match(
            /<(?:span|div|a)[^>]*class=["'][^"']*(?:title|name|caption)[^"']*["'][^>]*>([\s\S]{1,700}?)<\/(?:span|div|a)>/i
        );
        if (tm) title = cleanText(tm[1]);
    }
    if (isGenericTitle(title)) title = "";

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

    seen[id] = results.length + 1;
    rememberTitle(id, title);

    // FIX real: no dar por sentado que el motor de GrayJay mantiene el
    // estado de este script (TITLE_CACHE) entre la llamada a search() y la
    // llamada posterior a getContentDetails(). Para no depender de eso, el
    // título viaja directamente adentro de la URL que se le entrega a
    // GrayJay; es la misma URL que después vuelve en getContentDetails(url).
    let urlWithTitle = ext
        ? ext.url
        : ("https://ok.ru/video/" + id +
            (!/^OK\.ru video\b/i.test(title)
                ? "?t=" + encodeURIComponent(title)
                : ""));

    let authorInfo = extractAuthorFromBlock(block);

    results.push({
        id: ext ? (ext.plugin.toLowerCase() + ":" + ext.id) : id,
        url: urlWithTitle,
        title: title,
        thumbnail: poster,
        duration: duration,
        authorInfo: authorInfo
    });
}

function extractAuthorForVideoInHtml(html, videoId, strict) {
    html = safeStr(html);
    videoId = safeStr(videoId);
    if (!html || !videoId) return { name: "", id: "", url: "", thumbnail: "", subscribers: 0 };

    let re = new RegExp("(?:\\\"|/|:)" + videoId + "(?:\\\"|/|,|\\s)", "g");
    let fallback = { name: "", id: "", url: "", thumbnail: "", subscribers: 0 };
    let m;
    let tries = 0;
    while ((m = re.exec(html)) !== null && tries++ < 4) {
        // Ventana suficiente para JSON de la tarjeta, sin recorrer bloques
        // enormes para cada resultado.
        let start = Math.max(0, m.index - 3000);
        let end = Math.min(html.length, m.index + 3000);
        let info = extractAuthorFromBlock(html.substring(start, end), strict);
        if (info.name && info.url) return info;
        if (!fallback.name && info.name) fallback = info;
        if (strict && !fallback.url && info.url) fallback = info;
    }
    return fallback;
}

function resolveAuthorFromVideoSearch(id) {
    id = safeStr(id);
    if (!/^\d+$/.test(id)) return { name: "", id: "", url: "", thumbnail: "", subscribers: 0 };
    try {
        let page = httpGetAuthenticated("https://ok.ru/video/" + id);
        if (!page) return { name: "", id: "", url: "", thumbnail: "", subscribers: 0 };
        let meta = parseMetadata(page, "https://ok.ru/video/" + id);
        let info = getAuthorInfo(meta);
        if (info.name) return info;
        return extractAuthorForVideoInHtml(page, id);
    } catch (e) {
        addDebug("author detail " + id + ": " + e);
        return { name: "", id: "", url: "", thumbnail: "", subscribers: 0 };
    }
}

function enrichSearchAuthors(results, html) {
    /*
     * IMPORTANTE: esta función se ejecuta dentro de search().
     * No hacemos peticiones /video/<id> aquí. Cada una es una petición
     * autenticada adicional y, al hacerlas en serie, la búsqueda puede quedar
     * bloqueada durante decenas de segundos.
     *
     * El autor se obtiene únicamente del HTML que ya descargó la búsqueda.
     * Si el HTML no trae la identidad, se deja para getContentDetails(), donde
     * ya existe la ruta normal de detalles y no se bloquea la lista de
     * resultados.
     */
    html = safeStr(html);
    if (!html || !results || !results.length) return results;

    // Solo enriquecemos los primeros resultados visibles. El resto conserva
    // el authorInfo que haya podido obtener addSearchCandidate().
    for (let i = 0; i < results.length && i < 24; i++) {
        let r = results[i];
        let ai = r.authorInfo || {};
        if (ai.name && ai.url) continue;

        let info = extractAuthorForVideoInHtml(html, r.id);
        if (info && (info.name || info.url || info.id)) {
            r.authorInfo = info;
        }
    }
    return results;
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
            m[3],
            m[1]
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

    // Segundo intento: buscar author en el bloque JSON asociado a cada video.
    // Esto corrige el caso que se ve en la captura: la tarjeta terminaba
    // mostrando "OK.ru" porque el autor estaba fuera de los 400 caracteres
    // alrededor del enlace.
    enrichSearchAuthors(results, html);

    return results;
}

function makeSearchVideo(r) {
    // Persistir el título antes de que GrayJay haga la segunda llamada de
    // detalles. La URL ya contiene ?t= como segunda barrera.
    try { rememberTitle(r.id, r.title); } catch (_) {}

    let thumbs = [];
    if (isHttpUrl(r.thumbnail)) {
        try { thumbs.push(new Thumbnail(r.thumbnail, 0)); } catch (_) {}
    }

    let thumbnails;
    try { thumbnails = new Thumbnails(thumbs); }
    catch (_) { thumbnails = new Thumbnails([]); }

    try { rememberAuthor(r.id, r.authorInfo); } catch (_) {}

    let author = null;
    try {
        // El extractor de búsqueda guarda authorInfo en r cuando OK.ru lo
        // expone en el mismo bloque HTML. Así el nombre ya aparece en la
        // tarjeta y el enlace apunta directamente al canal/perfil.
        author = makeAuthorLink(r.authorInfo || {}, r.id, !(r.authorInfo && r.authorInfo.trusted));
    } catch (_) {}

    try {
        return new PlatformVideo({
            id: new PlatformID(PLATFORM_NAME, r.id, PLUGIN_ID),
            name: r.title,
            thumbnails: thumbnails,
            author: author,
            uploadDate: 0,
            url: withAuthorParams(r.url, r.authorInfo),
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

    // La búsqueda de OK.ru exige sesión: se usa la del Login de GrayJay.
    let html = httpGetAuthenticated(url);
    addDebug("search page " + page + " bytes=" + (html ? html.length : 0));

    let hasVideos = /\/(?:video|videoembed)\/\d+/i.test(safeStr(html));
    if (!hasVideos && (page <= 1 || looksLikeLoginWall(html))) {
        // Sin enlaces a videos en la primera página (o pared de login): no hay sesión.
        throw makeErr(LOGIN_MSG);
    }
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

    prefetchResultAuthors(raw);

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
    if (/does not exist|не существует|page not found|not found|не найден/.test(s)) return true;
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

    try {
        let ua = extractAuthorParams(url);
        if (ua.name || ua.url) rememberAuthor(id, ua);
    } catch (_) {}

    let cached = getCachedDetails(id);
    if (cached) {
        // Si GrayJay vuelve con la URL que conserva ?t=<titulo>, úsalo para
        // corregir una tarjeta que haya quedado con el ID como nombre.
        let requestedTitle = extractTitleParam(url);
        if (requestedTitle && !/^OK\.ru video\b/i.test(requestedTitle)) {
            try {
                cached.name = requestedTitle;
                rememberTitle(id, requestedTitle);
            } catch (_) {}
        }
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

    if (meta && meta.error) addDebug("OK meta.error: " + meta.error);
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


// ------------------------- Canales / autores -------------------------

const REGEX_CHANNEL_URL = /https?:\/\/(?:www\.|m\.)?ok\.ru\/(?:profile\/[^/?#]+(?:\/video)?|group\/[^/?#]+(?:\/video(?:\/all)?(?:[?#].*)?)?|[A-Za-z0-9_.-]+)(?:[?#].*)?$/i;

const PSEUDO_RESOLVED = {};

function pseudoAuthorUrl(videoId) { return "https://ok.ru/__author/" + safeStr(videoId); }
function isPseudoAuthorUrl(u) { return /ok\.ru\/__author\/\d+/i.test(safeStr(u)); }

// Canal que declara la página del video (nunca lo adivinado en la tarjeta).
function pageChannelFromHtml(html, vid, page, names) {
    let guess = null;
    try {
        let meta = parseMetadata(html, page);
        if (meta) {
            let gi = getAuthorInfo(meta);
            if (gi.name) names.push(gi.name);
            if (gi.url && isChannelLikeUrl(gi.url)) {
                if (gi.explicit) return { url: gi.url, name: gi.name, src: "meta" };
                guess = { url: gi.url, name: gi.name, src: "meta-id" };
            }
        }
    } catch (_) {}
    try {
        let ex = extractAuthorFromVideoPage(html, vid, names);
        if (ex && ex.url && isChannelLikeUrl(ex.url)) return { url: ex.url, name: ex.name, src: "html" };
    } catch (_) {}
    return guess;
}

// Resuelve el canal real de un enlace diferido: 1) página pública del video,
// 2) página con la sesión de GrayJay, 3) buscador de grupos/personas por
// nombre, 4) último recurso, lo visto en la tarjeta de búsqueda.
function resolvePseudoAuthor(url) {
    let m = safeStr(url).match(/ok\.ru\/__author\/(\d+)/i);
    if (!m) return "";
    let vid = m[1];
    if (PSEUDO_RESOLVED[vid]) return PSEUDO_RESOLVED[vid];
    let page = "https://ok.ru/video/" + vid;
    let rem = recallAuthor(vid);
    let names = [];
    if (rem && rem.name) names.push(rem.name);
    let found = null;
    let lastHtml = "";
    let html = "";
    try { html = httpGet(page, { "Referer": "https://ok.ru/" }); } catch (_) {}
    if (html) { lastHtml = html; found = pageChannelFromHtml(html, vid, page, names); }
    if (!found) {
        try {
            let ah = httpGetAuthenticated(page);
            if (ah && ah !== html) { lastHtml = ah; found = pageChannelFromHtml(ah, vid, page, names); }
        } catch (e) { addDebug("autor diferido (sesión): " + e); }
    }
    if (!found) {
        let uniq = [];
        for (let i = 0; i < names.length; i++) {
            let n = cleanText(names[i]);
            if (n && !isJunkName(n) && uniq.indexOf(n) < 0) uniq.push(n);
        }
        names = uniq;
        let r = names.length ? searchChannelByName(names) : null;
        if (r) found = { url: r.url, name: r.name, src: "buscador-por-nombre" };
        if (!found) {
            let gv = names.length ? searchChannelByVideoAuthor(names) : null;
            if (gv) found = { url: gv.url, name: gv.name, src: "buscador-global-videos" };
        }
    }
    if (!found && rem && rem.url && isChannelLikeUrl(rem.url) && !isPseudoAuthorUrl(rem.url)) {
        found = { url: rem.url, name: "", src: "busqueda" };
    }
    if (found) {
        let bare = bareChannelUrl(found.url);
        if (found.name && !isJunkName(found.name)) CHANNEL_ORIG_NAMES[chanKey(bare)] = found.name;
        PSEUDO_RESOLVED[vid] = bare;
        addDebug("autor diferido " + vid + " [" + found.src + "] -> " + bare);
        return bare;
    }
    addDebug("autor diferido " + vid + ": no se encontró canal. nombres=" + (names.join(" / ") || "-"));
    addDebug("página: " + describeChannelAnchors(lastHtml, names));
    return "";
}

function unpseudoChannel(url) {
    if (!isPseudoAuthorUrl(url)) return url;
    let real = resolvePseudoAuthor(url);
    if (!real) throw new Error("OK.ru no indica a qué canal pertenece este video. Abre el video y vuelve a probar.\n" + debugText());
    return real;
}

function isOkChannelUrl(url) {
    if (isPseudoAuthorUrl(url)) return true;
    let u = safeStr(url);
    let pg = u.match(/^(?:https?:\/\/)?(?:www\.|m\.)?ok\.ru\/(?:profile|group)\/([^/?#]+)/i);
    if (pg && badChannelId(pg[1])) return false;
    if (/^(?:https?:\/\/)?(?:www\.|m\.)?ok\.ru\/(?:profile\/[^/?#]+(?:\/video)?|group\/[^/?#]+(?:\/video(?:\/all)?(?:[?#].*)?)?)(?:[?#].*)?$/i.test(u)) return true;
    // Alias de usuario: https://ok.ru/<alias> (excluye rutas reservadas del sitio).
    let v = u.match(/^(?:https?:\/\/)?(?:www\.|m\.)?ok\.ru\/([A-Za-z0-9_.-]{2,})(?:\/video(?:\/all)?)?\/?(?:[?#].*)?$/i);
    return !!v && !OK_RESERVED.test(v[1]) && !badChannelId(v[1]);
}

function normalizeChannelUrl(url) {
    let u = safeStr(url).trim();
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "https://ok.ru/" + u.replace(/^\/+/, "");
    u = u.replace(/^https?:\/\/m\.ok\.ru/i, "https://ok.ru");
    u = u.replace(/\/$/, "");

    // OK.ru expone los videos de grupos en /video/all y los videos de
    // perfiles en /profile/<id>/video. Un perfil raíz puede mostrar el feed
    // general, no necesariamente todos sus videos.
    if (/\/group\/[^/?#]+$/i.test(u)) return u + "/video/all";
    if (/\/profile\/[^/?#]+$/i.test(u)) return u + "/video";
    return u;
}

function extractChannelId(url) {
    let m = safeStr(url).match(/\/(profile|group)\/([^/?#]+)/i);
    return m ? safeStr(m[2]) : "";
}

function extractChannelName(html, url) {
    let t = extractPageTitle(html);
    if (t) return t;

    let m = safeStr(html).match(/<h1[^>]*>([\s\S]{2,500}?)<\/h1>/i);
    if (m) {
        let n = cleanText(m[1]);
        if (n && !isGenericSiteTitle(n)) return n;
    }

    // Meta OG title es una fuente frecuente en perfiles/grupos.
    m = safeStr(html).match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (m) return cleanText(m[1]);
    return "OK.ru";
}

function extractChannelThumbnail(html) {
    html = safeStr(html);
    let pats = [
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
        /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
        /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
        /["'](?:avatarUrl|avatar|pic190x190|pic128x128|pic50x50|picBase)["']\s*:\s*["']([^"']+)["']/i,
        /<img[^>]+(?:class|data-l)[^>]*(?:avatar|profile|group)[^>]+(?:src|data-src)=["']([^"']+)["']/i
    ];
    for (let i = 0; i < pats.length; i++) {
        let m = html.match(pats[i]);
        if (m) {
            let u = normalizeUrl(m[1], "https://ok.ru/");
            if (validImageUrl(u)) return u;
        }
    }
    return "";
}

function extractChannelDescription(html) {
    let m = safeStr(html).match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    return m ? cleanText(m[1]) : "";
}

const CHANNEL_RESOLVED = {};
// v47: resultados sin videos (canal dudoso) se recuerdan solo 60 s, así un
// fallo puntual (sesión, red) no deja el canal roto toda la sesión.
const CHANNEL_WEAK = {};
const CHANNEL_WEAK_TTL = 10 * 60 * 1000;
// v47: ids de video ya entregados por canal, para cortar páginas repetidas.
const CHANNEL_SEEN = {};

// Videos de una página de canal: primero el extractor normal; si no hay nada,
// se decodifica el HTML (JSON escapado / entidades) y se buscan IDs de video
// en claves habituales de OK.ru (movieId, mvId, videoId) y rutas /video/<id>.
function collectChannelVideos(html, quiet) {
    html = safeStr(html);
    let raw = [];
    let seen = {};

    function take(found) {
        for (let i = 0; i < found.length; i++) {
            if (!seen[found[i].id]) { seen[found[i].id] = true; raw.push(found[i]); }
        }
    }

    try { take(extractSearchResults(html)); } catch (e) { addDebug("canal extract: " + e); }
    if (raw.length) return raw;

    let dec = html;
    try { dec = htmlDecode(html).replace(/\\\//g, "/"); } catch (_) {}
    try { take(extractSearchResults(dec)); } catch (e) { addDebug("canal extract dec: " + e); }
    if (raw.length) { if (!quiet) addDebug("canal: videos tras decodificar HTML=" + raw.length); return raw; }

    let pats = [
        /(?:movieId|mvId|videoId|movie_id)["']?\s*[:=]\s*["']?(\d{6,})/gi,
        /st\.mvId=(\d{6,})/g,
        /\/video\/(\d{6,})/g
    ];
    let idSeen = {};
    let hits = [];
    for (let p = 0; p < pats.length; p++) {
        let m;
        while ((m = pats[p].exec(dec)) !== null && hits.length < 96) {
            if (!idSeen[m[1]]) { idSeen[m[1]] = true; hits.push({ id: m[1], index: m.index }); }
        }
    }

    let results = [];
    let seen2 = {};
    for (let i = 0; i < hits.length; i++) {
        let h = hits[i];
        let win = dec.substring(Math.max(0, h.index - 600), Math.min(dec.length, h.index + 900));
        addSearchCandidate(results, seen2, h.id, win, "");
        let r = results[results.length - 1];
        if (r && r.id === h.id && /^OK\.ru video\b/i.test(r.title)) {
            let after = dec.substring(h.index, Math.min(dec.length, h.index + 600));
            let before = dec.substring(Math.max(0, h.index - 300), h.index);
            let jm = after.match(/["']title["']\s*:\s*["']([^"']{2,300})["']/i);
            if (!jm) {
                let all = before.match(/["']title["']\s*:\s*["']([^"']{2,300})["']/gi);
                if (all && all.length) jm = all[all.length - 1].match(/["']title["']\s*:\s*["']([^"']{2,300})["']/i);
            }
            if (jm) {
                let t = cleanText(jm[1]);
                if (t && !isGenericTitle(t)) {
                    r.title = t;
                    r.url = "https://ok.ru/video/" + h.id + "?t=" + encodeURIComponent(t);
                }
            }
        }
    }

    if (!results.length && !quiet) {
        let t = extractPageTitle(html) || "";
        let n1 = (dec.match(/\/video\/\d+/g) || []).length;
        let n2 = (dec.match(/movieId|mvId|videoId/gi) || []).length;
        addDebug("canal sin videos: len=" + dec.length + " title=" + t + " refs/video=" + n1 + " claves=" + n2);
        addDebug("inicio: " + cleanText(dec.substring(0, 300)).substring(0, 100));
    } else if (results.length && !quiet) {
        addDebug("canal: videos por IDs=" + results.length);
    }
    return results;
}

// Último recurso: buscar el nombre del canal en el buscador de OK.ru y
// quedarse solo con los resultados cuyo autor es este canal.
function channelSearchFallback(bare, ident, page) {
    let name = ident && ident.name ? ident.name : "";
    if (!name || isGenericSiteTitle(name)) return [];
    let id = (bare.match(/ok\.ru\/(?:(?:profile|group)\/)?([^\/?#]+)/i) || [])[1] || "";
    let sh = fetchSearchPage(name, page);
    if (!sh) return [];
    let found = extractSearchResults(sh);
    let out = [];
    for (let i = 0; i < found.length; i++) {
        let ai = found[i].authorInfo || {};
        let au = safeStr(ai.url);
        let sameId = id && (safeStr(ai.id) === id || au.indexOf("/" + id) >= 0);
        let sameName = ai.name && cleanText(ai.name).toLowerCase() === cleanText(name).toLowerCase();
        if (sameId || sameName) out.push(found[i]);
    }
    addDebug("canal: respaldo por buscador '" + name + "' => " + out.length + " de " + found.length);
    return out;
}

function channelIdentity(bare, html) {
    let name = CHANNEL_ORIG_NAMES[chanKey(bare)] || "";
    if (!name && html) {
        let n = extractChannelName(html, bare);
        if (n && !isGenericSiteTitle(n) && !/^OK\.ru$/i.test(n)) name = n;
    }
    let thumb = CHANNEL_AVATARS[chanKey(bare)] || "";
    if (!thumb && html) {
        thumb = extractChannelThumbnail(html);
        if (thumb) CHANNEL_AVATARS[chanKey(bare)] = thumb;
    }
    let idm = bare.match(/ok\.ru\/(?:(?:profile|group)\/)?([^\/?#]+)/i);
    return { name: name, id: idm ? idm[1] : "", url: bare, thumbnail: thumb, subscribers: 0 };
}

function channelCandidates(base) {
    let m = base.match(/ok\.ru\/(profile|group)\/([^\/?#]+)/i);
    if (m) {
        let id = m[2];
        let p = "https://ok.ru/profile/" + id;
        let g = "https://ok.ru/group/" + id;
        let pc = [p + "/video", p, "https://m.ok.ru/profile/" + id + "/video"];
        let gc = [g + "/video/all", g + "/video", g, "https://m.ok.ru/group/" + id + "/video"];
        // Los IDs de comunidad tienen 14+ dígitos; los de persona, menos.
        let groupFirst = m[1].toLowerCase() === "group" || /^\d{14,}$/.test(id);
        return groupFirst ? gc.concat(pc) : pc.concat(gc);
    }
    return [base + "/video", base];
}

function channelHtmlLooksValid(html) {
    html = safeStr(html);
    if (html.length < 500) return false;
    let t = extractPageTitle(html);
    if (!t) return false;
    return !/not\s+found|не\s+найден|не\s+существует|404|doesn.t\s+exist|unavailable|недоступ/i.test(t);
}

// OK.ru usa /profile/<id> para personas y /group/<id> para comunidades, y el
// reproductor no siempre dice cuál es. Se prueban las variantes hasta que una
// devuelva contenido, y se recuerda cuál funcionó.
function resolveChannel(url) {
    let base = bareChannelUrl(url) || safeStr(url);
    if (badChannelId(chanKey(base))) { addDebug("canal con ID inválido: " + safeStr(url)); return null; }
    if (CHANNEL_RESOLVED[base]) return CHANNEL_RESOLVED[base];
    let wk = CHANNEL_WEAK[base];
    if (wk && nowMs() - wk.time < CHANNEL_WEAK_TTL) return wk.res;

    let lines = [];
    function note(line) { lines.push(line); addDebug(line); }

    let cands = channelCandidates(base);
    let weak = null;
    let best = null;

    for (let i = 0; i < cands.length; i++) {
        let html = "";
        try { html = httpGetAuthenticated(cands[i]); } catch (e) { note("channel fetch " + cands[i] + ": " + e); }
        let n = 0;
        if (html) {
            try { n = collectChannelVideos(html, true).length; } catch (_) {}
        }
        let t = html ? (extractPageTitle(html) || "-") : "-";
        note("probe " + cands[i].replace("https://", "") + " bytes=" + (html ? html.length : 0) + " videos=" + n + " title=" + t);
        if (!html) continue;

        let res = { fetchUrl: cands[i], bare: bareChannelUrl(cands[i]), html: html, log: lines };
        if (!best || html.length > best.html.length) best = res;
        if (n > 0) {
            CHANNEL_RESOLVED[base] = res;
            CHANNEL_RESOLVED[res.bare] = res;
            return res;
        }
        if (!weak && channelHtmlLooksValid(html)) weak = res;
    }

    let chosen = weak || best;
    if (chosen) {
        chosen.log = lines;
        CHANNEL_WEAK[base] = { time: nowMs(), res: chosen };
        CHANNEL_WEAK[chosen.bare] = { time: nowMs(), res: chosen };
    }
    return chosen;
}

function fetchChannelPage(url, page) {
    let res = resolveChannel(url);
    if (!res) return "";

    if (page <= 1) {
        if (res.html) {
            let h = res.html;
            res.html = "";
            return h;
        }
        return httpGetAuthenticated(res.fetchUrl) || "";
    }

    let target = res.fetchUrl + (res.fetchUrl.indexOf("?") >= 0 ? "&" : "?") + "st.page=" + page;
    let html = httpGetAuthenticated(target);
    addDebug("channel page " + page + " bytes=" + (html ? html.length : 0) + " url=" + target);
    return html || "";
}

function channelPager(url, page) {
    if (page <= 1) resetDebug();
    url = unpseudoChannel(url);
    if (badChannelId(chanKey(url))) {
        throw new Error("OK.ru no indica a qué canal pertenece este video (" + safeStr(url) + "). Abre el video y vuelve a probar.");
    }
    let res = resolveChannel(url);
    let bare = res ? res.bare : bareChannelUrl(url);
    if (page <= 1 && res && res.log) {
        // resetDebug() borró los intentos de resolveChannel si estaba en caché.
        for (let i = 0; i < res.log.length; i++) {
            if (DEBUG.indexOf(res.log[i]) < 0) addDebug(res.log[i]);
        }
    }
    let html = fetchChannelPage(url, page);

    let raw = html ? collectChannelVideos(html) : [];
    let ident = channelIdentity(bare, page <= 1 ? html : "");

    // Si la página del canal no trae un título de perfil válido (caso visto
    // en los logs: nombre correcto en los videos pero "OK.ru" en el canal),
    // usar la identidad que ya viene en las propias tarjetas. No inventamos
    // una identidad: solo aceptamos el autor extraído del video.
    if (raw.length) {
        let ai0 = raw[0].authorInfo || {};
        if ((!ident.name || /^OK\.ru$/i.test(ident.name)) && ai0.name && !isJunkName(ai0.name)) ident.name = ai0.name;
        if (!ident.url && ai0.url && isChannelLikeUrl(ai0.url)) ident.url = bareChannelUrl(ai0.url);
        if (!ident.id && ai0.id) ident.id = ai0.id;
        if (!ident.thumbnail && ai0.thumbnail) ident.thumbnail = ai0.thumbnail;
        if (ident.name && ident.url) CHANNEL_ORIG_NAMES[chanKey(ident.url)] = ident.name;
    }

    if (!raw.length) {
        try { raw = channelSearchFallback(bare, ident, page); }
        catch (e) { addDebug("canal respaldo: " + e); raw = []; }
    }

    if (!raw.length) {
        if (page <= 1) throw new Error("El canal de OK.ru no devolvió videos (" + bare + ")\n" + debugText());
        return new OkChannelVideoPager([], false, { url: url, page: page + 1 });
    }

    // v47: si OK.ru ignora st.page y devuelve lo mismo, cortar la paginación.
    let seenKey = chanKey(bare);
    if (page <= 1 || !CHANNEL_SEEN[seenKey]) CHANNEL_SEEN[seenKey] = {};
    let seenSet = CHANNEL_SEEN[seenKey];
    let fresh = [];
    for (let i = 0; i < raw.length; i++) {
        if (!seenSet[raw[i].id]) { seenSet[raw[i].id] = true; fresh.push(raw[i]); }
    }
    if (page > 1 && !fresh.length) {
        addDebug("canal página " + page + ": sin videos nuevos, fin");
        return new OkChannelVideoPager([], false, { url: url, page: page + 1 });
    }
    raw = fresh;

    // Todos los videos de esta página pertenecen al canal: usar su identidad
    // (nombre + enlace + foto) en lugar de adivinarla por tarjeta.
    for (let i = 0; i < raw.length; i++) {
        let ai = raw[i].authorInfo || {};
        raw[i].authorInfo = {
            name: ident.name || ai.name || "",
            id: ident.id || ai.id || "",
            url: ident.url,
            thumbnail: ident.thumbnail || ai.thumbnail || "",
            subscribers: 0,
            trusted: true
        };
    }

    prefetchResultAuthors(raw);

    let out = [];
    for (let i = 0; i < raw.length; i++) {
        let v = makeSearchVideo(raw[i]);
        if (v) out.push(v);
    }

    return new OkChannelVideoPager(out, raw.length > 0, { url: url, page: page + 1 });
}

class OkChannelVideoPager extends VideoPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
    }
    nextPage() {
        if (!this.hasMorePagers()) return this;
        return channelPager(this.context.url, this.context.page);
    }
}

function getChannelObject(url) {
    resetDebug();
    url = unpseudoChannel(url);
    if (badChannelId(chanKey(url))) {
        throw new Error("OK.ru no indica a qué canal pertenece este video (" + safeStr(url) + "). Abre el video y vuelve a probar.");
    }
    let res = null;
    try { res = resolveChannel(url); } catch (e) { addDebug("getChannel: " + e); }
    if (!res) throw new Error("No se pudo abrir el canal de OK.ru: " + safeStr(url) + "\n" + debugText());

    let canonical = res.bare;
    let id = extractChannelId(canonical) || (canonical.match(/ok\.ru\/([^\/?#]+)/i) || [])[1] || canonical;
    let html = res.html;
    if (!html) { try { html = httpGetAuthenticated(res.fetchUrl); } catch (_) { html = ""; } }

    let known = CHANNEL_NAMES[chanKey(canonical)] || CHANNEL_NAMES[chanKey(url)] || "";
    let name = known || (html ? extractChannelName(html, canonical) : "OK.ru");
    let thumbnail = CHANNEL_AVATARS[chanKey(canonical)] || (html ? extractChannelThumbnail(html) : "");
    if (thumbnail) CHANNEL_AVATARS[chanKey(canonical)] = thumbnail;
    let description = html ? extractChannelDescription(html) : "";

    try {
        return new PlatformChannel({
            id: new PlatformID(PLATFORM_NAME, id, PLUGIN_ID),
            name: toSpanishName(name),
            thumbnail: thumbnail,
            banner: "",
            subscribers: 0,
            description: description,
            url: canonical,
            links: {}
        });
    } catch (e) {
        addDebug("PlatformChannel EXCEPTION: " + e);
        throw new Error("PlatformChannel: " + e + "\n" + debugText());
    }
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
    return isOkChannelUrl(url);
};

source.getChannel = function (url) {
    return getChannelObject(url);
};

// API actual de GrayJay para el contenido de un canal.
source.getChannelContents = function (url, type, order, filters, continuationToken) {
    let page = 1;
    try {
        if (continuationToken && typeof continuationToken === "object") {
            page = Math.max(1, Number(continuationToken.page) || 1);
        } else if (continuationToken) {
            page = Math.max(1, Number(continuationToken) || 1);
        }
    } catch (_) {}
    return channelPager(url, page);
};

// Compatibilidad con versiones de GrayJay que todavía llaman getChannelVideos.
source.getChannelVideos = function (url, type, order, filters, continuationToken) {
    return source.getChannelContents(url, type, order, filters, continuationToken);
};

function okChannelTypes() {
    try {
        if (typeof Type !== "undefined" && Type && Type.Feed && Type.Feed.Mixed) return [Type.Feed.Mixed];
    } catch (_) {}
    return ["MIXED"];
}

source.getChannelCapabilities = function () {
    try {
        return new ResultCapabilities(okChannelTypes(), [], []);
    } catch (_) {
        return { types: okChannelTypes(), sorts: [], filters: [] };
    }
};

source.getSearchChannelContentsCapabilities = function () {
    try {
        return new ResultCapabilities(okChannelTypes(), [], []);
    } catch (_) {
        return { types: okChannelTypes(), sorts: [], filters: [] };
    }
};

source.searchChannelContents = function (url, query, type, order, filters, continuationToken) {
    // Búsqueda dentro del canal: primero obtenemos el feed del canal y
    // filtramos localmente por título. Así no mezclamos resultados de otros
    // autores de la búsqueda global de OK.ru.
    let page = 1;
    try {
        if (continuationToken && typeof continuationToken === "object") {
            page = Math.max(1, Number(continuationToken.page) || 1);
        }
    } catch (_) {}

    let pager = channelPager(url, page);
    let q = cleanText(query).toLowerCase();
    if (!q) return pager;

    let filtered = [];
    for (let i = 0; i < pager.results.length; i++) {
        let v = pager.results[i];
        if (cleanText(v.name).toLowerCase().indexOf(q) >= 0) filtered.push(v);
    }
    pager.results = filtered;
    return pager;
};
