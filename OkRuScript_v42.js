/*
 * GrayJay - OK.ru Source v42 (base Cast v38 + autor/canal/capitulos)
 *
 * Base: OkRuScript_conLogin-Cast.js (el que busca y reproduce rapido).
 * Del script de autores se toma solo lo que no frena el arranque:
 *   - titulo real (descarta "Смотреть"/"Ver"/"Watch" sin depender de \\b)
 *   - nombre del dueno en la tarjeta y en el video
 *   - clic en el nombre -> canal con sus videos
 *   - album de serie (/video/cID) y paginacion de capitulos al abrir el canal
 *
 * No se hace en la busqueda ni al reproducir:
 *   - pedir la ficha de cada video para adivinar el autor
 *   - leer /profile/.../video/channels
 *   - sondas de HLS, m.ok.ru o POST de diagnostico
 * La cookie de sesion solo sirve para HTML. El stream sigue sin cookie/Origin.
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
    if (isGenericTitle(title)) return;

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

    // El boton de la ficha ("Ver", "Watch", "Смотреть") no es el titulo.
    if (isGenericTitle(v)) v = "";
    if (isGenericTitle(fb)) fb = "";

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
    let authorInfo = resolveAuthorInfo(getAuthorInfo(meta), extractVideoId(pageUrl), html);
    let authorName = (authorInfo && authorInfo.name) || getAuthorName(meta) || "OK.ru";

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
        author = makeAuthorLink(authorInfo, extractVideoId(pageUrl));
    } catch (_) {}
    if (!author) {
        try {
            author = new PlatformAuthorLink(
                new PlatformID(PLATFORM_NAME, "", PLUGIN_ID),
                authorName,
                "https://ok.ru/",
                "",
                0
            );
        } catch (_) {}
    }

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
    if (/^[\d:\s]+$/.test(t)) return true;
    if (/^(image|video|videos|more|next|previous|menu|play|share|like|comment)$/.test(t)) return true;
    // Sin \\b: en el JS de GrayJay \\b solo ve ASCII, y "Смотреть" se colaba como titulo.
    if (/^(view|views|ver|watch|play|reproducir|mirar|смотреть|посмотреть|просмотр|просмотры|открыть|открыть видео)(?:\s+(video|vídeo|видео|ролик))?$/.test(t)) return true;
    if (/^(view|views|ver|watch|play|reproducir|mirar|смотреть|посмотреть|просмотр|просмотры|открыть)\s+\d/.test(t) && t.length <= 40) return true;
    return false;
}

function titleFromBlock(block) {
    block = safeStr(block);
    if (!block) return "";
    let keys = ["movieTitle", "videoTitle", "data-title", "data-name", "title", "name", "caption"];
    for (let k = 0; k < keys.length; k++) {
        let key = keys[k];
        let re = new RegExp("(?:^|[^A-Za-z0-9_-])" + key + "\\s*[=:]\\s*[\"']([^\"']{2,300})[\"']", "gi");
        let m;
        while ((m = re.exec(block)) !== null) {
            let c = cleanText(m[1]);
            if (c && !isGenericTitle(c) && !/^\d+$/.test(c)) return c;
        }
    }
    return "";
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

    if (!title) title = titleFromBlock(block);
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

    let authorInfo = emptyAuthor();
    try { authorInfo = extractAuthorFromBlock(block) || emptyAuthor(); } catch (_) {}

    results.push({
        id: ext ? (ext.plugin.toLowerCase() + ":" + ext.id) : id,
        url: urlWithTitle,
        title: title,
        thumbnail: poster,
        duration: duration,
        authorInfo: authorInfo
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
        let start = Math.max(0, m.index - 900);
        let end = Math.min(html.length, re.lastIndex + 900);
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
    try { author = makeAuthorLink(r.authorInfo || {}, r.id); } catch (_) {}
    if (!author) {
        try {
            author = new PlatformAuthorLink(
                new PlatformID(PLATFORM_NAME, "", PLUGIN_ID),
                "OK.ru",
                "https://ok.ru/",
                "",
                0
            );
        } catch (_) {}
    }

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

/* ======================= Autores y canales (liviano) =======================
 * Solo lo necesario: nombre real del autor en cada tarjeta/video, clic en el
 * nombre -> canal con sus videos. Sin traducción de nombres.
 * ========================================================================== */

const JUNK_NAME = /^(?:sd|hd|hdp|sdp|low|lowest|lq|lqp|mobile|full|fullhd|high|higher|highest|medium|ultra|quad|mp4|hls|dash|auto|default|unknown|null|undefined|true|false|ok|ok\.ru|video|name|title|\d{1,4}p?)$/i;
const OK_RESERVED = /^(?:video|videoembed|videos|search|dk|feed|games|music|live|settings|apphook|profile|group|mobile|help|about|vkp|cdn|market|events|friends|messages|notifications|dkstatic|api|static|web-api|r|st|logout|anonymMain|post|photo|album|topic|statuses|discussions|sports)$/i;

const CHANNEL_NAMES = {};    // nombre por id de canal
const CHANNEL_AVATARS = {};  // foto por id de canal
let AUTHOR_CACHE = {};       // autor visto en la búsqueda, por id de video
let AUTHOR_CACHE_COUNT = 0;
const PSEUDO_RESOLVED = {};
const CHANNEL_RESOLVED = {};

function isJunkName(n) {
    n = cleanText(n);
    return !n || JUNK_NAME.test(n);
}

function emptyAuthor() {
    return { name: "", id: "", url: "", thumbnail: "", subscribers: 0 };
}

function badChannelId(id) {
    id = safeStr(id).trim();
    return !id || /^(?:null|undefined|nan|none|false|true|0|-1)$/i.test(id);
}

function validImageUrl(u) {
    u = safeStr(u);
    return /^(?:https?:)?\/\//i.test(u) && !/^data:/i.test(u);
}

// Enlace "diferido": autor con nombre pero sin canal conocido todavía.
function pseudoAuthorUrl(videoId) { return "https://ok.ru/__author/" + safeStr(videoId); }
function isPseudoAuthorUrl(u) { return /ok\.ru\/__author\/\d+/i.test(safeStr(u)); }

function isOkChannelUrl(url) {
    if (isPseudoAuthorUrl(url)) return true;
    let u = safeStr(url);
    let pg = u.match(/^(?:https?:\/\/)?(?:www\.|m\.)?ok\.ru\/(?:profile|group)\/([^/?#]+)/i);
    if (pg && badChannelId(pg[1])) return false;
    if (/^(?:https?:\/\/)?(?:www\.|m\.)?ok\.ru\/(?:profile\/[^/?#]+(?:\/video(?:\/c\d+)?)?|group\/[^/?#]+(?:\/video(?:\/all|\/c\d+)?(?:[?#].*)?)?)(?:[?#].*)?$/i.test(u)) return true;
    // Alias de usuario: https://ok.ru/<alias> (sin rutas reservadas del sitio).
    let v = u.match(/^(?:https?:\/\/)?(?:www\.|m\.)?ok\.ru\/([A-Za-z0-9_.-]{2,})(?:\/video(?:\/all)?)?\/?(?:[?#].*)?$/i);
    return !!v && !OK_RESERVED.test(v[1]) && !badChannelId(v[1]);
}

function isChannelLikeUrl(u) {
    u = safeStr(u);
    let m = u.match(/ok\.ru\/(?:profile|group)\/([^\/?#]+)/i);
    if (m) return !badChannelId(m[1]);
    return isOkChannelUrl(u) && !/ok\.ru\/?$/i.test(u);
}

function bareChannelUrl(url) {
    let u = safeStr(url).trim();
    let m = u.match(/^(?:https?:\/\/)?(?:www\.|m\.)?ok\.ru\/(profile|group)\/([^\/?#]+)(\/video\/c\d+)?/i);
    if (m) return "https://ok.ru/" + m[1].toLowerCase() + "/" + m[2] + (m[3] || "");
    let v = u.match(/^(?:https?:\/\/)?(?:www\.|m\.)?ok\.ru\/([A-Za-z0-9_.-]{2,})(?:\/video(?:\/all)?)?\/?(?:[?#].*)?$/i);
    if (v && !OK_RESERVED.test(v[1])) return "https://ok.ru/" + v[1];
    return u;
}

// Clave de caché: id numérico o alias (compartida entre /profile/<id> y /group/<id>).
function chanKey(url) {
    let sc = safeStr(url).match(/ok\.ru\/(?:profile|group)\/([^\/?#]+)\/video\/c(\d+)/i);
    if (sc) return sc[1] + "_c" + sc[2];   // canal de serie: clave propia
    let m = safeStr(url).match(/ok\.ru\/(?:(?:profile|group)\/)?([^\/?#]+)/i);
    return m ? m[1] : safeStr(url);
}

/* ---------------------- Autor desde metadata / tarjeta ---------------------- */

function getAuthorInfo(meta) {
    let info = emptyAuthor();
    if (!safeObj(meta)) return info;

    let a = safeObj(meta.author) ? meta.author :
            (safeObj(meta.owner) ? meta.owner :
            (safeObj(meta.user) ? meta.user :
            (safeObj(meta.uploader) ? meta.uploader : null)));

    if (a) {
        info.name = cleanText(firstValue(a, ["name", "displayName", "fullName", "userName", "username", "nickName"]));
        info.id = safeStr(firstValue(a, ["id", "userId", "uid", "profileId"]));
        if (!/^\d{4,}$/.test(info.id)) info.id = "";
        let pv = firstValue(a, ["profile", "profileUrl", "url", "href"]);
        if (safeObj(pv)) pv = firstValue(pv, ["url", "href", "profile"]);
        info.url = normalizeUrl(pv, "https://ok.ru/");
        if (info.url && !isChannelLikeUrl(info.url)) info.url = "";
        info.explicit = !!info.url;
        info.thumbnail = normalizeUrl(firstValue(a, ["thumbnail", "avatar", "avatarUrl", "photo", "photoUrl", "pic", "picUrl", "pic190x190", "pic128x128", "pic50x50", "picBase", "image", "imageUrl"]), "https://ok.ru/");
        let sub = firstValue(a, ["subscribers", "subscriberCount", "followers", "followersCount"]);
        if (sub) info.subscribers = parseInt(sub, 10) || 0;
    }

    if (!info.name) info.name = getAuthorName(meta);

    // La ficha web muestra el grupo, no al usuario que lo publicó.
    let group = groupFromMeta(meta);
    if (group.id || group.url) {
        info.id = group.id || info.id;
        info.url = group.url || info.url;
        if (group.name && !isJunkName(group.name)) info.name = group.name;
        else if (isGroupUrl(info.url)) info.name = "";
        if (group.thumbnail) info.thumbnail = group.thumbnail;
        info.explicit = true;
        info.fromGroup = true;
    }
    if (!info.url && info.id) info.url = "https://ok.ru/profile/" + encodeURIComponent(info.id);

    if (!isHttpUrl(info.url) || /^https?:\/\/ok\.ru\/?$/i.test(info.url)) info.url = "";
    if (isJunkName(info.name)) info.name = "";
    if (info.url && !isChannelLikeUrl(info.url)) { info.url = ""; info.explicit = false; }
    return info;
}

function normName(s) {
    return cleanText(s).toLowerCase().replace(/[\s\-_.,:;'"()\[\]!¡?¿|\/\\&]+/g, " ").trim();
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

// Enlace de canal cuyo texto coincide con el nombre del autor (sirve para alias).
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

// Identidad del autor dentro del bloque HTML/JSON de una tarjeta de resultados.
function extractAuthorFromBlock(block, strict) {
    block = safeStr(block);
    let out = emptyAuthor();
    if (!block) return out;

    let src = block;
    try { src = htmlDecode(src); } catch (_) {}
    src = src.replace(/\\(["'])/g, "$1");

    // 1) Objeto author / owner / uploader en JSON.
    let m = src.match(/(?:["']?(?:author|owner|uploader|creator)["']?\s*:\s*)\{([\s\S]{0,6000})\}/i);
    let hasObj = !!m;
    let obj = m ? m[1] : src;
    // Modo estricto (página de detalle): sin objeto author explícito se ignora
    // cualquier "name"/"id" suelto de la ventana.
    if (!m && strict) obj = "";

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

    // 2) Enlace explícito /profile/<id> o /group/<id> (absoluto o relativo),
    // el más cercano al centro de la ventana (donde está el video de la tarjeta).
    let linkFound = false;
    {
        let linkRe = /(?:https?:\\?\/\\?\/(?:www\.|m\.)?ok\.ru)?\\?\/(profile|group)\\?\/([A-Za-z0-9_.-]{3,80})(?=[\/?#"'\s<>\\&]|$)/ig;
        let center = Math.floor(src.length / 2);
        let best = null, bestDist = 1e9, lm;
        while ((lm = linkRe.exec(src)) !== null) {
            let d = Math.abs(lm.index - center);
            if (d < bestDist) { bestDist = d; best = { kind: lm[1].toLowerCase(), id: lm[2], end: lm.index + lm[0].length }; }
        }
        if (best && bestDist > 500) best = null; // enlace lejano = de otra tarjeta
        if (best) {
            linkFound = true;
            out.url = "https://ok.ru/" + best.kind + "/" + best.id;
            out.id = best.id;
            if (!out.name) {
                let am = src.substring(best.end, best.end + 500).match(/^[^>]*>([^<]{2,300})<\/a>/i);
                if (am) {
                    let an = cleanText(am[1]);
                    if (!isJunkName(an)) out.name = an;
                }
            }
        }
    }

    // 2b) Con nombre: su enlace es el ancla con ESE texto (puede ser un alias).
    if (out.name) {
        try {
            let nl = channelLinkByName(src, [out.name]);
            if (nl) {
                out.url = nl.url;
                out.id = (nl.url.match(/ok\.ru\/(?:(?:profile|group)\/)?([^\/?#]+)/i) || [])[1] || "";
                linkFound = true;
            }
        } catch (_) {}
    }

    // 3) data-* y clases usadas por las tarjetas.
    if (!out.name) {
        m = src.match(/(?:data-author-name|data-owner-name|data-uploader-name|data-creator-name)\s*=\s*["']([^"']{2,300})["']/i);
        if (m) out.name = cleanText(m[1]);
    }
    if (!out.name) {
        m = src.match(/class=["'][^"']*(?:ucard_name|ucard-name|author-name|authorName|owner-name|entity-name)[^"']*["'][^>]*>([\s\S]{1,500}?)<\//i);
        if (m) out.name = cleanText(m[1]);
    }

    // 4) Comunidad: el canal correcto es /group/<id>, no /profile/<id>.
    let groupSet = false;
    let gm = linkFound ? null : src.match(/(?:["']?(?:groupId|groupID|group_id|group\.id)["']?)\s*:\s*["']?([A-Za-z0-9_-]{3,80})["']?/i);
    if (gm && !/^\d{5,}$/.test(gm[1])) gm = null;
    if (gm && !/\/profile\//i.test(out.url)) {
        out.id = cleanText(gm[1]);
        out.url = "https://ok.ru/group/" + encodeURIComponent(out.id) + "/video/all";
        let gn = src.match(/(?:["']?(?:groupName|groupTitle|communityName|communityTitle)["']?)\s*:\s*["']([^"']{2,300})["']/i);
        if (gn) out.name = cleanText(gn[1]);
        groupSet = true;
    }

    // Un "id" suelto (sin objeto author ni enlace) no es fiable.
    if (!hasObj && !linkFound && !groupSet) {
        out.id = "";
        if (!isChannelLikeUrl(out.url)) out.url = "";
    }
    if (out.id && !out.url) out.url = "https://ok.ru/profile/" + encodeURIComponent(out.id) + "/video";

    // Misma regla que la ficha: si el bloque trae un grupo, ese es el canal.
    let gcard = groupCardFromBlock(src);
    if (gcard && (gcard.url || gcard.id)) {
        out.url = gcard.url || out.url;
        out.id = gcard.id || out.id;
        if (gcard.name && !isJunkName(gcard.name)) out.name = gcard.name;
        out.fromGroup = true;
    }

    if (!isHttpUrl(out.url) || /^https?:\/\/ok\.ru\/?$/i.test(out.url)) out.url = "";
    if (out.url && !isChannelLikeUrl(out.url)) out.url = "";
    return out;
}

function extractAuthorForVideoInHtml(html, videoId, strict) {
    html = safeStr(html);
    videoId = safeStr(videoId);
    if (!html || !videoId) return emptyAuthor();

    let re = new RegExp("(?:\\\"|/|:)" + videoId + "(?:\\\"|/|,|\\s)", "g");
    let fallback = emptyAuthor();
    let m, tries = 0;
    while ((m = re.exec(html)) !== null && tries++ < 4) {
        let info = extractAuthorFromBlock(html.substring(Math.max(0, m.index - 3000), Math.min(html.length, m.index + 3000)), strict);
        if (info.name && info.url) return info;
        if (!fallback.name && info.name) fallback = info;
        if (strict && !fallback.url && info.url) fallback = info;
    }
    return fallback;
}

// Solo usa el HTML ya descargado por la búsqueda (sin requests extra).
function enrichSearchAuthors(results, html) {
    html = safeStr(html);
    if (!html || !results || !results.length) return results;
    for (let i = 0; i < results.length && i < 24; i++) {
        let r = results[i];
        let ai = r.authorInfo || {};
        if (ai.fromGroup && ai.name && ai.url) continue;
        if (ai.name && ai.url && isGroupUrl(ai.url)) continue;
        let info = extractAuthorForVideoInHtml(html, r.id);
        if (info && (info.fromGroup || isGroupUrl(info.url))) r.authorInfo = info;
        else if (info && (info.name || info.url || info.id) && !(ai.name && ai.url)) r.authorInfo = info;
    }
    return results;
}

// Tope: leer la ficha (como la web) solo en las primeras tarjetas que todavía
// muestran un usuario o no tienen canal. Así "LORENZO J" pasa a "Cine de antes"
// sin pedir una página por cada resultado del scroll.
const WATCH_AUTHOR_CAP = 8;
let WATCH_AUTHOR_CACHE = {};

function isGroupUrl(url) {
    return /ok\.ru\/group\/[^/?#]+/i.test(safeStr(url));
}

function groupFromMeta(meta) {
    let out = emptyAuthor();
    if (!safeObj(meta)) return out;
    let movie = safeObj(meta.movie) ? meta.movie : {};
    let containers = [movie, meta, safeObj(meta.group) ? meta.group : null, safeObj(meta.album) ? meta.album : null];
    let groupId = "";
    let groupName = "";
    let thumb = "";
    for (let i = 0; i < containers.length; i++) {
        let c = containers[i];
        if (!c) continue;
        if (!groupId) {
            let id = safeStr(firstValue(c, ["groupId", "groupID", "group_id"]));
            if (/^\d{4,}$/.test(id)) groupId = id;
        }
        if (!groupName) {
            let n = cleanText(firstValue(c, ["groupName", "groupTitle", "communityName", "communityTitle"]));
            if (n && !isJunkName(n)) groupName = n;
        }
        if (!thumb) {
            thumb = normalizeUrl(firstValue(c, ["groupAvatar", "groupPhoto", "avatarUrl", "pic190x190"]), "https://ok.ru/");
        }
    }
    if (!groupId && isGroupUrl(firstValue(meta, ["groupUrl", "communityUrl"]))) {
        let m = safeStr(firstValue(meta, ["groupUrl", "communityUrl"])).match(/\/group\/([^/?#]+)/i);
        if (m) groupId = m[1];
    }
    if (!groupId) return out;
    out.id = groupId;
    out.url = "https://ok.ru/group/" + encodeURIComponent(groupId) + "/video/all";
    out.name = groupName;
    out.thumbnail = validImageUrl(thumb) ? thumb : "";
    out.fromGroup = true;
    out.explicit = true;
    return out;
}

function groupCardFromBlock(src) {
    src = safeStr(src);
    if (!src) return null;
    let out = emptyAuthor();
    let gm = src.match(/(?:["']?(?:groupId|groupID|group_id)["']?)\s*[:=]\s*["']?(\d{4,})["']?/i);
    if (gm) out.id = gm[1];
    let gn = src.match(/(?:["']?(?:groupName|groupTitle|communityName|communityTitle)["']?)\s*[:=]\s*["']([^"']{2,300})["']/i);
    if (gn) {
        let n = cleanText(gn[1]);
        if (!isJunkName(n)) out.name = n;
    }
    let linkRe = /(?:href\s*=\s*["']|["'])((?:https?:\/\/(?:www\.|m\.)?ok\.ru)?\/group\/(\d{4,})[^"'\s)]*)/gi;
    let m, best = null;
    while ((m = linkRe.exec(src)) !== null) {
        best = m;
        break;
    }
    if (best) {
        out.id = best[2];
        out.url = "https://ok.ru/group/" + encodeURIComponent(best[2]) + "/video/all";
        if (!out.name) {
            let after = src.substring(best.index, Math.min(src.length, best.index + 700));
            let am = after.match(/>([^<]{2,300})<\/a>/i);
            if (am) {
                let an = cleanText(am[1]);
                if (!isJunkName(an)) out.name = an;
            }
        }
    }
    if (out.id && !out.url) out.url = "https://ok.ru/group/" + encodeURIComponent(out.id) + "/video/all";
    if (!out.id && !out.url) return null;
    out.fromGroup = true;
    return out;
}

function nameNearGroup(html, groupId) {
    if (!groupId) return "";
    let src = "";
    try { src = htmlDecode(safeStr(html)).replace(/\\\//g, "/"); } catch (_) { src = safeStr(html); }
    let esc = safeStr(groupId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let re = new RegExp("href=[\"'][^\"']*/group/" + esc + "[^\"']*[\"'][^>]*>([^<]{2,300})<", "i");
    let m = src.match(re);
    if (m) {
        let n = cleanText(m[1]);
        if (n && !isJunkName(n)) return n;
    }
    re = new RegExp(">([^<]{2,300})<\\/a>[\\s\\S]{0,240}href=[\"'][^\"']*/group/" + esc, "i");
    m = src.match(re);
    if (m) {
        let n2 = cleanText(m[1]);
        if (n2 && !isJunkName(n2)) return n2;
    }
    return "";
}

function parseSubscribers(text) {
    text = cleanText(text).replace(/\s+/g, "").replace(",", ".");
    let m = text.match(/(\d+(?:\.\d+)?)([KkКк])?/);
    if (!m) return 0;
    let n = parseFloat(m[1]);
    if (!isFinite(n)) return 0;
    if (m[2]) n *= 1000;
    return Math.round(n);
}

// Tarjeta bajo el reproductor: la que muestra la web (grupo o perfil-canal).
// No usar el primer /group/ de la página: las recomendaciones también traen grupos.
function ownerCardFromHtml(html) {
    let out = emptyAuthor();
    html = safeStr(html);
    if (!html) return out;
    let src = html;
    try { src = htmlDecode(src).replace(/\\\//g, "/"); } catch (_) {}

    let props = src.match(/autoplay-layer-movie-author[\s\S]{0,400}?data-props\s*=\s*["'](\{[\s\S]{0,2500}?\})["']/i);
    if (props) {
        let j = tryParseJson(props[1]);
        if (j && j.name && !isJunkName(j.name)) {
            out.name = cleanText(j.name);
            out.id = safeStr(j.id);
            out.thumbnail = normalizeUrl(j.imgSrc || j.image || "", "https://ok.ru/");
            out.subscribers = parseInt(j.subscribersCount, 10) || 0;
            let type = safeStr(j.type).toUpperCase();
            if (/^\d{4,}$/.test(out.id)) {
                out.url = type === "GROUP"
                    ? "https://ok.ru/group/" + encodeURIComponent(out.id) + "/video/all"
                    : "https://ok.ru/profile/" + encodeURIComponent(out.id) + "/video";
            }
            out.fromGroup = type === "GROUP";
            out.fromOwner = true;
            out.explicit = !!out.url;
            return out;
        }
    }

    let blockM = src.match(/movie-layer_owner[\s\S]{0,4000}/i) || src.match(/vp-layer-author[\s\S]{0,4000}/i);
    let block = blockM ? blockM[0] : "";
    if (block) {
        let nm = block.match(/itemprop\s*=\s*["']name["'][^>]*>([^<]{2,300})</i)
            || block.match(/movie-author_name[^>]*>([^<]{2,300})</i)
            || block.match(/class\s*=\s*["'][^"']*\busr\b[^"']*["'][^>]*>([^<]{2,300})</i);
        if (nm) out.name = cleanText(nm[1]);
        let im = block.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
        if (im) out.thumbnail = normalizeUrl(im[1], "https://ok.ru/");
        let sm = block.match(/(\d[\d\s.,]*\s*[KkКк]?)\s*(?:подписчик|subscribers|seguidor)/i);
        if (sm) out.subscribers = parseSubscribers(sm[1]);
        let gm = block.match(/\/group\/(\d{4,})/i) || block.match(/st\.groupId=(\d{4,})/i);
        let um = block.match(/\/profile\/(\d{4,})/i) || block.match(/st\.friendId=(\d{4,})/i);
        if (gm) {
            out.id = gm[1];
            out.url = "https://ok.ru/group/" + encodeURIComponent(out.id) + "/video/all";
            out.fromGroup = true;
        } else if (um) {
            out.id = um[1];
            out.url = "https://ok.ru/profile/" + encodeURIComponent(out.id) + "/video";
        }
        if (out.name && !isJunkName(out.name) && out.url) {
            out.fromOwner = true;
            out.explicit = true;
            return out;
        }
    }

    let login = src.match(/ya:ovs:login["'][^>]*content\s*=\s*["']([^"']{2,300})["']/i)
        || src.match(/content\s*=\s*["']([^"']{2,300})["'][^>]*ya:ovs:login/i);
    if (login && !out.name) out.name = cleanText(login[1]);
    if (out.name && !isJunkName(out.name) && !out.url) {
        let um2 = src.match(/\/profile\/(\d{5,})/i);
        if (um2) {
            out.id = um2[1];
            out.url = "https://ok.ru/profile/" + encodeURIComponent(out.id) + "/video";
            out.fromOwner = true;
            out.explicit = true;
        }
    }
    return out;
}


/* ---- Canal de serie: /profile/<id>/video/c<N> ----
   Si la página del video enlaza al canal (lista) del mismo dueño donde está
   la serie, el autor apunta directo a ese canal en vez de al perfil general. */
const ENABLE_SERIES_CHANNEL = true;

const ENABLE_SERIES_DEBUG = false;  // debug de serie apagado: no infla la descripcion ni lanza errores de corte
let SERIES_DIAG = "";

function seriesChannelUrl(html, info) {
    SERIES_DIAG = "";
    try {
        html = safeStr(html);
        if (!ENABLE_SERIES_CHANNEL || !html || !info || !info.url) { SERIES_DIAG = "sin html/autor"; return ""; }
        let o = safeStr(info.url).match(/ok\.ru\/(profile|group)\/(\d{6,})(?:\/video\/c\d+)?/i);
        if (!o) { SERIES_DIAG = "autor sin id numérico: " + safeStr(info.url); return ""; }
        let dec = html;
        try { dec = htmlDecode(html).replace(/\\\//g, "/"); } catch (_) {}

        // 1) enlace con el perfil del dueño: /profile/<id>/video/c<N>
        let re1 = new RegExp("\\/(?:profile|group)\\/" + o[2] + "\\/video\\/c(\\d{4,})", "i");
        let m = dec.match(re1);
        // 2) enlace sin prefijo: /video/c<N>
        let all = [], re2 = /\/video\/c(\d{4,})/g, x;
        while ((x = re2.exec(dec)) !== null && all.length < 8) if (all.indexOf(x[1]) < 0) all.push(x[1]);
        let chosen = m ? m[1] : (all.length ? all[0] : "");
        SERIES_DIAG = "html=" + dec.length + " enlaces c#=" + (all.join(",") || "ninguno") + (m ? " (con perfil)" : "") + " -> " + (chosen || "nada");
        return chosen ? "https://ok.ru/" + o[1].toLowerCase() + "/" + o[2] + "/video/c" + chosen : "";
    } catch (e) { SERIES_DIAG = "error " + e; return ""; }
}


/* ---- Canal de serie por TÍTULO: se lee /profile/<id>/video/channels una vez
   por perfil y se elige el canal cuyo nombre coincide con la serie del video. */
const SERIES_BY_PROFILE = {};

function normKey(t) {
    t = safeStr(t).toLowerCase();
    try { t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (_) {}
    return t.replace(/[^a-z0-9]+/g, "");
}

function seriesKeyFromTitle(title) {
    let t = safeStr(title);
    let cut = t.search(/\s*[-\u2013\u2014:|(\[]|\s+cap(?:[ií]tulo|\.)?\b|\s+ep(?:isodio|\.)?\b|\s+temporada\b/i);
    if (cut > 0) t = t.substring(0, cut);
    return normKey(t);
}

function loadProfileChannels(profileId) {
    if (SERIES_BY_PROFILE[profileId]) return SERIES_BY_PROFILE[profileId];
    let list = [];
    try {
        let html = httpGetAuthenticated("https://ok.ru/profile/" + profileId + "/video/channels") || "";
        let dec = html;
        try { dec = htmlDecode(html).replace(/\\\//g, "/"); } catch (_) {}
        let re = /\/video\/c(\d{4,})/g, m, occ = [];
        while ((m = re.exec(dec)) !== null && occ.length < 600) occ.push({ id: m[1], idx: m.index });
        let texts = {}, order = [];
        for (let i = 0; i < occ.length; i++) {
            let lo = i > 0 ? Math.floor((occ[i - 1].idx + occ[i].idx) / 2) : Math.max(0, occ[i].idx - 300);
            let hi = i < occ.length - 1 ? Math.floor((occ[i].idx + occ[i + 1].idx) / 2) : Math.min(dec.length, occ[i].idx + 500);
            let win = dec.substring(lo, hi);
            let titles = [];
            let tr = /(?:title|alt|aria-label)=["']([^"']{2,160})["']/gi, tm;
            while ((tm = tr.exec(win)) !== null) titles.push(tm[1]);
            let t = titles.join(" ") + " " + win.replace(/<[^>]+>/g, " ");
            if (!texts[occ[i].id]) { texts[occ[i].id] = ""; order.push(occ[i].id); }
            texts[occ[i].id] += " " + t;
        }
        for (let i = 0; i < order.length && list.length < 200; i++) list.push({ id: order[i], key: normKey(texts[order[i]]) });
        addDebug("canales del perfil " + profileId + ": " + list.length + " (html=" + html.length + ")");
    } catch (e) { addDebug("canales del perfil: " + e); }
    SERIES_BY_PROFILE[profileId] = list;
    return list;
}

const SERIES_LEARNED = {};   // "<perfil>|<serie>" -> id de canal (aprendido de un video de esa serie)

function applySeriesByTitle(info, title) {
    try {
        if (!ENABLE_SERIES_CHANNEL || !info || !info.url) return info;
        let o = safeStr(info.url).match(/ok\.ru\/profile\/(\d{6,})(?:\/|$|\?)/i);
        if (!o) return info;
        let key = seriesKeyFromTitle(title);
        if (key.length < 3) { SERIES_DIAG += " | titulo sin serie"; return info; }
        let lk = o[1] + "|" + key;
        let cur = safeStr(info.url).match(/\/video\/c(\d+)/i);
        if (info.seriesChannel && cur) {            // el video mismo reveló su canal: se recuerda
            SERIES_LEARNED[lk] = cur[1];
            SERIES_DIAG += " | aprendido " + key + "=" + cur[1];
            return info;
        }
        let id = SERIES_LEARNED[lk] || "";
        // No se consulta /video/channels aqui: esa peticion frenaba la reproduccion.
        // El album se toma del HTML ya cargado (seriesChannelUrl) o al abrir el canal.
        if (id) {
            info.url = "https://ok.ru/profile/" + o[1] + "/video/c" + id;
            info.id = extractChannelId(info.url) || info.id;
            info.seriesChannel = true;
        }
    } catch (e) { SERIES_DIAG += " | error titulo: " + e; }
    return info;
}

// Resultados de búsqueda: toda serie ya conocida se aplica a todos sus capítulos;
// para las series nuevas se lee UN video (página embed, ~37 KB) por serie, en paralelo.
function applySeriesToResults(results) {
    if (!ENABLE_SERIES_CHANNEL || !results || !results.length) return results;
    try {
        let groups = {}, order = [];
        for (let i = 0; i < results.length; i++) {
            let r = results[i];
            let ai = r && r.authorInfo;
            if (!ai || ai.seriesChannel) continue;
            let o = safeStr(ai.url).match(/ok\.ru\/profile\/(\d{6,})(?:\/|$|\?)/i);
            if (!o || /\/video\/c\d+/i.test(ai.url)) continue;
            let key = seriesKeyFromTitle(r.title);
            if (key.length < 3) continue;
            let lk = o[1] + "|" + key;
            if (SERIES_LEARNED[lk]) { applySeriesByTitle(ai, r.title); continue; }
            if (!groups[lk]) { groups[lk] = []; order.push(lk); }
            groups[lk].push(r);
        }
        order = order.slice(0, 4);
        if (!order.length) return results;
        let ids = order.map(function (lk) { return groups[lk][0].id; });
        let headers = { "Referer": "https://ok.ru/", "User-Agent": UA_DESKTOP };
        let res = null;
        try {
            let b = http.batch();
            for (let i = 0; i < ids.length; i++) b = b.GET("https://ok.ru/videoembed/" + ids[i], headers, false);
            res = b.execute();
        } catch (e) { addDebug("series batch: " + e); return results; }
        for (let i = 0; i < order.length; i++) {
            let body = "";
            try { body = safeStr(res[i] ? (res[i].body || "") : ""); } catch (_) {}
            let first = groups[order[i]][0];
            let tmp = { url: first.authorInfo.url, id: first.authorInfo.id };
            let u = seriesChannelUrl(body, tmp);
            let m = u.match(/\/video\/c(\d+)/i);
            if (m) {
                SERIES_LEARNED[order[i]] = m[1];
                for (let j = 0; j < groups[order[i]].length; j++) applySeriesByTitle(groups[order[i]][j].authorInfo, groups[order[i]][j].title);
            }
        }
    } catch (e) { addDebug("applySeriesToResults: " + e); }
    return results;
}

function applySeriesChannel(info, html) {
    let u = seriesChannelUrl(html, info);
    if (u && info && info.url !== u) {
        addDebug("canal de serie: " + u);
        info.url = u;
        info.id = extractChannelId(u) || info.id;
        info.seriesChannel = true;
    }
    return info;
}

function authorFromWatchHtml(html, videoId) {
    let res0 = authorFromWatchHtml0(html, videoId);
    return applySeriesChannel(res0, html);
}

function authorFromWatchHtml0(html, videoId) {
    let out = ownerCardFromHtml(html);
    if (out.fromOwner && out.name) return out;
    html = safeStr(html);
    if (!html) return out;
    let meta = null;
    try { meta = extractMetadataFromHtml(html); } catch (_) {}
    if (meta) {
        let g = groupFromMeta(meta);
        if (g.url && g.name) return g;
        if (!out.url && g.url) out = g;
    }
    if (!out.name || !out.url) {
        let page = emptyAuthor();
        try { page = extractAuthorFromVideoPage(html, videoId, [out.name]); } catch (_) {}
        if (page.name && page.url && !out.fromOwner) out = page;
    }
    if (out.url) out.explicit = true;
    return out;
}

// RAPIDO: antes se pedían hasta 8 fichas EN SERIE (cada una con 2 páginas
// y reintento con sesión) antes de mostrar el primer resultado. Ahora:
//  - una sola petición por video (m.ok.ru, ~130 KB), sin caer a la ficha de escritorio
//  - todas en PARALELO con http.batch()
//  - solo se piden las que aún no tienen canal real (grupo/perfil) ni están en caché
const ENABLE_WATCH_AUTHORS = false;  // la busqueda no pide fichas extra; el autor sale de la tarjeta
const WATCH_AUTHOR_CAP_FAST = 6;

function fetchWatchAuthorsParallel(ids) {
    let headers = { "Referer": "https://ok.ru/", "User-Agent": UA_DESKTOP,
                    "Accept-Language": "es-419,es;q=0.9,en;q=0.8" };
    let t0 = nowMs();
    let bodies = [];
    try {
        let b = http.batch();
        for (let i = 0; i < ids.length; i++) b = b.GET("https://m.ok.ru/video/" + ids[i], headers, false);
        let res = b.execute();
        for (let i = 0; i < ids.length; i++) {
            let body = "";
            try { body = safeStr(res[i] ? (res[i].body || "") : ""); } catch (_) {}
            bodies.push(body);
        }
    } catch (e) {
        addDebug("batch autores no disponible: " + e);
        return null; // el llamador usa el respaldo en serie
    }
    addDebug("autores en paralelo (" + ids.length + "): " + (nowMs() - t0) + "ms");
    let out = {};
    for (let i = 0; i < ids.length; i++) {
        let info = emptyAuthor();
        if (bodies[i]) {
            try { info = authorFromWatchHtml(bodies[i], ids[i]); } catch (_) {}
        }
        out[ids[i]] = info;
    }
    return out;
}

function fetchWatchAuthor(videoId) { // respaldo en serie, UNA sola página
    videoId = safeStr(videoId);
    if (!/^\d{6,}$/.test(videoId)) return emptyAuthor();
    if (WATCH_AUTHOR_CACHE[videoId]) return WATCH_AUTHOR_CACHE[videoId];
    let html = httpGet("https://m.ok.ru/video/" + videoId,
        { "Referer": "https://ok.ru/", "User-Agent": UA_DESKTOP });
    let info = html ? authorFromWatchHtml(html, videoId) : emptyAuthor();
    WATCH_AUTHOR_CACHE[videoId] = info;
    return info;
}

function enrichAuthorsFromWatchPage(results) {
    if (!ENABLE_WATCH_AUTHORS || !results || !results.length) return results;
    try { applySeriesToResults(results); } catch (_) {}
    let todo = [];
    for (let i = 0; i < results.length && todo.length < WATCH_AUTHOR_CAP_FAST; i++) {
        let r = results[i];
        if (!r || !/^\d{6,}$/.test(safeStr(r.id))) continue;
        let ai = r.authorInfo || {};
        if (ai.fromGroup && ai.name && ai.url) continue;         // ya viene bien de la búsqueda
        if (WATCH_AUTHOR_CACHE[r.id]) { applyWatchAuthor(r, WATCH_AUTHOR_CACHE[r.id]); continue; }
        todo.push(r);
    }
    if (!todo.length) return results;

    let ids = todo.map(function (r) { return r.id; });
    let map = fetchWatchAuthorsParallel(ids);
    for (let i = 0; i < todo.length; i++) {
        let info;
        if (map) { info = map[todo[i].id]; WATCH_AUTHOR_CACHE[todo[i].id] = info; }
        else { try { info = fetchWatchAuthor(todo[i].id); } catch (_) { info = null; } }
        applyWatchAuthor(todo[i], info);
    }
    try { applySeriesToResults(results); } catch (_) {}
    return results;
}

function applyWatchAuthor(r, info) {
    if (!info || !info.name || isJunkName(info.name) || !info.url) return;
    applySeriesByTitle(info, r.title);
    r.authorInfo = info;
    try { rememberAuthor(r.id, info); } catch (_) {}
}

/* ------------- Autor viajando en la URL (&an=&au=&ap=) y caché ------------- */

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

function authorComplete(a) {
    return !!(a && a.name && a.url);
}

/* ---------------------- Autor desde la página del video ---------------------- */

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

    // 3) Enlace (perfil, grupo o alias) cuyo texto es el nombre del autor.
    try {
        if (!out.url) {
            let nl = channelLinkByName(html, (names || []).concat([out.name]));
            if (nl) { out.url = nl.url; if (!out.name) out.name = nl.name; }
        }
    } catch (_) {}

    // 4) Ventana alrededor del id del video.
    try {
        if (!out.url && videoId) {
            let w = extractAuthorForVideoInHtml(html, videoId, true);
            if (w) mergeAuthorInfo(out, w);
        }
    } catch (_) {}

    if (out.url && !isChannelLikeUrl(out.url)) out.url = "";
    return out;
}

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

// El reproductor suele traer el nombre pero no el perfil: se completa con lo
// visto en la tarjeta de búsqueda y, si hace falta, con la página del video.
let AUTHOR_FETCH_TRIED = {};

function resolveAuthorInfo(info, videoId, html) {
    let wasExplicit = !!(info && info.explicit);
    info = mergeAuthorInfo(emptyAuthor(), info);
    info.explicit = wasExplicit;
    try {
        let names = [info.name];
        let rem = recallAuthor(videoId);
        if (rem) names.push(rem.name);

        let owner = html ? ownerCardFromHtml(html) : null;
        if (owner && owner.fromOwner && owner.name && owner.url) {
            info = owner;
        }
        let pageGroup = html ? groupCardFromBlock(html) : null;
        if (!info.fromOwner && pageGroup && pageGroup.id && !pageGroup.name) pageGroup.name = nameNearGroup(html, pageGroup.id);
        if (!info.fromOwner && pageGroup && isGroupUrl(pageGroup.url)) {
            info.url = pageGroup.url;
            info.id = pageGroup.id || info.id;
            if (pageGroup.name && !isJunkName(pageGroup.name)) info.name = pageGroup.name;
            info.explicit = true;
            info.fromGroup = true;
        } else if (!info.fromOwner && !info.explicit && html) {
            let pg = extractAuthorFromVideoPage(html, videoId, names);
            if (pg && pg.url) {
                info.url = pg.url;
                if (pg.id) info.id = pg.id;
                info.explicit = true;
            }
            mergeAuthorInfo(info, pg);
        }
        if (rem && !info.fromGroup && !info.fromOwner) {
            if (rem.url && !info.explicit) {
                info.url = rem.url;
                if (rem.id) info.id = rem.id;
            }
            mergeAuthorInfo(info, rem);
        } else if (rem && info.fromGroup && !info.name && rem.name && isGroupUrl(rem.url)) {
            info.name = rem.name;
        }
        // sin segunda descarga: el autor incompleto se resuelve al hacer clic en el canal
    } catch (e) {
        addDebug("resolveAuthorInfo: " + e);
    }
    try {
        if (!info.thumbnail && info.url) {
            let k = chanKey(bareChannelUrl(info.url));
            if (CHANNEL_AVATARS[k]) info.thumbnail = CHANNEL_AVATARS[k];
            else if (html) info.thumbnail = findAvatarNearLink(html, info.url);
        }
    } catch (_) {}
    try { applySeriesChannel(info, html); } catch (_) {}
    return info;
}

// PlatformAuthorLink clickeable. Con nombre pero sin canal conocido se entrega
// un enlace diferido (/__author/<videoId>) que se resuelve al hacer clic.
function makeAuthorLink(info, videoId, forceDeferred) {
    info = info || {};
    let name = isJunkName(info.name) ? "" : cleanText(info.name);
    let url = isHttpUrl(info.url) ? info.url : "";
    let id = badChannelId(info.id) ? "" : safeStr(info.id);
    if (url && !isChannelLikeUrl(url)) url = "";

    if (!id && url) {
        let m = url.match(/\/(?:profile|group)\/([^/?#]+)/i);
        if (m) id = m[1];
    }
    if (!url && /^\d{4,}$/.test(id)) url = "https://ok.ru/profile/" + encodeURIComponent(id);
    if (url) url = bareChannelUrl(url);

    let pseudo = false;
    if (!url && /^\d{6,}$/.test(safeStr(videoId))) {
        url = pseudoAuthorUrl(videoId);
        id = "author-" + safeStr(videoId);
        pseudo = true;
    }

    // Mismo canal visto antes con nombre: reutilizarlo en vez de "OK.ru".
    if (!name && url && !pseudo && CHANNEL_NAMES[chanKey(url)]) name = CHANNEL_NAMES[chanKey(url)];
    if (!name && url) name = "OK.ru";
    if (!name) return null;

    if (!id) {
        let m2 = url.match(/ok\.ru\/(?:(?:profile|group)\/)?([^/?#]+)/i);
        id = m2 ? m2[1] : name;
    }
    if (url && !pseudo && name !== "OK.ru") CHANNEL_NAMES[chanKey(url)] = name;

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

/* --------------------- Resolver el enlace diferido al clic --------------------- */

function unescapeJsonText(s) {
    s = safeStr(s);
    try {
        s = s.replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
    } catch (_) {}
    return s.replace(/\\\//g, "/").replace(/\\&quot;/g, '"');
}

// Busca el nombre en el texto y toma el enlace de canal más cercano.
function channelNearName(html, names) {
    let src = unescapeJsonText(htmlDecode(safeStr(html)));
    let low = src.toLowerCase();
    for (let i = 0; i < (names || []).length; i++) {
        let n = cleanText(names[i]).toLowerCase();
        if (!n || n.length < 4) continue;
        let pos = 0, tries = 0;
        while ((pos = low.indexOf(n, pos)) >= 0 && tries++ < 12) {
            let from = Math.max(0, pos - 1200);
            let win = src.substring(from, Math.min(src.length, pos + n.length + 1200));
            let best = null, bestD = 1e9, m;
            let re = /(?:href\s*=\s*["']|["'(])((?:https?:\/\/(?:www\.|m\.)?ok\.ru)?\/(?:group|profile)\/\d{4,}[^"'\s)<]*)/gi;
            while ((m = re.exec(win)) !== null) {
                let ch = channelFromHref(m[1]);
                if (!ch) continue;
                let d = Math.abs(m.index - (pos - from));
                if (d < bestD) { bestD = d; best = ch; }
            }
            if (best) return { url: best, name: names[i] };
            pos += n.length;
        }
    }
    return null;
}

function pageChannelFromHtml(html, vid, page, names) {
    let guess = null;
    try {
        let meta = parseMetadata(html, page);
        if (meta) {
            let gi = getAuthorInfo(meta);
            if (gi.name) names.push(gi.name);
            if (gi.url && isChannelLikeUrl(gi.url)) {
                if (gi.explicit) return { url: gi.url, name: gi.name };
                guess = { url: gi.url, name: gi.name };
            }
        }
    } catch (_) {}
    try {
        let ex = extractAuthorFromVideoPage(html, vid, names);
        if (ex && ex.url && isChannelLikeUrl(ex.url)) return { url: ex.url, name: ex.name };
    } catch (_) {}
    return guess;
}

// Último recurso: buscar el nombre en el buscador de grupos/personas y de videos.
function searchChannelByName(names) {
    for (let i = 0; i < names.length && i < 2; i++) {
        let modes = ["Groups", "Users"];
        for (let k = 0; k < modes.length; k++) {
            let h = "";
            try {
                h = httpGetAuthenticated("https://ok.ru/dk?st.cmd=searchResult&st.mode=" + modes[k] + "&st.query=" + encodeURIComponent(names[i]));
            } catch (e) { addDebug("buscar canal: " + e); }
            if (!h) continue;
            let r = channelLinkByName(h, [names[i]]) || channelNearName(h, [names[i]]);
            if (r) return r;
        }
        let vh = "";
        try { vh = fetchSearchPage(names[i], 1); } catch (_) {}
        if (vh) {
            let found = [];
            try { found = extractSearchResults(vh); } catch (_) {}
            for (let j = 0; j < found.length; j++) {
                let ai = found[j].authorInfo || {};
                if (ai.url && isChannelLikeUrl(ai.url) && ai.name && nameMatches(ai.name, names[i])) {
                    return { url: ai.url, name: ai.name };
                }
            }
        }
    }
    return null;
}

function resolvePseudoAuthor(url) {
    let m = safeStr(url).match(/ok\.ru\/__author\/(\d+)/i);
    if (!m) return "";
    let vid = m[1];
    if (PSEUDO_RESOLVED[vid]) return PSEUDO_RESOLVED[vid];
    let page = "https://ok.ru/video/" + vid;
    let rem = recallAuthor(vid);
    let names = [];
    if (rem && rem.name) names.push(rem.name);
    let found = null, lastHtml = "", html = "";

    try { html = httpGet(page, { "Referer": "https://ok.ru/" }); } catch (_) {}
    if (html) { lastHtml = html; found = pageChannelFromHtml(html, vid, page, names); }
    if (!found) {
        try {
            let ah = httpGetAuthenticated(page);
            if (ah && ah !== html) { lastHtml = ah; found = pageChannelFromHtml(ah, vid, page, names); }
        } catch (e) { addDebug("autor diferido (sesión): " + e); }
    }
    if (!found && lastHtml) {
        let nn = null;
        try { nn = channelNearName(lastHtml, names); } catch (_) {}
        if (nn) found = nn;
    }
    if (!found) {
        let uniq = [];
        for (let i = 0; i < names.length; i++) {
            let n = cleanText(names[i]);
            if (n && !isJunkName(n) && uniq.indexOf(n) < 0) uniq.push(n);
        }
        if (uniq.length) found = searchChannelByName(uniq);
    }
    if (!found && rem && rem.url && isChannelLikeUrl(rem.url) && !isPseudoAuthorUrl(rem.url)) {
        found = { url: rem.url, name: "" };
    }
    if (found) {
        let bare = bareChannelUrl(found.url);
        if (found.name && !isJunkName(found.name)) CHANNEL_NAMES[chanKey(bare)] = found.name;
        PSEUDO_RESOLVED[vid] = bare;
        return bare;
    }
    addDebug("autor diferido " + vid + ": no se encontró canal. nombres=" + (names.join(" / ") || "-"));
    return "";
}

function unpseudoChannel(url) {
    if (!isPseudoAuthorUrl(url)) return url;
    let real = resolvePseudoAuthor(url);
    if (!real) throw new Error("OK.ru no indica a qué canal pertenece este video. Abre el video y vuelve a probar.\n" + debugText());
    return real;
}

/* ------------------------------ Datos del canal ------------------------------ */

function extractChannelId(url) {
    let sc = safeStr(url).match(/\/(?:profile|group)\/([^/?#]+)\/video\/c(\d+)/i);
    if (sc) return sc[1] + "_c" + sc[2];
    let m = safeStr(url).match(/\/(profile|group)\/([^/?#]+)/i);
    return m ? safeStr(m[2]) : "";
}

function extractChannelName(html) {
    let t = extractPageTitle(html);
    if (t) return t;
    let m = safeStr(html).match(/<h1[^>]*>([\s\S]{2,500}?)<\/h1>/i);
    if (m) {
        let n = cleanText(m[1]);
        if (n && !isGenericSiteTitle(n)) return n;
    }
    m = safeStr(html).match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (m) return cleanText(m[1]);
    return "OK.ru";
}

function extractChannelThumbnail(html) {
    html = safeStr(html);
    let pats = [
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
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

// Videos de una página de canal: extractor normal; si no hay nada, se decodifica
// el HTML y se buscan IDs de video en claves habituales (movieId, mvId, videoId).
function collectChannelVideos(html) {
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
    if (raw.length) return raw;

    let pats = [
        /(?:movieId|mvId|videoId|movie_id)["']?\s*[:=]\s*["']?(\d{6,})/gi,
        /st\.mvId=(\d{6,})/g,
        /\/video\/(\d{6,})/g
    ];
    let idSeen = {}, hits = [];
    for (let p = 0; p < pats.length; p++) {
        let m;
        while ((m = pats[p].exec(dec)) !== null && hits.length < 96) {
            if (!idSeen[m[1]]) { idSeen[m[1]] = true; hits.push({ id: m[1], index: m.index }); }
        }
    }
    let results = [], seen2 = {};
    for (let i = 0; i < hits.length; i++) {
        let h = hits[i];
        addSearchCandidate(results, seen2, h.id, dec.substring(Math.max(0, h.index - 600), Math.min(dec.length, h.index + 900)), "");
        let r = results[results.length - 1];
        if (r && r.id === h.id && /^OK\.ru video\b/i.test(r.title)) {
            let after = dec.substring(h.index, Math.min(dec.length, h.index + 600));
            let jm = after.match(/["']title["']\s*:\s*["']([^"']{2,300})["']/i);
            if (jm) {
                let t = cleanText(jm[1]);
                if (t && !isGenericTitle(t)) {
                    r.title = t;
                    r.url = "https://ok.ru/video/" + h.id + "?t=" + encodeURIComponent(t);
                }
            }
        }
    }
    if (!results.length) addDebug("canal sin videos: len=" + dec.length + " title=" + (extractPageTitle(html) || ""));
    return results;
}

function channelCandidates(base) {
    if (/ok\.ru\/(?:profile|group)\/[^\/?#]+\/video\/c\d+/i.test(base)) return [base];
    let m = base.match(/ok\.ru\/(profile|group)\/([^\/?#]+)/i);
    if (m) {
        let id = m[2];
        let p = "https://ok.ru/profile/" + id;
        let g = "https://ok.ru/group/" + id;
        let pc = [p + "/video", p];
        let gc = [g + "/video/all", g + "/video", g];
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

// OK.ru usa /profile/<id> para personas y /group/<id> para comunidades; se
// prueban las variantes hasta que una devuelva videos, y se recuerda cuál.
function resolveChannel(url) {
    let base = bareChannelUrl(url) || safeStr(url);
    if (badChannelId(chanKey(base))) return null;
    if (CHANNEL_RESOLVED[base]) return CHANNEL_RESOLVED[base];

    let cands = channelCandidates(base);
    let weak = null, best = null;

    for (let i = 0; i < cands.length; i++) {
        let html = "";
        try { html = httpGetAuthenticated(cands[i]); } catch (e) { addDebug("canal fetch " + cands[i] + ": " + e); }
        if (!html) continue;
        let n = 0;
        try { n = collectChannelVideos(html).length; } catch (_) {}
        addDebug("probe " + cands[i].replace("https://", "") + " bytes=" + html.length + " videos=" + n);

        let res = { fetchUrl: cands[i], bare: bareChannelUrl(cands[i]), html: html };
        if (!best || html.length > best.html.length) best = res;
        if (n > 0) {
            CHANNEL_RESOLVED[base] = res;
            CHANNEL_RESOLVED[res.bare] = res;
            return res;
        }
        if (!weak && channelHtmlLooksValid(html)) weak = res;
    }
    return weak || best;
}

/* ---- Paginación real de canales de serie (capturada del scroll en PC) ----
   OK.ru carga más videos con un POST a:
     https://ok.ru/video/c<ID>?st.cmd=video&st.m=ALBUM&st.ft=album&st.aid=c<ID>&cmd=VideoAlbumBlock
   con form-data: fetch=false & st.page=<n> & st.lastelem=<marcador> & gwt.requested=<hash>T<ms>
   - st.lastelem: marcador (data-last-element) del último video entregado; se toma de la
     página/respuesta anterior.
   - gwt.requested: hash de la página + "T" + Date.now(). */
const CHANNEL_PAGING = {}; // chanKey -> { marker, gwt, aid }

function extractLastElement(html) {
    html = safeStr(html);
    let dec = html;
    try { dec = htmlDecode(html).replace(/\\\//g, "/"); } catch (_) {}
    function lastMatch(re, src) {
        let last = "", m;
        while ((m = re.exec(src)) !== null) last = m[1];
        return last;
    }
    // El marcador real es un timestamp de 13 dígitos (uploadedMovieMarker / st.lastelem).
    let srcs = [dec, html];
    for (let i = 0; i < srcs.length; i++) {
        let src = srcs[i];
        let v = lastMatch(/st\.lastelem(?:=|%3D)(\d{12,})/gi, src) ||
                lastMatch(/uploadedMovieMarker\W{1,8}marker\W{1,8}(\d{12,})/gi, src) ||
                lastMatch(/uploadedMovieMarker\W{1,8}(\d{12,})/gi, src) ||
                lastMatch(/data-last-element=["'](\d{12,})["']/gi, src) ||
                lastMatch(/(?:lastElem|last_element|lastelem)\W{1,6}(\d{12,})/gi, src) ||
                lastMatch(/\bmarker\W{1,8}(\d{12,})/gi, src);
        if (v) return v;
    }
    // Diagnóstico: valores de data-last-element que NO sirvieron.
    let all = [], m, re = /data-last-element=["']([^"']{1,60})["']/gi;
    while ((m = re.exec(dec)) !== null && all.length < 6) all.push(m[1]);
    if (all.length) addDebug("data-last-element descartados (no 13 dígitos): " + all.join(" | "));
    let um = dec.match(/uploadedMovieMarker[\s\S]{0,80}/i);
    if (um) addDebug("uploadedMovieMarker ctx: " + um[0].replace(/\s+/g, " "));
    return "";
}

function extractGwtHash(html) {
    html = safeStr(html);
    let m = html.match(/gwt\.requested(?:=|["']?\s*[:=]\s*["']?)([0-9a-f]{6,10})T\d{10,}/i);
    if (m) return m[1];
    m = html.match(/gwtHash["']?\s*[:=]\s*["']([0-9a-f]{6,10})["']/i);
    if (m) return m[1];
    m = html.match(/\b([0-9a-f]{8})T1\d{12}\b/i);
    if (m) return m[1];
    return "";
}

function extractHasMore(html) {
    let src = safeStr(html), dec = src;
    try { dec = htmlDecode(src).replace(/\\\//g, "/"); } catch (_) {}
    let last = "", m, re = /uploadedMovieMarker\W{1,8}marker\W{1,8}\d*\W{0,8}hasMore\W{1,6}(true|false)/gi;
    while ((m = re.exec(dec)) !== null) last = m[1].toLowerCase();
    return last === "" ? null : (last === "true");
}

function extractTkn(html) {
    let src = safeStr(html), dec = src;
    try { dec = htmlDecode(src).replace(/\\\//g, "/"); } catch (_) {}
    let pats = [
        /OK\.tkn\.set\(\s*["']([^"']{8,})["']\s*\)/i,
        /["']?tkn["']?\s*[:=]\s*["']([A-Za-z0-9_\-:.]{8,})["']/i,
        /[?&;]tkn=([A-Za-z0-9_\-:.]{8,})/i,
        /name=["']tkn["'][^>]*value=["']([^"']{8,})["']/i
    ];
    for (let i = 0; i < pats.length; i++) {
        let m = dec.match(pats[i]) || src.match(pats[i]);
        if (m) return m[1];
    }
    let c = dec.match(/.{0,40}tkn.{0,60}/i);
    addDebug("tkn no hallado" + (c ? " ctx: " + c[0].replace(/\s+/g, " ") : " (sin 'tkn' en el HTML)"));
    return "";
}

function seriesIdFromUrl(url) {
    let m = safeStr(url).match(/\/video\/c(\d+)/i);
    return m ? m[1] : "";
}

function learnChannelPaging(key, url, html) {
    if (!html) return;
    let st = CHANNEL_PAGING[key] || (CHANNEL_PAGING[key] = {});
    let mk = extractLastElement(html);
    if (mk) st.marker = mk;
    let g = extractGwtHash(html);
    if (g) st.gwt = g;
    if (!st.tkn) { let t = extractTkn(html); if (t) st.tkn = t; }
    let hm = extractHasMore(html);
    if (hm !== null) st.hasMore = hm;
    let id = seriesIdFromUrl(url);
    if (id) st.aid = "c" + id;
    addDebug("paging " + key + ": marker=" + (st.marker || "-") + " gwt=" + (st.gwt || "-") + " aid=" + (st.aid || "-") + " tkn=" + (st.tkn ? "sí" : "no") + " hasMore=" + (st.hasMore === undefined ? "?" : st.hasMore));
}

function seriesDiag(key) {
    let st = CHANNEL_PAGING[key];
    return st && st.diag ? ("### " + st.diag + "\n") : "";
}

function buildDiag(html, prev) {
    let dh = html;
    try { dh = htmlDecode(html).replace(/\\\//g, "/"); } catch (_) {}
    let out = [];
    out.push("cola=" + dh.slice(-260).replace(/\s+/g, " "));
    let names = {}, nl = [], m, r = /\b(data-[a-z0-9\-]+)=/gi;
    while ((m = r.exec(dh)) !== null) { if (!names[m[1]]) { names[m[1]] = 1; nl.push(m[1]); } if (nl.length >= 14) break; }
    out.push("attrs=" + nl.join(","));
    let ml = [], r2 = /.{0,45}(?:show-?more|showMore|loader|lastel|last-el|nextpage|next-page|hasMore).{0,60}/gi;
    while ((m = r2.exec(dh)) !== null && ml.length < 3) ml.push(m[0].replace(/\s+/g, " "));
    out.push("more=" + (ml.join(" || ") || "ninguno"));
    return out.join(" ## ");
}

var LAST_POST_HEADERS = "";

function httpPostAuthenticated(url, body, referer, tkn) {
    let headers = {
        "User-Agent": UA_DESKTOP,
        "Accept": "*/*",
        "Accept-Language": "es-419,es;q=0.9,en;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": "https://ok.ru",
        "Referer": referer || "https://ok.ru/"
    };
    if (tkn) headers["TKN"] = tkn;
    let r;
    try {
        r = http.POST(url, body, headers, true);
        try { LAST_POST_HEADERS = JSON.stringify(r.headers || {}); } catch (_) { LAST_POST_HEADERS = ""; }
        try { addDebug("POST status=" + (r && (r.code !== undefined ? r.code : r.status))); } catch (_) {}
    } catch (e) {
        addDebug("POST canal: " + e);
        throw makeErr(LOGIN_MSG);
    }
    return readBody(r);
}

function postIds(html) {
    let ids = [], m, re = /js-movie-card[^>]*data-id="(\d+)"/g;
    while ((m = re.exec(safeStr(html))) !== null) ids.push(m[1]);
    return ids;
}

function postBatch(st, T, page) {
    let endpoint = "https://ok.ru/video/" + st.aid +
        "?st.cmd=video&st.m=ALBUM&st.ft=album&st.aid=" + st.aid + "&cmd=VideoAlbumBlock";
    let body = "fetch=false&st.page=" + page + "&st.lastelem=" + T +
        (st.gwt ? "&gwt.requested=" + encodeURIComponent(st.gwt + "T" + Date.now()) : "");
    return httpPostAuthenticated(endpoint, body, "https://ok.ru/video/" + st.aid, st.tkn) || "";
}

/* st.lastelem es un corte por tiempo: el servidor devuelve los 24 videos con fecha <= corte.
   OK.ru no entrega el siguiente corte, así que se busca: se prueba un corte y se mira con qué
   video ya visto empieza el lote. Se acepta cuando empieza en uno de los últimos 3 vistos
   (solapa 2-3 videos, sin saltarse ninguno; el script descarta los repetidos). */
function fetchChannelMore(url, key, page) {
    let st = CHANNEL_PAGING[key];
    if (!st || !st.aid || !st.marker || !st.order || !st.order.length) {
        addDebug("sin marcador/aid/lista para paginar " + key);
        return "";
    }
    if (!st.idx) { st.idx = {}; for (let i = 0; i < st.order.length; i++) st.idx[st.order[i]] = i; }
    function absorb(ids) {
        for (let i = 0; i < ids.length; i++) if (st.idx[ids[i]] === undefined) { st.idx[ids[i]] = st.order.length; st.order.push(ids[i]); }
    }
    let M1 = Number(st.marker);

    // Primer lote tras la página 1: el marcador de la página es exacto.
    if (!st.samples) {
        let h = postBatch(st, M1, page);
        let ids = postIds(h);
        st.samples = [{ T: M1, first: ids[0] }];
        addDebug("lote p" + page + " T=" + M1 + " n=" + ids.length + " primero=" + (ids[0] || "-"));
        absorb(ids);
        return h;
    }

    let L = st.order.length;
    let W = Math.min(3, L), idxMin = L - W;
    function sIdx(x) { return (x.first !== undefined && st.idx[x.first] !== undefined) ? st.idx[x.first] : null; }
    let DEF = 164000; // ms por video (aprox., de las pruebas)
    let grow = 1, lastA = null;
    for (let it = 0; it < 20; it++) {
        let S = st.samples, A = null, B = null, A2 = null, i;
        for (i = 0; i < S.length; i++) {
            let xi = sIdx(S[i]);
            if (xi !== null && xi < idxMin && (!A || S[i].T < A.T)) A = S[i];
        }
        if (!A) A = S[0];
        let Aidx = sIdx(A);
        for (i = 0; i < S.length; i++) {
            let xi = sIdx(S[i]);
            if (xi === null && S[i].T < A.T && (!B || S[i].T > B.T)) B = S[i];
            if (xi !== null && S[i].T > A.T && xi < Aidx && (!A2 || xi > sIdx(A2))) A2 = S[i];
        }
        let msPer = DEF;
        if (A2 && Aidx > sIdx(A2)) { let r = (A2.T - A.T) / (Aidx - sIdx(A2)); if (r > 1000 && r < 3.6e7) msPer = r; }
        let guess = A.T - (L - 2 - Aidx) * msPer;
        // Si no se avanza (misma cota A), ampliar el paso; si se avanza, volver al paso base.
        if (A !== lastA) grow = 1;
        let delta = A.T - guess;
        if (!(delta >= 60000)) delta = B ? 60000 : 3600000;
        delta *= grow; grow *= 2;
        if (delta > 259200000) delta = 259200000;
        guess = Math.round(A.T - delta);
        if (B) {
            if (A.T - B.T < 2) break;
            let mid = Math.round((A.T + B.T) / 2);
            if (guess <= B.T || guess >= A.T) guess = mid;
            if (guess - B.T < 1000 || A.T - guess < 1000) guess = mid;
        }
        lastA = A;
        let h = postBatch(st, guess, page);
        let ids = postIds(h);
        let first = ids[0], idx = null;
        if (first !== undefined && st.idx[first] !== undefined) idx = st.idx[first];
        st.samples.push({ T: guess, first: first });
        addDebug("busca p" + page + " it" + it + " A=" + A.T + " B=" + (B ? B.T : "-") + " T=" + guess + " n=" + ids.length + " primero=" + (first || "-") + " idx=" + idx + " (objetivo " + idxMin + "-" + (L - 1) + ")");
        if (!ids.length) continue;
        if (idx !== null && idx >= idxMin) {
            st.marker = String(guess);
            absorb(ids);
            return h;
        }
    }
    st.searchFailed = true;
    addDebug("búsqueda de corte fallida en p" + page);
    return "";
}

function fetchChannelPage(url, page) {
    let res = resolveChannel(url);
    if (!res) return "";
    let key = chanKey(res.bare);
    let isSeries = /\/video\/c\d+/i.test(res.fetchUrl);

    if (page <= 1) {
        let h = "";
        if (res.html) {
            h = res.html;
            res.html = "";
        } else {
            h = httpGetAuthenticated(res.fetchUrl) || "";
        }
        if (isSeries) {
            CHANNEL_PAGING[key] = {};
            learnChannelPaging(key, res.fetchUrl, h);
        }
        return h;
    }

    if (isSeries) {
        let h = fetchChannelMore(res.fetchUrl, key, page);
        if (h) return h;
        return ""; // sin marcador: no insistir con st.page (OK.ru lo ignora)
    }

    let target = res.fetchUrl + (res.fetchUrl.indexOf("?") >= 0 ? "&" : "?") + "st.page=" + page;
    return httpGetAuthenticated(target) || "";
}

const CHANNEL_SEEN = {}; // ids ya entregados por canal (corta páginas repetidas)

class OkChannelVideoPager extends VideoPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
    }
    nextPage() {
        if (!this.hasMorePagers()) return this;
        return channelPager(this.context.url, this.context.page);
    }
}

function channelPager(url, page) {
    if (page <= 1) resetDebug();
    url = unpseudoChannel(url);
    if (badChannelId(chanKey(url))) {
        throw new Error("OK.ru no indica a qué canal pertenece este video (" + safeStr(url) + "). Abre el video y vuelve a probar.");
    }
    let res = resolveChannel(url);
    let bare = res ? res.bare : bareChannelUrl(url);
    let html = fetchChannelPage(url, page);
    let raw = html ? collectChannelVideos(html) : [];

    // Identidad del canal: nombre + foto (de la página, o de las propias tarjetas).
    let key = chanKey(bare);
    let name = CHANNEL_NAMES[key] || "";
    if (!name && html && page <= 1) {
        let n = extractChannelName(html);
        if (n && !isGenericSiteTitle(n) && !/^OK\.ru$/i.test(n)) name = n;
    }
    let thumb = CHANNEL_AVATARS[key] || "";
    if (!thumb && html && page <= 1) {
        thumb = extractChannelThumbnail(html);
        if (thumb) CHANNEL_AVATARS[key] = thumb;
    }
    if (raw.length) {
        let ai0 = raw[0].authorInfo || {};
        if (!name && ai0.name && !isJunkName(ai0.name)) name = ai0.name;
        if (!thumb && ai0.thumbnail) thumb = ai0.thumbnail;
    }
    if (name) CHANNEL_NAMES[key] = name;

    // Respaldo: buscar por el nombre del canal y quedarse con sus videos.
    let isSeriesCh = !!(res && /\/video\/c\d+/i.test(res.fetchUrl));
    if (page <= 1 && isSeriesCh && CHANNEL_PAGING[key]) {
        let st0 = CHANNEL_PAGING[key];
        st0.order = []; st0.idx = {}; st0.samples = null; st0.searchFailed = false;
        for (let q = 0; q < raw.length; q++) { st0.idx[raw[q].id] = st0.order.length; st0.order.push(raw[q].id); }
    }
    if (!raw.length && !isSeriesCh && name && !isGenericSiteTitle(name)) {
        try {
            let id = chanKey(bare);
            let found = extractSearchResults(fetchSearchPage(name, page));
            for (let i = 0; i < found.length; i++) {
                let ai = found[i].authorInfo || {};
                let sameId = id && (safeStr(ai.id) === id || safeStr(ai.url).indexOf("/" + id) >= 0);
                let sameName = ai.name && cleanText(ai.name).toLowerCase() === cleanText(name).toLowerCase();
                if (sameId || sameName) raw.push(found[i]);
            }
        } catch (e) { addDebug("canal respaldo: " + e); }
    }

    if (!raw.length) {
        if (isSeriesCh && page > 1 && ENABLE_SERIES_DEBUG && CHANNEL_PAGING[key] && CHANNEL_PAGING[key].searchFailed) throw new Error("Fin/corte de la serie (POST VideoAlbumBlock, página " + page + ", hasMore=" + (CHANNEL_PAGING[key] ? CHANNEL_PAGING[key].hasMore : "?") + ")\n" + seriesDiag(key) + debugText());
        if (page <= 1) throw new Error("El canal de OK.ru no devolvió videos (" + bare + ")\n" + debugText());
        return new OkChannelVideoPager([], false, { url: url, page: page + 1 });
    }

    // Si OK.ru ignora st.page y devuelve lo mismo, cortar la paginación.
    if (page <= 1 || !CHANNEL_SEEN[key]) CHANNEL_SEEN[key] = {};
    let fresh = [];
    for (let i = 0; i < raw.length; i++) {
        if (!CHANNEL_SEEN[key][raw[i].id]) { CHANNEL_SEEN[key][raw[i].id] = true; fresh.push(raw[i]); }
    }
    if (page > 1 && !fresh.length) {
        if (isSeriesCh && ENABLE_SERIES_DEBUG && CHANNEL_PAGING[key] && CHANNEL_PAGING[key].searchFailed) throw new Error("La serie repitió videos / fin (página " + page + ", hasMore=" + (CHANNEL_PAGING[key] ? CHANNEL_PAGING[key].hasMore : "?") + ")\n" + seriesDiag(key) + debugText());
        return new OkChannelVideoPager([], false, { url: url, page: page + 1 });
    }
    raw = fresh;

    // Todos los videos de la página son del canal: se usa su identidad.
    for (let i = 0; i < raw.length; i++) {
        let ai = raw[i].authorInfo || {};
        raw[i].authorInfo = {
            name: name || ai.name || "",
            id: extractChannelId(bare) || ai.id || "",
            url: bare,
            thumbnail: thumb || ai.thumbnail || "",
            subscribers: 0
        };
    }

    let out = [];
    for (let i = 0; i < raw.length; i++) {
        let v = makeSearchVideo(raw[i]);
        if (v) out.push(v);
    }
    return new OkChannelVideoPager(out, raw.length > 0, { url: url, page: page + 1 });
}

/* Sonda de m.ok.ru (solo debug): ¿la web móvil lista la serie y cómo pagina? */
function mobileProbe(fetchUrl) {
    let id = seriesIdFromUrl(fetchUrl);
    if (!id) return;
    let UA_M = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
    let urls = ["https://m.ok.ru/video/c" + id];
    let pm = safeStr(fetchUrl).match(/ok\.ru\/(profile|group)\/([^\/?#]+)/i);
    if (pm) urls.push("https://m.ok.ru/" + pm[1] + "/" + pm[2] + "/video/c" + id);
    for (let i = 0; i < urls.length; i++) {
        try {
            let r = http.GET(urls[i], { "User-Agent": UA_M, "Accept": "text/html,*/*;q=0.8", "Accept-Language": "es-419,es;q=0.9", "Referer": "https://m.ok.ru/" }, true);
            let h = readBody(r), dh = h;
            try { dh = htmlDecode(h).replace(/\\\//g, "/"); } catch (_) {}
            let st = ""; try { st = r.code !== undefined ? r.code : r.status; } catch (_) {}
            let vids = h ? collectChannelVideos(h).length : 0;
            let hrefs = [], m, re = /href=["']([^"']*(?:st\.page|[?&]page=|lastelem|st\.cmd=video)[^"']*)["']/gi;
            while ((m = re.exec(dh)) !== null && hrefs.length < 3) hrefs.push(m[1].substring(0, 120));
            let nx = dh.match(/.{0,50}(?:Далее|Ещё|Показать ещё|Más|Siguiente|More).{0,50}/i);
            addDebug("m.ok.ru " + urls[i] + " status=" + st + " bytes=" + h.length + " videos=" + vids +
                " title=" + safeStr(extractPageTitle(h)).substring(0, 50) +
                " | hrefs=" + (hrefs.join(" || ") || "ninguno") + " | sig=" + (nx ? nx[0].replace(/\s+/g, " ") : "ninguno"));
        } catch (e) { addDebug("m.ok.ru " + urls[i] + " error: " + e); }
    }
}

/* Sonda (solo debug): hace el POST del lote 2 y vuelca qué datos trae cada tarjeta. */
function seriesProbePost(res, html, key) {
    CHANNEL_PAGING[key] = {};
    learnChannelPaging(key, res.fetchUrl, html);
    let R = fetchChannelMore(res.fetchUrl, key, 2);
    if (!R) { addDebug("probe POST vacío"); return; }
    let d = R;
    try { d = htmlDecode(R).replace(/\\\//g, "/"); } catch (_) {}
    let ids = [], m, re = /js-movie-card[^>]*data-id="(\d+)"/g;
    while ((m = re.exec(d)) !== null) ids.push(m[1]);
    addDebug("probe tarjetas=" + ids.length + " primero=" + ids[0] + " ultimo=" + ids[ids.length - 1]);
    let tf = [], r2 = /["']?([A-Za-z_]*(?:[tT]ime|[dD]ate|[uU]pload|[cC]reat|[sS]tamp|Ts)[A-Za-z_]*)["']?\s*[:=]\s*["']?(\d{9,14})/g;
    while ((m = r2.exec(d)) !== null && tf.length < 8) tf.push(m[1] + "=" + m[2]);
    addDebug("probe campos de tiempo: " + (tf.join(", ") || "ninguno"));
    let ns = d.match(/\b17\d{11}\b/g) || [];
    addDebug("probe numeros 17xxxxxxxxxxx: " + ns.length + " " + ns.slice(0, 4).join(","));
    addDebug("probe cabeceras: " + (LAST_POST_HEADERS ? LAST_POST_HEADERS.substring(0, 700) : "no disponibles"));
    let hn = (LAST_POST_HEADERS.match(/\d{12,14}/g) || []);
    addDebug("probe numeros largos en cabeceras: " + (hn.join(",") || "ninguno"));
    let cl = [], r3 = /(?:last|marker|cursor|offset|anchor|next)[A-Za-z_\-]{0,20}["'=: ]{1,4}[^"'<> ]{1,30}/gi, seenC = {};
    while ((m = r3.exec(d)) !== null && cl.length < 8) { let c = m[0]; if (!seenC[c]) { seenC[c] = 1; cl.push(c); } }
    addDebug("probe pistas cursor: " + (cl.join(" | ") || "ninguna"));
    // Experimento: ¿st.lastelem es un corte por tiempo? Moverlo y ver qué lote devuelve el servidor.
    let M = Number((CHANNEL_PAGING[key] && CHANNEL_PAGING[key].marker) || 0);
    let stp = CHANNEL_PAGING[key] || {};
    if (M && stp.aid) {
        let deltas = [0.5, 2, 4, 6, 8, 12];
        for (let k = 0; k < deltas.length; k++) {
            try {
                let T = M - Math.round(deltas[k] * 3600000);
                let ep = "https://ok.ru/video/" + stp.aid + "?st.cmd=video&st.m=ALBUM&st.ft=album&st.aid=" + stp.aid + "&cmd=VideoAlbumBlock";
                let bd = "fetch=false&st.page=2&st.lastelem=" + T + (stp.gwt ? "&gwt.requested=" + encodeURIComponent(stp.gwt + "T" + Date.now()) : "");
                let rh = httpPostAuthenticated(ep, bd, "https://ok.ru/video/" + stp.aid, stp.tkn) || "";
                let ids2 = [], m2, re2 = /js-movie-card[^>]*data-id="(\d+)"/g;
                while ((m2 = re2.exec(rh)) !== null) ids2.push(m2[1]);
                let pos = ids2.length ? ids.indexOf(ids2[0]) : -9;
                addDebug("exp -" + deltas[k] + "h: n=" + ids2.length + " primero=" + (ids2[0] || "-") + " ultimo=" + (ids2[ids2.length - 1] || "-") +
                    " posEnLote2=" + pos + (pos === -1 ? " (NUEVO)" : ""));
            } catch (e) { addDebug("exp -" + deltas[k] + "h: " + e); }
        }
    }
    let li = d.lastIndexOf("js-movie-card");
    if (li >= 0) addDebug("probe ultima tarjeta: " + d.substring(li, li + 900).replace(/\s+/g, " "));
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
    let key = chanKey(canonical);
    let id = extractChannelId(canonical) || key || canonical;
    let html = res.html;
    if (!html) { try { html = httpGetAuthenticated(res.fetchUrl); } catch (_) { html = ""; } }


    let name = CHANNEL_NAMES[key] || CHANNEL_NAMES[chanKey(url)] || (html ? extractChannelName(html) : "OK.ru");
    let thumbnail = CHANNEL_AVATARS[key] || (html ? extractChannelThumbnail(html) : "");
    if (thumbnail) CHANNEL_AVATARS[key] = thumbnail;

    return new PlatformChannel({
        id: new PlatformID(PLATFORM_NAME, id, PLUGIN_ID),
        name: name,
        thumbnail: thumbnail,
        banner: "",
        subscribers: 0,
        description: (html ? extractChannelDescription(html) : "") +
            (ENABLE_SERIES_DEBUG ? "\n\n[debug canal] pedido=" + safeStr(url) + " | abierto=" + res.fetchUrl +
                " | bytes=" + (html ? html.length : 0) + "\n" + debugText() : ""),
        url: canonical,
        links: {}
    });
}

function channelPageFromToken(token) {
    try {
        if (token && typeof token === "object") return Math.max(1, Number(token.page) || 1);
        if (token) return Math.max(1, Number(token) || 1);
    } catch (_) {}
    return 1;
}

function okChannelTypes() {
    try {
        if (typeof Type !== "undefined" && Type && Type.Feed && Type.Feed.Mixed) return [Type.Feed.Mixed];
    } catch (_) {}
    return ["MIXED"];
}

/* ------------------------- GrayJay: canales ------------------------- */

source.isChannelUrl = function (url) {
    return isOkChannelUrl(url);
};

source.getChannel = function (url) {
    return getChannelObject(url);
};

source.getChannelContents = function (url, type, order, filters, continuationToken) {
    return channelPager(url, channelPageFromToken(continuationToken));
};

// Compatibilidad con versiones de GrayJay que todavía llaman getChannelVideos.
source.getChannelVideos = function (url, type, order, filters, continuationToken) {
    return channelPager(url, channelPageFromToken(continuationToken));
};

source.getChannelCapabilities = function () {
    try {
        return new ResultCapabilities(okChannelTypes(), [], []);
    } catch (_) {
        return { types: okChannelTypes(), sorts: [], filters: [] };
    }
};
