import * as cheerio from 'cheerio';

/**
 * ===========================================================================================
 * CONFIGURAZIONE E COSTANTI
 * ===========================================================================================
 */
const CONFIG = {
    TIMEOUT_SOURCE: 4000, // Timeout per ogni sito
    PROVIDERS: {
        CORSARO: 'https://ilcorsaronero.link',
        KNABEN: 'https://knaben.org',
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
    "udp://opentracker.i2p.rocks:6969/announce"
];

const ITA_REGEX = /\b(ITA|ITALIAN|ITALIANO|MULTI|DUAL|MD|SUB[\s._-]?ITA|FORCED|AC3[\s._-]?ITA|CINEFILE|NOVARIP|MEM|ROBBYRS|IDN_CREW|PSO|BADASS)\b/i;

/**
 * ===========================================================================================
 * UTILITY HELPERS
 * ===========================================================================================
 */
class Utils {
    static getRandomUserAgent() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
    static cleanText(text) { return text ? text.replace(/[:"'’]/g, "").replace(/[^a-zA-Z0-9\s\-.\[\]]/g, " ").replace(/\s+/g, " ").trim() : ''; }
    static extractInfoHash(magnet) { const match = magnet?.match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i); return match ? match[1].toUpperCase() : null; }
    static detectQuality(title) {
        const t = title.toLowerCase();
        if (t.includes('2160p') || t.includes('4k') || t.includes('uhd')) return '4K';
        if (t.includes('1080p')) return '1080p';
        if (t.includes('720p')) return '720p';
        return 'SD';
    }
    static buildMagnet(infoHash, name) {
        const tr = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
        return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${tr}`;
    }
}

/**
 * ===========================================================================================
 * CLIENT HTTP
 * ===========================================================================================
 */
class HttpClient {
    static async get(url, json = false) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_SOURCE);
        try {
            const res = await fetch(url, { headers: { 'User-Agent': Utils.getRandomUserAgent() }, signal: controller.signal });
            if (!res.ok) throw new Error(`Status ${res.status}`);
            return json ? await res.json() : await res.text();
        } catch (e) { return null; } finally { clearTimeout(timeout); }
    }
}

/**
 * ===========================================================================================
 * SCRAPERS (Providers)
 * ===========================================================================================
 */
const Providers = {
    async corsaro(query, type) {
        let q = query;
        const cat = type === 'movie' ? 'film' : 'serie-tv';
        if (type === 'series') q = q.replace(/S(\d{1,2})E\d{1,2}/i, (m, s) => `Stagione ${parseInt(s)}`).split('Stagione')[0].trim();
        
        const html = await HttpClient.get(`${CONFIG.PROVIDERS.CORSARO}/search?q=${encodeURIComponent(q)}&cat=${cat}`);
        if (!html) return [];
        const $ = cheerio.load(html);
        const candidates = [];
        
        $('tbody tr').slice(0, 10).each((_, el) => {
            const link = $(el).find('a.tab');
            const href = link.attr('href');
            if (href) candidates.push({ title: Utils.cleanText(link.text()), href, size: $(el).find('td').eq(3).text(), seeds: parseInt($(el).find('.text-green-500').text()) || 0 });
        });

        const details = await Promise.all(candidates.map(async (c) => {
            const h = await HttpClient.get(`${CONFIG.PROVIDERS.CORSARO}${c.href}`);
            if (!h) return null;
            const $$ = cheerio.load(h);
            const m = $$('a[href^="magnet:"]').attr('href') || $$("div.w-full:nth-child(2) a").attr('href');
            return m ? { provider: 'Corsaro', title: c.title, magnet: m, size: c.size, seeds: c.seeds, infoHash: Utils.extractInfoHash(m) } : null;
        }));
        return details.filter(Boolean);
    },

    async x1337(title, year) {
        const q = year ? `${title} ${year}` : title;
        const html = await HttpClient.get(`${CONFIG.PROVIDERS.X1337}/category-search/${encodeURIComponent(q)}/${year?'Movies':'TV'}/1/`);
        if (!html) return [];
        const $ = cheerio.load(html);
        const candidates = [];
        $("table.table-list tbody tr").slice(0, 8).each((_, el) => {
            const name = Utils.cleanText($(el).find("a[href^='/torrent/']").text());
            if (ITA_REGEX.test(name)) candidates.push({ name, href: $(el).find("a[href^='/torrent/']").attr("href"), seeds: parseInt($(el).find(".coll-2").text()) || 0, size: $(el).find(".coll-4").text() });
        });

        const details = await Promise.all(candidates.map(async (c) => {
            const h = await HttpClient.get(`${CONFIG.PROVIDERS.X1337}${c.href}`);
            if (!h) return null;
            const $$ = cheerio.load(h);
            const m = $$("a[href^='magnet:']").first().attr("href");
            return m ? { provider: '1337x', title: c.name, magnet: m, size: c.size, seeds: c.seeds, infoHash: Utils.extractInfoHash(m) } : null;
        }));
        return details.filter(Boolean);
    },

    async apibay(title) {
        const data = await HttpClient.get(`${CONFIG.PROVIDERS.APIBAY}?q=${encodeURIComponent(title)}&cat=200`, true);
        if (!Array.isArray(data) || data[0]?.name === 'No results returned') return [];
        return data.filter(i => ITA_REGEX.test(i.name)).slice(0, 10).map(i => ({ provider: 'ApiBay', title: i.name, magnet: Utils.buildMagnet(i.info_hash, i.name), size: (parseInt(i.size)/1073741824).toFixed(2)+" GB", seeds: parseInt(i.seeders), infoHash: i.info_hash }));
    },

    async knaben(title) {
        const html = await HttpClient.get(`${CONFIG.PROVIDERS.KNABEN}/search/${encodeURIComponent(title)}/0/1/seeders`);
        if (!html) return [];
        const $ = cheerio.load(html);
        const res = [];
        $('table tbody tr').each((_, el) => {
            const t = Utils.cleanText($(el).find('td:nth-child(2) a').text());
            const m = $(el).find('a[href^="magnet:"]').attr('href');
            if (ITA_REGEX.test(t) && m) res.push({ provider: 'Knaben', title: t, magnet: m, size: $(el).find('td').eq(2).text(), seeds: parseInt($(el).find('td').eq(4).text())||0, infoHash: Utils.extractInfoHash(m) });
        });
        return res;
    }
};

/**
 * ===========================================================================================
 * LOGICA STREAMING
 * ===========================================================================================
 */
class StreamManager {
    constructor(config) { this.config = config; }
    
    async getStreams(query, type) {
        const yearMatch = query.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? yearMatch[0] : null;
        const cleanQuery = Utils.cleanText(query);
        
        const promises = [
            Providers.corsaro(cleanQuery, type),
            Providers.x1337(cleanQuery, year),
            Providers.apibay(cleanQuery),
            Providers.knaben(cleanQuery)
        ];

        let results = (await Promise.allSettled(promises)).filter(r => r.status === 'fulfilled').flatMap(r => r.value);

        // Filtro NO 4K (Se attivo)
        if (this.config.no_4k) {
            results = results.filter(i => Utils.detectQuality(i.title) !== '4K');
        }

        // Deduplicazione + Score
        const unique = new Map();
        results.forEach(i => {
            if (i.infoHash && !unique.has(i.infoHash)) {
                let score = 0;
                if (i.provider === 'Corsaro') score += 100;
                if (Utils.detectQuality(i.title) === '4K') score += 40;
                if (Utils.detectQuality(i.title) === '1080p') score += 30;
                score += Math.min(i.seeds, 50);
                i.score = score;
                unique.set(i.infoHash, i);
            }
        });

        return Array.from(unique.values()).sort((a, b) => b.score - a.score).map(i => {
            const q = Utils.detectQuality(i.title);
            const flag = (i.provider === 'Corsaro' || ITA_REGEX.test(i.title)) ? '🇮🇹' : '🇬🇧';
            return {
                name: `${flag} ${q} [${i.provider}]`,
                title: `${i.title}\n💾 ${i.size} | 👥 ${i.seeds}`,
                infoHash: i.infoHash,
                behaviorHints: { bingeGroup: `stremizio-${q}` }
            };
        });
    }
}

/**
 * ===========================================================================================
 * INTERFACCIA HTML (CYBERPUNK)
 * ===========================================================================================
 */
const HTML_PAGE = `
<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Stremio ITA - Configurazione</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
<style>
:root{--accent:#00f2ff;--accent-glow:rgba(0,242,255,0.4);--bg-dark:#050510;--glass:rgba(15,15,25,0.75);--border:rgba(255,255,255,0.08);--text:#ffffff;--text-muted:#8b9bb4}
*{box-sizing:border-box;margin:0;padding:0;outline:none}body{font-family:'Outfit',sans-serif;background-color:var(--bg-dark);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;overflow-x:hidden}
#bg-canvas{position:fixed;top:0;left:0;width:100%;height:100%;z-index:-1;background:radial-gradient(circle at center,#1a1a2e 0%,#000000 100%)}
.container{width:100%;max-width:500px;background:var(--glass);backdrop-filter:blur(20px);border:1px solid var(--border);border-top:1px solid rgba(255,255,255,0.2);border-radius:24px;padding:40px;box-shadow:0 0 40px rgba(0,0,0,0.6);animation:up .8s cubic-bezier(0.2,0.8,0.2,1)}
@keyframes up{from{opacity:0;transform:translateY(30px)scale(0.95)}to{opacity:1;transform:translateY(0)scale(1)}}
h1{font-size:2.5rem;font-weight:800;background:linear-gradient(135deg,#fff 0%,var(--accent) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-shadow:0 0 20px var(--accent-glow);margin-bottom:5px;text-align:center}
.subtitle{color:var(--text-muted);font-size:.9rem;text-align:center;margin-bottom:30px}
.input-group{margin-bottom:20px;position:relative}.input-field{width:100%;padding:16px 16px 16px 45px;background:rgba(0,0,0,0.4);border:1px solid var(--border);border-radius:12px;color:#fff;font-size:1rem;transition:.3s}.input-icon{position:absolute;left:16px;top:50%;transform:translateY(-50%);font-size:1.1rem;opacity:.6}
.input-field:focus{border-color:var(--accent);box-shadow:0 0 15px var(--accent-glow);background:rgba(0,0,0,0.6)}
.btn{width:100%;padding:18px;border-radius:14px;font-size:1.1rem;font-weight:700;cursor:pointer;border:none;text-transform:uppercase;margin-top:10px;background:var(--accent);color:#000;box-shadow:0 0 20px var(--accent-glow);transition:.3s}.btn:hover{transform:translateY(-2px);box-shadow:0 0 40px var(--accent-glow)}
.copy-btn{background:transparent;border:1px solid var(--border);color:var(--text-muted);margin-top:15px}.copy-btn:hover{border-color:#fff;color:#fff}
.options-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px}.option-card{background:rgba(255,255,255,0.03);padding:10px;border-radius:8px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;border:1px solid transparent}.option-card:hover{border-color:var(--accent)}
.switch{position:relative;display:inline-block;width:34px;height:20px}.switch input{opacity:0;width:0;height:0}.slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background-color:#333;transition:.4s;border-radius:34px}.slider:before{position:absolute;content:"";height:12px;width:12px;left:4px;bottom:4px;background-color:#fff;transition:.4s;border-radius:50%}input:checked+.slider{background-color:var(--accent)}input:checked+.slider:before{transform:translateX(14px)}
</style></head><body><canvas id="bg-canvas"></canvas><div class="container"><header><h1>CORSARO</h1><p class="subtitle">Multi-Source ITA Stream Engine</p></header>
<div class="input-group"><input type="text" id="rd_key" class="input-field" placeholder="Real-Debrid API Key (Opzionale)"><span class="input-icon">⚡</span></div>
<div class="input-group"><input type="text" id="tmdb_key" class="input-field" placeholder="TMDB API Key (Opzionale)"><span class="input-icon">🎬</span></div>
<div style="margin:15px 0;font-size:.8rem;color:var(--accent);text-transform:uppercase;font-weight:bold">Opzioni</div>
<div class="options-grid"><div class="option-card" onclick="document.getElementById('no4k').click()"><span class="option-label">No 4K</span><label class="switch"><input type="checkbox" id="no4k"><span class="slider"></span></label></div></div>
<button class="btn" onclick="install()">INSTALLA SU STREMIO</button><button class="btn copy-btn" onclick="copy()">COPIA LINK</button></div>
<script>
const canvas=document.getElementById('bg-canvas'),ctx=canvas.getContext('2d');let w,h,p=[];const resize=()=>{w=canvas.width=window.innerWidth;h=canvas.height=window.innerHeight};window.addEventListener('resize',resize);resize();for(let i=0;i<60;i++)p.push({x:Math.random()*w,y:Math.random()*h,vx:(Math.random()-.5),vy:(Math.random()-.5)});function anim(){ctx.clearRect(0,0,w,h);ctx.fillStyle='rgba(0, 242, 255, 0.4)';p.forEach(e=>{e.x+=e.vx;e.y+=e.vy;if(e.x<0||e.x>w)e.vx*=-1;if(e.y<0||e.y>h)e.vy*=-1;ctx.beginPath();ctx.arc(e.x,e.y,1.5,0,Math.PI*2);ctx.fill()});requestAnimationFrame(anim)}anim();
function cfg(){return{rd_key:document.getElementById('rd_key').value.trim(),tmdb_key:document.getElementById('tmdb_key').value.trim(),no_4k:document.getElementById('no4k').checked}}
function url(){return 'stremio://'+window.location.host+'/'+btoa(JSON.stringify(cfg()))+'/manifest.json'}
function install(){window.location.href=url()}
function copy(){const u=url().replace('stremio://','https://');navigator.clipboard.writeText(u).then(()=>alert('Copiato!'))}
</script></body></html>
`;

/**
 * ===========================================================================================
 * HANDLER VERCEL
 * ===========================================================================================
 */
export default async function handler(req, res) {
    const url = new URL(req.url, `https://${req.headers.host}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Content-Type', 'application/json');

    try {
        if (url.pathname === '/') {
            res.setHeader('Content-Type', 'text/html');
            return res.send(HTML_PAGE);
        }

        const pathParts = url.pathname.split('/').filter(Boolean);
        const hasConfig = pathParts[0] && pathParts[0].length > 10;
        let config = { no_4k: false };
        if (hasConfig) { try { config = JSON.parse(atob(pathParts[0])); } catch(e){} }

        if (url.pathname.endsWith('manifest.json')) {
            return res.send({
                id: 'org.stremio.ita.corsaro',
                version: '3.0.0',
                name: 'CORSARO (ITA)',
                description: 'Il Corsaro Nero, 1337x, Knaben, APIBay.',
                resources: ['stream'],
                types: ['movie', 'series'],
                catalogs: []
            });
        }

        if (url.pathname.includes('/stream/')) {
            const type = pathParts[hasConfig ? 2 : 1];
            const id = decodeURIComponent(pathParts[hasConfig ? 3 : 2].replace('.json', ''));
            let query = id;

            // Se l'utente ha messo la Key TMDB, convertiamo tt12345 in Titolo
            if (config.tmdb_key && (id.startsWith('tt') || id.startsWith('kitsu'))) {
                try {
                    const findUrl = `https://api.themoviedb.org/3/find/${id.split(':')[0]}?api_key=${config.tmdb_key}&external_source=imdb_id`;
                    const tmdbRes = await fetch(findUrl).then(r => r.json());
                    const media = tmdbRes.movie_results?.[0] || tmdbRes.tv_results?.[0];
                    if (media) query = media.title || media.name;
                } catch(e) {}
            }
            
            // Fix per serie (tt123:1:1) -> Passiamo ID grezzo se non abbiamo TMDB, sperando nel fallback
            if (type === 'series' && id.includes(':')) {
                // Se non abbiamo convertito tramite TMDB, estraiamo almeno S e E
                if (query === id) { 
                    // Non possiamo fare molto senza titolo, ma proviamo
                } else {
                    // Abbiamo il titolo da TMDB, aggiungiamo SxxExx
                    const p = id.split(':');
                    query += ` S${p[1].padStart(2,'0')}E${p[2].padStart(2,'0')}`;
                }
            }

            const manager = new StreamManager(config);
            const streams = await manager.getStreams(query, type);
            return res.send({ streams });
        }

    } catch (e) {
        return res.status(500).send({ streams: [] });
    }
}
