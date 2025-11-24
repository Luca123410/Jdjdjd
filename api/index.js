import * as cheerio from 'cheerio';

/**
 * ===========================================================================================
 * ⚙️ CONFIGURAZIONE & COSTANTI (Porting da torrentmagnet.js)
 * ===========================================================================================
 */
const CONFIG = {
    TIMEOUT: 8000, // Timeout globale per evitare blocchi Vercel
    MAX_RESULTS: 20
};

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15"
];

const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://9.rarbg.com:2810/announce",
    "udp://tracker.openbittorrent.com:80/announce",
    "udp://opentracker.i2p.rocks:6969/announce"
];

// Regex ITA potenziata (dal tuo file)
const ITA_REGEX = /\b(ITA|ITALIAN|ITALIANO|MULTI|DUAL|MD|SUB[\s._-]?ITA|FORCED|AC3[\s._-]?ITA|DTS[\s._-]?ITA|CINEFILE|NOVARIP|MEM|ROBBYRS|IDN_CREW|PSO|BADASS)\b/i;

/**
 * ===========================================================================================
 * 🛠️ UTILITIES
 * ===========================================================================================
 */
class Utils {
    static getRandomUserAgent() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
    
    static cleanText(str) {
        if (!str) return "";
        return str.replace(/[:"'’]/g, "").replace(/[^a-zA-Z0-9\s\-.\[\]]/g, " ").replace(/\s+/g, " ").trim();
    }

    static extractInfoHash(magnet) {
        const match = magnet?.match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
        return match ? match[1].toUpperCase() : null;
    }

    static formatBytes(bytes) {
        if (!+bytes) return '0 B';
        const k = 1024;
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${['B','KB','MB','GB','TB'][i]}`;
    }

    static detectQuality(title) {
        const t = title.toLowerCase();
        if (t.includes('2160p') || t.includes('4k') || t.includes('uhd')) return '4K';
        if (t.includes('1080p') || t.includes('fhd')) return '1080p';
        if (t.includes('720p')) return '720p';
        return 'SD';
    }
}

/**
 * ===========================================================================================
 * 🎬 METADATA ENGINE (Logica da addon.js)
 * Gestisce la conversione da ID IMDb/Stremio a Titolo + Stagione
 * ===========================================================================================
 */
class MetadataClient {
    constructor(tmdbKey) { this.tmdbKey = tmdbKey; }

    async getMetadata(type, id) {
        // Se non c'è chiave TMDB, proviamo a parsare ID se è semplice, altrimenti falliamo
        if (!this.tmdbKey) {
            console.log("⚠️ TMDB Key mancante. Uso ID grezzo.");
            return { title: id, year: null, season: null, episode: null };
        }

        let tmdbId = id;
        let season = null, episode = null;

        // Gestione ID composti: tt12345:1:5
        if (id.includes(':')) {
            const parts = id.split(':');
            tmdbId = parts[0];
            season = parseInt(parts[1]);
            episode = parseInt(parts[2]);
        }

        // Conversione IMDb -> TMDB
        if (tmdbId.startsWith('tt')) {
            try {
                const findUrl = `https://api.themoviedb.org/3/find/${tmdbId}?api_key=${this.tmdbKey}&external_source=imdb_id`;
                const res = await fetch(findUrl).then(r => r.json());
                const result = type === 'movie' ? res.movie_results?.[0] : res.tv_results?.[0];
                if (result) tmdbId = result.id;
            } catch (e) { console.error("Error converting ID", e); }
        }

        // Fetch dettagli completi
        const url = `https://api.themoviedb.org/3/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}?api_key=${this.tmdbKey}&language=it-IT`;
        try {
            const res = await fetch(url).then(r => r.json());
            const title = res.title || res.name;
            const year = (res.release_date || res.first_air_date)?.split('-')[0];
            return { title, year, season, episode, isSeries: type === 'series' };
        } catch (e) {
            return { title: id }; // Fallback
        }
    }
}

/**
 * ===========================================================================================
 * 🕷️ SCRAPING ENGINE (Logica da torrentmagnet.js)
 * ===========================================================================================
 */
class Scraper {
    static async fetchHtml(url) {
        try {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 4000); // Timeout aggressivo
            const res = await fetch(url, { 
                headers: { 'User-Agent': Utils.getRandomUserAgent() },
                signal: controller.signal 
            });
            return res.ok ? await res.text() : null;
        } catch (e) { return null; }
    }

    static async searchCorsaro(query) {
        // Logica specifica per Corsaro dal tuo file
        const url = `https://ilcorsaronero.link/search?q=${encodeURIComponent(query)}`;
        const html = await this.fetchHtml(url);
        if (!html) return [];
        const $ = cheerio.load(html);
        const rows = $('tbody tr').toArray().slice(0, 8); // Limitiamo per velocità

        const promises = rows.map(async (row) => {
            const linkEl = $(row).find('a.tab');
            const detailLink = linkEl.attr('href');
            const title = Utils.cleanText(linkEl.text());
            if (!detailLink) return null;

            // Fetch pagina dettaglio per il magnet
            const detailHtml = await this.fetchHtml(`https://ilcorsaronero.link${detailLink}`);
            if (!detailHtml) return null;
            const $$ = cheerio.load(detailHtml);
            const magnet = $$('a[href^="magnet:"]').attr('href') || $$("div.w-full:nth-child(2) a").attr('href');
            const size = $(row).find('td').eq(3).text();
            const seeders = parseInt($(row).find('.text-green-500').text()) || 0;

            return magnet ? { source: 'Corsaro', title, magnet, size, seeders } : null;
        });

        return (await Promise.all(promises)).filter(Boolean);
    }

    static async search1337x(title) {
        const url = `https://1337x.to/category-search/${encodeURIComponent(title)}/Movies/1/`; // Semplificato
        const html = await this.fetchHtml(url);
        if (!html) return [];
        const $ = cheerio.load(html);
        const candidates = [];
        
        $('table.table-list tbody tr').slice(0, 5).each((_, el) => {
            const link = $(el).find('a[href^="/torrent/"]');
            const name = link.text();
            if (ITA_REGEX.test(name)) {
                candidates.push({ 
                    href: link.attr('href'), 
                    title: Utils.cleanText(name),
                    seeders: parseInt($(el).find('.coll-2').text()) || 0,
                    size: $(el).find('.coll-4').text()
                });
            }
        });

        const promises = candidates.map(async c => {
            const dh = await this.fetchHtml(`https://1337x.to${c.href}`);
            if(!dh) return null;
            const magnet = cheerio.load(dh)('a[href^="magnet:"]').first().attr('href');
            return magnet ? { source: '1337x', ...c, magnet } : null;
        });

        return (await Promise.all(promises)).filter(Boolean);
    }

    static async searchKnaben(title) {
        const url = `https://knaben.org/search/${encodeURIComponent(title)}/0/1/seeders`;
        const html = await this.fetchHtml(url);
        if (!html) return [];
        const $ = cheerio.load(html);
        const res = [];
        $('table tbody tr').each((_, el) => {
            const name = $(el).find('td:nth-child(2) a').text();
            const magnet = $(el).find('a[href^="magnet:"]').attr('href');
            if (magnet && ITA_REGEX.test(name)) {
                res.push({
                    source: 'Knaben',
                    title: Utils.cleanText(name),
                    magnet,
                    size: $(el).find('td').eq(2).text(),
                    seeders: parseInt($(el).find('td').eq(4).text()) || 0
                });
            }
        });
        return res;
    }
}

/**
 * ===========================================================================================
 * ⚡ DEBRID HANDLER (Integrazione RD)
 * ===========================================================================================
 */
class RealDebrid {
    constructor(apiKey) { this.token = apiKey; }

    async resolve(magnet) {
        try {
            // 1. Aggiungi Magnet
            const addForm = new FormData();
            addForm.append('magnet', magnet);
            const addRes = await fetch('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.token}` },
                body: addForm
            }).then(r => r.json());

            if (!addRes.id) throw new Error("RD Add Failed");

            // 2. Seleziona tutti i file
            const infoRes = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${addRes.id}`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            }).then(r => r.json());
            
            const files = infoRes.files.map(f => f.id).join(',');
            await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${addRes.id}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.token}` },
                body: new URLSearchParams({ files })
            });

            // 3. Ottieni il link unrestrict (prendiamo il primo link generato)
            const activeRes = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${addRes.id}`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            }).then(r => r.json());

            if (activeRes.links && activeRes.links.length > 0) {
                const unrestrictForm = new FormData();
                unrestrictForm.append('link', activeRes.links[0]);
                const stream = await fetch('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${this.token}` },
                    body: unrestrictForm
                }).then(r => r.json());
                return stream.download;
            }
            return null;
        } catch (e) {
            console.error(e);
            return null;
        }
    }
}

/**
 * ===========================================================================================
 * 🚀 MAIN HANDLER (Entry Point Vercel)
 * ===========================================================================================
 */
export default async function handler(req, res) {
    // Setup Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Content-Type', 'application/json');

    const url = new URL(req.url, `https://${req.headers.host}`);
    const pathParts = url.pathname.split('/').filter(Boolean);
    
    // 1. Pagina di configurazione HTML (Route: /)
    if (url.pathname === '/' || url.pathname === '/index.html') {
        res.setHeader('Content-Type', 'text/html');
        return res.send(landingPageHTML); // HTML in fondo al file
    }

    // 2. Parsing Configurazione utente (base64)
    let config = {};
    const hasConfig = pathParts[0] && pathParts[0].length > 10; // check blando per stringa base64
    if (hasConfig) {
        try { config = JSON.parse(atob(pathParts[0])); } catch(e) {}
    }

    // 3. Manifest (Route: /manifest.json)
    if (url.pathname.endsWith('manifest.json')) {
        return res.send({
            id: 'org.community.corsaro-merged',
            version: '1.0.1',
            name: 'Corsaro + RD (Full Logic)',
            description: 'Il Corsaro Nero, 1337x, Knaben con risoluzione automatica titoli e RealDebrid.',
            resources: ['stream'],
            types: ['movie', 'series'],
            catalogs: []
        });
    }

    // 4. Stream Handler (Route: /stream/...)
    if (url.pathname.includes('/stream/')) {
        const type = pathParts[hasConfig ? 2 : 1];
        const id = decodeURIComponent(pathParts[hasConfig ? 3 : 2].replace('.json', ''));
        
        console.log(`🔎 Richiesta: ${type} - ${id}`);

        // A. Ottenere Metadati Reali
        const metaClient = new MetadataClient(config.tmdb_key);
        const meta = await metaClient.getMetadata(type, id);

        // B. Costruzione Query
        let queries = [];
        if (meta.isSeries && meta.season) {
            const s = meta.season.toString().padStart(2, '0');
            const e = meta.episode.toString().padStart(2, '0');
            // Logica addon.js: Prova "Nome S01E01" e "Nome Stagione 1"
            queries.push(`${meta.title} S${s}E${e}`);
            queries.push(`${meta.title} S${s}`);
            queries.push(`${meta.title} Stagione ${meta.season}`); // Corsaro style
        } else {
            queries.push(`${meta.title} ${meta.year || ''}`);
            queries.push(`${meta.title} ITA`);
        }

        // C. Esecuzione Scraping Parallelo
        // Usiamo solo la prima query per velocità, o facciamo Promise.all su più query se necessario
        const mainQuery = queries[0];
        console.log(`🎯 Searching for: ${mainQuery}`);

        const results = await Promise.all([
            Scraper.searchCorsaro(mainQuery),
            Scraper.search1337x(meta.title), // 1337x preferisce il titolo pulito
            Scraper.searchKnaben(mainQuery)
        ]);

        let streams = results.flat();

        // D. Deduplicazione e Ordinamento
        const unique = new Map();
        streams.forEach(s => {
            const hash = Utils.extractInfoHash(s.magnet);
            if(hash && !unique.has(hash)) {
                // Score System (simile a addon.js)
                let score = s.seeders;
                if(s.source === 'Corsaro') score += 500; // Priorità ITA
                if(s.title.match(ITA_REGEX)) score += 200;
                if(s.title.includes('2160p')) score += 50;
                s.score = score;
                unique.set(hash, s);
            }
        });

        let sortedStreams = Array.from(unique.values()).sort((a,b) => b.score - a.score);

        // E. Formattazione per Stremio
        const rdClient = config.rd_key ? new RealDebrid(config.rd_key) : null;

        const finalStreams = await Promise.all(sortedStreams.slice(0, 15).map(async (item) => {
            const quality = Utils.detectQuality(item.title);
            const isIta = item.source === 'Corsaro' || item.title.match(ITA_REGEX);
            const flag = isIta ? '🇮🇹' : '🇬🇧';
            
            let streamObj = {
                name: `${flag} ${item.source}\n${quality}`,
                title: `${item.title}\n💾 ${item.size} 👥 ${item.seeders}`,
                behaviorHints: { bingeGroup: `corsaro-${quality}` }
            };

            // Se c'è RD Key, proviamo a risolvere (Opzionale: rallenta la risposta)
            // Per Vercel, meglio ritornare il magnet se non vogliamo timeout, 
            // ma qui simuliamo la logica RD se richiesta.
            if (rdClient) {
                // NOTA: Risolvere tutti rallenta. In produzione si usa "resolve on click" (non supportato nativamente da Stremio senza addon proxy).
                // Qui ritorniamo il magnet, ma se volessi il link diretto dovresti scommentare:
                // const directLink = await rdClient.resolve(item.magnet);
                // if(directLink) streamObj.url = directLink; else streamObj.url = item.magnet;
                streamObj.url = item.magnet; // Default behavior
                streamObj.description = "RD Enabled (Serverless mode)";
            } else {
                streamObj.url = item.magnet;
            }

            return streamObj;
        }));

        return res.send({ streams: finalStreams });
    }

    return res.status(404).send({ error: 'Not found' });
}

// HTML UI per la configurazione
const landingPageHTML = `
<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Corsaro Serverless</title>
    <style>
        body { background: #0f0f13; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: #1a1a20; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); width: 90%; max-width: 400px; text-align: center; }
        h1 { background: -webkit-linear-gradient(#00d2ff, #3a7bd5); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 2rem; }
        input { width: 100%; padding: 12px; margin-bottom: 1rem; border-radius: 6px; border: 1px solid #333; background: #222; color: #fff; box-sizing: border-box; }
        button { width: 100%; padding: 12px; background: #00d2ff; color: #000; font-weight: bold; border: none; border-radius: 6px; cursor: pointer; transition: 0.2s; }
        button:hover { background: #3a7bd5; color: #fff; }
        .note { font-size: 0.8rem; color: #666; margin-top: 1rem; }
    </style>
</head>
<body>
    <div class="card">
        <h1>CORSARO</h1>
        <input type="text" id="tmdb" placeholder="TMDB API Key (Necessaria per le Serie)">
        <input type="text" id="rd" placeholder="Real-Debrid Key (Opzionale)">
        <button onclick="install()">INSTALLA</button>
        <p class="note">Inserisci la chiave TMDB per convertire correttamente "S01E01".</p>
    </div>
    <script>
        function install() {
            const tmdb = document.getElementById('tmdb').value;
            const rd = document.getElementById('rd').value;
            const config = { tmdb_key: tmdb, rd_key: rd };
            const b64 = btoa(JSON.stringify(config));
            const url = window.location.protocol + '//' + window.location.host + '/' + b64 + '/manifest.json';
            window.location.href = 'stremio://' + url.replace('https://', '').replace('http://', '');
        }
    </script>
</body>
</html>
`;
