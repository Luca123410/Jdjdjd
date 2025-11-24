import * as cheerio from 'cheerio';

/**
 * ===========================================================================================
 * CONFIGURAZIONE E COSTANTI
 * ===========================================================================================
 */
const CONFIG = {
    TIMEOUT_MS: 9000, // Timeout globale Vercel (safe margin)
    TIMEOUT_SOURCE: 4000, // Timeout per singola richiesta
    MAX_RESULTS: 30,
    PROVIDERS: {
        CORSARO: 'https://ilcorsaronero.link',
        KNABEN: 'https://knaben.org',
        UINDEX: 'https://uindex.org',
        APIBAY: 'https://apibay.org/q.php',
        X1337: 'https://1337x.to'
    }
};

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
];

const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://9.rarbg.com:2810/announce",
    "udp://tracker.openbittorrent.com:80/announce",
    "udp://opentracker.i2p.rocks:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce"
];

// Regex ITA Potenziata (tua versione)
const ITA_REGEX = /\b(ITA|ITALIAN|ITALIANO|MULTI|DUAL|MD|SUB[\s._-]?ITA|FORCED|AC3[\s._-]?ITA|DTS[\s._-]?ITA|CINEFILE|NOVARIP|MEM|ROBBYRS|IDN_CREW|PSO|BADASS)\b/i;

/**
 * ===========================================================================================
 * UTILITY HELPERS
 * ===========================================================================================
 */
class Utils {
    static getRandomUserAgent() {
        return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    }

    static cleanText(text) {
        if (!text) return '';
        return text.replace(/[:"'’]/g, "").replace(/[^a-zA-Z0-9\s\-.\[\]]/g, " ").replace(/\s+/g, " ").trim();
    }

    static extractInfoHash(magnet) {
        const match = magnet?.match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
        return match ? match[1].toUpperCase() : null;
    }

    static detectQuality(title) {
        const t = title.toLowerCase();
        if (t.includes('2160p') || t.includes('4k') || t.includes('uhd')) return '4K';
        if (t.includes('1080p')) return '1080p';
        if (t.includes('720p')) return '720p';
        if (t.includes('480p') || t.includes('sd')) return '480p';
        return 'SD';
    }

    static buildMagnet(infoHash, name) {
        const trackersStr = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
        return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${trackersStr}`;
    }

    static parseSize(sizeStr) {
        if (!sizeStr) return 0;
        const match = sizeStr.match(/([\d.,]+)\s*(T|G|M|K)?i?B/i);
        if (!match) return 0;
        let val = parseFloat(match[1].replace(',', '.'));
        const unit = (match[2] || 'B').toUpperCase();
        if (unit === 'G') val *= 1024**3;
        else if (unit === 'M') val *= 1024**2;
        else if (unit === 'K') val *= 1024;
        return Math.round(val);
    }
}

/**
 * ===========================================================================================
 * CLIENT DI RETE
 * ===========================================================================================
 */
class HttpClient {
    static async get(url, json = false) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_SOURCE);

        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': Utils.getRandomUserAgent() },
                signal: controller.signal
            });
            if (!res.ok) throw new Error(`Status ${res.status}`);
            return json ? await res.json() : await res.text();
        } catch (e) {
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }
}

/**
 * ===========================================================================================
 * SCRAPERS
 * ===========================================================================================
 */
const Providers = {
    // 🏴‍☠️ IL CORSARO NERO (Con Deep Scraping Parallelo)
    async corsaro(query, type) {
        const cat = type === 'movie' ? 'film' : 'serie-tv';
        // Fix per le serie: Corsaro preferisce "Stagione X" invece di "S0X"
        let q = query;
        if (type === 'series') {
            q = q.replace(/S(\d{1,2})E\d{1,2}/i, (m, s) => `Stagione ${parseInt(s)}`).split('Stagione')[0].trim();
        }

        const url = `${CONFIG.PROVIDERS.CORSARO}/search?q=${encodeURIComponent(q)}&cat=${cat}`;
        const html = await HttpClient.get(url);
        if (!html) return [];

        const $ = cheerio.load(html);
        const candidates = [];

        $('tbody tr').slice(0, 10).each((_, el) => {
            const $el = $(el);
            const link = $el.find('a.tab');
            const title = Utils.cleanText(link.text());
            const href = link.attr('href');
            const size = $el.find('td').eq(3).text().trim();
            const seeds = parseInt($el.find('.text-green-500').text()) || 0;
            
            if (href) candidates.push({ title, href, size, seeds });
        });

        // Fetch parallelo dei dettagli per prendere i magnet
        const details = await Promise.all(candidates.map(async (c) => {
            const detailHtml = await HttpClient.get(`${CONFIG.PROVIDERS.CORSARO}${c.href}`);
            if (!detailHtml) return null;
            const $$ = cheerio.load(detailHtml);
            let magnet = $$('a[href^="magnet:"]').attr('href');
            // Fallback selettore
            if (!magnet) magnet = $$("div.w-full:nth-child(2) a").attr('href');
            
            if (magnet) {
                return {
                    provider: 'CorsaroNero',
                    title: c.title,
                    magnet,
                    size: c.size,
                    seeds: c.seeds,
                    infoHash: Utils.extractInfoHash(magnet)
                };
            }
            return null;
        }));

        return details.filter(Boolean);
    },

    // 🚀 1337x (Scraping Avanzato)
    async x1337(title, year) {
        const q = year ? `${title} ${year}` : title;
        const catPath = year ? 'Movies' : 'TV';
        const url = `${CONFIG.PROVIDERS.X1337}/category-search/${encodeURIComponent(q)}/${catPath}/1/`;
        
        const html = await HttpClient.get(url);
        if (!html) return [];
        const $ = cheerio.load(html);
        const candidates = [];

        $("table.table-list tbody tr").slice(0, 8).each((_, el) => {
            const $el = $(el);
            const nameLink = $el.find("a[href^='/torrent/']");
            if (!nameLink.length) return;
            
            const name = Utils.cleanText(nameLink.text());
            if (!ITA_REGEX.test(name)) return; // Filtro ITA qui

            candidates.push({
                name,
                href: nameLink.attr("href"),
                seeds: parseInt($el.find(".coll-2").text()) || 0,
                size: $el.find(".coll-4").text()
            });
        });

        const details = await Promise.all(candidates.map(async (c) => {
            const dHtml = await HttpClient.get(`${CONFIG.PROVIDERS.X1337}${c.href}`);
            if (!dHtml) return null;
            const $$ = cheerio.load(dHtml);
            const magnet = $$("a[href^='magnet:']").first().attr("href");
            
            if (magnet) {
                return {
                    provider: '1337x',
                    title: c.name,
                    magnet,
                    size: c.size,
                    seeds: c.seeds,
                    infoHash: Utils.extractInfoHash(magnet)
                };
            }
            return null;
        }));

        return details.filter(Boolean);
    },

    // 🌊 APIBAY (ThePirateBay Dump)
    async apibay(title) {
        const url = `${CONFIG.PROVIDERS.APIBAY}?q=${encodeURIComponent(title)}&cat=200`;
        const data = await HttpClient.get(url, true);
        if (!Array.isArray(data) || data[0]?.name === 'No results returned') return [];

        return data
            .filter(item => ITA_REGEX.test(item.name)) // Filtro ITA
            .slice(0, 10)
            .map(item => ({
                provider: 'ApiBay',
                title: item.name,
                magnet: Utils.buildMagnet(item.info_hash, item.name),
                size: (parseInt(item.size) / 1073741824).toFixed(2) + " GB",
                seeds: parseInt(item.seeders),
                infoHash: item.info_hash
            }));
    },

    // 🦉 KNABEN
    async knaben(title) {
        const url = `${CONFIG.PROVIDERS.KNABEN}/search/${encodeURIComponent(title)}/0/1/seeders`;
        const html = await HttpClient.get(url);
        if (!html) return [];
        const $ = cheerio.load(html);
        const results = [];

        $('table tbody tr').each((_, el) => {
            const $el = $(el);
            const title = Utils.cleanText($el.find('td:nth-child(2) a').text());
            if (!ITA_REGEX.test(title)) return;

            const magnet = $el.find('a[href^="magnet:"]').attr('href');
            if (title && magnet) {
                results.push({
                    provider: 'Knaben',
                    title,
                    magnet,
                    size: $el.find('td').eq(2).text(),
                    seeds: parseInt($el.find('td').eq(4).text()) || 0,
                    infoHash: Utils.extractInfoHash(magnet)
                });
            }
        });
        return results;
    }
};

/**
 * ===========================================================================================
 * LOGICA DI AGGREGAZIONE
 * ===========================================================================================
 */
class StreamManager {
    constructor(config) { this.config = config; }

    calculateScore(item) {
        let score = 0;
        if (item.provider === 'CorsaroNero') score += 50; // Fiducia ITA
        if (item.title.toUpperCase().includes('4K') || item.title.includes('2160p')) score += 40;
        if (item.title.toUpperCase().includes('1080P')) score += 30;
        score += Math.min(item.seeds, 50); // Seeders bonus
        return score;
    }

    async getStreams(query, type) {
        console.log(`🔎 Searching: ${query} [${type}]`);
        
        // Estrai anno se presente per 1337x
        const yearMatch = query.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? yearMatch[0] : null;
        const cleanQuery = Utils.cleanText(query);

        // Lancio Parallelo di TUTTI i providers
        const promises = [
            Providers.corsaro(cleanQuery, type),
            Providers.x1337(cleanQuery, year),
            Providers.apibay(cleanQuery),
            Providers.knaben(cleanQuery)
        ];

        const resultsRaw = (await Promise.allSettled(promises))
            .filter(r => r.status === 'fulfilled')
            .flatMap(r => r.value);

        // Deduplicazione avanzata (basata su InfoHash)
        const unique = new Map();
        resultsRaw.forEach(i => {
            if (i.infoHash && !unique.has(i.infoHash)) {
                // Calcola punteggio per ordinamento
                i.score = this.calculateScore(i);
                unique.set(i.infoHash, i);
            }
        });

        let processed = Array.from(unique.values()).sort((a, b) => b.score - a.score);

        // Formattazione Stremio
        return processed.map(item => {
            const quality = Utils.detectQuality(item.title);
            const isIta = ITA_REGEX.test(item.title) || item.provider === 'CorsaroNero';
            
            let name = isIta ? `🇮🇹 ${quality}` : `🇬🇧 ${quality}`;
            name += ` [${item.provider}]`;

            return {
                name: name,
                title: `${item.title}\n💾 ${item.size} | 👥 ${item.seeds} Seeds`,
                infoHash: item.infoHash,
                behaviorHints: { bingeGroup: `stremizio-${quality}` }
            };
        });
    }
}

/**
 * ===========================================================================================
 * HANDLER VERCEL (HTML + API)
 * ===========================================================================================
 */
const HTML_PAGE = `
<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Stremio ITA Multi-Source</title>
    <style>
        body { background: #111; color: #eee; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .card { background: #222; padding: 2rem; border-radius: 10px; text-align: center; max-width: 400px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
        h1 { color: #00d2ff; }
        button { background: #00d2ff; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-weight: bold; margin-top: 20px; width: 100%; }
        .sources { font-size: 0.8em; color: #888; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="card">
        <h1>🇮🇹 Stremio ITA Plus</h1>
        <p>Aggregatore Multi-Sorgente Italiano</p>
        <div class="sources">Fonti: Il Corsaro Nero, 1337x, APIBay, Knaben</div>
        <button onclick="window.location.href='stremio://' + window.location.host + '/manifest.json'">INSTALLA ADDON</button>
    </div>
</body>
</html>
`;

export default async function handler(req, res) {
    const url = new URL(req.url, `https://${req.headers.host}`);
    
    // Headers CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Content-Type', 'application/json');

    try {
        if (url.pathname === '/') {
            res.setHeader('Content-Type', 'text/html');
            return res.send(HTML_PAGE);
        }

        if (url.pathname.endsWith('manifest.json')) {
            return res.send({
                id: 'org.stremio.ita.multisource',
                version: '2.0.0',
                name: 'ITA Plus (Multi-Source)',
                description: 'Cerca su CorsaroNero, 1337x, APIBay e Knaben. Solo ITA.',
                resources: ['stream'],
                types: ['movie', 'series'],
                catalogs: []
            });
        }

        if (url.pathname.includes('/stream/')) {
            const pathParts = url.pathname.split('/');
            const type = pathParts[2];
            const id = decodeURIComponent(pathParts[3].replace('.json', ''));

            // Logica base per ID IMDB (es. tt12345) -> Titolo
            // In un setup reale qui chiameresti TMDB. Per ora usiamo l'ID o assumiamo che il client mandi il titolo se possibile
            // Ma per far funzionare l'esempio, assumiamo che 'id' contenga info utili o usiamo un placeholder
            // NOTA: Stremio manda tt12345. Senza TMDB Key non possiamo convertire tt -> Titolo.
            // Se usi questo codice, assicurati di implementare la logica TMDB o usa "stremio-jackett" per mappare.
            // PER TEST: Se cerchi manualmente funzionerà, se clicchi un film da Stremio serve conversione.
            
            // Qui inserisco un "Hack" simulato: Se l'ID inizia con 'tt', non funzionerà bene senza TMDB.
            // Ma se l'addon viene chiamato con "kitsu" o stringhe di ricerca manuali, va.
            
            let query = id;
            if (id.startsWith('tt')) {
                 // Per Vercel free senza Key esterne, questo è il limite.
                 // Consiglio: Cerca "The Avengers" nella barra di Stremio invece di cliccare sulla locandina per testare.
                 console.log("Ricerca per ID IMDB non supportata pienamente senza API Key. Tento query diretta.");
            }

            // Parsing S01E01 per le serie
            if (type === 'series' && id.includes(':')) {
                const p = id.split(':');
                query = p[0]; // IMDB ID
                // Qui servirebbe lookup TMDB per trasformare tt123 -> "Breaking Bad"
                // Per ora lascio la logica pulita di scraping.
            }

            // Se vuoi testare, usa ID finti tipo "Matrix" nell'URL per vedere se scarica
            
            const manager = new StreamManager({});
            const streams = await manager.getStreams(query, type);
            return res.send({ streams });
        }

    } catch (e) {
        console.error(e);
        return res.status(500).send({ streams: [] });
    }
}
