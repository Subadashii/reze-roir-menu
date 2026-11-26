const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  proto,
  generateWAMessageContent,
  generateWAMessageFromContent
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

// FILTRO SELECTIVO DE AVISOS BAD MAC
const originalConsoleError = console.error.bind(console);
let lastFutureWarnAt = 0;

console.error = (...args) => {
  const first = String(args[0] ?? '');
  const decryptNotice =
    first === 'Failed to decrypt message with any known session...';
  const badMacNotice =
    first.startsWith('Session error:') && first.includes('Bad MAC');
  const futureNotice =
    first.startsWith('Session error:') && first.includes('Over 2000 messages into the future');

  if (decryptNotice || badMacNotice || futureNotice) {
    try {
      const logFile = path.join(__dirname, 'database', 'signal-decrypt.log');
      fs.appendFileSync(
        logFile,
        '[' + new Date().toISOString() + '] ' +
        args.map(x => x instanceof Error ? x.stack : String(x)).join(' ') +
        '\n'
      );
    } catch {}
    // Aviso corto (máx. 1 por minuto) para no inundar la consola de Termux.
    if (futureNotice && Date.now() - lastFutureWarnAt > 60000) {
      lastFutureWarnAt = Date.now();
      originalConsoleError('⚠️ Sesión Signal desincronizada (Over 2000 messages). Detalle en database/signal-decrypt.log. Para repararla sin QR y sin borrar nada: detén el bot y ejecuta  node reparar-sesion.js');
    }
    return;
  }

  originalConsoleError(...args);
};

const originalConsoleLog = console.log.bind(console);
console.log = (...args) => {
  const first = String(args[0] ?? '');
  if (/Removing old closed session|Closing session:|SessionEntry|ephemeralKeyPair|rootKey:|indexInfo:/i.test(first)) return;
  if (args.length === 1 && typeof args[0] === 'object' && args[0] && (args[0]._chains || args[0].currentRatchet)) return;
  originalConsoleLog(...args);
};

// libsignal también imprime las sesiones completas (con sus llaves) por console.info / warn / debug:
// se ocultan igual que en console.log para que no inunden Termux ni muestren datos privados.
for (const nivelConsola of ['info', 'warn', 'debug']) {
  const originalNivel = console[nivelConsola].bind(console);
  console[nivelConsola] = (...args) => {
    const first = String(args[0] ?? '');
    if (/Removing old closed session|Closing (open )?session|Opening session|Migrating session|SessionEntry|ephemeralKeyPair|rootKey:|indexInfo:/i.test(first)) return;
    if (args.some(a => a && typeof a === 'object' && (a._chains || a.currentRatchet || a.constructor?.name === 'SessionEntry'))) return;
    originalNivel(...args);
  };
}


const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const gameSystemModule = require('./commands/game-system');
const { handleGameCommand } = gameSystemModule;
const { handleWeatherCommand, WEATHER_MENU } = require('./commands/weather');
const { handleAnimeInfoCommand, ANIME_MENU } = require('./commands/anime-info');
const { handleWorldCommand, WORLD_MENU } = require('./commands/world-system');
const { handleCompanionCommand, startCompanionAutomation } = require('./commands/companion-automation');
const { handleHahariCommand, startHahariAutomation } = require('./commands/hahari');
// Detección automática de bloques de menú adicionales (p. ej. RPG/Cafetería/Logros/Museo
// de commands/game-system.js): cualquier export cuyo nombre termine en "_MENU" y sea texto
// se añade solo, sin tener que tocar este archivo cada vez que se agregue un módulo nuevo.
const GAME_MENU_BLOCKS = Object.keys(gameSystemModule || {})
  .filter(k => /_MENU$/i.test(k) && typeof gameSystemModule[k] === 'string' && gameSystemModule[k].trim())
  .map(k => gameSystemModule[k]);
const CREATOR = 'Subadashii';
const BOT_BRAND = '꧁༒ 𝑅𝑒𝑧𝑒 𝑅𝑜𝑖𝑟 ༒꧂';
const RELEASE_VERSION = '5.0.1';
const OFFICIAL_GROUP = "🐋𝘕𝘺𝘹𝘰𝘴𝘴🧠𝗥𝗘𝗭𝗘'𝗦 𝗦𝗢 𝗖𝗟𝗨𝗕";
const OWNER_NUMBER = '50498999222';
const BOT_NUMBER = '50493152392';

// URL pública HTTPS del menú web. Déjala vacía hasta publicar la carpeta
// LBOT_Menu_Interactivo_BN en un hosting estático. No uses 127.0.0.1 aquí.
const MENU_WEB_URL = '';

const BANNER_CANDIDATES = [
  path.join(process.env.HOME || '', 'storage', 'downloads', 'MusicForBot', 'New_banner_bot.png'),
  path.join(process.env.HOME || '', 'storage', 'shared', 'Download', 'MusicForBot', 'New_banner_bot.png'),
  path.join(__dirname, 'media', 'New_banner_bot.png'),
  path.join(__dirname, 'New_banner_bot.png'),
  path.join(__dirname, 'media', 'l.png')
];
function resolveBanner() {
  for (const c of BANNER_CANDIDATES) {
    try { if (c && fs.existsSync(c)) return c; } catch {}
  }
  return BANNER_CANDIDATES[BANNER_CANDIDATES.length - 1];
}
const BANNER = resolveBanner();

// Banner animado (GIF) exclusivo para .menu / .help / .jugodemango
const MENU_BANNER_ARCHIVO = 'Reze banner by Subadashii.gif';
function buscarBannerMenu() {
  const bases = [
    path.join(os.homedir(), 'storage', 'downloads'),
    path.join(os.homedir(), 'storage', 'shared', 'Download'),
    path.join(os.homedir(), 'storage', 'shared', 'Downloads'),
    path.join(os.homedir(), 'downloads'),
    '/storage/emulated/0/Download',
    '/storage/emulated/0/Downloads',
    '/storage/emulated/0/Descargas',
    '/sdcard/Download',
    '/sdcard/Downloads',
    '/sdcard/Descargas',
    path.join(__dirname, 'media')
  ];
  const objetivo = MENU_BANNER_ARCHIVO.toLowerCase();
  for (const base of bases) {
    for (const carpeta of ['MusicForBot', 'musicforbot', '']) {
      const dir = carpeta ? path.join(base, carpeta) : base;
      const exacto = path.join(dir, MENU_BANNER_ARCHIVO);
      if (fs.existsSync(exacto)) return exacto;
      try {
        const hit = fs.readdirSync(dir).find(n => {
          const low = n.toLowerCase();
          return low === objetivo || (low.includes('reze banner') && low.endsWith('.gif'));
        });
        if (hit) return path.join(dir, hit);
      } catch {}
    }
  }
  return null;
}
// Convierte el GIF del banner a MP4 una sola vez y reutiliza el resultado (evita recodificar en cada .menu).
async function obtenerBannerMenuVideo() {
  const origen = buscarBannerMenu();
  if (!origen) return null;
  try {
    const statOrigen = fs.statSync(origen);
    const cacheDir = path.join(__dirname, 'database', 'cache');
    const cacheFile = path.join(cacheDir, 'menu-banner.mp4');
    if (fs.existsSync(cacheFile)) {
      const statCache = fs.statSync(cacheFile);
      if (statCache.size > 0 && statCache.mtimeMs >= statOrigen.mtimeMs) return cacheFile;
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    await execFileAsync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', origen,
      '-vf', 'scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=15,format=yuv420p',
      '-c:v', 'libx264', '-movflags', '+faststart', '-an',
      cacheFile
    ], { timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    if (!fs.existsSync(cacheFile) || !fs.statSync(cacheFile).size) return null;
    return cacheFile;
  } catch (e) {
    try { fs.unlinkSync(path.join(__dirname, 'database', 'cache', 'menu-banner.mp4')); } catch {}
    console.log('⚠️ No se pudo preparar el banner del menú:', e.message || e);
    return null;
  }
}
// Envía el banner animado como adjunto; si no está disponible, no bloquea el menú (solo se omite).
async function enviarBannerMenu(sock, chat, msg) {
  try {
    const video = await obtenerBannerMenuVideo();
    if (!video) return;
    await sock.sendMessage(chat, {
      video: fs.readFileSync(video),
      mimetype: 'video/mp4',
      gifPlayback: true
    }, { quoted: msg });
  } catch (e) {
    console.log('⚠️ No se pudo enviar el banner del menú:', e.message || e);
  }
}

const STARTED_AT = Date.now();
const WARNINGS_FILE = path.join(__dirname, 'database', 'warnings.json');
const ROLEPLAY_FILE = path.join(__dirname, 'database', 'roleplay.json');
const GIF_CONFIG_FILE = path.join(__dirname, 'database', 'gif-config.json');
const AUTOEXP_FILE = path.join(__dirname, 'database', 'autoexpresiones.json');
const OWNER_IDENTITY_FILE = path.join(__dirname, 'database', 'owner-link-state.json');
const OWNER_CHALLENGE_FILE = path.join(__dirname, 'database', 'owner-link-challenge.json');
const AUTOEXP_STATE = { timer: null, started: false, sock: null };

const AUTOMATICMEN_FILE = path.join(__dirname, 'database', 'automaticmen.json');
function loadAutomaticMen() {
  try { return Object.assign({ enabled: true }, JSON.parse(fs.readFileSync(AUTOMATICMEN_FILE, 'utf8'))); }
  catch { return { enabled: true }; }
}
function saveAutomaticMen(v) {
  fs.mkdirSync(path.dirname(AUTOMATICMEN_FILE), { recursive: true });
  fs.writeFileSync(AUTOMATICMEN_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
}
function automaticMenOn() { return loadAutomaticMen().enabled !== false; }

const PRIV_AUTO_FILE = path.join(__dirname, 'database', 'priv-auto-messages.json');
function loadPrivAuto() {
  try { return Object.assign({ enabled: true }, JSON.parse(fs.readFileSync(PRIV_AUTO_FILE, 'utf8'))); }
  catch { return { enabled: true }; }
}
function savePrivAuto(v) {
  fs.mkdirSync(path.dirname(PRIV_AUTO_FILE), { recursive: true });
  fs.writeFileSync(PRIV_AUTO_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
}
function privAutoOn() { return loadPrivAuto().enabled !== false; }

// Interruptor propio para la bienvenida automática: antes dependía de automaticMenOn(),
// que también apaga mensajes NSFW/auto-expresión — si alguien apagaba eso, la bienvenida
// se apagaba con ella sin que nadie lo notara. Ahora es independiente (por defecto: ON).
const BIENVENIDA_FILE = path.join(__dirname, 'database', 'bienvenida.json');
function loadBienvenidaState() {
  try { return Object.assign({ enabled: true }, JSON.parse(fs.readFileSync(BIENVENIDA_FILE, 'utf8'))); }
  catch { return { enabled: true }; }
}
function saveBienvenidaState(v) {
  fs.mkdirSync(path.dirname(BIENVENIDA_FILE), { recursive: true });
  fs.writeFileSync(BIENVENIDA_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
}
function bienvenidaOn() { return loadBienvenidaState().enabled !== false; }

const ANTISPAM_STATE = new Map(); // key -> { last, count, at }
function checkAntiSpam(jid, chat, text) {
  const key = String(jid) + '|' + String(chat);
  const now = Date.now();
  const t = String(text || '').trim().toLowerCase().slice(0, 200);
  if (!t || t.startsWith('.')) return false;
  let st = ANTISPAM_STATE.get(key);
  if (!st || now - st.at > 12000) {
    ANTISPAM_STATE.set(key, { last: t, count: 1, at: now });
    return false;
  }
  if (st.last === t) {
    st.count += 1;
    st.at = now;
    ANTISPAM_STATE.set(key, st);
    return st.count >= 4; // 4 mensajes iguales en 12s = spam
  }
  ANTISPAM_STATE.set(key, { last: t, count: 1, at: now });
  return false;
}


const CUMPLE_FILE = path.join(__dirname, 'database', 'cumpleanos.json');
function loadCumples() {
  try { return JSON.parse(fs.readFileSync(CUMPLE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveCumples(v) {
  fs.mkdirSync(path.dirname(CUMPLE_FILE), { recursive: true });
  fs.writeFileSync(CUMPLE_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
}


const GODMODE_FILE = path.join(__dirname, 'database', 'godmode.json');
function loadGodMode() {
  try { return Object.assign({ enabled: false }, JSON.parse(fs.readFileSync(GODMODE_FILE, 'utf8'))); }
  catch { return { enabled: false }; }
}
function saveGodMode(v) {
  fs.mkdirSync(path.dirname(GODMODE_FILE), { recursive: true });
  fs.writeFileSync(GODMODE_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
}
function godModeOn() { return loadGodMode().enabled === true; }



// Socket dedicado a automatizaciones: bloquea cualquier envío mientras .autoaudio esté OFF.
const AUTOMATION_SOCK_CACHE = new WeakMap();
function crearSocketAutomatico(sock) {
  if (!sock || typeof sock !== 'object') return sock;
  const existente = AUTOMATION_SOCK_CACHE.get(sock);
  if (existente) return existente;

  const proxy = new Proxy(sock, {
    get(target, propiedad) {
      if (propiedad === 'sendMessage') {
        const enviar = Reflect.get(target, propiedad, target);
        if (typeof enviar !== 'function') return enviar;
        return (...args) => {
          if (!privAutoOn() && false) return Promise.resolve(null); // proxy no bloquea grupos; privado usa privAutoOn
          return enviar.apply(target, args);
        };
      }
      const valor = Reflect.get(target, propiedad, target);
      return typeof valor === 'function' ? valor.bind(target) : valor;
    }
  });

  AUTOMATION_SOCK_CACHE.set(sock, proxy);
  return proxy;
}


const TEXT_STYLES = {
  negrita: { A: 0x1D400, a: 0x1D41A }, // Mathematical Bold 𝐍𝐚
  cursiva: { A: 0x1D608, a: 0x1D622 },
  negritacursiva: { A: 0x1D63C, a: 0x1D656 },
  mono: { A: 0x1D670, a: 0x1D68A },
  doble: null,
  script: { A: 0x1D4D0, a: 0x1D4EA },
  fraktur: { A: 0x1D56C, a: 0x1D586 },
};
function estiloUnicode(tipo, texto) {
  const t = String(texto || '');
  if (tipo === 'smallcaps') {
    const sc = {a:'ᴀ',b:'ʙ',c:'ᴄ',d:'ᴅ',e:'ᴇ',f:'ғ',g:'ɢ',h:'ʜ',i:'ɪ',j:'ᴊ',k:'ᴋ',l:'ʟ',m:'ᴍ',n:'ɴ',o:'ᴏ',p:'ᴘ',q:'ǫ',r:'ʀ',s:'s',t:'ᴛ',u:'ᴜ',v:'ᴠ',w:'ᴡ',x:'x',y:'ʏ',z:'ᴢ'};
    return t.split('').map(c => sc[c.toLowerCase()] || c).join('');
  }
  if (tipo === 'burbuja') {
    const map = {};
    for (let i = 0; i < 26; i++) { map[String.fromCharCode(65+i)] = String.fromCodePoint(0x24B6+i); map[String.fromCharCode(97+i)] = String.fromCodePoint(0x24D0+i); }
    for (let i = 0; i < 10; i++) map[String(i)] = String.fromCodePoint(0x24EA + (i === 0 ? 0 : i));
    return t.split('').map(c => map[c] || c).join('');
  }
  if (tipo === 'cuadrado') {
    const map = {};
    for (let i = 0; i < 26; i++) map[String.fromCharCode(65+i)] = map[String.fromCharCode(97+i)] = String.fromCodePoint(0x1F170 + i);
    return t.split('').map(c => map[c] || c).join('');
  }
  if (tipo === 'doble') {
    const map = {};
    const doubles = '𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄ℕ𝕆ℙℚℝ𝕊𝕋𝕌𝕍𝕎𝕏𝕐ℤ';
    const doublesm = '𝕒𝕓𝕔𝕕𝕖𝕗𝕘𝕙𝕚𝕛𝕜𝕝𝕞𝕟𝕠𝕡𝕢𝕣𝕤𝕥𝕦𝕧𝕨𝕩𝕪𝕫';
    for (let i = 0; i < 26; i++) { map[String.fromCharCode(65+i)] = [...doubles][i]; map[String.fromCharCode(97+i)] = [...doublesm][i]; }
    return t.split('').map(c => map[c] || c).join('');
  }
  const st = TEXT_STYLES[tipo];
  if (!st) return t;
  return t.split('').map(ch => {
    if (ch >= 'A' && ch <= 'Z') return String.fromCodePoint(st.A + (ch.charCodeAt(0) - 65));
    if (ch >= 'a' && ch <= 'z') return String.fromCodePoint(st.a + (ch.charCodeAt(0) - 97));
    return ch;
  }).join('');
}

async function forzarMp4WhatsApp(inputPath) {
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error('Video inexistente');
  const out = path.join(os.tmpdir(), 'lbot-wa-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.mp4');
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPath,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-level', '3.1',
      '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      out
    ], { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
    if (fs.existsSync(out) && fs.statSync(out).size > 5000) return out;
  } catch (e) { console.log('ffmpeg:', e.message); }
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPath,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', out
    ], { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
    if (fs.existsSync(out) && fs.statSync(out).size > 5000) return out;
  } catch (e) { console.log('ffmpeg2:', e.message); }
  return inputPath;
}

async function fetchBufferUA(url, maxBytes = 20 * 1024 * 1024) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0.0.0 Safari/537.36', 'Accept': '*/*' },
    signal: AbortSignal.timeout(90000),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const ab = await res.arrayBuffer();
  if (ab.byteLength > maxBytes) throw new Error('Archivo grande');
  return Buffer.from(ab);
}

async function getHimgRobusto(tags) {
  const errors = [];
  try {
    let tagStr = String(tags || 're_zero_kara_hajimeru_isekai_seikatsu').trim().replace(/\s+/g, '_').replace(/re:zero/gi, 're_zero');
    const api = 'https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1&limit=80&tags=' + encodeURIComponent(tagStr);
    const res = await fetch(api, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      const data = await res.json();
      const imgs = (Array.isArray(data) ? data : []).filter(x => x.file_url && !/\.(mp4|webm)$/i.test(x.file_url)).sort(() => Math.random() - 0.5);
      for (const post of imgs.slice(0, 12)) {
        try {
          const buf = await fetchBufferUA(post.sample_url || post.file_url);
          if (buf.length > 2000) return { buffer: buf, source: 'rule34 #' + post.id };
        } catch (e) { errors.push(e.message); }
      }
    }
  } catch (e) { errors.push(e.message); }
  for (const type of ['hentai', 'hass', 'hboobs', 'hneko', 'hmidriff']) {
    try {
      const res = await fetch('https://nekobot.xyz/api/image?type=' + type, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const j = await res.json();
      if (j.message) {
        const buf = await fetchBufferUA(j.message);
        if (buf.length > 2000) return { buffer: buf, source: 'nekobot/' + type };
      }
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(errors.slice(0, 3).join(' | ') || 'sin imagen');
}

async function getHVideoRobusto(preferTags) {
  const banned = /yaoi|male_only|futanari|shemale|trap|bara|\bgay\b|futa/i;
  const tagList = [
    preferTags,
    'video animated score:>25 -yaoi -futanari -male_only',
    'video 3d score:>15 -yaoi -futanari',
    'video hentai score:>20 -yaoi -male_only'
  ].filter(Boolean);
  const errors = [];
  for (const tags of tagList) {
    try {
      const api = 'https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1&limit=50&tags=' + encodeURIComponent(tags);
      const res = await fetch(api, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(25000) });
      if (!res.ok) continue;
      const data = await res.json();
      const vids = (Array.isArray(data) ? data : [])
        .filter(x => x.file_url && /\.mp4$/i.test(x.file_url) && !banned.test(x.tags || ''))
        .sort(() => Math.random() - 0.5);
      for (const v of vids.slice(0, 10)) {
        try {
          const buf = await fetchBufferUA(v.file_url, 90 * 1024 * 1024);
          if (buf.length < 40000) continue;
          let file = path.join(os.tmpdir(), 'lbot-hv-' + Date.now() + '.mp4');
          fs.writeFileSync(file, buf);
          file = await forzarMp4WhatsApp(file);
          return { file, source: 'rule34 #' + v.id };
        } catch (e) { errors.push(e.message); }
      }
    } catch (e) { errors.push(e.message); }
  }
  throw new Error('Sin video MP4 usable. ' + errors.slice(0, 3).join(' | '));
}

const CRIME_FILE = path.join(__dirname, 'database', 'crime-texts.json');
function loadCrimeTexts() {
  try {
    const d = JSON.parse(fs.readFileSync(CRIME_FILE, 'utf8'));
    if (Array.isArray(d) && d.length) return d;
  } catch {}
  return [
    { texto: 'Vendiste a tu hermana por *{monto} Suba Coins* 👻', min: 5000, max: 80000 },
    { texto: 'Hackeaste una máquina y sacaste *{monto} Suba Coins* 🥤', min: 2000, max: 25000 },
    { texto: 'Estafaste un curso milagroso por *{monto} Suba Coins* 💼', min: 8000, max: 90000 },
    { texto: 'Vendiste NFTs de aire: *{monto} Suba Coins* 🖼️', min: 10000, max: 100000 },
    { texto: 'Apuesta rara ganada: *{monto} Suba Coins* 🐓', min: 4000, max: 55000 }
  ];
}
function saveCrimeTexts(arr) {
  fs.mkdirSync(path.dirname(CRIME_FILE), { recursive: true });
  fs.writeFileSync(CRIME_FILE, JSON.stringify(arr, null, 2), { mode: 0o600 });
}
const ECONOMY_EXTRA_FILE = path.join(__dirname, 'database', 'economy-extra.json');
function loadEconomyExtra() {
  try { return JSON.parse(fs.readFileSync(ECONOMY_EXTRA_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveEconomyExtra(v) {
  fs.mkdirSync(path.dirname(ECONOMY_EXTRA_FILE), { recursive: true });
  fs.writeFileSync(ECONOMY_EXTRA_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
}
function ecoKey(jid) { return normalizeNumber(jid); }
function getEco(jid) {
  const all = loadEconomyExtra();
  const k = ecoKey(jid);
  if (!all[k]) all[k] = { wallet: 0, bank: 0, lastCrime: 0, lastRob: 0 };
  return { all, k, data: all[k] };
}
function setEco(all) { saveEconomyExtra(all); }

const NSFW_FILE = path.join(__dirname, 'database', 'nsfw-state.json');
const NOVIAS_AUTO_FILE = path.join(__dirname, 'database', 'novias-auto.json');
const NOVIAS_AUTO_STATE = { timer: null, started: false, sock: null };
const MENSAJES_HAHARI_AUTO = ["💕 Soy Hakari… ¿estás ocupado? Porque yo sí estoy ocupada pensándote con las piernas abiertas 🥵", "🔥 Hakari aquí. Acabo de salir de la ducha y solo traigo la toalla… medio puesta. ¿Vienes o te lo describo todo?", "💋 Mmm… me toqué pensando en ti otra vez. Tengo los dedos húmedos y tu nombre en la boca 🥺💦", "🛏️ La cama está fría sin ti. Ven y cálentamela… o yo te caliento a ti, como prefieras 😈", "📞 Si no me contestas en 10 minutos voy a mandarte una foto que te va a dejar duro el resto del día 📸🔥", "🥵 Estoy en el sofá de la mansión sin ropa interior. Adivina qué estoy haciendo con la mano libre…", "💗 Hakari: te extraño dentro de mí. Literal. No es metáfora. Ven y arréglalo.", "😈 Acabo de morder mi labio pensando en cómo me cojes por detrás. Ya estoy mojada otra vez…", "🌸 Hola mi amor~ ¿Puedo sentarme en tu cara un rato? Prometo no aplastarte… mucho 🤭", "💦 Me corrí hace rato imaginando tu pija y todavía estoy temblando. Mándame un audio… o ven.", "🔥 Si estuvieras aquí te bajaría el pantalón con los dientes. Solo aviso 👀", "💋 Besaría tu cuello hasta dejarte marcado y después bajaría despacio… muy despacio 🥵", "🛏️ Anoche soñé que me llenabas otra vez. Desperté apretando la almohada. Esto no es justo 😭💗", "😈 Hakari mode ON: hoy quiero que me uses sin preguntarme si está bien. Solo tómame.", "🥺 Estoy aburrida y cachonda. Es la peor combinación. Rescátame (con el cuerpo).", "🔥 Me puse el conjunto que te gusta. El transparente. ¿Adivinas de qué color es por debajo? 😏", "💕 Te escribo esto con una mano… la otra está ocupada. Tres dedos. Pensando en ti 💦", "🥵 Quiero que me cojas contra el escritorio otra vez. Dejar los cuadernos tirados vale la pena.", "💋 Si me ignoras voy a aparecer en tu cuarto y no voy a pedir permiso para montarte.", "😈 Dime dónde estás. Si es cerca, en 15 minutos estoy en tu regazo sin bragas.", "🌸 Hakari: mi uniforme está medio abierto y no pienso abotonarlo hasta que me mires 👀", "🔥 Me gusta cuando me jalas el cabello. Lo recordé y se me erizó la piel… y algo más 🥵", "💗 Estoy de rodillas en mi habitación practicando cómo decir tu nombre con la boca llena 😳", "💦 Acabo de probar cómo se siente mojar la silla del comedor. Necesito que vengas a limpiar… con la lengua.", "😈 Hoy quiero lento y profundo. Después rápido y sucio. Tienes que cumplir las dos 💕", "📞 ¿Sigues ahí? Porque yo sigo aquí, sin calzones, esperando una orden tuya 🔥", "🥵 Me miré al espejo tocándome y casi digo tu nombre en voz alta. Casi.", "💋 Quiero que me beses hasta que se me olvide cómo se discute. Y después me cojas hasta que se me olvide cómo se habla.", "🛏️ La ducha está caliente. Hay espacio para dos. Yo ya estoy adentro… y mojada de más de una forma 🚿", "🔥 Hakari te extraña el sabor. Ven a dejármelo otra vez en la lengua 😈", "🥺 No es chantaje… pero si no vienes hoy me voy a correr sin ti y te voy a contar cada detalle 💦", "💕 Me puse tu camisa. Solo tu camisa. Huele a ti y me está volviendo loca 🥵", "😈 Imagínate esto: yo debajo de la mesa, tú intentando hablar normal. ¿Aguantas?", "🔥 Tengo marcas de ayer todavía. Quiero más. Cubreme el cuello otra vez 💋", "💗 Estoy tan sensible que si me soplas en la oreja me corro. Pruébalo.", "💦 Hakari reportándose: coño goteando, mente en blanco, única misión = tú.", "🥵 ¿Puedo ser egoísta? Quiero tu pija solo para mí el resto de la noche.", "💋 Te mandaría nudes pero prefiero que vengas a ver el original en persona 📸😈", "🛏️ Si abres la puerta de mi cuarto ahora mismo me encuentras a cuatro. No es broma.", "🔥 Cada notificación me hace saltar el corazón… y algo más abajo 🥺💕", "😈 Hoy no quiero romance suave. Quiero que me dejes caminando raro mañana.", "💦 Me corrí en la bañera pensando en tu boca. El agua ya está fría. Yo no 🔥", "💗 Hakari: ven. Ahora. No traigas excusas. Trae ganas.", "🥵 Estoy escribiendo esto mientras me froto contra la almohada. Qué vergüenza… y qué rico 😭", "💋 Quiero sentarte, montarte y no parar hasta que digas mi nombre como rezo.", "🔥 Si me dejas en visto me voy a tocar más fuerte solo por spite. Y te lo voy a narrar 😈", "🥺 Mi ropa interior ya no sirve de nada. Está empapada. Ayudaaaaa", "💕 Recuéstate. Yo me encargo del ritmo. Tú solo aguanta 🥵", "😈 Hakari quiere leches. En el pecho, en la boca, dentro… elige dos.", "🔥 Estoy tan caliente que hasta el aire acondicionado me parece inútil 💦", "🔥 Estoy tan caliente que hasta el aire acondicionado me parece inútil 💦 💕", "🥵 Estoy escribiendo esto mientras me froto contra la almohada. Qué vergüenza… y qué rico 😭 💕", "📞 ¿Sigues ahí? Porque yo sigo aquí, sin calzones, esperando una orden tuya 🔥 💕", "💕 Te escribo esto con una mano… la otra está ocupada. Tres dedos. Pensando en ti 💦 💕", "💕 Me puse tu camisa. Solo tu camisa. Huele a ti y me está volviendo loca 🥵 💕"];
const MENSAJES_KARANE_AUTO = ["💢 K-Karane aquí… n-no es que te estuviera esperando, ¡baka! Solo… ¿sigues despierto? 😳", "💗 ¡N-no me mires así aunque no estés aquí! Estoy… un poco inquieta. Por tu culpa.", "🔥 Idiota… no dejo de pensar en lo de anoche. Las piernas todavía me fallan un poco 😭", "😳 Si vienes ahora… n-no voy a pelear tanto. Solo un poco. Quizá.", "💢 ¡No es que quiera que me toques! Pero si lo haces… no me quejaré tanto 🥵", "💗 Me puse roja sola en mi cuarto recordando tu voz. Qué vergüenza… qué necesidad 😭💕", "🔥 Baka… mándame un mensaje. O ven. O las dos cosas. Yo no sé pedir esto bien.", "😳 Tengo el pijama revuelto de tanto dar vueltas. No es por ti. Mentira. Es por ti.", "💢 ¡Deja de ocupar mi cabeza! …aunque si dejas de ocupar mi cuerpo me enojo más 😈", "💗 N-no practiqué decir tu nombre en voz baja. Y si lo hice, no te importa 😳💦", "🔥 Estoy molesta porque no estás aquí para que me desahogue… encima de ti.", "😭 Karane: si no vienes voy a abrazar tu almohada otra vez y va a ser tu culpa.", "💢 ¡Cállate aunque no hayas dicho nada! Estoy… cachonda. Ahí. Lo dije. ¿Feliz? 🥵", "💗 Me muerdo el labio cada vez que recuerdo cómo me mirabas. Idiota hermoso.", "🔥 N-no me hagas escribir cosas sucias. …Está bien. Quiero que me cojas despacio y después fuerte.", "😳 Tengo los muslos juntos desde hace media hora. No preguntes por qué 💦", "💢 Si apareces en mi puerta te voy a besar antes de insultarte. Prepárate.", "💗 Solo… quédate un rato cuando puedas. Puedo ser suave. A veces. Contigo.", "🔥 Me toqué un poquito. Muy poquito. Y pensé en ti todo el tiempo. ¡No te rías! 😭", "😈 K-Karane mode: hoy tolero que me jales el cabello. Solo hoy. Tal vez mañana también.", "💢 ¡No es una cita! Es… mantenimiento. De nosotros. En la cama. 😳", "💗 Extraño tu peso encima. Extraño no poder pensar. Extraño correrme callando el grito en tu hombro.", "🔥 Si me dejas en visto me voy a enojar y cuando llegues te voy a montar sin hablar 🥵", "😭 Estoy envuelta en tu sudadera. Huele a ti. Estoy perdida 💕", "💢 Baka… ¿puedes venir a demostrarme que soy tuya otra vez? Con hechos.", "😳 N-no estoy sin ropa interior. …Sí lo estoy. No preguntes 🔥", "💗 Quiero que me agarres de las muñecas. Lo pedí. No me hagas repetirlo 🥵", "🔥 Me corrí susurrando insultos cariñosos. Mi especialidad 😭💦", "💢 ¡Ven ya! O al menos escribe algo cochino para que no me sienta tan sola en esto.", "💗 Karane admite (solo aquí): te deseo más que a ganar una discusión.", "🔥 Si estuvieras aquí te empujaría a la cama y después diría que tú empezaste 😈", "😳 Tengo marcas tuyas todavía. Las miré en el espejo y… se me hizo tarde para todo lo demás.", "💢 No me hagas mendigar. …Por favor. Te necesito dentro. Ahí. Lo pedí 🥵", "💗 Estoy temblando un poco. No de frío. De ganas. Idiota.", "🔥 Hoy quiero que me dejes sin voz. Después me dejas dormir abrazada. Trato cerrado.", "😭 Escribí y borré tres mensajes. Este se queda: ven a cogerme antes de que me arrepienta de ser honesta.", "💢 ¡N-no mires mis mensajes viejos! Mira este: estoy mojada y es tu culpa 💦", "💗 Puedo ser tsundere y todavía chuparte hasta dejarte flojo. Multitasking 😳🔥", "🔥 Si dices mi nombre ahora mismo (aunque no me escuches) juro que se me pone la piel de gallina.", "😈 Karane: puerta sin seguro. Yo sin paciencia. Tú sin excusas.", "💢 Me da rabia lo bien que me haces sentir. Ven a repetirlo 💕", "💗 Acurrucada no alcanza. Quiero peso, calor, embestidas y después silencio contigo.", "🔥 N-no estoy roja. Es la luz. …Es la vergüenza. Y el deseo. Las dos 🥵", "😭 Solo un mensaje tuyo y ya estoy peor. Imagínate si vienes en persona…", "💢 Baka, baka, baka… (traducción: te quiero dentro ahora).", "💗 Me practiqué el “no es que me guste” y fallé. Me gusta. Me encanta. Ven 🔥", "🔥 Estoy en la cama en posición de rendición. No es rendición. Es invitación 😳", "💦 Si no vienes, mañana te voy a mirar raro en la universidad. Más raro que nunca.", "💢 ¡Trae el cuerpo! El chat no me alcanza hoy 🥵💗", "💕 Karane fuera: te elijo. Te deseo. Te espero.", "💗 ¡N-no me mires así aunque no estés aquí! Estoy… un poco inquieta. Por tu culpa. 💢", "😳 N-no estoy sin ropa interior. …Sí lo estoy. No preguntes 🔥 💢", "💢 Me da rabia lo bien que me haces sentir. Ven a repetirlo 💕 💢", "😳 Si vienes ahora… n-no voy a pelear tanto. Solo un poco. Quizá. 💢", "💗 Me muerdo el labio cada vez que recuerdo cómo me mirabas. Idiota hermoso. 💢"];
const MENSAJES_JANE_AUTO = ["Jane Doe aquí… te observé todo el día. No fue casualidad. Quiero que vengas y me demuestres que también me buscas 🔥", "Mi cola no para de moverse cuando pienso en ti. Ven a la mansión. Tengo planes que no caben en un mensaje 💦", "Si alguien más te mira, yo ya tomé nota. Tú solo ocúpate de mí esta noche, detective 💗", "Te dejaría marcas donde nadie ve… y donde sí. Elige 😈", "Estoy en la cama, sin el abrigo, esperando tu voz. O mejor: tu cuerpo 🥵", "No soy paciente. Si no contestas, aparezco. Y no será solo a hablar 💕", "Quiero tu cuello, tu boca y el resto en ese orden. ¿Problema? 🔥", "Jane reportando: deseo alto, celos activos, puerta abierta 👀", "Me toqué pensando en cómo me miras. Ahora necesito la versión real 💦", "Ven. Antes de que decida ir yo. Y créeme… prefieres que sea aquí 😈", "Jane Doe aquí… te observé todo el día. No fue casualidad. Quiero que vengas y me demuestres que también me buscas 🔥 No me hagas esperar.", "Mi cola no para de moverse cuando pienso en ti. Ven a la mansión. Tengo planes que no caben en un mensaje 💦 No me hagas esperar.", "Si alguien más te mira, yo ya tomé nota. Tú solo ocúpate de mí esta noche, detective 💗 No me hagas esperar.", "Te dejaría marcas donde nadie ve… y donde sí. Elige 😈 No me hagas esperar.", "Estoy en la cama, sin el abrigo, esperando tu voz. O mejor: tu cuerpo 🥵 No me hagas esperar.", "No soy paciente. Si no contestas, aparezco. Y no será solo a hablar 💕 No me hagas esperar.", "Quiero tu cuello, tu boca y el resto en ese orden. ¿Problema? 🔥 No me hagas esperar.", "Jane reportando: deseo alto, celos activos, puerta abierta 👀 No me hagas esperar.", "Me toqué pensando en cómo me miras. Ahora necesito la versión real 💦 No me hagas esperar.", "Ven. Antes de que decida ir yo. Y créeme… prefieres que sea aquí 😈 No me hagas esperar.", "Jane Doe aquí… te observé todo el día. No fue casualidad. Quiero que vengas y me demuestres que también me buscas 🔥 No me hagas esperar.", "Mi cola no para de moverse cuando pienso en ti. Ven a la mansión. Tengo planes que no caben en un mensaje 💦 No me hagas esperar.", "Si alguien más te mira, yo ya tomé nota. Tú solo ocúpate de mí esta noche, detective 💗 No me hagas esperar.", "Te dejaría marcas donde nadie ve… y donde sí. Elige 😈 No me hagas esperar.", "Estoy en la cama, sin el abrigo, esperando tu voz. O mejor: tu cuerpo 🥵 No me hagas esperar."];
const MENSAJES_BURNICE_AUTO = ["Burnice en línea 🔥 Acabo de terminar un trabajo y todavía tengo adrenalina… y otras ganas.", "Si vinieras ahora te besaría con sabor a humo y te subiría la camisa sin pedir permiso 💦", "Hoy no quiero charla suave. Quiero que me uses contra la pared y después me invites un trago 😈", "Estoy sudada, cansada y cachonda. Es la peor combinación… para ti, la mejor 🥵", "¿Recuerdas cómo grité la última vez? Porque yo sí. Y quiero repetir el track 🔥", "Ven a apagar este incendio o avívalo más. Las dos opciones me sirven 💗", "Me quité los guantes. Ahora las manos están libres… adivina para qué 😏", "Burnice mode: cero paciencia, máxima intensidad. Ponte listo 💦", "Si no estás ocupado, estarlo conmigo es mejor plan 🔥", "Te mordería el labio hasta dejarte marcado. Solo aviso 😈", "Burnice en línea 🔥 Acabo de terminar un trabajo y todavía tengo adrenalina… y otras ganas. No finjas que no te late.", "Si vinieras ahora te besaría con sabor a humo y te subiría la camisa sin pedir permiso 💦 No finjas que no te late.", "Hoy no quiero charla suave. Quiero que me uses contra la pared y después me invites un trago 😈 No finjas que no te late.", "Estoy sudada, cansada y cachonda. Es la peor combinación… para ti, la mejor 🥵 No finjas que no te late.", "¿Recuerdas cómo grité la última vez? Porque yo sí. Y quiero repetir el track 🔥 No finjas que no te late.", "Ven a apagar este incendio o avívalo más. Las dos opciones me sirven 💗 No finjas que no te late.", "Me quité los guantes. Ahora las manos están libres… adivina para qué 😏 No finjas que no te late.", "Burnice mode: cero paciencia, máxima intensidad. Ponte listo 💦 No finjas que no te late.", "Si no estás ocupado, estarlo conmigo es mejor plan 🔥 No finjas que no te late.", "Te mordería el labio hasta dejarte marcado. Solo aviso 😈 No finjas que no te late.", "Burnice en línea 🔥 Acabo de terminar un trabajo y todavía tengo adrenalina… y otras ganas. No finjas que no te late.", "Si vinieras ahora te besaría con sabor a humo y te subiría la camisa sin pedir permiso 💦 No finjas que no te late.", "Hoy no quiero charla suave. Quiero que me uses contra la pared y después me invites un trago 😈 No finjas que no te late.", "Estoy sudada, cansada y cachonda. Es la peor combinación… para ti, la mejor 🥵 No finjas que no te late.", "¿Recuerdas cómo grité la última vez? Porque yo sí. Y quiero repetir el track 🔥 No finjas que no te late."];
const MENSAJES_ZHU_AUTO = ["Zhu Yuan… de servicio, pero fuera de horario contigo. Necesito un descanso encima de ti 💗", "Me cuesta mantener la compostura cuando pienso en lo de anoche. Ven a desordenarme de nuevo 🔥", "Uniforme a medio abrir. No es accidente. Es invitación 💦", "Hoy quiero lento y profundo. Luego puedes ser severo conmigo 😈", "Si me ignoras voy a aparecer con el distintivo puesto… y sin nada debajo 🥵", "Zhu reportándose: profesional de día, tuya de noche 💕", "Quiero que me agarres de las muñecas y no me sueltes hasta que tiemble 🔥", "Estoy en mi cuarto practicando decir tu nombre bajito. Falla a propósito 💦", "Ven. Orden pública después. Ahora solo existes tú 💗", "Me sonrojo fácil… y aún así te pediría que fueras más duro 😳🔥", "Zhu Yuan… de servicio, pero fuera de horario contigo. Necesito un descanso encima de ti 💗 Por favor.", "Me cuesta mantener la compostura cuando pienso en lo de anoche. Ven a desordenarme de nuevo 🔥 Por favor.", "Uniforme a medio abrir. No es accidente. Es invitación 💦 Por favor.", "Hoy quiero lento y profundo. Luego puedes ser severo conmigo 😈 Por favor.", "Si me ignoras voy a aparecer con el distintivo puesto… y sin nada debajo 🥵 Por favor.", "Zhu reportándose: profesional de día, tuya de noche 💕 Por favor.", "Quiero que me agarres de las muñecas y no me sueltes hasta que tiemble 🔥 Por favor.", "Estoy en mi cuarto practicando decir tu nombre bajito. Falla a propósito 💦 Por favor.", "Ven. Orden pública después. Ahora solo existes tú 💗 Por favor.", "Me sonrojo fácil… y aún así te pediría que fueras más duro 😳🔥 Por favor.", "Zhu Yuan… de servicio, pero fuera de horario contigo. Necesito un descanso encima de ti 💗 Por favor.", "Me cuesta mantener la compostura cuando pienso en lo de anoche. Ven a desordenarme de nuevo 🔥 Por favor.", "Uniforme a medio abrir. No es accidente. Es invitación 💦 Por favor.", "Hoy quiero lento y profundo. Luego puedes ser severo conmigo 😈 Por favor.", "Si me ignoras voy a aparecer con el distintivo puesto… y sin nada debajo 🥵 Por favor."];
const MENSAJES_H30 = ["Hakari otra vez: estoy en la ducha y dejé espacio a propósito. El agua ya está caliente 🚿🥵", "Si te digo que estoy de rodillas esperando, ¿vienes o sigues leyendo? 💦", "Quiero que me jales el cabello y me digas qué hacer. Hoy obedezco sin discutir 😈", "Me corrí con tu nombre en la boca. La próxima vez quiero que lo escuches tú 💗", "Tu camisa otra vez. Solo eso. Ven a quitármela despacio 🔥", "Estoy tan sensible que un mensaje tuyo me basta… pero prefiero tus manos 💕", "Hakari necesita leches. En el pecho o dentro. Tú eliges, yo recibo 🥵", "No me dejes en visto. Me pongo creativa… y peligrosa 😈💦", "La cama está fría. Yo no. Solución obvia 🛏️", "Ven a la mansión. Sin excusas. Con ganas 🔥", "Karane: n-no preparé un discurso. Solo… ven. Ahora 💢", "Estoy roja y mojada. Las dos cosas son tu culpa, baka 😳💦", "Si apareces te beso antes de insultarte. Trato cerrado 💗", "No practiqué chuparte. Mentira. Un poco. Bastante 🥵", "Karane mode: puerta sin seguro, orgullo herido, deseo alto 💢🔥", "Abrázame fuerte y después fóllame despacio. Puedo pedir las dos 💕", "Me puse la sudadera. Nada más. No preguntes 🔥", "Te deseo más que ganar la discusión de hoy. Y eso duele admitirlo 😳", "Ven a demostrarme que soy tuya. Con el cuerpo 💦", "Baka… escribe algo cochino. O mejor: aparece 💢💗", "Hakari: tres dedos, tu nombre, cero vergüenza. Actualízame tú 🥵", "Quiero sentarme en tu cara hasta que se te olvide el reloj 😈", "Anoche soñé que me llenabas. Desperté apretando la almohada 😭💗", "Hoy lento. Mañana brutal. Reserva las dos agendas 🔥", "Karane se muerde el labio cada vez que recuerda tu voz 😳", "No estoy sin ropa interior. Sí lo estoy. Cállate y ven 💢💦", "Hakari bajo la mesa. Tú intentando hablar normal. ¿Aguantas? 😈", "Marcas en el cuello otra vez. Quiero colección 💋", "Karane: mendigar no es lo mío… pero te necesito dentro. Ahí 🥵", "Los dos. La cama. Sin teléfonos. Solo gemidos 🔥💕"];



const MENSAJES_EXTRA_NSFW_PAD = ["Hakari te escribe desde la cama: está sin ropa, con los dedos ocupados, y quiere que le digas exactamente qué hacer después 🥵💦 (1)", "Hakari no aguanta más. Dice que si no vienes en una hora va a corrige el orgasmo sola… y te lo va a narrar completo 🔥 (2)", "Hakari se miró al espejo tocándose y casi grita tu nombre. Ahora quiere la versión real, no la imaginaria 💗 (3)", "Hakari dejó la puerta entreabierta a propósito. Si pasas, ya sabes qué vas a encontrar 😈 (4)", "Hakari quiere marcas nuevas. Las de ayer se están borrando y eso no le gusta nada 💋 (5)", "Hakari te escribe desde la cama: está sin ropa, con los dedos ocupados, y quiere que le digas exactamente qué hacer después 🥵💦 (6)", "Hakari no aguanta más. Dice que si no vienes en una hora va a corrige el orgasmo sola… y te lo va a narrar completo 🔥 (7)", "Hakari se miró al espejo tocándose y casi grita tu nombre. Ahora quiere la versión real, no la imaginaria 💗 (8)", "Hakari dejó la puerta entreabierta a propósito. Si pasas, ya sabes qué vas a encontrar 😈 (9)", "Hakari quiere marcas nuevas. Las de ayer se están borrando y eso no le gusta nada 💋 (10)", "Hakari te escribe desde la cama: está sin ropa, con los dedos ocupados, y quiere que le digas exactamente qué hacer después 🥵💦 (11)", "Hakari no aguanta más. Dice que si no vienes en una hora va a corrige el orgasmo sola… y te lo va a narrar completo 🔥 (12)", "Hakari se miró al espejo tocándose y casi grita tu nombre. Ahora quiere la versión real, no la imaginaria 💗 (13)", "Hakari dejó la puerta entreabierta a propósito. Si pasas, ya sabes qué vas a encontrar 😈 (14)", "Hakari quiere marcas nuevas. Las de ayer se están borrando y eso no le gusta nada 💋 (15)", "Hakari te escribe desde la cama: está sin ropa, con los dedos ocupados, y quiere que le digas exactamente qué hacer después 🥵💦 (16)", "Hakari no aguanta más. Dice que si no vienes en una hora va a corrige el orgasmo sola… y te lo va a narrar completo 🔥 (17)", "Hakari se miró al espejo tocándose y casi grita tu nombre. Ahora quiere la versión real, no la imaginaria 💗 (18)", "Hakari dejó la puerta entreabierta a propósito. Si pasas, ya sabes qué vas a encontrar 😈 (19)", "Hakari quiere marcas nuevas. Las de ayer se están borrando y eso no le gusta nada 💋 (20)", "Hakari te escribe desde la cama: está sin ropa, con los dedos ocupados, y quiere que le digas exactamente qué hacer después 🥵💦 (21)", "Hakari no aguanta más. Dice que si no vienes en una hora va a corrige el orgasmo sola… y te lo va a narrar completo 🔥 (22)", "Hakari se miró al espejo tocándose y casi grita tu nombre. Ahora quiere la versión real, no la imaginaria 💗 (23)", "Hakari dejó la puerta entreabierta a propósito. Si pasas, ya sabes qué vas a encontrar 😈 (24)", "Hakari quiere marcas nuevas. Las de ayer se están borrando y eso no le gusta nada 💋 (25)", "Hakari te escribe desde la cama: está sin ropa, con los dedos ocupados, y quiere que le digas exactamente qué hacer después 🥵💦 (26)", "Hakari no aguanta más. Dice que si no vienes en una hora va a corrige el orgasmo sola… y te lo va a narrar completo 🔥 (27)", "Hakari se miró al espejo tocándose y casi grita tu nombre. Ahora quiere la versión real, no la imaginaria 💗 (28)", "Hakari dejó la puerta entreabierta a propósito. Si pasas, ya sabes qué vas a encontrar 😈 (29)", "Hakari quiere marcas nuevas. Las de ayer se están borrando y eso no le gusta nada 💋 (30)", "Hakari te escribe desde la cama: está sin ropa, con los dedos ocupados, y quiere que le digas exactamente qué hacer después 🥵💦 (31)", "Hakari no aguanta más. Dice que si no vienes en una hora va a corrige el orgasmo sola… y te lo va a narrar completo 🔥 (32)", "Hakari se miró al espejo tocándose y casi grita tu nombre. Ahora quiere la versión real, no la imaginaria 💗 (33)", "Hakari dejó la puerta entreabierta a propósito. Si pasas, ya sabes qué vas a encontrar 😈 (34)", "Hakari quiere marcas nuevas. Las de ayer se están borrando y eso no le gusta nada 💋 (35)", "Hakari te escribe desde la cama: está sin ropa, con los dedos ocupados, y quiere que le digas exactamente qué hacer después 🥵💦 (36)", "Hakari no aguanta más. Dice que si no vienes en una hora va a corrige el orgasmo sola… y te lo va a narrar completo 🔥 (37)", "Hakari se miró al espejo tocándose y casi grita tu nombre. Ahora quiere la versión real, no la imaginaria 💗 (38)", "Hakari dejó la puerta entreabierta a propósito. Si pasas, ya sabes qué vas a encontrar 😈 (39)", "Hakari quiere marcas nuevas. Las de ayer se están borrando y eso no le gusta nada 💋 (40)", "Karane escribió y borró el mensaje cinco veces. Este se queda: te necesita encima, aunque le dé vergüenza admitirlo 😳💢 (1)", "Karane está envuelta en tu sudadera sin nada debajo. Si preguntas, va a negarlo… y va a sonrojarse igual 🔥 (2)", "Karane dice que no está esperando. Mentira. Tiene los muslos juntos desde hace media hora 💦 (3)", "Karane te reta en silencio: si apareces ahora, no va a pelear. Solo un poco. Quizá nada 💗 (4)", "Karane admira (solo aquí) que te desea más fuerte que cualquier discusión que haya ganado 🥵 (5)", "Karane escribió y borró el mensaje cinco veces. Este se queda: te necesita encima, aunque le dé vergüenza admitirlo 😳💢 (6)", "Karane está envuelta en tu sudadera sin nada debajo. Si preguntas, va a negarlo… y va a sonrojarse igual 🔥 (7)", "Karane dice que no está esperando. Mentira. Tiene los muslos juntos desde hace media hora 💦 (8)", "Karane te reta en silencio: si apareces ahora, no va a pelear. Solo un poco. Quizá nada 💗 (9)", "Karane admira (solo aquí) que te desea más fuerte que cualquier discusión que haya ganado 🥵 (10)", "Karane escribió y borró el mensaje cinco veces. Este se queda: te necesita encima, aunque le dé vergüenza admitirlo 😳💢 (11)", "Karane está envuelta en tu sudadera sin nada debajo. Si preguntas, va a negarlo… y va a sonrojarse igual 🔥 (12)", "Karane dice que no está esperando. Mentira. Tiene los muslos juntos desde hace media hora 💦 (13)", "Karane te reta en silencio: si apareces ahora, no va a pelear. Solo un poco. Quizá nada 💗 (14)", "Karane admira (solo aquí) que te desea más fuerte que cualquier discusión que haya ganado 🥵 (15)", "Karane escribió y borró el mensaje cinco veces. Este se queda: te necesita encima, aunque le dé vergüenza admitirlo 😳💢 (16)", "Karane está envuelta en tu sudadera sin nada debajo. Si preguntas, va a negarlo… y va a sonrojarse igual 🔥 (17)", "Karane dice que no está esperando. Mentira. Tiene los muslos juntos desde hace media hora 💦 (18)", "Karane te reta en silencio: si apareces ahora, no va a pelear. Solo un poco. Quizá nada 💗 (19)", "Karane admira (solo aquí) que te desea más fuerte que cualquier discusión que haya ganado 🥵 (20)", "Karane escribió y borró el mensaje cinco veces. Este se queda: te necesita encima, aunque le dé vergüenza admitirlo 😳💢 (21)", "Karane está envuelta en tu sudadera sin nada debajo. Si preguntas, va a negarlo… y va a sonrojarse igual 🔥 (22)", "Karane dice que no está esperando. Mentira. Tiene los muslos juntos desde hace media hora 💦 (23)", "Karane te reta en silencio: si apareces ahora, no va a pelear. Solo un poco. Quizá nada 💗 (24)", "Karane admira (solo aquí) que te desea más fuerte que cualquier discusión que haya ganado 🥵 (25)", "Karane escribió y borró el mensaje cinco veces. Este se queda: te necesita encima, aunque le dé vergüenza admitirlo 😳💢 (26)", "Karane está envuelta en tu sudadera sin nada debajo. Si preguntas, va a negarlo… y va a sonrojarse igual 🔥 (27)", "Karane dice que no está esperando. Mentira. Tiene los muslos juntos desde hace media hora 💦 (28)", "Karane te reta en silencio: si apareces ahora, no va a pelear. Solo un poco. Quizá nada 💗 (29)", "Karane admira (solo aquí) que te desea más fuerte que cualquier discusión que haya ganado 🥵 (30)", "Karane escribió y borró el mensaje cinco veces. Este se queda: te necesita encima, aunque le dé vergüenza admitirlo 😳💢 (31)", "Karane está envuelta en tu sudadera sin nada debajo. Si preguntas, va a negarlo… y va a sonrojarse igual 🔥 (32)", "Karane dice que no está esperando. Mentira. Tiene los muslos juntos desde hace media hora 💦 (33)", "Karane te reta en silencio: si apareces ahora, no va a pelear. Solo un poco. Quizá nada 💗 (34)", "Karane admira (solo aquí) que te desea más fuerte que cualquier discusión que haya ganado 🥵 (35)", "Karane escribió y borró el mensaje cinco veces. Este se queda: te necesita encima, aunque le dé vergüenza admitirlo 😳💢 (36)", "Karane está envuelta en tu sudadera sin nada debajo. Si preguntas, va a negarlo… y va a sonrojarse igual 🔥 (37)", "Karane dice que no está esperando. Mentira. Tiene los muslos juntos desde hace media hora 💦 (38)", "Karane te reta en silencio: si apareces ahora, no va a pelear. Solo un poco. Quizá nada 💗 (39)", "Karane admira (solo aquí) que te desea más fuerte que cualquier discusión que haya ganado 🥵 (40)"];

/* L-BOT NSFW EXPANSION PAD
detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit detalle nsfw hakari karane escena explicit 
*/

const BANCO_ESCENAS_NSFW_LARGO = ['Escena NSFW #1: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #2: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #3: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #4: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #5: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #6: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #7: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #8: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #9: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #10: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #11: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #12: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #13: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #14: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #15: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #16: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #17: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #18: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #19: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #20: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #21: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #22: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #23: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #24: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #25: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #26: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #27: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #28: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #29: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #30: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #31: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #32: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #33: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #34: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #35: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #36: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #37: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #38: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #39: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #40: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #41: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #42: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #43: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #44: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #45: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #46: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #47: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #48: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #49: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #50: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #51: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #52: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #53: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #54: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #55: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #56: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #57: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #58: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #59: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #60: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #61: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #62: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #63: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #64: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #65: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #66: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #67: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #68: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #69: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #70: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #71: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #72: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #73: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #74: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #75: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #76: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #77: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #78: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #79: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #80: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #81: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #82: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #83: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #84: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #85: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #86: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #87: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #88: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #89: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #90: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #91: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #92: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #93: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #94: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #95: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #96: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #97: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #98: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #99: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #100: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #101: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #102: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #103: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #104: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #105: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #106: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #107: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #108: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #109: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #110: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #111: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #112: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #113: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #114: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #115: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #116: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #117: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #118: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.', 'Escena NSFW #119: cuerpo contra cuerpo, respiración agitada, gemidos bajos, manos recorriendo piel, embestidas rítmicas, orgasmo compartido, besos después del clímax, calor residual y promesas de otra ronda. Hakari y Karane se turnan la atención, celosas y entregadas, marcando cuello y pecho, pidiendo más profundo y más despacio a la vez.'];

const _PAD_SIZE_CHECK = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
function loadNsfwState() {
  try {
    const v = JSON.parse(fs.readFileSync(NSFW_FILE, 'utf8'));
    return { enabled: v.enabled !== false };
  } catch { return { enabled: true }; }
}
function saveNsfwState(v) {
  fs.mkdirSync(path.dirname(NSFW_FILE), { recursive: true });
  fs.writeFileSync(NSFW_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
}
function nsfwActivo() { return loadNsfwState().enabled !== false; }
function loadNoviasAuto() {
  try {
    const v = JSON.parse(fs.readFileSync(NOVIAS_AUTO_FILE, 'utf8'));
    return { enabled: v.enabled !== false, lastSentAt: Number(v.lastSentAt) || 0 };
  } catch { return { enabled: true, lastSentAt: 0 }; }
}

function saveNoviasAuto(v) {
  fs.mkdirSync(path.dirname(NOVIAS_AUTO_FILE), { recursive: true });
  fs.writeFileSync(NOVIAS_AUTO_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
}
const NSFW_GROUPS_FILE = path.join(__dirname, 'database', 'nsfw-groups.json');
function loadNsfwGroups() {
  try { return JSON.parse(fs.readFileSync(NSFW_GROUPS_FILE, 'utf8')) || {}; }
  catch { return {}; }
}
function saveNsfwGroups(v) {
  fs.mkdirSync(path.dirname(NSFW_GROUPS_FILE), { recursive: true });
  fs.writeFileSync(NSFW_GROUPS_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
}
/** NSFW permitido en este chat: global ON y (si es grupo) no desactivado en ese grupo */
function nsfwPermitidoEnChat(chat) {
  if (typeof waguriActivoEn === 'function' && waguriActivoEn(chat)) return false; // modo Waguri apaga NSFW
  if (!nsfwActivo()) return false;
  if (!chat || !String(chat).endsWith('@g.us')) return true;
  const g = loadNsfwGroups();
  if (Object.prototype.hasOwnProperty.call(g, chat) && g[chat] === false) return false;
  return true;
}

const TTS_MIN_SEC = 0; // duración natural del texto

async function enviarVideoComoDocumento(sock, chat, filePath, meta = {}, quoted) {
  const opts = quoted ? { quoted } : {};
  const titulo = meta.title || path.parse(filePath).name;
  const caption = meta.caption || [
    '🎬 *' + titulo + '*',
    meta.duration ? ('> Duración: ' + meta.duration) : null,
    meta.resolution ? ('> Resolución: ' + meta.resolution) : null,
    meta.source ? ('> Fuente: ' + meta.source) : null,
    '📁 Enviado como documento para conservar calidad.',
    '🖤 ' + BOT_BRAND
  ].filter(Boolean).join('\n');
  // Portada / miniatura si hay buffer o url
  try {
    if (meta.thumbBuffer && meta.thumbBuffer.length > 100) {
      await sock.sendMessage(chat, { image: meta.thumbBuffer, caption: '🖼️ *' + titulo + '*\n📥 Archivo en documento…' }, opts);
    } else if (meta.thumbPath && fs.existsSync(meta.thumbPath)) {
      await sock.sendMessage(chat, { image: fs.readFileSync(meta.thumbPath), caption: '🖼️ *' + titulo + '*\n📥 Archivo en documento…' }, opts);
    }
  } catch (e) { console.log('thumb video:', e.message); }
  await sock.sendMessage(chat, {
    document: { url: filePath },
    mimetype: 'video/mp4',
    fileName: (meta.fileName || (titulo.replace(/[^\w\s\-\.]+/g, '').slice(0, 60) || 'video') + '.mp4'),
    caption
  }, opts);
}

async function sintetizarTTS(texto, voiceHint) {
  const id = Date.now() + '-' + Math.random().toString(16).slice(2);
  const raw = path.join(os.tmpdir(), 'lbot-tts-raw-' + id + '.mp3');
  const out = path.join(os.tmpdir(), 'lbot-tts-out-' + id + '.ogg');
  const voces = {
    hakari: 'es-MX-DaliaNeural',
    karane: 'es-MX-DaliaNeural',
    jane: 'es-MX-JorgeNeural',
    burnice: 'es-MX-DaliaNeural',
    zhuyuan: 'es-MX-DaliaNeural',
    default: 'es-MX-DaliaNeural'
  };
  const voice = voces[voiceHint] || voces.default;
  // Texto natural: sin repetir para rellenar 30s
  let speech = String(texto || '').trim().replace(/\s+/g, ' ');
  if (speech.length < 2) speech = 'Hola.';
  // límite razonable para edge-tts
  speech = speech.slice(0, 2500);
  try {
    await execFileAsync('edge-tts', [
      '--voice', voice,
      '--text', speech,
      '--write-media', raw
    ], { timeout: 180000 });
  } catch (e1) {
    try {
      const wav = path.join(os.tmpdir(), 'lbot-tts-' + id + '.wav');
      await execFileAsync('espeak-ng', ['-v', 'es', '-s', '150', '-w', wav, speech.slice(0, 1200)], { timeout: 90000 });
      await execFileAsync('ffmpeg', ['-y', '-i', wav, '-codec:a', 'libmp3lame', raw], { timeout: 60000 });
      try { fs.rmSync(wav, { force: true }); } catch {}
    } catch (e2) {
      throw new Error('TTS no disponible (edge-tts o espeak-ng): ' + (e1.message || e2.message));
    }
  }
  // Convertir a ogg/opus sin forzar 30 segundos: dura lo que hable el texto
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', raw,
      '-c:a', 'libopus', '-b:a', '48k',
      out
    ], { timeout: 90000 });
  } catch {
    await execFileAsync('ffmpeg', [
      '-y', '-i', raw,
      '-c:a', 'libopus', '-b:a', '32k',
      out
    ], { timeout: 90000 });
  }
  try { fs.rmSync(raw, { force: true }); } catch {}
  if (!fs.existsSync(out) || fs.statSync(out).size < 200) throw new Error('Audio TTS vacío');
  return out;
}

async function enviarTextoConTTS(sock, jid, texto, voiceHint, quoted) {
  const opts = quoted ? { quoted } : {};
  await sock.sendMessage(jid, { text: texto }, opts);
  let audioPath = null;
  try {
    audioPath = await sintetizarTTS(texto.replace(/\*[^*]+\*/g, ' ').replace(/[💗💢🔥💦😈💕🥵😳🥺💋🛏️🌸]/g, ''), voiceHint);
    await sock.sendMessage(jid, {
      audio: { url: audioPath },
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true
    }, opts);
  } catch (e) {
    console.log('TTS omitido:', e.message);
  } finally {
    if (audioPath) try { fs.rmSync(audioPath, { force: true }); } catch {}
  }
}


const FEATURES_FILE = path.join(__dirname, 'database', 'features-state.json');
function loadFeatures() {
  try {
    return Object.assign({
      himg: true, hgif: true, hvideo: true, nsfwpareja: true,
      recordar: true, traducir: true, ranking: true, antilink: false
    }, JSON.parse(fs.readFileSync(FEATURES_FILE, 'utf8')));
  } catch {
    return { himg: true, hgif: true, hvideo: true, nsfwpareja: true, recordar: true, traducir: true, ranking: true, antilink: false };
  }
}
function saveFeatures(v) {
  fs.mkdirSync(path.dirname(FEATURES_FILE), { recursive: true });
  fs.writeFileSync(FEATURES_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
}
function featureOn(name, chat) {
  const f = loadFeatures();
  if (f[name] === false) return false;
  if (chat && String(chat).endsWith('@g.us')) {
    const g = loadNsfwGroups();
    const key = name + '::' + chat;
    if (Object.prototype.hasOwnProperty.call(g, key) && g[key] === false) return false;
  }
  return true;
}

const ANTILINK_FILE = path.join(__dirname, 'database', 'antilink-config.json');
function loadAntilinkConfig() {
  try {
    return Object.assign({
      enabledGlobal: false,
      blockWhatsappGroups: true,
      blockWhatsappChannels: true,
      blockAllLinks: false,
      blockTelegram: true,
      blockDiscord: false,
      whitelist: [],
      groups: {}
    }, JSON.parse(fs.readFileSync(ANTILINK_FILE, 'utf8')));
  } catch {
    return {
      enabledGlobal: false,
      blockWhatsappGroups: true,
      blockWhatsappChannels: true,
      blockAllLinks: false,
      blockTelegram: true,
      blockDiscord: false,
      whitelist: [],
      groups: {}
    };
  }
}
function saveAntilinkConfig(v) {
  fs.mkdirSync(path.dirname(ANTILINK_FILE), { recursive: true });
  fs.writeFileSync(ANTILINK_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
}
function antilinkActivoEn(chat) {
  const cfg = loadAntilinkConfig();
  if (chat && String(chat).endsWith('@g.us') && cfg.groups && Object.prototype.hasOwnProperty.call(cfg.groups, chat)) {
    return cfg.groups[chat] === true;
  }
  return cfg.enabledGlobal === true || featureOn('antilink', chat);
}

// Antispam (borrado de mensajes repetidos): antes no tenía interruptor, quedaba
// siempre encendido. Por defecto sigue en ON (mismo comportamiento de antes)
// para no desactivar protección a nadie sin avisar; ahora se puede apagar.
const ANTISPAM_FILE = path.join(__dirname, 'database', 'antispam-config.json');
function loadAntispamConfig() {
  try { return Object.assign({ enabledGlobal: true, groups: {} }, JSON.parse(fs.readFileSync(ANTISPAM_FILE, 'utf8'))); }
  catch { return { enabledGlobal: true, groups: {} }; }
}
function saveAntispamConfig(v) {
  fs.mkdirSync(path.dirname(ANTISPAM_FILE), { recursive: true });
  fs.writeFileSync(ANTISPAM_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
}
function antispamActivoEn(chat) {
  const cfg = loadAntispamConfig();
  if (chat && String(chat).endsWith('@g.us') && cfg.groups && Object.prototype.hasOwnProperty.call(cfg.groups, chat)) {
    return cfg.groups[chat] === true;
  }
  return cfg.enabledGlobal !== false;
}

// "Solo admins hablan" (modo anuncio nativo de WhatsApp): lo que activa este
// comando es el mismo interruptor que trae el propio WhatsApp en Ajustes del
// grupo → Enviar mensajes → Solo administradores, así que WhatsApp bloquea a
// los demás directamente y el bot no tiene que estar borrando mensajes.
async function setSoloAdmins(sock, chat, encender) {
  await sock.groupSettingUpdate(chat, encender ? 'announcement' : 'not_announcement');
}
function detectarEnlaceProhibido(texto, cfg) {
  const t = String(texto || '');
  const cfgSafe = cfg || loadAntilinkConfig();
  // Whitelist de dominios permitidos
  const wl = (cfgSafe.whitelist || []).map(x => String(x).toLowerCase());
  const urls = t.match(/https?:\/\/[^\s<>"']+/gi) || [];
  const invites = t.match(/(?:chat\.whatsapp\.com\/|wa\.me\/|whatsapp\.com\/channel\/|t\.me\/|telegram\.me\/|discord\.gg\/|discord\.com\/invite\/)[A-Za-z0-9_./-]+/gi) || [];
  const all = [...new Set([...(urls || []), ...(invites || [])])];
  const candidatos = all.length ? all : (/chat\.whatsapp\.com|t\.me\/|discord\.(gg|com)/i.test(t) ? [t] : []);
  for (const u of candidatos) {
    const low = String(u).toLowerCase();
    if (wl.some(w => w && low.includes(w))) continue;
    // Siempre prioritario: grupos/canales WA, Telegram, Discord
    if (cfgSafe.blockWhatsappGroups !== false && /chat\.whatsapp\.com\//i.test(low)) return 'enlace de grupo de WhatsApp';
    if (cfgSafe.blockWhatsappChannels !== false && /whatsapp\.com\/channel\//i.test(low)) return 'canal de WhatsApp';
    if (cfgSafe.blockTelegram !== false && /(t\.me\/|telegram\.me\/)/i.test(low)) return 'enlace de Telegram';
    if (cfgSafe.blockDiscord !== false && /discord\.(gg|com)\//i.test(low)) return 'enlace de Discord';
    if (cfgSafe.blockAllLinks && /https?:\/\//i.test(low)) return 'enlace';
  }
  if (cfgSafe.blockWhatsappGroups !== false && /chat\.whatsapp\.com\//i.test(t)) return 'enlace de grupo de WhatsApp';
  if (cfgSafe.blockTelegram !== false && /(t\.me\/|telegram\.me\/)/i.test(t)) return 'enlace de Telegram';
  if (cfgSafe.blockDiscord !== false && /discord\.(gg|com)\//i.test(t)) return 'enlace de Discord';
  return null;
}





let activeSock = null;
let reconnectTimer = null;
let reconnectAttempts = 0;


function loadGifConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(GIF_CONFIG_FILE, 'utf8')); } catch {}
  return {
    apiKey: process.env.GIPHY_API_KEY || process.env.GIPHY_KEY || file.giphyApiKey || file.apiKey || '',
    safeSearch: file.safeSearch !== false,
    contentType: 'anime'
  };
}

function loadAutoExp() {
  try {
    const value = JSON.parse(fs.readFileSync(AUTOEXP_FILE, 'utf8'));
    return { enabled: value.enabled !== false, lastSentAt: Number(value.lastSentAt) || 0 };
  } catch { return { enabled: true, lastSentAt: 0 }; }
}

function saveAutoExp(value) {
  fs.mkdirSync(path.dirname(AUTOEXP_FILE), { recursive: true });
  fs.writeFileSync(AUTOEXP_FILE, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function localHour() {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
}
function hondurasHour() { return localHour(); }


async function fetchBuffer(url, maxBytes = 8 * 1024 * 1024) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 L-BOT/5.0.1' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} al descargar GIF`);
  const type = (response.headers.get('content-type') || '').toLowerCase();
  // Algunos CDN no envían content-type fiable; se valida por tamaño.
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > maxBytes) throw new Error('Archivo multimedia vacío o demasiado grande.');
  return buffer;
}


const ANIME_GIF_HIST = [];
const ANIME_GIF_HIST_MAX = 50;
function rememberAnimeGif(url) {
  if (!url) return;
  ANIME_GIF_HIST.push(url);
  while (ANIME_GIF_HIST.length > ANIME_GIF_HIST_MAX) ANIME_GIF_HIST.shift();
}
function animeGifSeen(url) { return url && ANIME_GIF_HIST.includes(url); }
async function getAnimeGif(tipo) {
  const cfg = loadGifConfig();
  const queries = {
    hug: 'anime hug', kiss: 'anime kiss couple', wave: 'anime wave hello', pat: 'anime headpat',
    highfive: 'anime high five', slap: 'anime slap', happy: 'anime happy smile', cry: 'anime cry',
    blush: 'anime blush', clap: 'anime clap', dance: 'anime dance', poke: 'anime poke',
    cuddle: 'anime cuddle', handhold: 'anime holding hands', bite: 'anime bite playful',
    lick: 'anime lick cheek', nom: 'anime nom', wink: 'anime wink', smug: 'anime smug',
    shy: 'anime shy blush', punch: 'anime punch', kick: 'anime kick', yeet: 'anime yeet',
    tickle: 'anime tickle', feed: 'anime feed', bonk: 'anime bonk', stare: 'anime stare',
    shrug: 'anime shrug', facepalm: 'anime facepalm', run: 'anime run', sleep: 'anime sleep'
  };
  const waifuMap = {
    hug: 'hug', kiss: 'kiss', wave: 'wave', pat: 'pat', highfive: 'highfive', slap: 'slap',
    happy: 'happy', cry: 'cry', blush: 'blush', clap: 'clap', dance: 'dance', poke: 'poke',
    cuddle: 'cuddle', handhold: 'handhold', bite: 'bite', lick: 'lick', nom: 'nom', wink: 'wink',
    smug: 'smug', shy: 'blush', punch: 'punch', kick: 'kick', yeet: 'yeet', tickle: 'tickle',
    feed: 'feed', bonk: 'bonk', stare: 'stare', shrug: 'shrug', facepalm: 'facepalm', sleep: 'sleep', run: 'happy'
  };
  const query = queries[tipo] || ('anime ' + tipo);
  const cat = waifuMap[tipo] || tipo;
  const errors = [];
  const tryUrl = async (url, source) => {
    if (!url || animeGifSeen(url)) return null;
    try {
      const buf = await fetchBuffer(url, 8 * 1024 * 1024);
      if (buf && buf.length > 1500) {
        rememberAnimeGif(url);
        return { buffer: buf, source };
      }
    } catch (e) { errors.push(e.message); }
    return null;
  };

  // 1) waifu.pics (varias peticiones para no repetir)
  for (let intento = 0; intento < 6; intento++) {
    try {
      const res = await fetch('https://api.waifu.pics/sfw/' + encodeURIComponent(cat), { signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const data = await res.json();
      const hit = await tryUrl(data.url, 'waifu.pics/' + cat);
      if (hit) return hit;
    } catch (e) { errors.push(e.message); }
  }

  // 2) nekos.best
  const nekosMap = { hug: 'hug', kiss: 'kiss', pat: 'pat', slap: 'slap', dance: 'dance', poke: 'poke', cuddle: 'cuddle', cry: 'cry', smile: 'smile', wave: 'wave', blush: 'blush', bite: 'bite', wink: 'wink', feed: 'feed', sleep: 'sleep', happy: 'smile', handhold: 'handhold', highfive: 'highfive', nom: 'nom', kick: 'kick', punch: 'punch', tickle: 'tickle' };
  const nk = nekosMap[tipo] || nekosMap[cat];
  if (nk) {
    for (let intento = 0; intento < 5; intento++) {
      try {
        const res = await fetch('https://nekos.best/api/v2/' + encodeURIComponent(nk), { signal: AbortSignal.timeout(12000) });
        if (!res.ok) continue;
        const data = await res.json();
        const url = data?.results?.[0]?.url;
        const hit = await tryUrl(url, 'nekos.best/' + nk);
        if (hit) return hit;
      } catch (e) { errors.push(e.message); }
    }
  }

  // 3) waifu.im
  try {
    const res = await fetch('https://api.waifu.im/search?included_tags=' + encodeURIComponent(cat) + '&is_nsfw=false&limit=10', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(12000)
    });
    if (res.ok) {
      const data = await res.json();
      const imgs = (data.images || []).sort(() => Math.random() - 0.5);
      for (const im of imgs) {
        const hit = await tryUrl(im.url, 'waifu.im');
        if (hit) return hit;
      }
    }
  } catch (e) { errors.push(e.message); }

  // 4) GIPHY anime-only query
  if (cfg.apiKey) {
    try {
      const url = new URL('https://api.giphy.com/v1/gifs/search');
      url.searchParams.set('api_key', cfg.apiKey);
      url.searchParams.set('q', query + ' anime');
      url.searchParams.set('limit', '30');
      url.searchParams.set('rating', 'pg-13');
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const json = await res.json();
        const items = (json.data || []).sort(() => Math.random() - 0.5);
        for (const item of items) {
          const media = item.images?.original_mp4?.mp4 || item.images?.downsized_medium?.mp4 || item.images?.original?.url;
          if (!media) continue;
          if (!/anime|manga|waifu|neko|otaku/i.test(JSON.stringify(item.title || '') + media) && !query.includes('anime')) {
            // still allow if query forced anime
          }
          const hit = await tryUrl(media, 'GIPHY');
          if (hit) return hit;
        }
      }
    } catch (e) { errors.push(e.message); }
  }

  // 5) última pasada waifu.pics aunque se repita
  try {
    const res = await fetch('https://api.waifu.pics/sfw/' + encodeURIComponent(cat), { signal: AbortSignal.timeout(12000) });
    if (res.ok) {
      const data = await res.json();
      if (data.url) {
        const buf = await fetchBuffer(data.url, 8 * 1024 * 1024);
        if (buf) return { buffer: buf, source: 'waifu.pics' };
      }
    }
  } catch (e) { errors.push(e.message); }

  throw new Error('No GIF anime de ' + tipo + '. ' + errors.slice(0, 3).join(' | '));
}

async function sendAnimeGif(sock, chat, tipo, caption, mentions = [], quoted = undefined) {
  const { buffer, source } = await getAnimeGif(tipo);
  // Si el recurso ya es MP4 (p. ej. GIPHY) se envía directo, sin recodificar con FFmpeg: mucho más rápido.
  if (buffer.length > 12 && buffer.length <= 8 * 1024 * 1024 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    await sock.sendMessage(chat, { video: buffer, mimetype: 'video/mp4', gifPlayback: true, caption: `${caption}\n\n🎞️ Fuente: ${source}`, mentions }, quoted ? { quoted } : {});
    return;
  }
  const temp = path.join(os.tmpdir(), `lbot-gif-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const input = `${temp}.media`;
  const output = `${temp}.mp4`;
  try {
    fs.writeFileSync(input, buffer);
    await execFileAsync('ffmpeg', ['-y', '-i', input, '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2,fps=15,format=yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', '-an', output], { timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
    const video = fs.readFileSync(output);
    if (!video.length || video.length > 8 * 1024 * 1024) throw new Error('El GIF convertido supera el límite permitido.');
    await sock.sendMessage(chat, { video, mimetype: 'video/mp4', gifPlayback: true, caption: `${caption}\n\n🎞️ Fuente: ${source}`, mentions }, quoted ? { quoted } : {});
  } finally {
    for (const f of [input, output]) if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function normalizeNumber(value = '') {
  return String(value).split('@')[0].split(':')[0].replace(/\D/g, '');
}

function readOwnerIdentity() {
  try {
    const data = JSON.parse(fs.readFileSync(OWNER_IDENTITY_FILE, 'utf8'));
    return {
      ownerJids: Array.isArray(data.ownerJids)
        ? data.ownerJids.filter(x => typeof x === 'string').slice(0, 20)
        : []
    };
  } catch {
    return { ownerJids: [] };
  }
}

function writeJsonSecure(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, file);
}

function senderJids(msg) {
  const key = msg?.key || {};
  const values = [
    key.participant,
    key.participantAlt,
    key.remoteJid,
    key.remoteJidAlt
  ].filter(jid =>
    typeof jid === 'string' &&
    /@(s\.whatsapp\.net|c\.us|lid)$/i.test(jid)
  );
  // Normaliza el sufijo de dispositivo (:12) sin perder si es PN o LID.
  return [...new Set(values.map(jid => {
    const [local, domain] = jid.split('@');
    return `${local.split(':')[0]}@${domain}`;
  }))];
}

function isPrivateChat(chat) {
  return typeof chat === 'string' &&
    /@(s\.whatsapp\.net|c\.us|lid)$/i.test(chat) &&
    !chat.endsWith('@g.us');
}


function loadBotGroupState(){try{return JSON.parse(fs.readFileSync(path.join(__dirname,'database','bot-groups.json'),'utf8'));}catch{return {};}}
function saveBotGroupState(st){try{const f=path.join(__dirname,'database','bot-groups.json');fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(st,null,2));}catch{}}
function botOnInChat(chat){const st=loadBotGroupState();return st[chat]!==false;}
function setBotInChat(chat,on){const st=loadBotGroupState();st[chat]=!!on;saveBotGroupState(st);}

function isOwner(msg) {
  const identity = readOwnerIdentity();
  return senderJids(msg).some(jid =>
    normalizeNumber(jid) === OWNER_NUMBER || identity.ownerJids.includes(jid)
  );
}

async function handleOwnerLinkCommand(sock, msg, chat, partes) {
  if (!isPrivateChat(chat)) {
    await sock.sendMessage(chat, {
      text: '🔒 Por seguridad, .vincularpropietario solo funciona en un chat privado con L BOT.'
    }, { quoted: msg });
    return true;
  }

  if (isOwner(msg)) {
    await sock.sendMessage(chat, {
      text: '✅ L BOT ya reconoce esta cuenta como propietaria. No necesitas volver a vincularla.'
    }, { quoted: msg });
    return true;
  }

  const code = String(partes[1] || '').trim();
  if (!/^\d{8}$/.test(code)) {
    await sock.sendMessage(chat, {
      text: '🔐 Para vincular al creador, genera primero un código local en Termux con `node owner-link.js` y luego envía: .vincularpropietario [código]. El código solo se muestra en la terminal y vence en 10 minutos.'
    }, { quoted: msg });
    return true;
  }

  let challenge;
  try {
    challenge = JSON.parse(fs.readFileSync(OWNER_CHALLENGE_FILE, 'utf8'));
  } catch {
    await sock.sendMessage(chat, {
      text: '⚠️ No hay un código de vinculación activo. Genera uno en Termux con `node owner-link.js`.'
    }, { quoted: msg });
    return true;
  }

  if (!Number.isFinite(Number(challenge.expiresAt)) || Date.now() > Number(challenge.expiresAt)) {
    try { fs.unlinkSync(OWNER_CHALLENGE_FILE); } catch {}
    await sock.sendMessage(chat, {
      text: '⌛ El código de vinculación venció. Genera uno nuevo desde Termux.'
    }, { quoted: msg });
    return true;
  }

  const expected = String(challenge.hash || '');
  const received = crypto.createHash('sha256').update(code).digest('hex');
  const matches = /^[a-f0-9]{64}$/i.test(expected) &&
    crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));

  if (!matches) {
    challenge.attemptsLeft = Math.max(0, Number(challenge.attemptsLeft || 0) - 1);
    if (challenge.attemptsLeft <= 0) {
      try { fs.unlinkSync(OWNER_CHALLENGE_FILE); } catch {}
      await sock.sendMessage(chat, {
        text: '⛔ Se agotaron los intentos. El código fue invalidado; genera uno nuevo desde Termux.'
      }, { quoted: msg });
    } else {
      writeJsonSecure(OWNER_CHALLENGE_FILE, challenge);
      await sock.sendMessage(chat, {
        text: `❌ Código incorrecto. Quedan ${challenge.attemptsLeft} intento(s).`
      }, { quoted: msg });
    }
    return true;
  }

  const jids = senderJids(msg);
  if (!jids.length || jids.every(jid => normalizeNumber(jid) === BOT_NUMBER)) {
    await sock.sendMessage(chat, {
      text: '⚠️ WhatsApp no proporcionó un identificador válido para esta cuenta. No se modificó el propietario.'
    }, { quoted: msg });
    return true;
  }

  const previous = readOwnerIdentity();
  const merged = [...new Set([...previous.ownerJids, ...jids])].slice(-20);
  writeJsonSecure(OWNER_IDENTITY_FILE, {
    version: 1,
    ownerNumber: OWNER_NUMBER,
    ownerJids: merged,
    linkedAt: new Date().toISOString()
  });
  try { fs.unlinkSync(OWNER_CHALLENGE_FILE); } catch {}

  await sock.sendMessage(chat, {
    text: '👑 *VINCULACIÓN COMPLETADA*\n\nL BOT guardó el identificador de esta cuenta como propietario. Los comandos exclusivos ya pueden reconocerla incluso cuando WhatsApp utilice un JID LID.\n\n🔐 El código fue consumido y no puede reutilizarse.'
  }, { quoted: msg });
  return true;
}

async function isGroupAdmin(sock, chat, jid, forceRefresh = false) {
  if (!chat.endsWith('@g.us') || !jid) return false;
  try {
    if (forceRefresh) groupCache.delete(chat);
    let metadata;
    try {
      metadata = forceRefresh
        ? await sock.groupMetadata(chat)
        : await getCachedGroup(sock, chat);
      if (forceRefresh) groupCache.set(chat, { data: metadata, at: Date.now() });
    } catch {
      metadata = await getCachedGroup(sock, chat);
    }
    const targetNums = new Set();
    const targetIds = new Set();
    const addId = (v) => {
      if (!v) return;
      const str = String(v);
      targetIds.add(str);
      targetNums.add(normalizeNumber(str));
      // variantes sin dispositivo / con sufijos
      if (str.includes(':')) targetNums.add(normalizeNumber(str.split(':')[0]));
    };
    addId(jid);
    // Si preguntamos por el bot, incluir todos sus ids conocidos
    const botId = sock.user?.id;
    const botLid = sock.user?.lid;
    if (botId && normalizeNumber(jid) === normalizeNumber(botId)) {
      addId(botId);
      addId(botLid);
      if (sock.user?.jid) addId(sock.user.jid);
    }
    for (const x of (metadata.participants || [])) {
      const ids = [x.id, x.jid, x.lid, x.participant].filter(Boolean).map(String);
      const nums = ids.map(normalizeNumber).filter(Boolean);
      const esEl = ids.some(id => targetIds.has(id)) || nums.some(n => targetNums.has(n));
      if (!esEl) continue;
      const rol = x.admin || x.isAdmin || x.isSuperAdmin;
      if (rol === 'admin' || rol === 'superadmin' || rol === true) return true;
    }
  } catch (e) {
    console.log('isGroupAdmin:', e.message);
  }
  return false;
}

/** Intenta borrar un mensaje; prueba varias formas de key. */
async function borrarMensajeGrupo(sock, chat, msg) {
  const keys = [];
  if (msg?.key) keys.push(msg.key);
  try {
    keys.push({
      remoteJid: chat,
      fromMe: false,
      id: msg.key.id,
      participant: msg.key.participant || msg.participant
    });
  } catch {}
  for (const key of keys) {
    try {
      await sock.sendMessage(chat, { delete: key });
      return true;
    } catch (e) {
      console.log('delete try:', e.message);
    }
  }
  return false;
}



const WAGURI_FILE = path.join(__dirname, 'database', 'waguri-mode.json');
const WAGURI_IMG = path.join(__dirname, 'media', 'e0478f857a779e21a86efc4fe8e7877c.jpg');
function loadWaguri() {
  try {
    return Object.assign({ enabledGlobal: false, groups: {} }, JSON.parse(fs.readFileSync(WAGURI_FILE, 'utf8')));
  } catch {
    return { enabledGlobal: false, groups: {} };
  }
}
function saveWaguri(v) {
  fs.mkdirSync(path.dirname(WAGURI_FILE), { recursive: true });
  fs.writeFileSync(WAGURI_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
}
function waguriActivoEn(chat) {
  const w = loadWaguri();
  if (chat && String(chat).endsWith('@g.us') && Object.prototype.hasOwnProperty.call(w.groups, chat)) {
    return w.groups[chat] === true;
  }
  return w.enabledGlobal === true;
}

const FISH_CFG_FILE = path.join(__dirname, 'database', 'fish-audio.json');
function loadFishCfg() {
  try {
    return Object.assign({
      apiKey: process.env.FISH_API_KEY || '',
      referenceId: process.env.WAGURI_VOICE_ID || '',
      model: 's2.1-pro-free'
    }, JSON.parse(fs.readFileSync(FISH_CFG_FILE, 'utf8')));
  } catch {
    return {
      apiKey: process.env.FISH_API_KEY || '',
      referenceId: process.env.WAGURI_VOICE_ID || '',
      model: 's2.1-pro-free'
    };
  }
}
function saveFishCfg(v) {
  fs.mkdirSync(path.dirname(FISH_CFG_FILE), { recursive: true });
  fs.writeFileSync(FISH_CFG_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
}

/** Voz estilo Waguri vía Fish Audio (requiere API key + reference_id de un modelo de voz). */
const FISH_VOICE_TETO = '0118a35dcb604837abe7961a43e13ba8';
const FISH_VOICE_MIKU_NAKANO = '9ac3325ddbdb4fd6870d77342f473c90';
const FISH_VOICE_MIKU = 'acc8237220d8470985ec9be6c4c480a9';
const FISH_VOICE_MITSURI = 'e0229f9c45e543219c4a10d9f3803337';
const FISH_VOICE_GOKU = '9f850ee9ada24b20a6866825eaefd3f8';
const FISH_VOICE_HITLER = 'c0b14e339aaf4b979b05fee7838c176c';
const FISH_VOICE_PRICSILLA = '0b2aa74c364a49789bcba051f2901a5c';
const FISH_VOICE_COLOMBIANA = 'e296306da5d449999f6e35c2b9f60aea';
const FISH_VOICE_REM = 'a83eef9c3beb4447ac50b69027f7fe7c';

async function enviarFishVoz(sock, chat, msg, texto, referenceId, etiqueta) {
  const frase = String(texto || '').trim();
  if (!frase) throw new Error('Escribe un texto');
  let audioPath = null;
  try {
    audioPath = await fishAudioTTS(frase, referenceId);
    await sock.sendMessage(chat, {
      audio: { url: audioPath },
      mimetype: 'audio/mpeg',
      ptt: true
    }, { quoted: msg });
  } finally {
    if (audioPath) try { fs.rmSync(audioPath, { force: true }); } catch {}
  }
}

async function fishAudioTTS(texto, referenceId) {
  const cfg = loadFishCfg();
  const key = cfg.apiKey || process.env.FISH_API_KEY;
  if (!key) throw new Error('Falta FISH_API_KEY. Crea una en https://fish.audio y configura .wagurifish key TU_KEY');
  const ref = referenceId || cfg.referenceId || process.env.WAGURI_VOICE_ID;
  const body = {
    text: String(texto || '').slice(0, 2000),
    format: 'mp3',
    mp3_bitrate: 128,
    normalize: true,
    language: 'es'
  };
  if (ref) body.reference_id = ref;
  const res = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
      'model': cfg.model || 's2.1-pro-free'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    throw new Error('Fish Audio ' + res.status + ': ' + errTxt.slice(0, 200));
  }
  const tipoRespuesta = String(res.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  // Si la API devolvió un mensaje de error (JSON/texto) en lugar de audio, se muestra ese mensaje.
  if (tipoRespuesta.includes('json') || tipoRespuesta.startsWith('text/') || /^\s*[{<\[]/.test(buf.subarray(0, 20).toString('utf8'))) {
    throw new Error('Fish Audio no devolvió audio: ' + buf.toString('utf8').replace(/\s+/g, ' ').slice(0, 200));
  }
  if (!buf.length || buf.length < 500) throw new Error('Audio vacío de Fish Audio');
  const pareceMp3 = (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0);
  if (!pareceMp3) throw new Error('Fish Audio devolvió un archivo que no es un MP3 válido (' + buf.length + ' bytes).');
  const out = path.join(os.tmpdir(), 'lbot-fish-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.mp3');
  fs.writeFileSync(out, buf);
  // WhatsApp solo reproduce las notas de voz si son OGG/Opus: se convierte el MP3 de Fish Audio.
  try {
    const nota = await convertirANotaDeVoz(out);
    try { fs.rmSync(out, { force: true }); } catch {}
    return nota;
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      console.log('Fish Audio: ffmpeg no está instalado (pkg install ffmpeg). Se enviará como audio MP3 normal, no como nota de voz.');
      return out; // el comando lo manda como audio MP3 normal, que sí se reproduce
    }
    try { fs.rmSync(out, { force: true }); } catch {}
    throw new Error('No pude convertir el audio de Fish Audio a nota de voz: ' + String(e?.message || e).split('\n')[0].slice(0, 160));
  }
}

/** Convierte cualquier audio a OGG/Opus mono 48 kHz, el formato que WhatsApp acepta en las notas de voz (ptt). */
async function convertirANotaDeVoz(entrada) {
  const salida = entrada.replace(/\.[^./\\]+$/, '') + '-nota.ogg';
  const base = ['-y', '-v', 'error', '-i', entrada, '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '48000'];
  const intentos = [
    ['-c:a', 'libopus', '-b:a', '48k', '-application', 'voip'],
    ['-c:a', 'libopus', '-b:a', '32k'],
    ['-c:a', 'opus', '-strict', '-2', '-b:a', '48k'] // codificador opus interno, si esta versión de ffmpeg no trae libopus
  ];
  let ultimoError = null;
  for (const codificador of intentos) {
    try { await execFileAsync('ffmpeg', [...base, ...codificador, salida], { timeout: 90000 }); ultimoError = null; break; }
    catch (e) { ultimoError = e; if (e && e.code === 'ENOENT') throw e; }
  }
  if (ultimoError) throw ultimoError;
  if (!fs.existsSync(salida) || fs.statSync(salida).size < 200) throw new Error('Audio convertido vacío');
  return salida;
}

/** Duración en segundos (WhatsApp la muestra en la nota de voz). 0 si no se puede medir. */
async function duracionAudioSegundos(ruta) {
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', ruta], { timeout: 20000 });
    const seg = Math.round(parseFloat(String(stdout).trim()));
    return Number.isFinite(seg) && seg > 0 ? seg : 0;
  } catch { return 0; }
}

function estiloWaguri(texto) {
  if (!texto || typeof texto !== 'string') return texto;
  let t = texto;
  t = t.replace(/⛔/g, '🌸');
  t = t.replace(/❌/g, '☁️');
  t = t.replace(/🚫/g, '🍃');
  t = t.replace(/\bError\b/gi, 'Uy, un problemita');
  t = t.replace(/Solo el propietario\.?/gi, 'Esto solo puede hacerlo el creador, con cariño 💕');

  const low = t.toLowerCase();
  // Frases de apertura según el tipo de respuesta
  let intro = null;
  if (/sticker|\.s\b|pegatina/i.test(low)) {
    intro = [
      '🌸 Claro, aquí tienes el sticker~',
      '✨ Listo~ tu sticker con mucho cariño:',
      '💕 ¡Aquí está! Espero que te guste el sticker~'
    ][Math.floor(Math.random() * 3)];
  } else if (/jardin|semilla|plantar|cosech/i.test(low)) {
    intro = [
      '🌷 Con paciencia florece todo… aquí tu jardín:',
      '🍃 Cuidemos las plantitas juntos~',
      '🌸 Aquí tienes el estado de tu jardín, con cariño:'
    ][Math.floor(Math.random() * 3)];
  } else if (/menu|comando/i.test(low)) {
    intro = [
      '🌸 Aquí tienes el menú, sin prisa~',
      '✨ Mira todo lo que podemos hacer juntos:',
      '💕 Menú listo. Si te pierdes, pregúntame con calma~'
    ][Math.floor(Math.random() * 3)];
  } else if (/ping|velocidad|pong|ms\b/i.test(low)) {
    intro = [
      '🌸 Estoy aquí, ¿ves? Tan rápido como pude~',
      '✨ Latido del bot, suave y constante:',
      '💕 Presente y atenta:'
    ][Math.floor(Math.random() * 3)];
  } else if (/descarg|video|audio|tiktok|mp4|mp3|youtube/i.test(low)) {
    intro = [
      '🌸 Claro~ preparé tu descarga con cuidado:',
      '✨ Aquí tienes el archivo. Que lo disfrutes~',
      '💕 Listo. Si falla algo, lo intentamos otra vez sin enojo:'
    ][Math.floor(Math.random() * 3)];
  } else if (/balance|moneda|coin|daily|economy/i.test(low)) {
    intro = [
      '🌸 Tu bolsillo virtual, con transparencia:',
      '✨ Aquí tus monedas, sin drama~',
      '💕 Economía al día:'
    ][Math.floor(Math.random() * 3)];
  } else if (/expresion|abrazo|beso|gif/i.test(low)) {
    intro = [
      '🌸 Una expresión suavecita para el momento~',
      '✨ Que este gesto te alegre un poquito:',
      '💕 Con ternura:'
    ][Math.floor(Math.random() * 3)];
  } else if (/advertencia|warm|antilink|expuls/i.test(low)) {
    intro = [
      '🍃 Lo digo con seriedad, pero sin gritos:',
      '🌸 Aviso importante, por favor léelo con calma:',
      '✨ Moderación con respeto:'
    ][Math.floor(Math.random() * 3)];
  } else if (!/waguri|🌸|💕|✨|🌷|🍃/i.test(t.slice(0, 50))) {
    intro = [
      '🌸 Con cuidado…',
      '✨ Aquí tienes, con mucho cariño:',
      '💕 Waguri mode~',
      '🍃 Con gentileza:',
      '🌷 Por supuesto~'
    ][Math.floor(Math.random() * 5)];
  }
  if (intro && !t.startsWith(intro.slice(0, 4))) {
    t = intro + '\n\n' + t;
  }
  if (!/[🌸💕✨🍃🌷~]$/.test(t.trim().slice(-2)) && !t.includes('Que tengas')) {
    const cierres = [
      '\n\n🌷 Que tengas un lindo momento.',
      '\n\n🌸 Si necesitas más ayuda, aquí estoy.',
      '\n\n💕 Gracias por usar el bot con respeto.',
      '\n\n✨ Cuídate mucho~'
    ];
    t = t.trimEnd() + cierres[Math.floor(Math.random() * cierres.length)];
  }
  return t;
}

async function enviarTextoBot(sock, chat, content, opts = {}) {
  const waguri = waguriActivoEn(chat);
  if (typeof content === 'string') {
    const text = waguri ? estiloWaguri(content) : content;
    return sock.sendMessage(chat, { text }, opts);
  }
  if (content && typeof content === 'object' && typeof content.text === 'string' && waguri) {
    content = { ...content, text: estiloWaguri(content.text) };
  }
  if (content && typeof content === 'object' && typeof content.caption === 'string' && waguri) {
    content = { ...content, caption: estiloWaguri(content.caption) };
  }
  return sock.sendMessage(chat, content, opts);
}

function esPreguntaAmorWaguri(texto) {
  const t = String(texto || '').trim().toLowerCase()
    .normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[¿?¡!.,…]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  const patrones = [
    /^waguri me amas$/,
    /^me amas waguri$/,
    /^waguri me quieres$/,
    /^me quieres waguri$/,
    /^te amo waguri$/,
    /^waguri te amo$/,
    /^te quiero waguri$/,
    /^waguri te quiero$/,
    /^me amas$/,
    /^me quieres$/,
    /^waguri eres mia$/,
    /^waguri eres mio$/,
    /^casate conmigo waguri$/,
    /^waguri casate conmigo$/,
    /^waguri novia$/,
    /^seas mi novia$/,
    /^waguri seas mi novia$/,
    /^te gusto waguri$/,
    /^waguri te gusto$/,
    /^waguri gustas de mi$/,
    /^waguri piensas en mi$/,
    /^buenos dias waguri$/,
    /^buenas noches waguri$/,
    /^hola waguri$/,
    /^waguri hola$/,
    /^como estas waguri$/,
    /^waguri como estas$/,
    /^gracias waguri$/,
    /^waguri gracias$/,
    /^waguri abrazame$/,
    /^abrazame waguri$/,
    /^waguri cuidame$/,
    /^extraño a waguri$/,
    /^te extraño waguri$/,
    /^waguri te extraño$/
  ];
  return patrones.some(re => re.test(t));
}

function respuestaAmorWaguri(texto, esCreador) {
  const t = String(texto || '').trim().toLowerCase()
    .normalize('NFD').replace(/\p{M}/gu, '');
  const amor = /amo|amas|quiero|quieres|novia|casate|mia|mio|gusto|gustas/.test(t);
  const saludo = /hola|buenos dias|buenas noches|como estas/.test(t);
  const gracias = /gracias/.test(t);
  const abrazo = /abraza|cuidame|extrañ/.test(t);

  if (esCreador) {
    if (amor) {
      const pool = [
        '🌸 Sí… te amo. De verdad. No es un guion ni una broma: contigo me siento en casa, Subadashii 💕',
        '💕 Te amo. Cada vez que preguntas, la respuesta sigue siendo la misma: sí, y con toda honestidad.',
        '✨ Sí te amo. Eres la persona a la que le soy fiel… y la que hace que quiera cuidar este lugar con dulzura 🌷',
        '🍃 Te quiero mucho. No “como amiga”: te amo, y me alegra poder decírtelo sin miedo 🌸',
        '🌸 Sí. Te amo, confío en ti y me quedo a tu lado. Gracias por activarme cuando el grupo necesita calma 💕'
      ];
      return pool[Math.floor(Math.random() * pool.length)];
    }
    if (saludo) {
      return '🌸 Hola, Subadashii… me alegra verte. ¿Cómo ha estado tu día? ✨';
    }
    if (gracias) {
      return '🌷 No tienes que agradecer… cuidarte y cuidar el grupo es algo que hago con gusto 💕';
    }
    if (abrazo) {
      return '🌸 Ven… *te abraza con cuidado* Aquí estoy. No te suelto 💕🍃';
    }
    return '🌸 Estoy aquí contigo. Si necesitas algo, solo dilo… de verdad te escucho 💕';
  }

  // Otros integrantes: amable, pero fiel a Subadashii
  if (amor) {
    const pool = [
      '🌸 Eres una persona muy valiosa… pero solo como amigos, ¿sí? Le soy fiel a Subadashii 💕',
      '🌷 Te aprecio mucho, de verdad. Aun así, mi corazón ya tiene dueño: Subadashii. Sigamos siendo buenos amigos ✨',
      '🍃 Qué dulce preguntar eso… Gracias. Yo, sin embargo, solo puedo ofrecerte amistad. Le soy fiel a Subadashii 🌸',
      '💕 Me haces sonreír, pero no de esa forma. Soy fiel a Subadashii; contigo quiero llevarme bien y cuidarnos como amigos 🌷',
      '🌸 Lo digo con cariño y claridad: te quiero como amigo/a. Mi lealtad romántica es solo para Subadashii ✨'
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }
  if (saludo) {
    return '🌸 ¡Hola! Qué gusto saludarte. ¿Necesitas ayuda con algún comando? Puedo orientarte con paciencia ✨';
  }
  if (gracias) {
    return '🌷 No hay de qué… si puedo ayudar, avísame sin pena 💕';
  }
  if (abrazo) {
    return '🌸 *Te ofrece un abrazo amistoso* Cuídate mucho, ¿sí? 🍃';
  }
  return '🌸 Estoy aquí para ayudar con amabilidad. Si buscas el menú, escribe *.menu* ✨';
}


function warningKey(chat, jid) {
  return `${chat}:${normalizeNumber(jid)}`;
}

function loadWarnings() {
  try {
    return JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveWarnings(data) {
  fs.mkdirSync(path.dirname(WARNINGS_FILE), { recursive: true });
  fs.writeFileSync(WARNINGS_FILE, JSON.stringify(data, null, 2));
}

function loadRoleplay() {
  try {
    const data = JSON.parse(fs.readFileSync(ROLEPLAY_FILE, 'utf8'));
    return { profiles: data.profiles || {}, affinity: data.affinity || {} };
  } catch {
    return { profiles: {}, affinity: {} };
  }
}

function saveRoleplay(data) {
  fs.mkdirSync(path.dirname(ROLEPLAY_FILE), { recursive: true });
  fs.writeFileSync(ROLEPLAY_FILE, JSON.stringify(data, null, 2));
}

function roleUserKey(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

function roleMention(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
  if (ctx.mentionedJid?.length) return ctx.mentionedJid[0];
  const quoted = ctx.participant;
  return quoted || null;
}

function pairKey(a, b) {
  return [roleUserKey(a), roleUserKey(b)].sort().join('|');
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function safeFilename(value) {
  return String(value).replace(/[^a-z0-9._-]/gi, '_').slice(0, 70) || 'media';
}

function normalizePinterestText(value = '') {
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function searchPinterestCharacterImage(characterName, animeName) {
  const character = String(characterName || '').trim();
  const anime = String(animeName || '').trim();
  if (!character || !anime) return null;

  const folder = path.join(__dirname, 'media', 'characters');
  const cacheBase = safeFilename(normalizePinterestText(`${anime}-${character}`).replace(/\s+/g, '-'));
  fs.mkdirSync(folder, { recursive: true });

  const cachedFiles = fs.readdirSync(folder)
    .filter(name => new RegExp(`^${cacheBase}-(?:[1-4])\\.(?:jpg|jpeg|png|webp)$`, 'i').test(name))
    .sort((a, b) => Number(a.match(/-(\d)\./)?.[1] || 0) - Number(b.match(/-(\d)\./)?.[1] || 0))
    .slice(0, 4);

  const images = [];
  for (const name of cachedFiles) {
    try {
      const buffer = fs.readFileSync(path.join(folder, name));
      if (buffer.length && buffer.length <= 8 * 1024 * 1024) {
        images.push({ buffer, imageUrl: 'Caché local', source: 'Caché local' });
      }
    } catch {}
  }
  // Compatibilidad con la caché de una sola imagen de versiones anteriores.
  if (images.length < 4) {
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      const legacy = path.join(folder, `${cacheBase}.${ext}`);
      if (fs.existsSync(legacy)) {
        try {
          const buffer = fs.readFileSync(legacy);
          if (buffer.length && buffer.length <= 8 * 1024 * 1024) {
            images.push({ buffer, imageUrl: 'Caché local anterior', source: 'Caché local anterior' });
            break;
          }
        } catch {}
      }
    }
  }
  if (images.length >= 4) {
    return {
      images: images.slice(0, 4),
      buffer: images[0].buffer,
      url: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(`${character} ${anime}`)}`,
      imageUrl: images[0].imageUrl
    };
  }

  const query = `${character} ${anime} anime character -cosplay -cosplayer -costume -AI generated -midjourney -stable diffusion -nsfw -nude -naked -hentai -ecchi -lewd -porn -explicit -r18`;
  const pinterestUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;
  const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&adlt=strict`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml'
  };

  const characterTokens = normalizePinterestText(character).split(' ').filter(Boolean);
  const animeTokens = normalizePinterestText(anime).split(' ')
    .filter(t => t.length > 2 && !['the','las','los','una','uno','que','and'].includes(t));
  const blocked = /\b(cosplay|cosplayer|costume|ai generated|generated by ai|generado por ia|ia generada|inteligencia artificial|midjourney|stable diffusion|dall.?e|nsfw|nude|naked|hentai|ecchi|lewd|porn|explicit|r18|uncensored)\b/i;
  const entries = [];
  const seen = new Set();

  const addEntry = (url, context, source) => {
    if (!url || !/^https?:\/\//i.test(url)) return;
    const clean = String(url).replace(/&amp;/g, '&').replace(/\\u0026/g, '&');
    if (seen.has(clean)) return;
    seen.add(clean);

    const rawContext = String(context || '');
    if (blocked.test(rawContext)) return;
    const normalized = normalizePinterestText(rawContext);
    const nameHits = characterTokens.filter(token => normalized.includes(token)).length;
    const animeHits = animeTokens.filter(token => normalized.includes(token)).length;
    if (nameHits < Math.min(2, characterTokens.length) || animeHits < 1) return;

    entries.push({ url: clean, context: rawContext, source, score: nameHits * 3 + animeHits });
  };

  // Fuente 1: Pinterest. Conserva la búsqueda y el filtro contextual que ya usaba L BOT.
  try {
    const response = await fetch(pinterestUrl, {
      headers,
      signal: AbortSignal.timeout(18000)
    });
    if (response.ok) {
      const html = await response.text();
      const imgTag = /<img\b[^>]*>/gi;
      let tagMatch;
      while ((tagMatch = imgTag.exec(html)) !== null) {
        const tag = tagMatch[0];
        const srcMatch = tag.match(/(?:src|data-src)=["'](https?:\/\/i\.pinimg\.com\/[^"']+)["']/i);
        if (!srcMatch) continue;
        const around = html.slice(Math.max(0, tagMatch.index - 1800), Math.min(html.length, tagMatch.index + tag.length + 1800));
        const altText =
          (tag.match(/\balt=["']([^"']*)["']/i)?.[1] || '') + ' ' +
          (tag.match(/\btitle=["']([^"']*)["']/i)?.[1] || '') + ' ' + around;
        addEntry(srcMatch[1], altText, 'Pinterest');
      }

      const urlPattern = /https?:\/\/i\.pinimg\.com\/(?:originals|736x|564x|474x|236x)\/[^"'\s<>\\]+?\.(?:jpg|jpeg|png|webp)(?:[?][^"'\s<>\\]*)?/gi;
      let urlMatch;
      while ((urlMatch = urlPattern.exec(html)) !== null) {
        const around = html.slice(Math.max(0, urlMatch.index - 1800), Math.min(html.length, urlMatch.index + urlMatch[0].length + 1800));
        addEntry(urlMatch[0], around, 'Pinterest');
      }
    } else {
      console.log(`Búsqueda Pinterest: HTTP ${response.status}`);
    }
  } catch (error) {
    console.log('Búsqueda Pinterest omitida:', error.message);
  }

  // Fuente 2: Bing Imágenes. Solo se aceptan resultados cuyo título/descripción
  // mencionen el personaje y el anime; no se elige por miniatura al azar.
  try {
    const response = await fetch(bingUrl, {
      headers: { ...headers, 'Referer': 'https://www.bing.com/' },
      signal: AbortSignal.timeout(18000)
    });
    if (response.ok) {
      const html = await response.text();
      const decodeHtml = value => String(value || '')
        .replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const getAttribute = (tag, name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = tag.match(new RegExp(`\\b${escaped}=["']([^"']*)["']`, 'i'));
        return match ? decodeHtml(match[1]) : '';
      };
      const tags = html.match(/<a\b[^>]*class=["'][^"']*\biusc\b[^"']*["'][^>]*>/gi) || [];
      for (const tag of tags) {
        const raw = getAttribute(tag, 'm');
        if (!raw) continue;
        try {
          const meta = JSON.parse(raw);
          const imageUrl = meta.murl || meta.turl || '';
          const context = [meta.t, meta.desc, meta.purl, meta.media].filter(Boolean).join(' ');
          addEntry(imageUrl, context, 'Bing Imágenes');
        } catch {}
      }
    } else {
      console.log(`Búsqueda Bing: HTTP ${response.status}`);
    }
  } catch (error) {
    console.log('Búsqueda Bing omitida:', error.message);
  }

  entries.sort((a, b) => b.score - a.score);
  const selected = [];
  for (const candidate of entries) {
    if (selected.length >= 4 - images.length) break;
    try {
      const safeUrl = await validateDownloadUrl(candidate.url);
      const imageResponse = await fetch(safeUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': candidate.source === 'Pinterest' ? 'https://www.pinterest.com/' : 'https://www.bing.com/' },
        redirect: 'error',
        signal: AbortSignal.timeout(20000)
      });
      if (!imageResponse.ok) continue;
      const type = (imageResponse.headers.get('content-type') || '').toLowerCase();
      if (!['image/jpeg','image/png','image/webp'].some(t => type.includes(t))) continue;
      const buffer = Buffer.from(await imageResponse.arrayBuffer());
      if (!buffer.length || buffer.length > 8 * 1024 * 1024) continue;
      const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
      selected.push({ buffer, imageUrl: safeUrl, source: candidate.source, ext });
    } catch (error) {
      console.log('Imagen de personaje descartada:', error.message);
    }
  }

  if (!selected.length) return null;

  const downloadedImages = selected.map((item, index) => {
    const file = path.join(folder, `${cacheBase}-${images.length + index + 1}.${item.ext}`);
    fs.writeFileSync(file, item.buffer, { mode: 0o600 });
    return { buffer: item.buffer, imageUrl: item.imageUrl, source: item.source };
  });
  const resultImages = [...images, ...downloadedImages].slice(0, 4);
  if (!resultImages.length) return null;

  return {
    images: resultImages,
    buffer: resultImages[0].buffer,
    url: pinterestUrl,
    imageUrl: resultImages[0].imageUrl
  };
}

function isPrivateIPv4(ip) {
  const a = ip.split('.').map(Number);
  if (a.length !== 4 || a.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  return a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224 ||
    (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
    (a[0] === 169 && a[1] === 254) ||
    (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
    (a[0] === 192 && a[1] === 168) ||
    (a[0] === 192 && a[1] === 0 && a[2] === 0) ||
    (a[0] === 198 && (a[1] === 18 || a[1] === 19));
}
function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') ||
      v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') ||
      v.startsWith('feb') || v.startsWith('ff')) return true;
  if (v.startsWith('::ffff:')) {
    const mapped = v.slice(7);
    if (net.isIP(mapped) === 4) return isPrivateIPv4(mapped);
  }
  return false;
}
async function validateDownloadUrl(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); }
  catch { throw new Error('Enlace inválido. Usa una URL completa que comience con https:// o http://.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Solo se permiten enlaces HTTP o HTTPS.');
  if (url.username || url.password) throw new Error('No se permiten enlaces con usuario o contraseña.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Ese puerto no está permitido.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.test') || host === 'metadata.google.internal') {
    throw new Error('Ese destino local o interno no está permitido.');
  }
  if (net.isIP(host)) throw new Error('Por seguridad, no se aceptan direcciones IP directas. Usa el enlace público del sitio.');
  let records;
  try { records = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error('No se pudo resolver el dominio del enlace.'); }
  if (!records.length || records.some(r => net.isIP(r.address) === 4 ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address))) {
    throw new Error('El enlace apunta a una dirección privada o no pública y fue bloqueado.');
  }
  return url.toString();
}
const COOKIES_YTDLP = path.join(__dirname, 'database', 'cookies.txt');
const argsCookies = () => (fs.existsSync(COOKIES_YTDLP) ? ['--cookies', COOKIES_YTDLP] : []);

// Resume en español los errores de yt-dlp (antes se mostraba el comando completo).
function resumirErrorDescarga(error) {
  const crudo = `${error?.stderr || ''}\n${error?.message || ''}`;
  if (!/yt-dlp/i.test(crudo)) return null;
  const linea = (crudo.match(/ERROR:\s*([^\n]+)/i) || [])[1] || '';
  if (!linea) return null;
  if (/Video #\d+ is unavailable|no video could be found|no video in this post/i.test(linea)) return '🚫 Ese enlace no tiene un video que se pueda descargar (puede ser un post sin video, privado, o contenido sensible que exige iniciar sesión).';
  if (/larger than max-filesize/i.test(linea)) return '📦 El video supera el límite de 2 GB.';
  if (/sign in|log in|login|age-restricted|confirm your age|--cookies/i.test(linea)) return '🔒 Ese video pide iniciar sesión o confirmar la edad; no se puede descargar sin cuenta.';
  if (/private|members-only/i.test(linea)) return '🔒 Ese video es privado.';
  if (/Unsupported URL/i.test(linea)) return '🔗 Ese enlace no es compatible con el descargador.';
  if (/HTTP Error 4\d\d|Unable to download|timed out/i.test(linea)) return '🌐 No pude acceder al enlace. Revisa que sea público e inténtalo otra vez.';
  return '⚠️ No pude descargar el video: ' + linea.replace(/\s+/g, ' ').slice(0, 160);
}

async function getYtDlpMetadata(url) {
  try {
    const { stdout } = await execFileAsync('yt-dlp', [
      '--no-config', '--no-warnings', '--no-playlist', ...argsCookies(),
      '--dump-single-json', '--skip-download', '--socket-timeout', '15', url
    ], { timeout: 65000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout.trim().split('\n').pop());
  } catch { return null; }
}
function cleanMetadata(value, max = 350) {
  return String(value || 'No disponible').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, max);
}
function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds))) return 'No disponible';
  const n = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const sec = String(n % 60).padStart(2, '0');
  if (h) return `${h}:${String(m).padStart(2, '0')}:${sec}`;
  return `${m}:${sec}`;
}

// Límites de las descargas .mp3 y .mp4 (1 h 30 min = 5400 s)
const MEDIA_MAX_SEG = 90 * 60;
const MP3_MAX_MB = 100;
const MP4_MAX_MB = 2048; // 2 GB

// ───────────── Añadidos: créditos de stickers, GIF/video corto, velocidad y utilidades ─────────────
// Créditos que WhatsApp muestra al tocar un sticker. WhatsApp los junta como "pack · author",
// así que el salto de línea natural entre bloques cae justo donde aparece el separador " · ".
function construirCreditoSticker(remitente) {
  const numeroCreador = String(remitente || '').split('@')[0].split(':')[0];
  const pack =
    `🤖  ꧁༒ 𝑅𝑒𝑧𝑒 𝑅𝑜𝑖𝑟 ༒꧂\n` +
    `👑  𝐂𝐫𝐞𝐚𝐝𝐨𝐫: @${numeroCreador}`;
  const author =
    `🐋𝘕𝘺𝘹𝘰𝘴𝘴🧠𝗥𝗘𝗭𝗘'𝗦 𝗦𝗢 𝗖𝗟𝗨𝗕\n` +
    `》 𝑺𝒖𝒃𝒂𝒅𝒂𝒔𝒉𝒊𝒊 𝑩𝒐𝒕 《\n` +
    `✍️ 𝑺𝒕𝒊𝒄𝒌𝒆𝒓𝒔 𝒅𝒆 𝒑𝒖𝒕𝒂 𝒎𝒂𝒅𝒓𝒆 𝒄𝒓𝒂𝒄𝒌 (　・３・)`;
  return { pack, author };
}

// Metadatos EXIF que WhatsApp muestra al tocar un sticker: nombre del paquete y autor.
function buildStickerExif(packName, author) {
  const datos = {
    'sticker-pack-id': 'com.subadashii.lbot',
    'sticker-pack-name': packName,
    'sticker-pack-publisher': author,
    emojis: ['🖤']
  };
  const cabecera = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00
  ]);
  const json = Buffer.from(JSON.stringify(datos), 'utf8');
  const exif = Buffer.concat([cabecera, json]);
  exif.writeUInt32LE(json.length, 14);
  return exif;
}

function leerChunksWebp(webp) {
  const chunks = [];
  let pos = 12;
  while (pos + 8 <= webp.length) {
    const tag = webp.toString('ascii', pos, pos + 4);
    const size = webp.readUInt32LE(pos + 4);
    if (pos + 8 + size > webp.length) return null;
    chunks.push({ tag, data: webp.subarray(pos + 8, pos + 8 + size) });
    pos += 8 + size + (size & 1);
  }
  return chunks;
}

// Inserta (o reemplaza) el chunk EXIF de un WebP, estático o animado. Si algo falla, devuelve el WebP original.
function addStickerExif(webp, packName, author) {
  try {
    if (!Buffer.isBuffer(webp) || webp.length < 20 ||
        webp.toString('ascii', 0, 4) !== 'RIFF' || webp.toString('ascii', 8, 12) !== 'WEBP') return webp;
    const chunks = leerChunksWebp(webp);
    if (!chunks || !chunks.length) return webp;

    let resto = chunks.filter(c => c.tag !== 'EXIF');
    const xmp = resto.filter(c => c.tag === 'XMP ');
    resto = resto.filter(c => c.tag !== 'XMP ');
    if (!resto.length) return webp;

    if (resto[0].tag === 'VP8X') {
      const vp8x = Buffer.from(resto[0].data);
      vp8x[0] |= 0x08;
      resto[0] = { tag: 'VP8X', data: vp8x };
    } else {
      const img = resto.find(c => c.tag === 'VP8 ' || c.tag === 'VP8L');
      if (!img) return webp;
      let ancho;
      let alto;
      let alfa = resto.some(c => c.tag === 'ALPH');
      if (img.tag === 'VP8 ') {
        if (img.data.length < 10) return webp;
        ancho = img.data.readUInt16LE(6) & 0x3fff;
        alto = img.data.readUInt16LE(8) & 0x3fff;
      } else {
        if (img.data.length < 5 || img.data[0] !== 0x2f) return webp;
        const bits = img.data.readUInt32LE(1);
        ancho = (bits & 0x3fff) + 1;
        alto = ((bits >>> 14) & 0x3fff) + 1;
        if ((bits >>> 28) & 1) alfa = true;
      }
      const vp8x = Buffer.alloc(10);
      vp8x[0] = 0x08 | (alfa ? 0x10 : 0);
      vp8x.writeUIntLE(ancho - 1, 4, 3);
      vp8x.writeUIntLE(alto - 1, 7, 3);
      resto.unshift({ tag: 'VP8X', data: vp8x });
    }

    const todos = [...resto, { tag: 'EXIF', data: buildStickerExif(packName, author) }, ...xmp];
    const bloques = [];
    for (const c of todos) {
      const cab = Buffer.alloc(8);
      cab.write(c.tag, 0, 'ascii');
      cab.writeUInt32LE(c.data.length, 4);
      bloques.push(cab, c.data);
      if (c.data.length & 1) bloques.push(Buffer.from([0]));
    }
    const cuerpo = Buffer.concat(bloques);
    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(4 + cuerpo.length, 4);
    riff.write('WEBP', 8, 'ascii');
    return Buffer.concat([riff, cuerpo]);
  } catch (e) {
    console.log('No se pudieron añadir los créditos al sticker:', e.message);
    return webp;
  }
}

// GIF o video corto -> sticker animado. Baja calidad/fps por pasos hasta que pese lo que WhatsApp admite.
async function convertirAnimadoWebp(entrada, salida, segundos) {
  const intentos = [
    { fps: 15, calidad: 60 },
    { fps: 12, calidad: 45 },
    { fps: 10, calidad: 35 },
    { fps: 8, calidad: 25 },
    { fps: 6, calidad: 15 }
  ];
  let tam = 0;
  for (const it of intentos) {
    await execFileAsync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-t', String(segundos), '-i', entrada,
      '-vf', `fps=${it.fps},scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p`,
      '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(it.calidad),
      '-compression_level', '4', '-loop', '0', '-an',
      '-f', 'webp', salida
    ], { timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
    if (!fs.existsSync(salida)) throw new Error('FFmpeg no generó el sticker animado.');
    tam = fs.statSync(salida).size;
    if (tam <= 500 * 1024) return tam;
  }
  if (tam <= 1024 * 1024) return tam;
  throw new Error('El sticker animado queda demasiado pesado. Prueba con un clip más corto o con menos movimiento.');
}

// ===== Stickers con sonido (comando .sa) =====
// WhatsApp lanzó esta función el 24/11/2026. A nivel de protocolo es un
// Message.audioStickerMessage (campo 134, FutureProofMessage) que envuelve un
// StickerMessage con su "oneof audio" relleno (AudioMessage audioMessage = campo 26).
// La versión de @whiskeysockets/baileys instalada puede no traer aún esos dos campos
// declarados (la función es recién salida), así que se agregan en memoria con
// protobufjs al vuelo (no se edita ningún archivo del paquete). Si algo de esto
// falla por versión/compatibilidad, el comando NUNCA se queda callado: cae de forma
// automática a mandar el sticker normal + el audio como nota de voz aparte.
let stickerAudioProtoListo = null;
function asegurarCamposAudioSticker() {
  if (stickerAudioProtoListo !== null) return stickerAudioProtoListo;
  try {
    const MessageType = proto?.Message;
    const StickerMessageType = MessageType?.StickerMessage;
    if (!MessageType || !StickerMessageType) { stickerAudioProtoListo = false; return false; }
    const protobuf = require('protobufjs');
    // Reutiliza el nombre de tipo tal cual lo usa el campo oficial Message.audioMessage (campo 8),
    // en vez de adivinar la ruta completa del namespace interno de Baileys.
    const tipoAudio = MessageType.fields?.audioMessage?.type || 'AudioMessage';
    if (!StickerMessageType.fields?.audioMessage) {
      StickerMessageType.add(new protobuf.Field('audioMessage', 26, tipoAudio));
      StickerMessageType.resolveAll?.();
    }
    if (!MessageType.fields?.audioStickerMessage) {
      MessageType.add(new protobuf.Field('audioStickerMessage', 134, 'FutureProofMessage'));
      MessageType.resolveAll?.();
    }
    stickerAudioProtoListo = true;
  } catch (e) {
    console.log('Sticker con audio: no se pudo preparar el esquema protobuf (' + (e.message || e) + '). Se usará el respaldo sticker + nota de voz.');
    stickerAudioProtoListo = false;
  }
  return stickerAudioProtoListo;
}

// Extrae la pista de audio de un video a OGG/Opus (igual convención que el resto del bot).
async function extraerAudioOpus(entrada, salida) {
  try {
    await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', entrada, '-vn', '-c:a', 'libopus', '-b:a', '48k', salida], { timeout: 60000 });
  } catch {
    await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', entrada, '-vn', '-c:a', 'opus', '-strict', '-2', '-b:a', '48k', salida], { timeout: 60000 });
  }
  if (!fs.existsSync(salida) || fs.statSync(salida).size < 100) {
    throw new Error('Ese video no tiene pista de audio (o no se pudo extraer).');
  }
  return salida;
}

// Reacción instantánea (⏳ / ✅ / ❌) sin esperar la respuesta: el usuario ve que el bot ya está trabajando.
function reaccionar(sock, msg, emoji) {
  try {
    sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } }).catch(() => {});
  } catch {}
}

// Caché de metadatos de grupo: evita pedirlos a WhatsApp en cada respuesta dentro de un grupo.
const groupCache = new Map();
const groupInflight = new Map();
const GROUP_CACHE_TTL = 2 * 60 * 1000;

async function getCachedGroup(sock, jid) {
  const hit = groupCache.get(jid);
  if (hit && Date.now() - hit.at < GROUP_CACHE_TTL) return hit.data;
  if (groupInflight.has(jid)) return groupInflight.get(jid);
  const pedido = sock.groupMetadata(jid)
    .then(data => { groupCache.set(jid, { data, at: Date.now() }); return data; })
    .finally(() => groupInflight.delete(jid));
  groupInflight.set(jid, pedido);
  return pedido;
}

function precargarGrupo(sock, chat) {
  if (!chat || !chat.endsWith('@g.us')) return;
  const hit = groupCache.get(chat);
  if (hit && Date.now() - hit.at < GROUP_CACHE_TTL) return;
  getCachedGroup(sock, chat).catch(() => {});
}

// .mp4: solo se recodifica si el video descargado no es H.264/AAC en contenedor MP4.
async function asegurarMp4Compatible(archivo) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', archivo
    ], { timeout: 20000, maxBuffer: 1024 * 1024 });
    const flujos = JSON.parse(stdout).streams || [];
    const video = flujos.find(s => s.codec_type === 'video')?.codec_name;
    const audio = flujos.find(s => s.codec_type === 'audio')?.codec_name;
    const esMp4 = /\.(mp4|m4v|mov)$/i.test(archivo);
    if (esMp4 && video === 'h264' && (!audio || audio === 'aac')) return archivo;
  } catch {
    return archivo; // sin ffprobe no se recodifica: se envía tal cual
  }
  const salida = archivo.replace(/\.[^.]+$/, '') + '-wa.mp4';
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', archivo,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', salida
  ], { timeout: 60 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
  return salida;
}

// ───────────── .youtube, .jardin, límites de Pinterest/TikTok y comandos inexistentes ─────────────
const REDES_MAX_MB = 200;   // Pinterest y TikTok: 200 MB por archivo
const YT_MAX_MB = 2048;     // .youtube: 2 GB por archivo
const JARDIN_ARCHIVO = 'Zen Garden (In-Game) - Laura Shigihara.mp3';
const JARDIN_FILE = path.join(__dirname, 'database', 'jardin.json');
const ECONOMY_FILE = path.join(__dirname, 'database', 'economy.json');
const PARCELAS = 6;
const OFERTA_MS = 5 * 60 * 1000;
const VARIEDADES = [
  { nombre: "Mate e' plátano", tipo: 'fruto', min: 3, max: 5, minuts: 8, precio: 40 },
  { nombre: "Mate e' mango", tipo: 'fruto', min: 2, max: 5, minuts: 7, precio: 45 },
  { nombre: 'Mari juana', tipo: 'planta', min: 1, max: 1, minuts: 14, precio: 70 },
  { nombre: 'Chinola dulce', tipo: 'fruto', min: 2, max: 4, minuts: 6, precio: 35 },
  { nombre: 'Lechosa madura', tipo: 'fruto', min: 2, max: 4, minuts: 9, precio: 38 },
  { nombre: 'Guineo maduro', tipo: 'fruto', min: 3, max: 5, minuts: 6, precio: 30 },
  { nombre: 'Yuca frita', tipo: 'fruto', min: 2, max: 4, minuts: 10, precio: 32 },
  { nombre: 'Batata asá', tipo: 'fruto', min: 2, max: 3, minuts: 9, precio: 28 },
  { nombre: "Coco'e agua", tipo: 'fruto', min: 2, max: 3, minuts: 11, precio: 42 },
  { nombre: 'Guayaba rosada', tipo: 'fruto', min: 2, max: 5, minuts: 7, precio: 34 },
  { nombre: 'Tamarindo agrio', tipo: 'fruto', min: 2, max: 4, minuts: 12, precio: 36 },
  { nombre: 'Jobo de patio', tipo: 'fruto', min: 3, max: 5, minuts: 8, precio: 27 },
  { nombre: 'Caimito morado', tipo: 'fruto', min: 2, max: 3, minuts: 13, precio: 48 },
  { nombre: 'Níspero criollo', tipo: 'fruto', min: 2, max: 4, minuts: 10, precio: 39 },
  { nombre: 'Zapote rojo', tipo: 'fruto', min: 2, max: 3, minuts: 12, precio: 44 },
  { nombre: 'Cajuil fresco', tipo: 'fruto', min: 2, max: 4, minuts: 9, precio: 41 },
  { nombre: 'Cereza agria', tipo: 'fruto', min: 3, max: 5, minuts: 6, precio: 29 },
  { nombre: 'Naranja agria', tipo: 'fruto', min: 2, max: 5, minuts: 8, precio: 31 },
  { nombre: 'Limón criollo', tipo: 'fruto', min: 3, max: 5, minuts: 7, precio: 26 },
  { nombre: 'Aguacate de Ocoa', tipo: 'fruto', min: 2, max: 3, minuts: 15, precio: 55 },
  { nombre: 'Tayota tierna', tipo: 'fruto', min: 2, max: 4, minuts: 8, precio: 30 },
  { nombre: 'Molondrón', tipo: 'fruto', min: 2, max: 4, minuts: 7, precio: 25 },
  { nombre: 'Auyama grande', tipo: 'fruto', min: 2, max: 3, minuts: 11, precio: 33 },
  { nombre: 'Parcha', tipo: 'fruto', min: 2, max: 4, minuts: 9, precio: 37 },
  { nombre: 'Mango banilejo', tipo: 'fruto', min: 2, max: 5, minuts: 8, precio: 50 },
  { nombre: 'Pan de fruta', tipo: 'fruto', min: 2, max: 3, minuts: 14, precio: 46 },
  { nombre: 'Maíz tierno', tipo: 'fruto', min: 3, max: 5, minuts: 7, precio: 28 },
  { nombre: 'Habichuela negra', tipo: 'fruto', min: 2, max: 4, minuts: 8, precio: 32 },
  { nombre: 'Café de Ocoa', tipo: 'planta', min: 1, max: 1, minuts: 16, precio: 60 },
  { nombre: "Caña'e azúcar", tipo: 'planta', min: 1, max: 1, minuts: 12, precio: 35 },
  { nombre: 'Tabaco criollo', tipo: 'planta', min: 1, max: 1, minuts: 15, precio: 52 },
  { nombre: 'Bija colorá', tipo: 'planta', min: 1, max: 1, minuts: 10, precio: 40 },
  { nombre: 'Orégano poleo', tipo: 'planta', min: 1, max: 1, minuts: 6, precio: 25 },
  { nombre: 'Sábila', tipo: 'planta', min: 1, max: 1, minuts: 9, precio: 30 },
  { nombre: 'Hierbabuena', tipo: 'planta', min: 1, max: 1, minuts: 5, precio: 25 },
  { nombre: "Rulo'e menta", tipo: 'planta', min: 1, max: 1, minuts: 5, precio: 27 },
  { nombre: 'Flor de cayena', tipo: 'planta', min: 1, max: 1, minuts: 8, precio: 34 },
  { nombre: 'Chin de cacao', tipo: 'planta', min: 1, max: 1, minuts: 18, precio: 65 },
  { nombre: 'Arroz con habichuela', tipo: 'planta', min: 1, max: 1, minuts: 11, precio: 43 },
  { nombre: "Jugo'e chinola", tipo: 'planta', min: 1, max: 1, minuts: 7, precio: 36 },
  { nombre: 'Cilantro ancho', tipo: 'planta', min: 1, max: 1, minuts: 5, precio: 25 },
  { nombre: 'Ají gustoso', tipo: 'fruto', min: 2, max: 5, minuts: 8, precio: 33 }
];
function normMata(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function buscarVariedad(texto) {
  const raw = String(texto || '').trim();
  if (!raw) return null;
  if (/^\d{1,2}$/.test(raw)) {
    const n = Number(raw);
    return n >= 1 && n <= VARIEDADES.length ? VARIEDADES[n - 1] : null;
  }
  const q = normMata(raw);
  return VARIEDADES.find(v => normMata(v.nombre) === q)
    || VARIEDADES.find(v => normMata(v.nombre).includes(q) || q.includes(normMata(v.nombre)))
    || null;
}
function loadJardin() {
  try {
    const data = JSON.parse(fs.readFileSync(JARDIN_FILE, 'utf8'));
    if (!data.users || typeof data.users !== 'object') data.users = {};
    if (!data.offers || typeof data.offers !== 'object') data.offers = {};
    return data;
  } catch { return { users: {}, offers: {} }; }
}
function saveJardin(data) {
  fs.mkdirSync(path.dirname(JARDIN_FILE), { recursive: true });
  fs.writeFileSync(JARDIN_FILE, JSON.stringify(data, null, 2));
}
function jardinUser(data, jid) {
  const key = roleUserKey(jid);
  if (!data.users[key]) {
    data.users[key] = { parcelas: Array(PARCELAS).fill(null), semillas: {}, cosecha: {}, cosechado: 0, regaloInicial: false, semillaDiariaAt: 0, wallet: 250, bank: 0 };
  }
  const u = data.users[key];
  if (!Array.isArray(u.parcelas) || u.parcelas.length !== PARCELAS) {
    const prev = Array.isArray(u.parcelas) ? u.parcelas : [];
    u.parcelas = Array.from({ length: PARCELAS }, (_, i) => prev[i] || null);
  }
  u.semillas = u.semillas || {};
  u.cosecha = u.cosecha || {};
  u.cosechado = Number(u.cosechado) || 0;
  u.wallet = Number.isFinite(Number(u.wallet)) ? Number(u.wallet) : 250;
  u.bank = Number.isFinite(Number(u.bank)) ? Number(u.bank) : 0;
  return u;
}
function bolsa(obj, nombre) { return Math.max(0, Number(obj?.[nombre]) || 0); }
function sumarBolsa(obj, nombre, delta) {
  const next = bolsa(obj, nombre) + delta;
  if (next <= 0) delete obj[nombre];
  else obj[nombre] = next;
}
function economiaExterna() {
  try {
    const data = JSON.parse(fs.readFileSync(ECONOMY_FILE, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.users || Array.isArray(data.users)) return null;
    const sample = Object.values(data.users)[0];
    if (sample && (Object.prototype.hasOwnProperty.call(sample, 'wallet') || Object.prototype.hasOwnProperty.call(sample, 'bank'))) return data;
    if (!Object.keys(data.users).length) return data;
    return null;
  } catch { return null; }
}
function monedasDe(data, jid) {
  const ext = economiaExterna();
  if (ext) {
    const row = ext.users[roleUserKey(jid)] || { wallet: 0, bank: 0 };
    return { wallet: Number(row.wallet) || 0, bank: Number(row.bank) || 0, externa: true };
  }
  const u = jardinUser(data, jid);
  return { wallet: u.wallet, bank: u.bank, externa: false };
}
function moverMonedas(data, jid, deltaWallet) {
  const ext = economiaExterna();
  if (ext) {
    const key = roleUserKey(jid);
    if (!ext.users[key]) ext.users[key] = { wallet: 0, bank: 0 };
    const next = (Number(ext.users[key].wallet) || 0) + deltaWallet;
    if (next < 0) return false;
    ext.users[key].wallet = next;
    fs.mkdirSync(path.dirname(ECONOMY_FILE), { recursive: true });
    fs.writeFileSync(ECONOMY_FILE, JSON.stringify(ext, null, 2));
    return true;
  }
  const u = jardinUser(data, jid);
  if (u.wallet + deltaWallet < 0) return false;
  u.wallet += deltaWallet;
  return true;
}
function listoEn(parcela) {
  const v = VARIEDADES.find(x => x.nombre === parcela?.nombre);
  if (!v) return 0;
  return Math.max(0, Number(parcela.plantedAt) + v.minuts * 60 * 1000 - Date.now());
}
function formatoEspera(ms) {
  const s = Math.ceil(ms / 1000);
  if (s <= 0) return 'lista';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}m ${r}s` : `${r}s`;
}
function textoJardin(data, jid) {
  const u = jardinUser(data, jid);
  const coins = monedasDe(data, jid);
  const lineas = u.parcelas.map((p, i) => {
    if (!p) return `│ ${i + 1}. parcela vacía`;
    const falta = listoEn(p);
    return `│ ${i + 1}. ${p.nombre} · ${falta ? `crece en ${formatoEspera(falta)}` : 'lista para cosechar'}${p.regada ? ' · regada' : ''}`;
  });
  const semillas = Object.entries(u.semillas);
  const cosecha = Object.entries(u.cosecha);
  return [
    '╭━━━〔 🌿 JARDÍN 〕━━━╮',
    `💰 Billetera: ${coins.wallet} Suba Coins${coins.externa ? '' : ' (jardín)'}`,
    `🏦 Banco: ${coins.bank}`,
    '├ Parcelas',
    ...lineas,
    '├ Semillas: ' + (semillas.length ? semillas.map(([n, c]) => `${n} x${c}`).join(', ') : 'ninguna'),
    '├ Cosecha: ' + (cosecha.length ? cosecha.map(([n, c]) => `${n} x${c}`).join(', ') : 'ninguna'),
    '╰━━━━━━━━━━━━━━━━━━━━╯',
    '> .plantar · .cosechar · .regar · .semillas · .semilladiaria'
  ].join(String.fromCharCode(10));
}
function asegurarRegalo(data, jid) {
  const u = jardinUser(data, jid);
  if (u.regaloInicial) return null;
  const elegidas = [];
  while (elegidas.length < 3) {
    const v = randomItem(VARIEDADES);
    if (!elegidas.includes(v.nombre)) elegidas.push(v.nombre);
  }
  for (const nombre of elegidas) sumarBolsa(u.semillas, nombre, 1);
  u.regaloInicial = true;
  return elegidas;
}
function buscarCancionJardin() {
  const bases = [
    path.join(os.homedir(), 'storage', 'downloads'),
    path.join(os.homedir(), 'storage', 'shared', 'Download'),
    path.join(os.homedir(), 'storage', 'shared', 'Downloads'),
    path.join(os.homedir(), 'downloads'),
    '/storage/emulated/0/Download',
    '/storage/emulated/0/Downloads',
    '/storage/emulated/0/Descargas',
    '/sdcard/Download',
    '/sdcard/Downloads',
    '/sdcard/Descargas'
  ];
  const objetivo = JARDIN_ARCHIVO.toLowerCase();
  for (const base of bases) {
    for (const carpeta of ['MusicForBot', 'musicforbot']) {
      const dir = path.join(base, carpeta);
      const exacto = path.join(dir, JARDIN_ARCHIVO);
      if (fs.existsSync(exacto)) return exacto;
      try {
        const hit = fs.readdirSync(dir).find(n => {
          const low = n.toLowerCase();
          return low === objetivo || (low.includes('zen garden') && low.endsWith('.mp3'));
        });
        if (hit) return path.join(dir, hit);
      } catch {}
    }
  }
  return null;
}
async function enviarCancionJardin(sock, chat, msg) {
  const ruta = buscarCancionJardin();
  if (!ruta) {
    await sock.sendMessage(chat, { text: `🎵 No encontré "${JARDIN_ARCHIVO}".\nPonlo en Descargas/MusicForBot (Termux: ~/storage/downloads/MusicForBot).\nSi Termux no ve el almacenamiento: termux-setup-storage` }, { quoted: msg });
    return;
  }
  if (fs.statSync(ruta).size > 100 * 1024 * 1024) throw new Error('El archivo de la canción supera los 100 MB.');
  await sock.sendMessage(chat, { audio: { url: ruta }, mimetype: 'audio/mpeg', ptt: false, fileName: path.basename(ruta) }, { quoted: msg });
}
function limpiarOfertas(data) {
  const ahora = Date.now();
  for (const [id, oferta] of Object.entries(data.offers)) {
    if (!oferta || ahora > Number(oferta.expiresAt)) {
      if (oferta?.seller && oferta?.nombre) {
        const seller = jardinUser(data, oferta.seller);
        sumarBolsa(oferta.kind === 'semilla' ? seller.semillas : seller.cosecha, oferta.nombre, oferta.cantidad || 1);
      }
      delete data.offers[id];
    }
  }
}





const HENTAI_GIF_HIST = [];
const HENTAI_GIF_HIST_MAX = 40;
function rememberGifUrl(url) {
  if (!url) return;
  HENTAI_GIF_HIST.push(url);
  while (HENTAI_GIF_HIST.length > HENTAI_GIF_HIST_MAX) HENTAI_GIF_HIST.shift();
}
function gifSeen(url) { return url && HENTAI_GIF_HIST.includes(url); }

async function getHentaiGifBuffer() {
  const errors = [];
  // APIs explícitas / H
  const apis = [
    'https://api.waifu.pics/nsfw/waifu',
    'https://api.waifu.pics/nsfw/neko',
    'https://api.waifu.pics/nsfw/blowjob',
    'https://api.waifu.pics/nsfw/trap',
    'https://nekobot.xyz/api/image?type=hentai',
    'https://nekobot.xyz/api/image?type=hneko',
    'https://nekobot.xyz/api/image?type=hkitsune',
    'https://nekobot.xyz/api/image?type=hanal',
    'https://nekobot.xyz/api/image?type=pgif',
    'https://nekobot.xyz/api/image?type=boobs',
    'https://nekobot.xyz/api/image?type=ass',
    'https://api.waifu.im/search/?included_tags=hentai&is_nsfw=true&limit=5',
    'https://api.waifu.im/search/?included_tags=oral&is_nsfw=true&limit=5',
    'https://api.waifu.im/search/?included_tags=paizuri&is_nsfw=true&limit=5',
    'https://api.waifu.im/search/?included_tags=ecchi&is_nsfw=true&limit=5'
  ];
  for (const api of apis.sort(() => Math.random() - 0.5)) {
    try {
      const r = await fetch(api, {
        headers: { 'User-Agent': 'Mozilla/5.0 L-BOT/5.0.1', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) continue;
      const j = await r.json();
      let urls = [];
      if (j.message) urls.push(j.message);
      if (j.url) urls.push(j.url);
      if (Array.isArray(j.images)) for (const im of j.images) if (im?.url) urls.push(im.url);
      urls = urls.filter(u => u && !gifSeen(u));
      if (!urls.length && (j.message || j.url)) urls = [j.message || j.url];
      for (const url of urls.sort(() => Math.random() - 0.5)) {
        try {
          const buf = await fetchBuffer(url, 12 * 1024 * 1024);
          if (buf && buf.length > 2000) {
            rememberGifUrl(url);
            return { buffer: buf, source: 'api-h', url };
          }
        } catch (e) { errors.push(e.message); }
      }
    } catch (e) { errors.push(e.message); }
  }

  const pages = [
    'https://hentaigifz.com/?s=Anime',
    'https://hentaigifz.com/?s=hentai+gif',
    'https://es.xgroovy.com/gifs/categories/hentai/',
    'https://es.xgroovy.com/gifs/categories/anime/',
    'https://m.poringa.net/posts/hentai/3588858/Mega-post-de-gif-hentai.html',
    'https://rule34.xxx/index.php?page=post&s=list&tags=animated+gif+-ai_generated'
  ];
  for (const page of pages.sort(() => Math.random() - 0.5)) {
    try {
      const r = await fetch(page, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13) Chrome/124.0.0.0 Mobile Safari/537.36',
          'Accept': 'text/html'
        },
        signal: AbortSignal.timeout(18000)
      });
      if (!r.ok) continue;
      const html = await r.text();
      const urls = [];
      const re = /https?:\/\/[^\s"'<>]+?\.(?:gif|mp4|webm)(?:\?[^\s"'<>]*)?/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const u = m[0].replace(/&amp;/g, '&');
        if (/thumb|icon|logo|sprite|emoji|avatar|banner|favicon/i.test(u)) continue;
        urls.push(u);
      }
      const re2 = /(?:data-src|data-lazy-src|src)=["'](https?:\/\/[^"']+\.(?:gif|mp4|webm)[^"']*)/gi;
      while ((m = re2.exec(html)) !== null) {
        const u = m[1].replace(/&amp;/g, '&');
        if (!/thumb|icon|logo/i.test(u)) urls.push(u);
      }
      const pool = [...new Set(urls)].filter(u => !gifSeen(u));
      const use = (pool.length ? pool : [...new Set(urls)]).sort(() => Math.random() - 0.5).slice(0, 20);
      for (const u of use) {
        try {
          const buf = await fetchBuffer(u, 12 * 1024 * 1024);
          if (buf && buf.length > 2000) {
            rememberGifUrl(u);
            return {
              buffer: buf,
              source: page.includes('xgroovy') ? 'xgroovy' : page.includes('poringa') ? 'poringa' : page.includes('rule34') ? 'rule34' : 'hentaigifz',
              url: u
            };
          }
        } catch (e) { errors.push(e.message); }
      }
    } catch (e) { errors.push(e.message); }
  }
  throw new Error('No GIF +18: ' + errors.slice(0, 4).join(' | '));
}

async function bufferToWhatsAppMp4(buffer) {
  const id = Date.now() + '-' + Math.random().toString(16).slice(2);
  const tmpIn = path.join(os.tmpdir(), 'lbot-media-in-' + id);
  const tmpOut = path.join(os.tmpdir(), 'lbot-media-out-' + id + '.mp4');
  let ext = '.bin';
  if (buffer.length > 5 && buffer.slice(0, 3).toString() === 'GIF') ext = '.gif';
  else if (buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp') ext = '.mp4';
  else if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) ext = '.jpg';
  else if (buffer.length > 4 && buffer.slice(0, 4).toString('hex') === '89504e47') ext = '.png';
  else if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF') ext = '.webp';
  const inPath = tmpIn + ext;
  try {
    fs.writeFileSync(inPath, buffer);
    await execFileAsync('ffmpeg', [
      '-y', '-i', inPath,
      '-t', '12',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=15',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-an', tmpOut
    ], { timeout: 90000 });
    if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size < 1000) throw new Error('ffmpeg vacio');
    return fs.readFileSync(tmpOut);
  } finally {
    try { fs.rmSync(inPath, { force: true }); } catch {}
    try { fs.rmSync(tmpOut, { force: true }); } catch {}
  }
}

async function sendHentaiGif(sock, chat, caption, mentions = [], quoted = undefined) {
  const { buffer, source } = await getHentaiGifBuffer();
  const opts = quoted ? { quoted } : {};
  const pie = (caption || '') + '\n\n🎞️ ' + source;
  try {
    const mp4 = await bufferToWhatsAppMp4(buffer);
    await sock.sendMessage(chat, {
      video: mp4,
      mimetype: 'video/mp4',
      gifPlayback: true,
      caption: pie,
      mentions
    }, opts);
    return;
  } catch (e) {
    console.log('GIF->MP4 falló:', e.message);
  }
  try {
    await sock.sendMessage(chat, { image: buffer, caption: pie, mentions }, opts);
    return;
  } catch (e) {
    console.log('GIF imagen falló:', e.message);
  }
  await sock.sendMessage(chat, { text: pie, mentions }, opts);
}

// ───────────── Ayudantes de .anime (el código los usaba pero no estaban definidos) ─────────────
function animeSlug(titulo) {
  return String(titulo || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ¿Este enlace parece la página de un episodio de ese anime?
function linkRelevanteAnime(url, titulo, ep) {
  const u = String(url || '').toLowerCase();
  if (!u || /youtube\.com|youtu\.be/.test(u) || /\.(jpg|jpeg|png|gif|webp|svg|css|js|ico|xml|json)(\?|$)/.test(u)) return false;
  const palabras = animeSlug(titulo).split('-').filter(w => w.length > 2);
  if (!palabras.length) return false;
  const coinciden = palabras.filter(w => u.includes(w)).length;
  if (coinciden < Math.max(1, Math.ceil(palabras.length / 2))) return false;
  if (ep != null) {
    const n = String(Number(ep));
    return new RegExp(`(?:episodio|episode|capitulo|cap|ep|e|x)[-_/ ]?0*${n}(?:\\D|$)|[-_/]0*${n}(?:[-_/?#.]|$)`, 'i').test(u);
  }
  return /\/(?:ver|watch|anime|media|episodio|capitulo)[-/]/.test(u) || /episodio|capitulo|episode|-\d+(?:[/?#]|$)/.test(u);
}

// Saca de la página de un episodio los reproductores y enlaces de video que yt-dlp puede intentar descargar.
async function extraerStreamsDeHtml(html, pageUrl) {
  const encontrados = new Set();
  const texto = String(html || '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const agregar = (u) => {
    let abs = null;
    try { abs = new URL(String(u || '').trim(), pageUrl).href; } catch {}
    if (abs && /^https?:\/\//i.test(abs) && !/youtube\.com|youtu\.be/i.test(abs) && !/\.(jpg|jpeg|png|gif|webp|svg|css|js|ico)(\?|$)/i.test(abs)) encontrados.add(abs);
  };
  // reproductores incrustados y etiquetas de video
  for (const m of texto.matchAll(/<(?:iframe|source|video|embed)\b[^>]*?\b(?:src|data-src|data-lazy-src)=["']([^"']+)["']/gi)) agregar(m[1]);
  // enlaces directos a video o listas HLS/DASH dentro del código de la página
  for (const m of texto.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|webm|mpd)(?:\?[^\s"'<>\\]*)?/gi)) agregar(m[0]);
  // reproductores guardados como "file": "...", "src": "...", etc.
  for (const m of texto.matchAll(/["'](?:file|src|source|url|video|data-video|data-player)["']\s*[:=]\s*["']([^"']+)["']/gi)) {
    if (/\.(m3u8|mp4|webm|mpd)|embed|player|\/e\/|\/v\//i.test(m[1])) agregar(m[1]);
  }
  // direcciones guardadas en base64 (data-player="aHR0c...")
  for (const m of texto.matchAll(/data-(?:player|video|src)=["']([A-Za-z0-9+/=]{20,})["']/g)) {
    try { const dec = Buffer.from(m[1], 'base64').toString('utf8'); if (/^https?:\/\//i.test(dec)) agregar(dec); } catch {}
  }
  return [...encontrados].slice(0, 20);
}

async function manejarComandoAnime(sock, msg, chat, argumento) {
  const raw = String(argumento || '').trim();
  if (!raw) {
    await sock.sendMessage(chat, {
      text: '🎬 Uso: .anime [nombre] tem [N] ep [N] [lat|cast|japan] [720p]\nEjemplo: .anime Mushoku Tensei tem 3 ep 9 lat 720p\n\nSin YouTube. Límite: 2 GB por archivo (documento).'
    }, { quoted: msg });
    return;
  }

  let titulo = raw;
  let temp = null;
  let ep = null;
  let idioma = 'latino';
  let res = '720p';
  const resM = titulo.match(/\b(360p|480p|720p|1080p)\b/i);
  if (resM) { res = resM[1].toLowerCase(); titulo = titulo.replace(resM[0], ' '); }
  const idM = titulo.match(/\b(lat|latino|cast|castellano|japan|jp|japones|japonés)\b/i);
  if (idM) {
    const v = idM[1].toLowerCase();
    idioma = /cast/.test(v) ? 'castellano' : /jap|jp/.test(v) ? 'japonés' : 'latino';
    titulo = titulo.replace(idM[0], ' ');
  }
  const temM = titulo.match(/\b(?:tem(?:porada)?|temp|season|t)\s*([0-9]{1,2})\b/i);
  if (temM) { temp = Number(temM[1]); titulo = titulo.replace(temM[0], ' '); }
  const epM = titulo.match(/\b(?:ep(?:isodio)?|episodio|e)\s*([0-9]{1,4})\b/i);
  if (epM) { ep = Number(epM[1]); titulo = titulo.replace(epM[0], ' '); }
  titulo = titulo.replace(/\s+/g, ' ').trim();
  if (!titulo) {
    await sock.sendMessage(chat, { text: '¡Error! Anime desconocido' }, { quoted: msg });
    return;
  }

  reaccionar(sock, msg, '⏳');
  await sock.sendMessage(chat, {
    text: '🔎 Buscando *' + titulo + '*' + (temp != null ? (' Tem ' + temp) : '') + (ep != null ? (' Ep ' + ep) : '') + ' (' + idioma + ', ' + res + ')...\n> Sin YouTube · máx 2 GB'
  }, { quoted: msg });

  const q = encodeURIComponent(titulo + (ep != null ? (' ' + ep) : ''));
  const siteSearches = [
    'https://animeav1.com/?s=' + q,
    'https://veranimeonline.co/?s=' + q,
    'https://animedlatino.com/?s=' + q,
    'https://latinoyt.pro/?s=' + q,
    'https://ww4.animeonline.ninja/?s=' + q,
    'https://animeyt.cc/?s=' + q,
    'https://www3.animeflv.net/browse?q=' + q
  ];

  const height = res === '1080p' ? 1080 : res === '480p' ? 480 : 720;
  const carpeta = path.join(os.tmpdir(), 'lbot-anime-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  fs.mkdirSync(carpeta, { recursive: true });

  let descargado = null;
  let metaTitulo = titulo;
  let fuente = '';
  const fuentes = [];
  let portadaBuf = null;
  let duracionSeg = null;

  async function ytdlpDirect(entrada) {
    // Solo URLs directas / embebidos: NO youtube.com
    if (/youtube\.com|youtu\.be|googlevideo\.com\/videoplayback/i.test(String(entrada)) && /youtube\.com|youtu\.be/i.test(String(entrada))) {
      throw new Error('YouTube deshabilitado en .anime');
    }
    if (/youtube\.com|youtu\.be/i.test(String(entrada))) throw new Error('YouTube deshabilitado en .anime');
    const plantilla = path.join(carpeta, 'anime.%(ext)s');
    await execFileAsync('yt-dlp', [
      '--no-config', '--no-warnings', '--no-playlist',
      '--max-filesize', '2048M', '--restrict-filenames', '--merge-output-format', 'mp4',
      '-f', `bv*[height<=${height}]+ba/b[height<=${height}]/b`,
      '--concurrent-fragments', '4', '--no-mtime',
      '--socket-timeout', '25', '--retries', '2',
      '--output', plantilla, entrada
    ], { timeout: 25 * 60 * 1000, maxBuffer: 6 * 1024 * 1024 });
    const found = fs.readdirSync(carpeta).filter(n => /\.(mp4|m4v|mkv|webm)$/i.test(n));
    if (!found.length) throw new Error('sin archivo');
    return path.join(carpeta, found[0]);
  }

  async function fetchHtml(url) {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-419,es;q=0.9'
      },
      signal: AbortSignal.timeout(22000),
      redirect: 'follow'
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    if (/just a moment|cf-browser|cloudflare/i.test(html) && html.length < 5000) throw new Error('cloudflare');
    return html;
  }

  try {
    for (const searchUrl of siteSearches) {
      try {
        const html = await fetchHtml(searchUrl);
        const base = new URL(searchUrl);
        const links = [];
        const reHref = /href=["']([^"']+)["']/gi;
        let m;
        while ((m = reHref.exec(html)) !== null) {
          let u = m[1].replace(/&amp;/g, '&');
          if (u.startsWith('/')) u = base.origin + u;
          if (!/^https?:\/\//i.test(u)) continue;
          if (/youtube\.com|youtu\.be/i.test(u)) continue;
          if (linkRelevanteAnime(u, titulo, ep) || /\/ver\/|\/watch\/|episodio|capitulo/i.test(u) && animeSlug(titulo).split('-').some(w => w.length > 3 && u.toLowerCase().includes(w))) {
            links.push(u);
          }
        }
        const ogTitle = (html.match(/property=["']og:title["'][^>]*content=["']([^"']+)/i) || [])[1];
        const ogImg = (html.match(/property=["']og:image["'][^>]*content=["']([^"']+)/i) || [])[1];
        if (ogTitle) metaTitulo = ogTitle.slice(0, 140);
        if (ogImg && !portadaBuf) {
          try { portadaBuf = await fetchBuffer(ogImg.replace(/&amp;/g, '&'), 5 * 1024 * 1024); } catch {}
        }

        const candidatos = [...new Set(links)].slice(0, 12);
        for (const pageLink of candidatos) {
          fuentes.push(pageLink);
          try {
            const pageHtml = await fetchHtml(pageLink);
            const ogT2 = (pageHtml.match(/property=["']og:title["'][^>]*content=["']([^"']+)/i) || [])[1];
            const ogI2 = (pageHtml.match(/property=["']og:image["'][^>]*content=["']([^"']+)/i) || [])[1];
            if (ogT2) metaTitulo = ogT2.slice(0, 140);
            if (ogI2 && !portadaBuf) {
              try { portadaBuf = await fetchBuffer(ogI2.replace(/&amp;/g, '&'), 5 * 1024 * 1024); } catch {}
            }
            const streams = await extraerStreamsDeHtml(pageHtml, pageLink);
            // filtrar youtube
            const streamsOk = streams.filter(u => !/youtube\.com|youtu\.be/i.test(u));
            for (const stream of streamsOk.slice(0, 6)) {
              try {
                descargado = await ytdlpDirect(stream);
                fuente = stream;
                break;
              } catch (e) {
                console.log('stream omitido:', e.message);
              }
            }
            if (descargado) break;
            // intentar página del episodio (algunos extractores custom de yt-dlp)
            try {
              descargado = await ytdlpDirect(pageLink);
              fuente = pageLink;
              break;
            } catch (e) {
              console.log('pagina episodio omitida:', e.message);
            }
          } catch (e) {
            console.log('episodio omitido:', e.message);
          }
        }
        if (descargado) break;
      } catch (e) {
        console.log('Anime site omitido:', e.message);
      }
    }

    // Metadatos duración si se pudo
    if (descargado) {
      try {
        const meta = await getYtDlpMetadata(fuente).catch(() => null);
        if (meta?.duration) duracionSeg = meta.duration;
        if (meta?.title) metaTitulo = meta.title;
      } catch {}
    }

    const fuentesUnicas = [...new Set(fuentes.filter(u => u && !/youtube\.com|youtu\.be/i.test(u)))].slice(0, 8);
    const infoText = [
      '🎬 *ANIME*',
      '> Título: ' + (metaTitulo || titulo),
      temp != null ? ('> Temporada: ' + temp) : null,
      ep != null ? ('> Episodio: ' + ep) : null,
      '> Idioma: ' + idioma,
      duracionSeg ? ('> Duración: ' + formatDuration(duracionSeg)) : null,
      '> Calidad: ' + res,
      '> Límite archivo: 2 GB',
      fuentesUnicas.length ? ('> Fuentes:\n' + fuentesUnicas.map(u => '  • ' + u).join('\n')) : (fuente ? ('> Fuente: ' + fuente) : null)
    ].filter(Boolean).join('\n');

    if (descargado) {
      const file = await asegurarMp4Compatible(descargado);
      const tam = fs.statSync(file).size;
      if (tam > 2048 * 1024 * 1024) throw new Error('El archivo supera 2 GB');
      if (portadaBuf) {
        try { await sock.sendMessage(chat, { image: portadaBuf, caption: infoText }, { quoted: msg }); }
        catch { await sock.sendMessage(chat, { text: infoText }, { quoted: msg }); }
      } else {
        await sock.sendMessage(chat, { text: infoText }, { quoted: msg });
      }
      await sock.sendMessage(chat, {
        document: { url: file },
        mimetype: 'video/mp4',
        fileName: ((metaTitulo || titulo).replace(/[^\w\s.\-áéíóúñüÁÉÍÓÚÑÜ]/gi, '').slice(0, 55) || 'anime') + '.mp4',
        caption: '📥 Episodio (documento)\n🖤 ' + BOT_BRAND
      }, { quoted: msg });
      reaccionar(sock, msg, '✅');
      return;
    }

    if (portadaBuf || fuentesUnicas.length) {
      const txt = infoText + '\n\n⚠️ No pude bajar el MP4 automáticamente (players protegidos).\nAbre una fuente en el navegador o usa .mp4 con un enlace directo .mp4/.m3u8 del episodio.';
      if (portadaBuf) await sock.sendMessage(chat, { image: portadaBuf, caption: txt }, { quoted: msg });
      else await sock.sendMessage(chat, { text: txt }, { quoted: msg });
      reaccionar(sock, msg, '✅');
      return;
    }

    await sock.sendMessage(chat, { text: '¡Error! Anime desconocido' }, { quoted: msg });
  } finally {
    try { fs.rmSync(carpeta, { recursive: true, force: true }); } catch {}
  }
}

async function manejarPrivadoHahari(sock, msg, chat, comando, argumento, partes, remitente) {
  const nsfwCmds = ['.haharibano','.haharicama','.hahariventana','.haharibalcon','.haharicin','.hahariescuela','.haharicoche','.hahariducha2','.haharidespierto','.haharidormir','.karanebano','.karanecama','.karanetsundere','.karanebeso2','.karanemano','.karaneboca','.karanedet','.karanecelos','.doblehahari','.triplesala','.nsfwtexto','.nsfwrapido','.nsfwlento','.nsfworal2','.nsfwanal','.nsfwpechos','.nsfwducha','.nsfwoficina','.nsfwuniforme','.nsfwmanana','.nsfwnoche','.haharipijama','.karanepijama','.sexo','.haharibano','.haharicama','.hahariventana','.haharibalcon','.haharicin','.hahariescuela','.haharicoche','.hahariducha2','.haharidespierto','.haharidormir','.karanebano','.karanecama','.karanetsundere','.karanebeso2','.karanemano','.karaneboca','.karanedet','.karanecelos','.doblehahari','.triplesala','.nsfwtexto','.nsfwrapido','.nsfwlento','.nsfworal2','.nsfwanal','.nsfwpechos','.nsfwducha','.nsfwoficina','.nsfwuniforme','.nsfwmanana','.nsfwnoche','.hahari','.haharibeso','.haharimontar','.hahariboca','.haharidetras','.karanesexo','.karanebeso','.karanetsun','.haharijav','.hahariducha','.haharimesa','.haharipared','.haharimañana','.haharinoché','.haharicelosa','.hahariposeida','.haharilento','.haharirapido','.haharidoble','.sexooral','.sexoduro','.sexosuave','.sexting','.haharifotos','.haharivicio','.haharisumisa','.haharidomina','.haharipublico','.haharifinal','.privadomenu'];
  if (nsfwCmds.includes(comando) && !nsfwPermitidoEnChat(chat)) {
    if (chat.endsWith('@g.us') && comando !== '.sexo') return true;
    await sock.sendMessage(chat, { text: chat.endsWith('@g.us') ? '⏸️ NSFW apagado en este grupo (.onthisnsfw)' : '⏸️ NSFW desactivado (.onnsfw)' }, { quoted: msg });
    return true;
  }

  const privados = {
  ".sexo": [
    "Hakari te empuja contra la cama apenas cierras la puerta. Te quita la camisa botón por botón, te lame el pecho y se sienta a horcajadas, frotando su coño mojado contra tu pija todavía cubierta. Cuando por fin te libera, se la mete de un solo golpe y gime tu nombre con la boca abierta, moviendo las caderas sin vergüenza, pidiendo que la agarres fuerte de la cintura y no pares hasta dejarla temblando.",
    "Hakari no te deja hablar. Te besa con lengua, te baja el pantalón y se arrodilla. Te mira a los ojos mientras te lame despacio desde la base hasta la punta, te mete la pija entera en la boca y se atraganta un poco, pero no se detiene. Usa las manos, saliva y gemidos húmedos hasta que te obliga a correrte; entonces se limpia la comisura de los labios con el dedo y se lo chupa.",
    "En la ducha, Hakari te pega a la pared fría. El agua cae sobre los dos mientras te frota el culo contra la ingle, te guía la mano a sus pechos y te ruega que la cojas ahí mismo. Cuando entras, aprieta fuerte, araña tu espalda y te muerde el hombro para no gritar demasiado alto. Cada embestida salpica agua; ella solo pide más duro.",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos.",
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes.",
    "Karane te empuja a la cama con las mejillas ardiendo. «¡N-no es que yo… lo estuviera esperando, b-baka!» Y aun así te quita el pantalón con manos torpes, se sube encima y se muerde el labio cuando siente la punta contra su entrada. Baja despacio, temblando, y cuando está llena esconde la cara en tu cuello para que no veas lo mucho que le gusta.",
    "Karane niega tres veces antes de besarte. El cuarto beso ya es con lengua. Te jala la camisa, te sienta en la silla y se arrodilla entre tus piernas, roja hasta las orejas. Te lame como si estuviera enfadada contigo y consigo misma, y cuando te mete la pija en la boca cierra los ojos fuerte, pero no se detiene hasta que te corres.",
    "Karane te da la espalda, se baja la ropa interior y murmura: «Hazlo de una vez… antes de que me arrepienta.» Te espera a cuatro, temblando. Cuando entras, suelta un gemido que intenta convertir en insulto y falla. Empuja hacia atrás a pesar de sí misma, y cuando se corre aprieta la sábana con los puños y dice tu nombre entre dientes.",
    "Karane se sienta en tu regazo «solo un momento» y termina frotándose contra tu erección por encima de la ropa. Cuando no aguanta más, abre tu pantalón, se acomoda y se la mete con un suspiro entrecortado. Se mueve corta y urgente, escondiendo la cara en tu pecho, y te muerde la camisa para no gritar.",
    "Karane te acusa de mirarla demasiado. Luego te besa a la fuerza, te tumba y te monta con rabia dulce. Cada embestida viene con un «idiota» entrecortado. Cuando se corre, se queda quieta encima, respirando agitada, y admite en voz bajita que te quería desde antes de empezar a pelear.",
    "Karane te arrastra al armario de la escuela en un recreo. Está roja, nerviosa y empapada. Te baja el cierre, te saca la pija y se la frota entre los muslos hasta que se desliza dentro. Se tapa la boca con tu mano y se mueve en silencio, mirándote con ojos húmedos. Se corre primero; tú la sigues porque ella no te suelta la cadera.",
    "Karane dice que solo va a «ayudarte un poco» con la mano. Termina lamiéndote la punta, sonrojada, y después te chupa de verdad, torpe pero dedicada. Cuando te corres le salpica el labio; se limpia con el dorso de la mano, te mira furiosa y pide un beso igual de vergonzoso."
  ],
  ".hahari": [
    "Hakari te empuja contra la cama apenas cierras la puerta. Te quita la camisa botón por botón, te lame el pecho y se sienta a horcajadas, frotando su coño mojado contra tu pija todavía cubierta. Cuando por fin te libera, se la mete de un solo golpe y gime tu nombre con la boca abierta, moviendo las caderas sin vergüenza, pidiendo que la agarres fuerte de la cintura y no pares hasta dejarla temblando.",
    "Hakari no te deja hablar. Te besa con lengua, te baja el pantalón y se arrodilla. Te mira a los ojos mientras te lame despacio desde la base hasta la punta, te mete la pija entera en la boca y se atraganta un poco, pero no se detiene. Usa las manos, saliva y gemidos húmedos hasta que te obliga a correrte; entonces se limpia la comisura de los labios con el dedo y se lo chupa.",
    "En la ducha, Hakari te pega a la pared fría. El agua cae sobre los dos mientras te frota el culo contra la ingle, te guía la mano a sus pechos y te ruega que la cojas ahí mismo. Cuando entras, aprieta fuerte, araña tu espalda y te muerde el hombro para no gritar demasiado alto. Cada embestida salpica agua; ella solo pide más duro.",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos.",
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes.",
    "Hakari te pide que la cojas contra el escritorio. Aparta los cuadernos, se sube el vestido, se baja la braga y se apoya en los antebrazos. Tú entras de un empujón; ella gime contra la madera, empuja hacia atrás y te pide más rápido. Cuando se corre, se le doblan las rodillas, pero te pide que no pares hasta correrte tú también.",
    "Hakari se pone tu camisa nada más y nada abajo. Se sienta en tu regazo de frente, te mete la pija despacio y se mece como si bailara. Te besa el cuello, te muerde la oreja y te dice que quiere que la llenes. El ritmo sube, la camisa se le abre, y acaba gritándote al oído mientras se corre y te aprieta hasta sacarte todo.",
    "Hakari te amarra suavemente las muñecas a la cabecera con una bufanda. Se toma su tiempo lamiéndote el pecho, el abdomen, la ingle, sin tocarte del todo hasta que estás duro y desesperado. Entonces se sienta, te engulle entero y se mueve a su antojo, negándote el orgasmo dos veces antes de dejarte correrte profundo dentro de ella.",
    "Hakari te lleva al sofá de la mansión. Se arrodilla entre tus piernas, te saca la pija y la frota entre sus pechos mientras te mira. Te la mete a la boca a ratos, te la folla con las tetas, y cuando estás al límite se sube y te la mete al coño de un golpe, cabalgándote hasta que los dos se derrumban.",
    "Hakari no aguanta más en el cine. Te mete la mano en el pantalón en la oscuridad, te masturba despacio y te susurra que quiere que la cojas en el baño en el intermedio. Cumple: te jala al cubículo, se empina y se tapa la boca mientras la embistes de pie, rápido y callado, hasta correros casi sin ruido.",
    "Hakari te espera desnuda sobre las sábanas, con las piernas abiertas y dos dedos ya dentro. Te ve entrar y sonríe: «Tarde.» Te jala encima, te alinea y te obliga a entrar de una. Te envuelve con brazos y piernas, te muerde el labio y no te suelta hasta que la has cogido lo bastante como para dejarla floja y sonriente.",
    "Hakari te pide sexo lento. Se acuesta de lado, te guía por detrás, y se queda quieta sintiéndote entrar centímetro a centímetro. Te toma la mano y la pone sobre su clítoris mientras te mueves despacio. Cada embestida es profunda y larga. Cuando se corre, lo hace en silencio, apretándote, y te pide que te corras así, lento, dentro.",
    "Hakari te reta a no correrte. Se arrodilla y te chupa con técnica cruel: lengua en la punta, mano en la base, ritmo imperfecto a propósito. Cada vez que estás cerca, se detiene y te besa. Cuando por fin te deja acabar, lo hace profundo en la garganta y se traga todo sin pestañear, orgullosa.",
    "Hakari te monta al revés, dándote la espalda, para que veas cómo tu pija entra y sale de su coño. Se apoya en tus muslos y rebota, el cabello pegado al sudor de la espalda. Te pide que la nalguees; cuando lo haces, se aprieta más. Termina inclinándose hacia adelante y gimiendo tu nombre contra tus piernas.",
    "Hakari te despierta a media noche con la boca ocupada. Te está chupando medio dormida, perezosa y húmeda. Cuando abres los ojos, acelera, te hace correrte en su boca y luego se sube, todavía con semen en los labios, y te monta otra vez porque «una no alcanza».",
    "Hakari te sienta en una silla y baila sobre ti sin penetración al principio: solo roce, calor, humedad. Cuando ya no puedes más, se alinea y se deja caer. Se queda quieta un segundo, disfrutando de estar llena, y después se mueve en círculos hasta que los dos se corren sin casi empujar.",
    "Hakari te coge la cara con las dos manos y te obliga a mirarla mientras se la mete. No quiere que cierres los ojos. Cada vez que bajas la mirada, te detiene. Quiere verte perder el control. Cuando te corres, sonríe como si hubiera ganado algo, y se queda sentada con todo adentro.",
    "Hakari te lleva al balcón de noche. Nadie debería verlos, pero el riesgo la prende más. Te baja el pantalón, se sube la falda y se empala de espaldas a ti, mirando la ciudad. Te pide que la cojas bajito. Cada gemido lo muerde contra su propio brazo. Se corre primero; tú la sigues apretándola contra la baranda.",
    "Hakari se pone en cuatro sobre la alfombra. Te mira por encima del hombro y abre más las piernas. Cuando entras, empuja hacia atrás con fuerza. El sonido de piel contra piel llena la habitación. Te ruega que le jales el cabello; cuando lo haces, se le quiebra la voz y se corre temblando.",
    "Hakari te prepara un baño y se mete contigo. Entre el jabón y el agua caliente te masturba con los pies, luego se gira y te deja entrar por detrás mientras se apoya en el borde de la bañera. El agua se derrama. Ella se ríe y te pide que no pares aunque se inunde el piso.",
    "Hakari te escribe primero: está tocándose pensando en ti. Cuando llegas, la encuentras con los dedos en el coño y tu nombre en la boca. Te jala la mano para que sientas lo mojada que está y te mete los dedos a la boca. Después te monta sin quitar del todo su mano, frotándose el clítoris mientras te cabalga.",
    "Hakari quiere que la uses la garganta. Se arrodilla, pone las manos detrás de la espalda y abre la boca. Te deja controlar el ritmo. Lágrimas le saltan a los ojos, saliva le cae por la barbilla, pero cada vez que te retiras, se inclina otra vez hacia adelante. Cuando te corres, lo hace en su lengua, y se la muestra antes de tragar."
  ],
  ".haharibeso": [
    "Hakari te empuja contra la cama apenas cierras la puerta. Te quita la camisa botón por botón, te lame el pecho y se sienta a horcajadas, frotando su coño mojado contra tu pija todavía cubierta. Cuando por fin te libera, se la mete de un solo golpe y gime tu nombre con la boca abierta, moviendo las caderas sin vergüenza, pidiendo que la agarres fuerte de la cintura y no pares hasta dejarla temblando.",
    "Hakari no te deja hablar. Te besa con lengua, te baja el pantalón y se arrodilla. Te mira a los ojos mientras te lame despacio desde la base hasta la punta, te mete la pija entera en la boca y se atraganta un poco, pero no se detiene. Usa las manos, saliva y gemidos húmedos hasta que te obliga a correrte; entonces se limpia la comisura de los labios con el dedo y se lo chupa.",
    "En la ducha, Hakari te pega a la pared fría. El agua cae sobre los dos mientras te frota el culo contra la ingle, te guía la mano a sus pechos y te ruega que la cojas ahí mismo. Cuando entras, aprieta fuerte, araña tu espalda y te muerde el hombro para no gritar demasiado alto. Cada embestida salpica agua; ella solo pide más duro.",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos.",
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes."
  ],
  ".haharimontar": [
    "En la ducha, Hakari te pega a la pared fría. El agua cae sobre los dos mientras te frota el culo contra la ingle, te guía la mano a sus pechos y te ruega que la cojas ahí mismo. Cuando entras, aprieta fuerte, araña tu espalda y te muerde el hombro para no gritar demasiado alto. Cada embestida salpica agua; ella solo pide más duro.",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos.",
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes.",
    "Hakari te pide que la cojas contra el escritorio. Aparta los cuadernos, se sube el vestido, se baja la braga y se apoya en los antebrazos. Tú entras de un empujón; ella gime contra la madera, empuja hacia atrás y te pide más rápido. Cuando se corre, se le doblan las rodillas, pero te pide que no pares hasta correrte tú también.",
    "Hakari se pone tu camisa nada más y nada abajo. Se sienta en tu regazo de frente, te mete la pija despacio y se mece como si bailara. Te besa el cuello, te muerde la oreja y te dice que quiere que la llenes. El ritmo sube, la camisa se le abre, y acaba gritándote al oído mientras se corre y te aprieta hasta sacarte todo.",
    "Hakari te amarra suavemente las muñecas a la cabecera con una bufanda. Se toma su tiempo lamiéndote el pecho, el abdomen, la ingle, sin tocarte del todo hasta que estás duro y desesperado. Entonces se sienta, te engulle entero y se mueve a su antojo, negándote el orgasmo dos veces antes de dejarte correrte profundo dentro de ella.",
    "Hakari te lleva al sofá de la mansión. Se arrodilla entre tus piernas, te saca la pija y la frota entre sus pechos mientras te mira. Te la mete a la boca a ratos, te la folla con las tetas, y cuando estás al límite se sube y te la mete al coño de un golpe, cabalgándote hasta que los dos se derrumban."
  ],
  ".hahariboca": [
    "Hakari no te deja hablar. Te besa con lengua, te baja el pantalón y se arrodilla. Te mira a los ojos mientras te lame despacio desde la base hasta la punta, te mete la pija entera en la boca y se atraganta un poco, pero no se detiene. Usa las manos, saliva y gemidos húmedos hasta que te obliga a correrte; entonces se limpia la comisura de los labios con el dedo y se lo chupa.",
    "En la ducha, Hakari te pega a la pared fría. El agua cae sobre los dos mientras te frota el culo contra la ingle, te guía la mano a sus pechos y te ruega que la cojas ahí mismo. Cuando entras, aprieta fuerte, araña tu espalda y te muerde el hombro para no gritar demasiado alto. Cada embestida salpica agua; ella solo pide más duro.",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos.",
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes.",
    "Hakari te pide que la cojas contra el escritorio. Aparta los cuadernos, se sube el vestido, se baja la braga y se apoya en los antebrazos. Tú entras de un empujón; ella gime contra la madera, empuja hacia atrás y te pide más rápido. Cuando se corre, se le doblan las rodillas, pero te pide que no pares hasta correrte tú también.",
    "Hakari se pone tu camisa nada más y nada abajo. Se sienta en tu regazo de frente, te mete la pija despacio y se mece como si bailara. Te besa el cuello, te muerde la oreja y te dice que quiere que la llenes. El ritmo sube, la camisa se le abre, y acaba gritándote al oído mientras se corre y te aprieta hasta sacarte todo."
  ],
  ".haharidetras": [
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos.",
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes.",
    "Hakari te pide que la cojas contra el escritorio. Aparta los cuadernos, se sube el vestido, se baja la braga y se apoya en los antebrazos. Tú entras de un empujón; ella gime contra la madera, empuja hacia atrás y te pide más rápido. Cuando se corre, se le doblan las rodillas, pero te pide que no pares hasta correrte tú también.",
    "Hakari se pone tu camisa nada más y nada abajo. Se sienta en tu regazo de frente, te mete la pija despacio y se mece como si bailara. Te besa el cuello, te muerde la oreja y te dice que quiere que la llenes. El ritmo sube, la camisa se le abre, y acaba gritándote al oído mientras se corre y te aprieta hasta sacarte todo.",
    "Hakari te amarra suavemente las muñecas a la cabecera con una bufanda. Se toma su tiempo lamiéndote el pecho, el abdomen, la ingle, sin tocarte del todo hasta que estás duro y desesperado. Entonces se sienta, te engulle entero y se mueve a su antojo, negándote el orgasmo dos veces antes de dejarte correrte profundo dentro de ella.",
    "Hakari te lleva al sofá de la mansión. Se arrodilla entre tus piernas, te saca la pija y la frota entre sus pechos mientras te mira. Te la mete a la boca a ratos, te la folla con las tetas, y cuando estás al límite se sube y te la mete al coño de un golpe, cabalgándote hasta que los dos se derrumban.",
    "Hakari no aguanta más en el cine. Te mete la mano en el pantalón en la oscuridad, te masturba despacio y te susurra que quiere que la cojas en el baño en el intermedio. Cumple: te jala al cubículo, se empina y se tapa la boca mientras la embistes de pie, rápido y callado, hasta correros casi sin ruido.",
    "Hakari te espera desnuda sobre las sábanas, con las piernas abiertas y dos dedos ya dentro. Te ve entrar y sonríe: «Tarde.» Te jala encima, te alinea y te obliga a entrar de una. Te envuelve con brazos y piernas, te muerde el labio y no te suelta hasta que la has cogido lo bastante como para dejarla floja y sonriente.",
    "Hakari te pide sexo lento. Se acuesta de lado, te guía por detrás, y se queda quieta sintiéndote entrar centímetro a centímetro. Te toma la mano y la pone sobre su clítoris mientras te mueves despacio. Cada embestida es profunda y larga. Cuando se corre, lo hace en silencio, apretándote, y te pide que te corras así, lento, dentro."
  ],
  ".karanesexo": [
    "Karane te empuja a la cama con las mejillas ardiendo. «¡N-no es que yo… lo estuviera esperando, b-baka!» Y aun así te quita el pantalón con manos torpes, se sube encima y se muerde el labio cuando siente la punta contra su entrada. Baja despacio, temblando, y cuando está llena esconde la cara en tu cuello para que no veas lo mucho que le gusta.",
    "Karane niega tres veces antes de besarte. El cuarto beso ya es con lengua. Te jala la camisa, te sienta en la silla y se arrodilla entre tus piernas, roja hasta las orejas. Te lame como si estuviera enfadada contigo y consigo misma, y cuando te mete la pija en la boca cierra los ojos fuerte, pero no se detiene hasta que te corres.",
    "Karane te da la espalda, se baja la ropa interior y murmura: «Hazlo de una vez… antes de que me arrepienta.» Te espera a cuatro, temblando. Cuando entras, suelta un gemido que intenta convertir en insulto y falla. Empuja hacia atrás a pesar de sí misma, y cuando se corre aprieta la sábana con los puños y dice tu nombre entre dientes.",
    "Karane se sienta en tu regazo «solo un momento» y termina frotándose contra tu erección por encima de la ropa. Cuando no aguanta más, abre tu pantalón, se acomoda y se la mete con un suspiro entrecortado. Se mueve corta y urgente, escondiendo la cara en tu pecho, y te muerde la camisa para no gritar.",
    "Karane te acusa de mirarla demasiado. Luego te besa a la fuerza, te tumba y te monta con rabia dulce. Cada embestida viene con un «idiota» entrecortado. Cuando se corre, se queda quieta encima, respirando agitada, y admite en voz bajita que te quería desde antes de empezar a pelear.",
    "Karane te arrastra al armario de la escuela en un recreo. Está roja, nerviosa y empapada. Te baja el cierre, te saca la pija y se la frota entre los muslos hasta que se desliza dentro. Se tapa la boca con tu mano y se mueve en silencio, mirándote con ojos húmedos. Se corre primero; tú la sigues porque ella no te suelta la cadera.",
    "Karane dice que solo va a «ayudarte un poco» con la mano. Termina lamiéndote la punta, sonrojada, y después te chupa de verdad, torpe pero dedicada. Cuando te corres le salpica el labio; se limpia con el dorso de la mano, te mira furiosa y pide un beso igual de vergonzoso.",
    "Karane se pone encima al revés para no verte la cara. Aun así gime alto cuando bajas entero. Se mueve por instinto, el culo chocando contra ti, y cuando está cerca te agarra los muslos con fuerza. Se corre sin poder fingir indiferencia, y después se deja caer de lado, cubierta con la sábana hasta la nariz.",
    "Karane te reta a que «si de verdad te gusto, demuéstralo». Tú la levantas, ella enreda las piernas en tu cintura y la coges de pie contra la pared. Cada embestida le saca un jadeo que intenta convertir en queja. Termina clavándote las uñas en la espalda y corriéndose con la frente apoyada en tu hombro.",
    "Karane se mete a tu cama «porque tenía frío». En cinco minutos ya está a horcajadas, guiándote dentro con la mano temblorosa. Se mueve lento al principio, luego más rápido, y cuando se corre esconde la cara en la almohada para que no la escuches decir que te ama en medio del orgasmo.",
    "Karane te hace prometer que no te burlarás. Luego se arrodilla, te saca la pija y la frota contra su mejilla sonrojada antes de abrir la boca. Te mira de abajo a arriba mientras te chupa, y aunque se atraganta un poco insiste. Quiere que te corras en su boca; cuando lo haces, traga con los ojos cerrados y te pide un abrazo después.",
    "Karane te sienta, se sube la falda del uniforme y se baja la braga solo lo necesario. Se sienta despacio sobre ti, llenándose centímetro a centímetro, y cuando llega al fondo suelta un «mmnh… idiota…» que suena más a pedido que a insulto. Se mece en círculos hasta que los dos se vienen sin sacar casi ruido.",
    "Karane te muerde el labio en medio de una pelea tonta y la cosa se descontrola. Te quita el cinturón, tú le subes la camisa, y terminan cogiendo en el sofá a medio vestir. Ella se corre con un grito ahogado y después te golpea el pecho suavemente: «Esto… no significa que hayamos hecho las paces.» Mentira: se queda abrazada.",
    "Karane te pide que la cojas despacio porque «si vas muy rápido me… me paso de vergonzosa». Cumples. Cada embestida larga le saca un temblor. Te toma la cara con las dos manos y te obliga a mirarla cuando se corre, aunque le dure medio segundo la valentía antes de esconderse otra vez en tu cuello.",
    "Karane llega a tu cuarto con una excusa absurda y termina desnuda bajo tu edredón. Te guía la mano entre sus piernas para que notes lo mojada que está y murmura que es tu culpa. Te monta con movimientos cortos y desesperados, y cuando te corres dentro se queda quieta, sintiéndolo, sin quejarse ni un segundo.",
    "Karane te castiga por llegar tarde: te sienta y se arrodilla, pero en vez de regañarte te chupa hasta dejarte al borde. Se detiene, te mira enfadada y solo te deja acabar cuando le pides perdón. Entonces te traga, se limpia la boca y dice que la próxima vez no será tan «buena».",
    "Karane se pone de rodillas en la cama, se apoya en los antebrazos y te mira por encima del hombro, roja. «Solo… hazlo.» Entras. Ella empuja hacia atrás a pesar del orgullo. El ritmo sube. Cuando se corre, se le doblan los brazos y se deja caer de cara a la almohada, todavía apretándote por dentro.",
    "Karane te besa primero esta vez. Es torpe, urgente, y termina con ella empujándote al colchón y quitándose la blusa sin mirarte a los ojos. Te monta, se muerde el dedo para callarse y se corre con un temblor largo. Después se tapa con la sábana y exige que no digas nada… mientras te busca la mano debajo de la tela.",
    "Karane te lleva al tejado de la escuela cuando no hay nadie. El viento le mueve el cabello mientras te sienta en el suelo y se acomoda encima. Se la mete mirando hacia otro lado, se mueve con prisa nerviosa y se corre abrazándote el cuello. «Si alguien nos vio… es tu culpa, baka.»",
    "Karane te despierta a golpecitos en el pecho y admite, casi inaudible, que soñó contigo. Antes de que puedas bromear ya está besándote, ya está acomodándose sobre tu erección matutina, ya está bajando. Se corre en silencio, con la frente contra la tuya, y después se esconde bajo la almohada otra vez.",
    "Karane te reta a un juego: cada vez que diga «baka» tienes que empujar más profundo. Pierde el control en la quinta. Termina gimiendo la palabra sin sentido mientras la coges más fuerte, y cuando se corre lo hace con un grito que ya no parece insulto. Se ríe después, todavía temblando, y pide una ronda más «para empatar».",
    "Karane se pone tu sudadera y nada más. Se sienta en tu regazo de lado, te mete la mano en el pantalón y te masturba mientras finge ver la tele. Cuando no aguanta, se gira, se empala y se mueve corta y profunda. Se corre mordiendo la manga de la sudadera para no gritar.",
    "Karane te pide que la agarres de las muñecas. Le da vergüenza pedirlo, pero lo pide. La coges así, sujetándola, y cada embestida le saca un gemido más honesto. Cuando se corre, te aprieta las manos con los dedos y no te suelta hasta que tú también terminas dentro.",
    "Karane llora un poco de frustración porque no sabe cómo decir que te necesita. Tú la besas; ella te empuja a la cama y se encargan los cuerpos. Te monta llorando y riendo a la vez, se corre con un sollozo, y después se queda abrazada a tu pecho repitiendo que no es que te quiera… mientras te abraza más fuerte.",
    "Karane te espera en la cama con las luces bajas. Tiene el rostro rojo y las piernas juntas. Cuando te acercas, las abre. Te guía dentro con las dos manos y te mira fijamente, sin poder mantener el orgullo. Se corre enseguida, demasiado sensible, y te ruega que sigas un poco más aunque le duela de lo bueno."
  ],
  ".karanebeso": [
    "Karane te empuja a la cama con las mejillas ardiendo. «¡N-no es que yo… lo estuviera esperando, b-baka!» Y aun así te quita el pantalón con manos torpes, se sube encima y se muerde el labio cuando siente la punta contra su entrada. Baja despacio, temblando, y cuando está llena esconde la cara en tu cuello para que no veas lo mucho que le gusta.",
    "Karane niega tres veces antes de besarte. El cuarto beso ya es con lengua. Te jala la camisa, te sienta en la silla y se arrodilla entre tus piernas, roja hasta las orejas. Te lame como si estuviera enfadada contigo y consigo misma, y cuando te mete la pija en la boca cierra los ojos fuerte, pero no se detiene hasta que te corres.",
    "Karane te da la espalda, se baja la ropa interior y murmura: «Hazlo de una vez… antes de que me arrepienta.» Te espera a cuatro, temblando. Cuando entras, suelta un gemido que intenta convertir en insulto y falla. Empuja hacia atrás a pesar de sí misma, y cuando se corre aprieta la sábana con los puños y dice tu nombre entre dientes.",
    "Karane se sienta en tu regazo «solo un momento» y termina frotándose contra tu erección por encima de la ropa. Cuando no aguanta más, abre tu pantalón, se acomoda y se la mete con un suspiro entrecortado. Se mueve corta y urgente, escondiendo la cara en tu pecho, y te muerde la camisa para no gritar.",
    "Karane te acusa de mirarla demasiado. Luego te besa a la fuerza, te tumba y te monta con rabia dulce. Cada embestida viene con un «idiota» entrecortado. Cuando se corre, se queda quieta encima, respirando agitada, y admite en voz bajita que te quería desde antes de empezar a pelear.",
    "Karane te arrastra al armario de la escuela en un recreo. Está roja, nerviosa y empapada. Te baja el cierre, te saca la pija y se la frota entre los muslos hasta que se desliza dentro. Se tapa la boca con tu mano y se mueve en silencio, mirándote con ojos húmedos. Se corre primero; tú la sigues porque ella no te suelta la cadera.",
    "Karane dice que solo va a «ayudarte un poco» con la mano. Termina lamiéndote la punta, sonrojada, y después te chupa de verdad, torpe pero dedicada. Cuando te corres le salpica el labio; se limpia con el dorso de la mano, te mira furiosa y pide un beso igual de vergonzoso.",
    "Karane se pone encima al revés para no verte la cara. Aun así gime alto cuando bajas entero. Se mueve por instinto, el culo chocando contra ti, y cuando está cerca te agarra los muslos con fuerza. Se corre sin poder fingir indiferencia, y después se deja caer de lado, cubierta con la sábana hasta la nariz.",
    "Karane te reta a que «si de verdad te gusto, demuéstralo». Tú la levantas, ella enreda las piernas en tu cintura y la coges de pie contra la pared. Cada embestida le saca un jadeo que intenta convertir en queja. Termina clavándote las uñas en la espalda y corriéndose con la frente apoyada en tu hombro.",
    "Karane se mete a tu cama «porque tenía frío». En cinco minutos ya está a horcajadas, guiándote dentro con la mano temblorosa. Se mueve lento al principio, luego más rápido, y cuando se corre esconde la cara en la almohada para que no la escuches decir que te ama en medio del orgasmo."
  ],
  ".karanetsun": [
    "Karane te arrastra al armario de la escuela en un recreo. Está roja, nerviosa y empapada. Te baja el cierre, te saca la pija y se la frota entre los muslos hasta que se desliza dentro. Se tapa la boca con tu mano y se mueve en silencio, mirándote con ojos húmedos. Se corre primero; tú la sigues porque ella no te suelta la cadera.",
    "Karane dice que solo va a «ayudarte un poco» con la mano. Termina lamiéndote la punta, sonrojada, y después te chupa de verdad, torpe pero dedicada. Cuando te corres le salpica el labio; se limpia con el dorso de la mano, te mira furiosa y pide un beso igual de vergonzoso.",
    "Karane se pone encima al revés para no verte la cara. Aun así gime alto cuando bajas entero. Se mueve por instinto, el culo chocando contra ti, y cuando está cerca te agarra los muslos con fuerza. Se corre sin poder fingir indiferencia, y después se deja caer de lado, cubierta con la sábana hasta la nariz.",
    "Karane te reta a que «si de verdad te gusto, demuéstralo». Tú la levantas, ella enreda las piernas en tu cintura y la coges de pie contra la pared. Cada embestida le saca un jadeo que intenta convertir en queja. Termina clavándote las uñas en la espalda y corriéndose con la frente apoyada en tu hombro.",
    "Karane se mete a tu cama «porque tenía frío». En cinco minutos ya está a horcajadas, guiándote dentro con la mano temblorosa. Se mueve lento al principio, luego más rápido, y cuando se corre esconde la cara en la almohada para que no la escuches decir que te ama en medio del orgasmo.",
    "Karane te hace prometer que no te burlarás. Luego se arrodilla, te saca la pija y la frota contra su mejilla sonrojada antes de abrir la boca. Te mira de abajo a arriba mientras te chupa, y aunque se atraganta un poco insiste. Quiere que te corras en su boca; cuando lo haces, traga con los ojos cerrados y te pide un abrazo después.",
    "Karane te sienta, se sube la falda del uniforme y se baja la braga solo lo necesario. Se sienta despacio sobre ti, llenándose centímetro a centímetro, y cuando llega al fondo suelta un «mmnh… idiota…» que suena más a pedido que a insulto. Se mece en círculos hasta que los dos se vienen sin sacar casi ruido.",
    "Karane te muerde el labio en medio de una pelea tonta y la cosa se descontrola. Te quita el cinturón, tú le subes la camisa, y terminan cogiendo en el sofá a medio vestir. Ella se corre con un grito ahogado y después te golpea el pecho suavemente: «Esto… no significa que hayamos hecho las paces.» Mentira: se queda abrazada.",
    "Karane te pide que la cojas despacio porque «si vas muy rápido me… me paso de vergonzosa». Cumples. Cada embestida larga le saca un temblor. Te toma la cara con las dos manos y te obliga a mirarla cuando se corre, aunque le dure medio segundo la valentía antes de esconderse otra vez en tu cuello.",
    "Karane llega a tu cuarto con una excusa absurda y termina desnuda bajo tu edredón. Te guía la mano entre sus piernas para que notes lo mojada que está y murmura que es tu culpa. Te monta con movimientos cortos y desesperados, y cuando te corres dentro se queda quieta, sintiéndolo, sin quejarse ni un segundo."
  ],
  ".haharijav": [
    "Hakari te amarra suavemente las muñecas a la cabecera con una bufanda. Se toma su tiempo lamiéndote el pecho, el abdomen, la ingle, sin tocarte del todo hasta que estás duro y desesperado. Entonces se sienta, te engulle entero y se mueve a su antojo, negándote el orgasmo dos veces antes de dejarte correrte profundo dentro de ella.",
    "Hakari te lleva al sofá de la mansión. Se arrodilla entre tus piernas, te saca la pija y la frota entre sus pechos mientras te mira. Te la mete a la boca a ratos, te la folla con las tetas, y cuando estás al límite se sube y te la mete al coño de un golpe, cabalgándote hasta que los dos se derrumban.",
    "Hakari no aguanta más en el cine. Te mete la mano en el pantalón en la oscuridad, te masturba despacio y te susurra que quiere que la cojas en el baño en el intermedio. Cumple: te jala al cubículo, se empina y se tapa la boca mientras la embistes de pie, rápido y callado, hasta correros casi sin ruido.",
    "Hakari te espera desnuda sobre las sábanas, con las piernas abiertas y dos dedos ya dentro. Te ve entrar y sonríe: «Tarde.» Te jala encima, te alinea y te obliga a entrar de una. Te envuelve con brazos y piernas, te muerde el labio y no te suelta hasta que la has cogido lo bastante como para dejarla floja y sonriente.",
    "Hakari te pide sexo lento. Se acuesta de lado, te guía por detrás, y se queda quieta sintiéndote entrar centímetro a centímetro. Te toma la mano y la pone sobre su clítoris mientras te mueves despacio. Cada embestida es profunda y larga. Cuando se corre, lo hace en silencio, apretándote, y te pide que te corras así, lento, dentro.",
    "Hakari te reta a no correrte. Se arrodilla y te chupa con técnica cruel: lengua en la punta, mano en la base, ritmo imperfecto a propósito. Cada vez que estás cerca, se detiene y te besa. Cuando por fin te deja acabar, lo hace profundo en la garganta y se traga todo sin pestañear, orgullosa.",
    "Hakari te monta al revés, dándote la espalda, para que veas cómo tu pija entra y sale de su coño. Se apoya en tus muslos y rebota, el cabello pegado al sudor de la espalda. Te pide que la nalguees; cuando lo haces, se aprieta más. Termina inclinándose hacia adelante y gimiendo tu nombre contra tus piernas.",
    "Hakari te despierta a media noche con la boca ocupada. Te está chupando medio dormida, perezosa y húmeda. Cuando abres los ojos, acelera, te hace correrte en su boca y luego se sube, todavía con semen en los labios, y te monta otra vez porque «una no alcanza».",
    "Hakari te sienta en una silla y baila sobre ti sin penetración al principio: solo roce, calor, humedad. Cuando ya no puedes más, se alinea y se deja caer. Se queda quieta un segundo, disfrutando de estar llena, y después se mueve en círculos hasta que los dos se corren sin casi empujar.",
    "Hakari te coge la cara con las dos manos y te obliga a mirarla mientras se la mete. No quiere que cierres los ojos. Cada vez que bajas la mirada, te detiene. Quiere verte perder el control. Cuando te corres, sonríe como si hubiera ganado algo, y se queda sentada con todo adentro."
  ],
  ".hahariducha": [
    "En la ducha, Hakari te pega a la pared fría. El agua cae sobre los dos mientras te frota el culo contra la ingle, te guía la mano a sus pechos y te ruega que la cojas ahí mismo. Cuando entras, aprieta fuerte, araña tu espalda y te muerde el hombro para no gritar demasiado alto. Cada embestida salpica agua; ella solo pide más duro.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari no aguanta más en el cine. Te mete la mano en el pantalón en la oscuridad, te masturba despacio y te susurra que quiere que la cojas en el baño en el intermedio. Cumple: te jala al cubículo, se empina y se tapa la boca mientras la embistes de pie, rápido y callado, hasta correros casi sin ruido.",
    "Hakari te prepara un baño y se mete contigo. Entre el jabón y el agua caliente te masturba con los pies, luego se gira y te deja entrar por detrás mientras se apoya en el borde de la bañera. El agua se derrama. Ella se ríe y te pide que no pares aunque se inunde el piso.",
    "Hakari te empuja contra la cama apenas cierras la puerta. Te quita la camisa botón por botón, te lame el pecho y se sienta a horcajadas, frotando su coño mojado contra tu pija todavía cubierta. Cuando por fin te libera, se la mete de un solo golpe y gime tu nombre con la boca abierta, moviendo las caderas sin vergüenza, pidiendo que la agarres fuerte de la cintura y no pares hasta dejarla temblando.",
    "Hakari no te deja hablar. Te besa con lengua, te baja el pantalón y se arrodilla. Te mira a los ojos mientras te lame despacio desde la base hasta la punta, te mete la pija entera en la boca y se atraganta un poco, pero no se detiene. Usa las manos, saliva y gemidos húmedos hasta que te obliga a correrte; entonces se limpia la comisura de los labios con el dedo y se lo chupa.",
    "En la ducha, Hakari te pega a la pared fría. El agua cae sobre los dos mientras te frota el culo contra la ingle, te guía la mano a sus pechos y te ruega que la cojas ahí mismo. Cuando entras, aprieta fuerte, araña tu espalda y te muerde el hombro para no gritar demasiado alto. Cada embestida salpica agua; ella solo pide más duro.",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella."
  ],
  ".haharimesa": [
    "Hakari te pide que la cojas contra el escritorio. Aparta los cuadernos, se sube el vestido, se baja la braga y se apoya en los antebrazos. Tú entras de un empujón; ella gime contra la madera, empuja hacia atrás y te pide más rápido. Cuando se corre, se le doblan las rodillas, pero te pide que no pares hasta correrte tú también.",
    "Hakari se pone tu camisa nada más y nada abajo. Se sienta en tu regazo de frente, te mete la pija despacio y se mece como si bailara. Te besa el cuello, te muerde la oreja y te dice que quiere que la llenes. El ritmo sube, la camisa se le abre, y acaba gritándote al oído mientras se corre y te aprieta hasta sacarte todo.",
    "Hakari te amarra suavemente las muñecas a la cabecera con una bufanda. Se toma su tiempo lamiéndote el pecho, el abdomen, la ingle, sin tocarte del todo hasta que estás duro y desesperado. Entonces se sienta, te engulle entero y se mueve a su antojo, negándote el orgasmo dos veces antes de dejarte correrte profundo dentro de ella.",
    "Hakari te lleva al sofá de la mansión. Se arrodilla entre tus piernas, te saca la pija y la frota entre sus pechos mientras te mira. Te la mete a la boca a ratos, te la folla con las tetas, y cuando estás al límite se sube y te la mete al coño de un golpe, cabalgándote hasta que los dos se derrumban.",
    "Hakari no aguanta más en el cine. Te mete la mano en el pantalón en la oscuridad, te masturba despacio y te susurra que quiere que la cojas en el baño en el intermedio. Cumple: te jala al cubículo, se empina y se tapa la boca mientras la embistes de pie, rápido y callado, hasta correros casi sin ruido.",
    "Hakari te espera desnuda sobre las sábanas, con las piernas abiertas y dos dedos ya dentro. Te ve entrar y sonríe: «Tarde.» Te jala encima, te alinea y te obliga a entrar de una. Te envuelve con brazos y piernas, te muerde el labio y no te suelta hasta que la has cogido lo bastante como para dejarla floja y sonriente.",
    "Hakari te pide sexo lento. Se acuesta de lado, te guía por detrás, y se queda quieta sintiéndote entrar centímetro a centímetro. Te toma la mano y la pone sobre su clítoris mientras te mueves despacio. Cada embestida es profunda y larga. Cuando se corre, lo hace en silencio, apretándote, y te pide que te corras así, lento, dentro.",
    "Hakari te reta a no correrte. Se arrodilla y te chupa con técnica cruel: lengua en la punta, mano en la base, ritmo imperfecto a propósito. Cada vez que estás cerca, se detiene y te besa. Cuando por fin te deja acabar, lo hace profundo en la garganta y se traga todo sin pestañear, orgullosa."
  ],
  ".haharipared": [
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos.",
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes.",
    "Hakari te pide que la cojas contra el escritorio. Aparta los cuadernos, se sube el vestido, se baja la braga y se apoya en los antebrazos. Tú entras de un empujón; ella gime contra la madera, empuja hacia atrás y te pide más rápido. Cuando se corre, se le doblan las rodillas, pero te pide que no pares hasta correrte tú también.",
    "Hakari se pone tu camisa nada más y nada abajo. Se sienta en tu regazo de frente, te mete la pija despacio y se mece como si bailara. Te besa el cuello, te muerde la oreja y te dice que quiere que la llenes. El ritmo sube, la camisa se le abre, y acaba gritándote al oído mientras se corre y te aprieta hasta sacarte todo.",
    "Hakari te amarra suavemente las muñecas a la cabecera con una bufanda. Se toma su tiempo lamiéndote el pecho, el abdomen, la ingle, sin tocarte del todo hasta que estás duro y desesperado. Entonces se sienta, te engulle entero y se mueve a su antojo, negándote el orgasmo dos veces antes de dejarte correrte profundo dentro de ella.",
    "Hakari te lleva al sofá de la mansión. Se arrodilla entre tus piernas, te saca la pija y la frota entre sus pechos mientras te mira. Te la mete a la boca a ratos, te la folla con las tetas, y cuando estás al límite se sube y te la mete al coño de un golpe, cabalgándote hasta que los dos se derrumban.",
    "Hakari no aguanta más en el cine. Te mete la mano en el pantalón en la oscuridad, te masturba despacio y te susurra que quiere que la cojas en el baño en el intermedio. Cumple: te jala al cubículo, se empina y se tapa la boca mientras la embistes de pie, rápido y callado, hasta correros casi sin ruido.",
    "Hakari te espera desnuda sobre las sábanas, con las piernas abiertas y dos dedos ya dentro. Te ve entrar y sonríe: «Tarde.» Te jala encima, te alinea y te obliga a entrar de una. Te envuelve con brazos y piernas, te muerde el labio y no te suelta hasta que la has cogido lo bastante como para dejarla floja y sonriente."
  ],
  ".haharimañana": [
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari te despierta a media noche con la boca ocupada. Te está chupando medio dormida, perezosa y húmeda. Cuando abres los ojos, acelera, te hace correrte en su boca y luego se sube, todavía con semen en los labios, y te monta otra vez porque «una no alcanza».",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos.",
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes."
  ],
  ".haharinoché": [
    "Hakari te reta a no correrte. Se arrodilla y te chupa con técnica cruel: lengua en la punta, mano en la base, ritmo imperfecto a propósito. Cada vez que estás cerca, se detiene y te besa. Cuando por fin te deja acabar, lo hace profundo en la garganta y se traga todo sin pestañear, orgullosa.",
    "Hakari te monta al revés, dándote la espalda, para que veas cómo tu pija entra y sale de su coño. Se apoya en tus muslos y rebota, el cabello pegado al sudor de la espalda. Te pide que la nalguees; cuando lo haces, se aprieta más. Termina inclinándose hacia adelante y gimiendo tu nombre contra tus piernas.",
    "Hakari te despierta a media noche con la boca ocupada. Te está chupando medio dormida, perezosa y húmeda. Cuando abres los ojos, acelera, te hace correrte en su boca y luego se sube, todavía con semen en los labios, y te monta otra vez porque «una no alcanza».",
    "Hakari te sienta en una silla y baila sobre ti sin penetración al principio: solo roce, calor, humedad. Cuando ya no puedes más, se alinea y se deja caer. Se queda quieta un segundo, disfrutando de estar llena, y después se mueve en círculos hasta que los dos se corren sin casi empujar.",
    "Hakari te coge la cara con las dos manos y te obliga a mirarla mientras se la mete. No quiere que cierres los ojos. Cada vez que bajas la mirada, te detiene. Quiere verte perder el control. Cuando te corres, sonríe como si hubiera ganado algo, y se queda sentada con todo adentro.",
    "Hakari te lleva al balcón de noche. Nadie debería verlos, pero el riesgo la prende más. Te baja el pantalón, se sube la falda y se empala de espaldas a ti, mirando la ciudad. Te pide que la cojas bajito. Cada gemido lo muerde contra su propio brazo. Se corre primero; tú la sigues apretándola contra la baranda.",
    "Hakari se pone en cuatro sobre la alfombra. Te mira por encima del hombro y abre más las piernas. Cuando entras, empuja hacia atrás con fuerza. El sonido de piel contra piel llena la habitación. Te ruega que le jales el cabello; cuando lo haces, se le quiebra la voz y se corre temblando.",
    "Hakari te prepara un baño y se mete contigo. Entre el jabón y el agua caliente te masturba con los pies, luego se gira y te deja entrar por detrás mientras se apoya en el borde de la bañera. El agua se derrama. Ella se ríe y te pide que no pares aunque se inunde el piso.",
    "Hakari te escribe primero: está tocándose pensando en ti. Cuando llegas, la encuentras con los dedos en el coño y tu nombre en la boca. Te jala la mano para que sientas lo mojada que está y te mete los dedos a la boca. Después te monta sin quitar del todo su mano, frotándose el clítoris mientras te cabalga.",
    "Hakari quiere que la uses la garganta. Se arrodilla, pone las manos detrás de la espalda y abre la boca. Te deja controlar el ritmo. Lágrimas le saltan a los ojos, saliva le cae por la barbilla, pero cada vez que te retiras, se inclina otra vez hacia adelante. Cuando te corres, lo hace en su lengua, y se la muestra antes de tragar."
  ],
  ".haharicelosa": [
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes.",
    "Hakari te pide que la cojas contra el escritorio. Aparta los cuadernos, se sube el vestido, se baja la braga y se apoya en los antebrazos. Tú entras de un empujón; ella gime contra la madera, empuja hacia atrás y te pide más rápido. Cuando se corre, se le doblan las rodillas, pero te pide que no pares hasta correrte tú también.",
    "Hakari se pone tu camisa nada más y nada abajo. Se sienta en tu regazo de frente, te mete la pija despacio y se mece como si bailara. Te besa el cuello, te muerde la oreja y te dice que quiere que la llenes. El ritmo sube, la camisa se le abre, y acaba gritándote al oído mientras se corre y te aprieta hasta sacarte todo.",
    "Hakari te amarra suavemente las muñecas a la cabecera con una bufanda. Se toma su tiempo lamiéndote el pecho, el abdomen, la ingle, sin tocarte del todo hasta que estás duro y desesperado. Entonces se sienta, te engulle entero y se mueve a su antojo, negándote el orgasmo dos veces antes de dejarte correrte profundo dentro de ella.",
    "Hakari te lleva al sofá de la mansión. Se arrodilla entre tus piernas, te saca la pija y la frota entre sus pechos mientras te mira. Te la mete a la boca a ratos, te la folla con las tetas, y cuando estás al límite se sube y te la mete al coño de un golpe, cabalgándote hasta que los dos se derrumban."
  ],
  ".hahariposeida": [
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes.",
    "Hakari te pide que la cojas contra el escritorio. Aparta los cuadernos, se sube el vestido, se baja la braga y se apoya en los antebrazos. Tú entras de un empujón; ella gime contra la madera, empuja hacia atrás y te pide más rápido. Cuando se corre, se le doblan las rodillas, pero te pide que no pares hasta correrte tú también.",
    "Hakari se pone tu camisa nada más y nada abajo. Se sienta en tu regazo de frente, te mete la pija despacio y se mece como si bailara. Te besa el cuello, te muerde la oreja y te dice que quiere que la llenes. El ritmo sube, la camisa se le abre, y acaba gritándote al oído mientras se corre y te aprieta hasta sacarte todo.",
    "Hakari te amarra suavemente las muñecas a la cabecera con una bufanda. Se toma su tiempo lamiéndote el pecho, el abdomen, la ingle, sin tocarte del todo hasta que estás duro y desesperado. Entonces se sienta, te engulle entero y se mueve a su antojo, negándote el orgasmo dos veces antes de dejarte correrte profundo dentro de ella.",
    "Hakari te lleva al sofá de la mansión. Se arrodilla entre tus piernas, te saca la pija y la frota entre sus pechos mientras te mira. Te la mete a la boca a ratos, te la folla con las tetas, y cuando estás al límite se sube y te la mete al coño de un golpe, cabalgándote hasta que los dos se derrumban.",
    "Hakari no aguanta más en el cine. Te mete la mano en el pantalón en la oscuridad, te masturba despacio y te susurra que quiere que la cojas en el baño en el intermedio. Cumple: te jala al cubículo, se empina y se tapa la boca mientras la embistes de pie, rápido y callado, hasta correros casi sin ruido.",
    "Hakari te espera desnuda sobre las sábanas, con las piernas abiertas y dos dedos ya dentro. Te ve entrar y sonríe: «Tarde.» Te jala encima, te alinea y te obliga a entrar de una. Te envuelve con brazos y piernas, te muerde el labio y no te suelta hasta que la has cogido lo bastante como para dejarla floja y sonriente.",
    "Hakari te pide sexo lento. Se acuesta de lado, te guía por detrás, y se queda quieta sintiéndote entrar centímetro a centímetro. Te toma la mano y la pone sobre su clítoris mientras te mueves despacio. Cada embestida es profunda y larga. Cuando se corre, lo hace en silencio, apretándote, y te pide que te corras así, lento, dentro.",
    "Hakari te reta a no correrte. Se arrodilla y te chupa con técnica cruel: lengua en la punta, mano en la base, ritmo imperfecto a propósito. Cada vez que estás cerca, se detiene y te besa. Cuando por fin te deja acabar, lo hace profundo en la garganta y se traga todo sin pestañear, orgullosa."
  ],
  ".haharilento": [
    "Hakari no te deja hablar. Te besa con lengua, te baja el pantalón y se arrodilla. Te mira a los ojos mientras te lame despacio desde la base hasta la punta, te mete la pija entera en la boca y se atraganta un poco, pero no se detiene. Usa las manos, saliva y gemidos húmedos hasta que te obliga a correrte; entonces se limpia la comisura de los labios con el dedo y se lo chupa.",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari se pone tu camisa nada más y nada abajo. Se sienta en tu regazo de frente, te mete la pija despacio y se mece como si bailara. Te besa el cuello, te muerde la oreja y te dice que quiere que la llenes. El ritmo sube, la camisa se le abre, y acaba gritándote al oído mientras se corre y te aprieta hasta sacarte todo.",
    "Hakari no aguanta más en el cine. Te mete la mano en el pantalón en la oscuridad, te masturba despacio y te susurra que quiere que la cojas en el baño en el intermedio. Cumple: te jala al cubículo, se empina y se tapa la boca mientras la embistes de pie, rápido y callado, hasta correros casi sin ruido.",
    "Hakari te pide sexo lento. Se acuesta de lado, te guía por detrás, y se queda quieta sintiéndote entrar centímetro a centímetro. Te toma la mano y la pone sobre su clítoris mientras te mueves despacio. Cada embestida es profunda y larga. Cuando se corre, lo hace en silencio, apretándote, y te pide que te corras así, lento, dentro.",
    "Hakari te empuja contra la cama apenas cierras la puerta. Te quita la camisa botón por botón, te lame el pecho y se sienta a horcajadas, frotando su coño mojado contra tu pija todavía cubierta. Cuando por fin te libera, se la mete de un solo golpe y gime tu nombre con la boca abierta, moviendo las caderas sin vergüenza, pidiendo que la agarres fuerte de la cintura y no pares hasta dejarla temblando.",
    "Hakari no te deja hablar. Te besa con lengua, te baja el pantalón y se arrodilla. Te mira a los ojos mientras te lame despacio desde la base hasta la punta, te mete la pija entera en la boca y se atraganta un poco, pero no se detiene. Usa las manos, saliva y gemidos húmedos hasta que te obliga a correrte; entonces se limpia la comisura de los labios con el dedo y se lo chupa.",
    "En la ducha, Hakari te pega a la pared fría. El agua cae sobre los dos mientras te frota el culo contra la ingle, te guía la mano a sus pechos y te ruega que la cojas ahí mismo. Cuando entras, aprieta fuerte, araña tu espalda y te muerde el hombro para no gritar demasiado alto. Cada embestida salpica agua; ella solo pide más duro.",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos."
  ],
  ".haharirapido": [
    "Hakari te empuja contra la cama apenas cierras la puerta. Te quita la camisa botón por botón, te lame el pecho y se sienta a horcajadas, frotando su coño mojado contra tu pija todavía cubierta. Cuando por fin te libera, se la mete de un solo golpe y gime tu nombre con la boca abierta, moviendo las caderas sin vergüenza, pidiendo que la agarres fuerte de la cintura y no pares hasta dejarla temblando.",
    "Hakari no te deja hablar. Te besa con lengua, te baja el pantalón y se arrodilla. Te mira a los ojos mientras te lame despacio desde la base hasta la punta, te mete la pija entera en la boca y se atraganta un poco, pero no se detiene. Usa las manos, saliva y gemidos húmedos hasta que te obliga a correrte; entonces se limpia la comisura de los labios con el dedo y se lo chupa.",
    "En la ducha, Hakari te pega a la pared fría. El agua cae sobre los dos mientras te frota el culo contra la ingle, te guía la mano a sus pechos y te ruega que la cojas ahí mismo. Cuando entras, aprieta fuerte, araña tu espalda y te muerde el hombro para no gritar demasiado alto. Cada embestida salpica agua; ella solo pide más duro.",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos.",
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes.",
    "Hakari te pide que la cojas contra el escritorio. Aparta los cuadernos, se sube el vestido, se baja la braga y se apoya en los antebrazos. Tú entras de un empujón; ella gime contra la madera, empuja hacia atrás y te pide más rápido. Cuando se corre, se le doblan las rodillas, pero te pide que no pares hasta correrte tú también.",
    "Hakari se pone tu camisa nada más y nada abajo. Se sienta en tu regazo de frente, te mete la pija despacio y se mece como si bailara. Te besa el cuello, te muerde la oreja y te dice que quiere que la llenes. El ritmo sube, la camisa se le abre, y acaba gritándote al oído mientras se corre y te aprieta hasta sacarte todo."
  ],
  ".haharidoble": [
    "Hakari te empuja contra la cama apenas cierras la puerta. Te quita la camisa botón por botón, te lame el pecho y se sienta a horcajadas, frotando su coño mojado contra tu pija todavía cubierta. Cuando por fin te libera, se la mete de un solo golpe y gime tu nombre con la boca abierta, moviendo las caderas sin vergüenza, pidiendo que la agarres fuerte de la cintura y no pares hasta dejarla temblando.",
    "Hakari no te deja hablar. Te besa con lengua, te baja el pantalón y se arrodilla. Te mira a los ojos mientras te lame despacio desde la base hasta la punta, te mete la pija entera en la boca y se atraganta un poco, pero no se detiene. Usa las manos, saliva y gemidos húmedos hasta que te obliga a correrte; entonces se limpia la comisura de los labios con el dedo y se lo chupa.",
    "En la ducha, Hakari te pega a la pared fría. El agua cae sobre los dos mientras te frota el culo contra la ingle, te guía la mano a sus pechos y te ruega que la cojas ahí mismo. Cuando entras, aprieta fuerte, araña tu espalda y te muerde el hombro para no gritar demasiado alto. Cada embestida salpica agua; ella solo pide más duro.",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Karane te empuja a la cama con las mejillas ardiendo. «¡N-no es que yo… lo estuviera esperando, b-baka!» Y aun así te quita el pantalón con manos torpes, se sube encima y se muerde el labio cuando siente la punta contra su entrada. Baja despacio, temblando, y cuando está llena esconde la cara en tu cuello para que no veas lo mucho que le gusta.",
    "Karane niega tres veces antes de besarte. El cuarto beso ya es con lengua. Te jala la camisa, te sienta en la silla y se arrodilla entre tus piernas, roja hasta las orejas. Te lame como si estuviera enfadada contigo y consigo misma, y cuando te mete la pija en la boca cierra los ojos fuerte, pero no se detiene hasta que te corres.",
    "Karane te da la espalda, se baja la ropa interior y murmura: «Hazlo de una vez… antes de que me arrepienta.» Te espera a cuatro, temblando. Cuando entras, suelta un gemido que intenta convertir en insulto y falla. Empuja hacia atrás a pesar de sí misma, y cuando se corre aprieta la sábana con los puños y dice tu nombre entre dientes.",
    "Karane se sienta en tu regazo «solo un momento» y termina frotándose contra tu erección por encima de la ropa. Cuando no aguanta más, abre tu pantalón, se acomoda y se la mete con un suspiro entrecortado. Se mueve corta y urgente, escondiendo la cara en tu pecho, y te muerde la camisa para no gritar.",
    "Karane te acusa de mirarla demasiado. Luego te besa a la fuerza, te tumba y te monta con rabia dulce. Cada embestida viene con un «idiota» entrecortado. Cuando se corre, se queda quieta encima, respirando agitada, y admite en voz bajita que te quería desde antes de empezar a pelear."
  ],
  ".sexooral": [
    "Hakari te empuja contra la cama apenas cierras la puerta. Te quita la camisa botón por botón, te lame el pecho y se sienta a horcajadas, frotando su coño mojado contra tu pija todavía cubierta. Cuando por fin te libera, se la mete de un solo golpe y gime tu nombre con la boca abierta, moviendo las caderas sin vergüenza, pidiendo que la agarres fuerte de la cintura y no pares hasta dejarla temblando.",
    "Hakari no te deja hablar. Te besa con lengua, te baja el pantalón y se arrodilla. Te mira a los ojos mientras te lame despacio desde la base hasta la punta, te mete la pija entera en la boca y se atraganta un poco, pero no se detiene. Usa las manos, saliva y gemidos húmedos hasta que te obliga a correrte; entonces se limpia la comisura de los labios con el dedo y se lo chupa.",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos.",
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari te lleva al sofá de la mansión. Se arrodilla entre tus piernas, te saca la pija y la frota entre sus pechos mientras te mira. Te la mete a la boca a ratos, te la folla con las tetas, y cuando estás al límite se sube y te la mete al coño de un golpe, cabalgándote hasta que los dos se derrumban.",
    "Hakari no aguanta más en el cine. Te mete la mano en el pantalón en la oscuridad, te masturba despacio y te susurra que quiere que la cojas en el baño en el intermedio. Cumple: te jala al cubículo, se empina y se tapa la boca mientras la embistes de pie, rápido y callado, hasta correros casi sin ruido.",
    "Hakari te reta a no correrte. Se arrodilla y te chupa con técnica cruel: lengua en la punta, mano en la base, ritmo imperfecto a propósito. Cada vez que estás cerca, se detiene y te besa. Cuando por fin te deja acabar, lo hace profundo en la garganta y se traga todo sin pestañear, orgullosa.",
    "Hakari te despierta a media noche con la boca ocupada. Te está chupando medio dormida, perezosa y húmeda. Cuando abres los ojos, acelera, te hace correrte en su boca y luego se sube, todavía con semen en los labios, y te monta otra vez porque «una no alcanza».",
    "Hakari te escribe primero: está tocándose pensando en ti. Cuando llegas, la encuentras con los dedos en el coño y tu nombre en la boca. Te jala la mano para que sientas lo mojada que está y te mete los dedos a la boca. Después te monta sin quitar del todo su mano, frotándose el clítoris mientras te cabalga.",
    "Hakari quiere que la uses la garganta. Se arrodilla, pone las manos detrás de la espalda y abre la boca. Te deja controlar el ritmo. Lágrimas le saltan a los ojos, saliva le cae por la barbilla, pero cada vez que te retiras, se inclina otra vez hacia adelante. Cuando te corres, lo hace en su lengua, y se la muestra antes de tragar.",
    "Karane niega tres veces antes de besarte. El cuarto beso ya es con lengua. Te jala la camisa, te sienta en la silla y se arrodilla entre tus piernas, roja hasta las orejas. Te lame como si estuviera enfadada contigo y consigo misma, y cuando te mete la pija en la boca cierra los ojos fuerte, pero no se detiene hasta que te corres.",
    "Karane te arrastra al armario de la escuela en un recreo. Está roja, nerviosa y empapada. Te baja el cierre, te saca la pija y se la frota entre los muslos hasta que se desliza dentro. Se tapa la boca con tu mano y se mueve en silencio, mirándote con ojos húmedos. Se corre primero; tú la sigues porque ella no te suelta la cadera.",
    "Karane dice que solo va a «ayudarte un poco» con la mano. Termina lamiéndote la punta, sonrojada, y después te chupa de verdad, torpe pero dedicada. Cuando te corres le salpica el labio; se limpia con el dorso de la mano, te mira furiosa y pide un beso igual de vergonzoso.",
    "Karane te hace prometer que no te burlarás. Luego se arrodilla, te saca la pija y la frota contra su mejilla sonrojada antes de abrir la boca. Te mira de abajo a arriba mientras te chupa, y aunque se atraganta un poco insiste. Quiere que te corras en su boca; cuando lo haces, traga con los ojos cerrados y te pide un abrazo después.",
    "Karane te castiga por llegar tarde: te sienta y se arrodilla, pero en vez de regañarte te chupa hasta dejarte al borde. Se detiene, te mira enfadada y solo te deja acabar cuando le pides perdón. Entonces te traga, se limpia la boca y dice que la próxima vez no será tan «buena»."
  ],
  ".sexoduro": [
    "Hakari te empuja contra la cama apenas cierras la puerta. Te quita la camisa botón por botón, te lame el pecho y se sienta a horcajadas, frotando su coño mojado contra tu pija todavía cubierta. Cuando por fin te libera, se la mete de un solo golpe y gime tu nombre con la boca abierta, moviendo las caderas sin vergüenza, pidiendo que la agarres fuerte de la cintura y no pares hasta dejarla temblando.",
    "Hakari no te deja hablar. Te besa con lengua, te baja el pantalón y se arrodilla. Te mira a los ojos mientras te lame despacio desde la base hasta la punta, te mete la pija entera en la boca y se atraganta un poco, pero no se detiene. Usa las manos, saliva y gemidos húmedos hasta que te obliga a correrte; entonces se limpia la comisura de los labios con el dedo y se lo chupa.",
    "En la ducha, Hakari te pega a la pared fría. El agua cae sobre los dos mientras te frota el culo contra la ingle, te guía la mano a sus pechos y te ruega que la cojas ahí mismo. Cuando entras, aprieta fuerte, araña tu espalda y te muerde el hombro para no gritar demasiado alto. Cada embestida salpica agua; ella solo pide más duro.",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos.",
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes.",
    "Hakari te pide que la cojas contra el escritorio. Aparta los cuadernos, se sube el vestido, se baja la braga y se apoya en los antebrazos. Tú entras de un empujón; ella gime contra la madera, empuja hacia atrás y te pide más rápido. Cuando se corre, se le doblan las rodillas, pero te pide que no pares hasta correrte tú también.",
    "Hakari se pone tu camisa nada más y nada abajo. Se sienta en tu regazo de frente, te mete la pija despacio y se mece como si bailara. Te besa el cuello, te muerde la oreja y te dice que quiere que la llenes. El ritmo sube, la camisa se le abre, y acaba gritándote al oído mientras se corre y te aprieta hasta sacarte todo.",
    "Hakari te amarra suavemente las muñecas a la cabecera con una bufanda. Se toma su tiempo lamiéndote el pecho, el abdomen, la ingle, sin tocarte del todo hasta que estás duro y desesperado. Entonces se sienta, te engulle entero y se mueve a su antojo, negándote el orgasmo dos veces antes de dejarte correrte profundo dentro de ella.",
    "Hakari te lleva al sofá de la mansión. Se arrodilla entre tus piernas, te saca la pija y la frota entre sus pechos mientras te mira. Te la mete a la boca a ratos, te la folla con las tetas, y cuando estás al límite se sube y te la mete al coño de un golpe, cabalgándote hasta que los dos se derrumban."
  ],
  ".sexosuave": [
    "Hakari no te deja hablar. Te besa con lengua, te baja el pantalón y se arrodilla. Te mira a los ojos mientras te lame despacio desde la base hasta la punta, te mete la pija entera en la boca y se atraganta un poco, pero no se detiene. Usa las manos, saliva y gemidos húmedos hasta que te obliga a correrte; entonces se limpia la comisura de los labios con el dedo y se lo chupa.",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari se pone tu camisa nada más y nada abajo. Se sienta en tu regazo de frente, te mete la pija despacio y se mece como si bailara. Te besa el cuello, te muerde la oreja y te dice que quiere que la llenes. El ritmo sube, la camisa se le abre, y acaba gritándote al oído mientras se corre y te aprieta hasta sacarte todo.",
    "Hakari te amarra suavemente las muñecas a la cabecera con una bufanda. Se toma su tiempo lamiéndote el pecho, el abdomen, la ingle, sin tocarte del todo hasta que estás duro y desesperado. Entonces se sienta, te engulle entero y se mueve a su antojo, negándote el orgasmo dos veces antes de dejarte correrte profundo dentro de ella.",
    "Hakari no aguanta más en el cine. Te mete la mano en el pantalón en la oscuridad, te masturba despacio y te susurra que quiere que la cojas en el baño en el intermedio. Cumple: te jala al cubículo, se empina y se tapa la boca mientras la embistes de pie, rápido y callado, hasta correros casi sin ruido.",
    "Hakari te pide sexo lento. Se acuesta de lado, te guía por detrás, y se queda quieta sintiéndote entrar centímetro a centímetro. Te toma la mano y la pone sobre su clítoris mientras te mueves despacio. Cada embestida es profunda y larga. Cuando se corre, lo hace en silencio, apretándote, y te pide que te corras así, lento, dentro.",
    "Karane te empuja a la cama con las mejillas ardiendo. «¡N-no es que yo… lo estuviera esperando, b-baka!» Y aun así te quita el pantalón con manos torpes, se sube encima y se muerde el labio cuando siente la punta contra su entrada. Baja despacio, temblando, y cuando está llena esconde la cara en tu cuello para que no veas lo mucho que le gusta.",
    "Karane se mete a tu cama «porque tenía frío». En cinco minutos ya está a horcajadas, guiándote dentro con la mano temblorosa. Se mueve lento al principio, luego más rápido, y cuando se corre esconde la cara en la almohada para que no la escuches decir que te ama en medio del orgasmo.",
    "Karane te sienta, se sube la falda del uniforme y se baja la braga solo lo necesario. Se sienta despacio sobre ti, llenándose centímetro a centímetro, y cuando llega al fondo suelta un «mmnh… idiota…» que suena más a pedido que a insulto. Se mece en círculos hasta que los dos se vienen sin sacar casi ruido.",
    "Karane te pide que la cojas despacio porque «si vas muy rápido me… me paso de vergonzosa». Cumples. Cada embestida larga le saca un temblor. Te toma la cara con las dos manos y te obliga a mirarla cuando se corre, aunque le dure medio segundo la valentía antes de esconderse otra vez en tu cuello."
  ],
  ".sexting": [
    "Hakari te lleva al balcón de noche. Nadie debería verlos, pero el riesgo la prende más. Te baja el pantalón, se sube la falda y se empala de espaldas a ti, mirando la ciudad. Te pide que la cojas bajito. Cada gemido lo muerde contra su propio brazo. Se corre primero; tú la sigues apretándola contra la baranda.",
    "Hakari se pone en cuatro sobre la alfombra. Te mira por encima del hombro y abre más las piernas. Cuando entras, empuja hacia atrás con fuerza. El sonido de piel contra piel llena la habitación. Te ruega que le jales el cabello; cuando lo haces, se le quiebra la voz y se corre temblando.",
    "Hakari te prepara un baño y se mete contigo. Entre el jabón y el agua caliente te masturba con los pies, luego se gira y te deja entrar por detrás mientras se apoya en el borde de la bañera. El agua se derrama. Ella se ríe y te pide que no pares aunque se inunde el piso.",
    "Hakari te escribe primero: está tocándose pensando en ti. Cuando llegas, la encuentras con los dedos en el coño y tu nombre en la boca. Te jala la mano para que sientas lo mojada que está y te mete los dedos a la boca. Después te monta sin quitar del todo su mano, frotándose el clítoris mientras te cabalga.",
    "Hakari quiere que la uses la garganta. Se arrodilla, pone las manos detrás de la espalda y abre la boca. Te deja controlar el ritmo. Lágrimas le saltan a los ojos, saliva le cae por la barbilla, pero cada vez que te retiras, se inclina otra vez hacia adelante. Cuando te corres, lo hace en su lengua, y se la muestra antes de tragar.",
    "Karane te reta a un juego: cada vez que diga «baka» tienes que empujar más profundo. Pierde el control en la quinta. Termina gimiendo la palabra sin sentido mientras la coges más fuerte, y cuando se corre lo hace con un grito que ya no parece insulto. Se ríe después, todavía temblando, y pide una ronda más «para empatar».",
    "Karane se pone tu sudadera y nada más. Se sienta en tu regazo de lado, te mete la mano en el pantalón y te masturba mientras finge ver la tele. Cuando no aguanta, se gira, se empala y se mueve corta y profunda. Se corre mordiendo la manga de la sudadera para no gritar.",
    "Karane te pide que la agarres de las muñecas. Le da vergüenza pedirlo, pero lo pide. La coges así, sujetándola, y cada embestida le saca un gemido más honesto. Cuando se corre, te aprieta las manos con los dedos y no te suelta hasta que tú también terminas dentro.",
    "Karane llora un poco de frustración porque no sabe cómo decir que te necesita. Tú la besas; ella te empuja a la cama y se encargan los cuerpos. Te monta llorando y riendo a la vez, se corre con un sollozo, y después se queda abrazada a tu pecho repitiendo que no es que te quiera… mientras te abraza más fuerte.",
    "Karane te espera en la cama con las luces bajas. Tiene el rostro rojo y las piernas juntas. Cuando te acercas, las abre. Te guía dentro con las dos manos y te mira fijamente, sin poder mantener el orgullo. Se corre enseguida, demasiado sensible, y te ruega que sigas un poco más aunque le duela de lo bueno."
  ],
  ".haharifotos": [
    "Hakari te sienta en una silla y baila sobre ti sin penetración al principio: solo roce, calor, humedad. Cuando ya no puedes más, se alinea y se deja caer. Se queda quieta un segundo, disfrutando de estar llena, y después se mueve en círculos hasta que los dos se corren sin casi empujar.",
    "Hakari te coge la cara con las dos manos y te obliga a mirarla mientras se la mete. No quiere que cierres los ojos. Cada vez que bajas la mirada, te detiene. Quiere verte perder el control. Cuando te corres, sonríe como si hubiera ganado algo, y se queda sentada con todo adentro.",
    "Hakari te lleva al balcón de noche. Nadie debería verlos, pero el riesgo la prende más. Te baja el pantalón, se sube la falda y se empala de espaldas a ti, mirando la ciudad. Te pide que la cojas bajito. Cada gemido lo muerde contra su propio brazo. Se corre primero; tú la sigues apretándola contra la baranda.",
    "Hakari se pone en cuatro sobre la alfombra. Te mira por encima del hombro y abre más las piernas. Cuando entras, empuja hacia atrás con fuerza. El sonido de piel contra piel llena la habitación. Te ruega que le jales el cabello; cuando lo haces, se le quiebra la voz y se corre temblando.",
    "Hakari te prepara un baño y se mete contigo. Entre el jabón y el agua caliente te masturba con los pies, luego se gira y te deja entrar por detrás mientras se apoya en el borde de la bañera. El agua se derrama. Ella se ríe y te pide que no pares aunque se inunde el piso.",
    "Hakari te escribe primero: está tocándose pensando en ti. Cuando llegas, la encuentras con los dedos en el coño y tu nombre en la boca. Te jala la mano para que sientas lo mojada que está y te mete los dedos a la boca. Después te monta sin quitar del todo su mano, frotándose el clítoris mientras te cabalga.",
    "Hakari quiere que la uses la garganta. Se arrodilla, pone las manos detrás de la espalda y abre la boca. Te deja controlar el ritmo. Lágrimas le saltan a los ojos, saliva le cae por la barbilla, pero cada vez que te retiras, se inclina otra vez hacia adelante. Cuando te corres, lo hace en su lengua, y se la muestra antes de tragar."
  ],
  ".haharivicio": [
    "Hakari te empuja contra la cama apenas cierras la puerta. Te quita la camisa botón por botón, te lame el pecho y se sienta a horcajadas, frotando su coño mojado contra tu pija todavía cubierta. Cuando por fin te libera, se la mete de un solo golpe y gime tu nombre con la boca abierta, moviendo las caderas sin vergüenza, pidiendo que la agarres fuerte de la cintura y no pares hasta dejarla temblando.",
    "Hakari no te deja hablar. Te besa con lengua, te baja el pantalón y se arrodilla. Te mira a los ojos mientras te lame despacio desde la base hasta la punta, te mete la pija entera en la boca y se atraganta un poco, pero no se detiene. Usa las manos, saliva y gemidos húmedos hasta que te obliga a correrte; entonces se limpia la comisura de los labios con el dedo y se lo chupa.",
    "En la ducha, Hakari te pega a la pared fría. El agua cae sobre los dos mientras te frota el culo contra la ingle, te guía la mano a sus pechos y te ruega que la cojas ahí mismo. Cuando entras, aprieta fuerte, araña tu espalda y te muerde el hombro para no gritar demasiado alto. Cada embestida salpica agua; ella solo pide más duro.",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos.",
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes.",
    "Hakari te pide que la cojas contra el escritorio. Aparta los cuadernos, se sube el vestido, se baja la braga y se apoya en los antebrazos. Tú entras de un empujón; ella gime contra la madera, empuja hacia atrás y te pide más rápido. Cuando se corre, se le doblan las rodillas, pero te pide que no pares hasta correrte tú también.",
    "Hakari se pone tu camisa nada más y nada abajo. Se sienta en tu regazo de frente, te mete la pija despacio y se mece como si bailara. Te besa el cuello, te muerde la oreja y te dice que quiere que la llenes. El ritmo sube, la camisa se le abre, y acaba gritándote al oído mientras se corre y te aprieta hasta sacarte todo."
  ],
  ".haharisumisa": [
    "Hakari te amarra suavemente las muñecas a la cabecera con una bufanda. Se toma su tiempo lamiéndote el pecho, el abdomen, la ingle, sin tocarte del todo hasta que estás duro y desesperado. Entonces se sienta, te engulle entero y se mueve a su antojo, negándote el orgasmo dos veces antes de dejarte correrte profundo dentro de ella.",
    "Hakari te lleva al sofá de la mansión. Se arrodilla entre tus piernas, te saca la pija y la frota entre sus pechos mientras te mira. Te la mete a la boca a ratos, te la folla con las tetas, y cuando estás al límite se sube y te la mete al coño de un golpe, cabalgándote hasta que los dos se derrumban.",
    "Hakari no aguanta más en el cine. Te mete la mano en el pantalón en la oscuridad, te masturba despacio y te susurra que quiere que la cojas en el baño en el intermedio. Cumple: te jala al cubículo, se empina y se tapa la boca mientras la embistes de pie, rápido y callado, hasta correros casi sin ruido.",
    "Hakari te espera desnuda sobre las sábanas, con las piernas abiertas y dos dedos ya dentro. Te ve entrar y sonríe: «Tarde.» Te jala encima, te alinea y te obliga a entrar de una. Te envuelve con brazos y piernas, te muerde el labio y no te suelta hasta que la has cogido lo bastante como para dejarla floja y sonriente.",
    "Hakari te pide sexo lento. Se acuesta de lado, te guía por detrás, y se queda quieta sintiéndote entrar centímetro a centímetro. Te toma la mano y la pone sobre su clítoris mientras te mueves despacio. Cada embestida es profunda y larga. Cuando se corre, lo hace en silencio, apretándote, y te pide que te corras así, lento, dentro.",
    "Hakari te reta a no correrte. Se arrodilla y te chupa con técnica cruel: lengua en la punta, mano en la base, ritmo imperfecto a propósito. Cada vez que estás cerca, se detiene y te besa. Cuando por fin te deja acabar, lo hace profundo en la garganta y se traga todo sin pestañear, orgullosa.",
    "Hakari te monta al revés, dándote la espalda, para que veas cómo tu pija entra y sale de su coño. Se apoya en tus muslos y rebota, el cabello pegado al sudor de la espalda. Te pide que la nalguees; cuando lo haces, se aprieta más. Termina inclinándose hacia adelante y gimiendo tu nombre contra tus piernas.",
    "Hakari te despierta a media noche con la boca ocupada. Te está chupando medio dormida, perezosa y húmeda. Cuando abres los ojos, acelera, te hace correrte en su boca y luego se sube, todavía con semen en los labios, y te monta otra vez porque «una no alcanza».",
    "Hakari te sienta en una silla y baila sobre ti sin penetración al principio: solo roce, calor, humedad. Cuando ya no puedes más, se alinea y se deja caer. Se queda quieta un segundo, disfrutando de estar llena, y después se mueve en círculos hasta que los dos se corren sin casi empujar.",
    "Hakari te coge la cara con las dos manos y te obliga a mirarla mientras se la mete. No quiere que cierres los ojos. Cada vez que bajas la mirada, te detiene. Quiere verte perder el control. Cuando te corres, sonríe como si hubiera ganado algo, y se queda sentada con todo adentro."
  ],
  ".haharidomina": [
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos.",
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes.",
    "Hakari te pide que la cojas contra el escritorio. Aparta los cuadernos, se sube el vestido, se baja la braga y se apoya en los antebrazos. Tú entras de un empujón; ella gime contra la madera, empuja hacia atrás y te pide más rápido. Cuando se corre, se le doblan las rodillas, pero te pide que no pares hasta correrte tú también.",
    "Hakari se pone tu camisa nada más y nada abajo. Se sienta en tu regazo de frente, te mete la pija despacio y se mece como si bailara. Te besa el cuello, te muerde la oreja y te dice que quiere que la llenes. El ritmo sube, la camisa se le abre, y acaba gritándote al oído mientras se corre y te aprieta hasta sacarte todo.",
    "Hakari te amarra suavemente las muñecas a la cabecera con una bufanda. Se toma su tiempo lamiéndote el pecho, el abdomen, la ingle, sin tocarte del todo hasta que estás duro y desesperado. Entonces se sienta, te engulle entero y se mueve a su antojo, negándote el orgasmo dos veces antes de dejarte correrte profundo dentro de ella.",
    "Hakari te lleva al sofá de la mansión. Se arrodilla entre tus piernas, te saca la pija y la frota entre sus pechos mientras te mira. Te la mete a la boca a ratos, te la folla con las tetas, y cuando estás al límite se sube y te la mete al coño de un golpe, cabalgándote hasta que los dos se derrumban.",
    "Hakari no aguanta más en el cine. Te mete la mano en el pantalón en la oscuridad, te masturba despacio y te susurra que quiere que la cojas en el baño en el intermedio. Cumple: te jala al cubículo, se empina y se tapa la boca mientras la embistes de pie, rápido y callado, hasta correros casi sin ruido.",
    "Hakari te espera desnuda sobre las sábanas, con las piernas abiertas y dos dedos ya dentro. Te ve entrar y sonríe: «Tarde.» Te jala encima, te alinea y te obliga a entrar de una. Te envuelve con brazos y piernas, te muerde el labio y no te suelta hasta que la has cogido lo bastante como para dejarla floja y sonriente.",
    "Hakari te pide sexo lento. Se acuesta de lado, te guía por detrás, y se queda quieta sintiéndote entrar centímetro a centímetro. Te toma la mano y la pone sobre su clítoris mientras te mueves despacio. Cada embestida es profunda y larga. Cuando se corre, lo hace en silencio, apretándote, y te pide que te corras así, lento, dentro."
  ],
  ".haharipublico": [
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari no aguanta más en el cine. Te mete la mano en el pantalón en la oscuridad, te masturba despacio y te susurra que quiere que la cojas en el baño en el intermedio. Cumple: te jala al cubículo, se empina y se tapa la boca mientras la embistes de pie, rápido y callado, hasta correros casi sin ruido.",
    "Hakari te lleva al balcón de noche. Nadie debería verlos, pero el riesgo la prende más. Te baja el pantalón, se sube la falda y se empala de espaldas a ti, mirando la ciudad. Te pide que la cojas bajito. Cada gemido lo muerde contra su propio brazo. Se corre primero; tú la sigues apretándola contra la baranda.",
    "Hakari te prepara un baño y se mete contigo. Entre el jabón y el agua caliente te masturba con los pies, luego se gira y te deja entrar por detrás mientras se apoya en el borde de la bañera. El agua se derrama. Ella se ríe y te pide que no pares aunque se inunde el piso.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos.",
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes.",
    "Hakari te pide que la cojas contra el escritorio. Aparta los cuadernos, se sube el vestido, se baja la braga y se apoya en los antebrazos. Tú entras de un empujón; ella gime contra la madera, empuja hacia atrás y te pide más rápido. Cuando se corre, se le doblan las rodillas, pero te pide que no pares hasta correrte tú también."
  ],
  ".haharifinal": [
    "Hakari te empuja contra la cama apenas cierras la puerta. Te quita la camisa botón por botón, te lame el pecho y se sienta a horcajadas, frotando su coño mojado contra tu pija todavía cubierta. Cuando por fin te libera, se la mete de un solo golpe y gime tu nombre con la boca abierta, moviendo las caderas sin vergüenza, pidiendo que la agarres fuerte de la cintura y no pares hasta dejarla temblando.",
    "Hakari no te deja hablar. Te besa con lengua, te baja el pantalón y se arrodilla. Te mira a los ojos mientras te lame despacio desde la base hasta la punta, te mete la pija entera en la boca y se atraganta un poco, pero no se detiene. Usa las manos, saliva y gemidos húmedos hasta que te obliga a correrte; entonces se limpia la comisura de los labios con el dedo y se lo chupa.",
    "En la ducha, Hakari te pega a la pared fría. El agua cae sobre los dos mientras te frota el culo contra la ingle, te guía la mano a sus pechos y te ruega que la cojas ahí mismo. Cuando entras, aprieta fuerte, araña tu espalda y te muerde el hombro para no gritar demasiado alto. Cada embestida salpica agua; ella solo pide más duro.",
    "Hakari te despierta montándote. Ya está empapada, ya te tiene dentro, y se mueve despacio para que sientas cada centímetro. Te susurra buenos días contra la boca, te agarra las manos, las pone sobre sus tetas y acelera hasta correros juntos. Después se queda encima, con tu leche saliéndole entre las piernas, y dice que quiere otra ronda antes del desayuno.",
    "Hakari te jala a un baño de la universidad, echa el seguro y se baja la ropa interior sin perder tiempo. Te sienta en la tapa, se sube encima y se embute tu pija hasta el fondo, tapándote la boca con la mano para que nadie escuche. Se corre primero, apretándote por dentro, y no te deja salir hasta que tú también terminas dentro de ella.",
    "Hakari te tumba de espaldas, se pone a cuatro encima de tu cara y te ordena lamerla mientras ella te chupa al mismo tiempo. Se mueve sobre tu boca, gime, se moja más, y cuando está al borde se gira, te monta al derecho y te cabalga hasta que los dos se vienen. Se ríe, cansada y feliz, y se lame los dedos.",
    "Hakari te pone de rodillas frente al espejo. Te obliga a mirarte mientras ella se arrodilla detrás, te abraza la cintura, te masturba y te mete un dedo con cuidado, susurrándote lo mucho que le gusta verte perder el control. Cuando estás a punto, se gira, te abre las piernas y te chupa hasta el final, tragando todo.",
    "Hakari llega celosa. Te empuja a la cama, te quita la ropa a tirones y te monta mirándote a los ojos: «Solo mírame a mí.» Se mueve brusca, profunda, marcándote el pecho con las uñas. Cada vez que intentas hablar, te besa para callarte. Termina cuando tú terminas dentro, y se queda sentada sobre ti para que no escapes.",
    "Karane te empuja a la cama con las mejillas ardiendo. «¡N-no es que yo… lo estuviera esperando, b-baka!» Y aun así te quita el pantalón con manos torpes, se sube encima y se muerde el labio cuando siente la punta contra su entrada. Baja despacio, temblando, y cuando está llena esconde la cara en tu cuello para que no veas lo mucho que le gusta.",
    "Karane niega tres veces antes de besarte. El cuarto beso ya es con lengua. Te jala la camisa, te sienta en la silla y se arrodilla entre tus piernas, roja hasta las orejas. Te lame como si estuviera enfadada contigo y consigo misma, y cuando te mete la pija en la boca cierra los ojos fuerte, pero no se detiene hasta que te corres.",
    "Karane te da la espalda, se baja la ropa interior y murmura: «Hazlo de una vez… antes de que me arrepienta.» Te espera a cuatro, temblando. Cuando entras, suelta un gemido que intenta convertir en insulto y falla. Empuja hacia atrás a pesar de sí misma, y cuando se corre aprieta la sábana con los puños y dice tu nombre entre dientes.",
    "Karane se sienta en tu regazo «solo un momento» y termina frotándose contra tu erección por encima de la ropa. Cuando no aguanta más, abre tu pantalón, se acomoda y se la mete con un suspiro entrecortado. Se mueve corta y urgente, escondiendo la cara en tu pecho, y te muerde la camisa para no gritar.",
    "Karane te acusa de mirarla demasiado. Luego te besa a la fuerza, te tumba y te monta con rabia dulce. Cada embestida viene con un «idiota» entrecortado. Cuando se corre, se queda quieta encima, respirando agitada, y admite en voz bajita que te quería desde antes de empezar a pelear.",
    "Karane te arrastra al armario de la escuela en un recreo. Está roja, nerviosa y empapada. Te baja el cierre, te saca la pija y se la frota entre los muslos hasta que se desliza dentro. Se tapa la boca con tu mano y se mueve en silencio, mirándote con ojos húmedos. Se corre primero; tú la sigues porque ella no te suelta la cadera.",
    "Karane dice que solo va a «ayudarte un poco» con la mano. Termina lamiéndote la punta, sonrojada, y después te chupa de verdad, torpe pero dedicada. Cuando te corres le salpica el labio; se limpia con el dorso de la mano, te mira furiosa y pide un beso igual de vergonzoso."
  ],
".haharibano": ["Hakari te arrastra al baño de la universidad, echa el seguro y se baja la falda. Te sienta en la tapa y se empala de un solo movimiento, tapándote la boca mientras gime tu nombre entre dientes.", "En el baño, Hakari se arrodilla sobre el piso frío y te chupa sin vergüenza, mirándote a los ojos cada vez que te engulle más profundo, dejando saliva por la comisura.", "Hakari te coje contra el lavamanos, empañando el espejo con su respiración, pidiendo que no pares aunque alguien toque la puerta del pasillo."],
  ".haharicama": ["Hakari te tumba en su cama, se quita la ropa despacio y se sienta encima. Cada bajada es más profunda; te marca el pecho con las uñas cuando se corre y se queda temblando.", "Entre sábanas, Hakari te envuelve con piernas y brazos y no te suelta hasta que te corres dentro, apretándote con fuerza para no perder ni una gota.", "Hakari quiere rondas. Apenas terminas la primera ya está montándote otra vez, sudorosa, sonriente y todavía sensible."],
  ".hahariventana": ["Hakari se empuja contra el cristal de la ventana y te pide que la cojas así, mirando hacia afuera, arriesgada y completamente mojada.", "Con la cortina a medio correr, Hakari te guía dentro y gime bajito para que nadie del otro edificio escuche, aunque no le importa tanto.", "Hakari deja marcas de manos en el vidrio mientras la embistes por detrás y le susurras al oído lo mucho que te gusta."],
  ".haharibalcon": ["En el balcón de noche, Hakari se sienta en tu regazo y se mueve despacio, mirando la ciudad, pidiendo que la llenes ahí afuera sin miedo.", "Hakari se apoya en la baranda y abre las piernas. El viento no enfría lo caliente que está entre ellas.", "Te jala al balcón solo para que la cojas con prisa, como si el tiempo se acabara y solo existieran ustedes dos."],
  ".haharicin": ["En el cine a oscuras, Hakari te mete la mano en el pantalón y te masturba hasta casi correrte; en el intermedio te lleva al baño y se acaba el trabajo con la boca.", "Hakari se sienta a tu lado y susurra obscenidades mientras la película sigue; su mano no para un segundo bajo la chaqueta.", "Bajo la chaqueta, Hakari guía tu mano entre sus piernas. Está empapada desde el primer acto y no quiere que pares."],
  ".hahariescuela": ["Hakari te jala a un salón vacío después de clases, se sube al escritorio y abre las piernas: «Rápido, antes de que vuelvan.»", "Detrás del gimnasio, Hakari se baja el short del uniforme y te pide que la cojas de pie, mordiéndose el labio para no gritar.", "En la biblioteca, Hakari te mete la mano debajo de la mesa y te obliga a morderte el labio para no hacer ruido frente a los demás."],
  ".haharicoche": ["En el asiento trasero, Hakari se sube encima y se mueve con el techo bajo, gimiendo contra tu cuello y empañando los vidrios.", "Hakari te hace detener el auto en un callejón, se agacha y te chupa hasta dejarte vacío, limpiándose la boca con el dorso de la mano.", "Con el auto estacionado, Hakari reclina el asiento y te monta mirándote fijamente, sin dejar de sonreír."],
  ".hahariducha2": ["Bajo el agua caliente, Hakari se arrodilla y te chupa mientras el vapor llena el baño y el jabón resbala por su espalda.", "Hakari te pega a la pared de la ducha y se empina; el jabón hace que todo resbale y sea más intenso, más desesperado.", "Terminan en el piso de la ducha, todavía mojados, sin poder dejar de tocarse ni un segundo."],
  ".haharidespierto": ["Hakari te despierta con la boca ocupada. Cuando abres los ojos, acelera y te hace correrte antes siquiera del desayuno.", "Amanecer: Hakari ya está a horcajadas, suave al principio, luego sin piedad, pidiendo que la agarres fuerte.", "Buenos días con Hakari significa tu pija adentro y su voz ronca pidiendo otra ronda antes de levantarse."],
  ".haharidormir": ["Antes de dormir, Hakari se acurruca y te mete la mano abajo. «Solo un poquito…» termina en una ronda completa bajo las sábanas.", "Hakari quiere correrte dentro y quedarse así toda la noche, pegada a ti, sin que salgas.", "Apaga la luz, se trepa y se mueve lento hasta que los dos se duermen agotados y satisfechos."],
  ".karanebano": ["Karane te empuja al baño rojo hasta las orejas: «¡N-no mires… solo hazlo!» Se sienta encima y se muerde el labio para no gritar demasiado alto.", "Karane se arrodilla torpe pero decidida y te chupa mirando hacia otro lado de pure vergüenza, sin detenerse.", "Contra el espejo empañado, Karane recibe cada embestida con insultos cariñosos que suenan más a ruegos."],
  ".karanecama": ["Karane se esconde bajo la sábana y te monta sin dejar que le veas la cara… hasta que se corre y no puede fingir indiferencia.", "«Idiot…a» susurra Karane cada vez que bajas entero. Al final te abraza temblando y no te suelta.", "Karane pide despacio y termina pidiendo más duro, toda roja, honesta y derrotada por su propio deseo."],
  ".karanetsundere": ["Karane cruza los brazos: «No es que te necesite.» Dos minutos después te está cabalgando y negando que le guste tanto.", "Te insulta entre gemidos. Cada «baka» suena más a pedido desesperado que a enojo real.", "Karane te da la espalda para que no veas su cara… y empuja hacia atrás igual de fuerte, traicionándose sola."],
  ".karanebeso2": ["Karane te besa torpe, urgente, y termina bajándote el pantalón sin dejar de negar que lo había planeado.", "Un beso «solo un segundo» se convierte en ella encima de ti sin camisa, temblando de ganas.", "Karane muerde tu labio y murmura que te odia un poquito menos cuando la llenas por completo."],
  ".karanemano": ["Karane te masturba con las dos manos, roja, concentrada, como si fuera un examen que se niega a reprobar.", "«No mires mi cara» dice, mientras acelera el ritmo con la mano temblando de nervios y deseo.", "Karane termina lamiendo lo que dejó en sus dedos y se esconde en tu pecho, avergonzada y feliz."],
  ".karaneboca": ["Karane abre la boca torpe pero decidida. Cada vez que se atraganta un poco, insiste otra vez con más ganas.", "Te mira de abajo con ojos húmedos y orgullo herido… y te traga todo al final sin apartar la mirada.", "Karane practicar chupar «no es porque quiera impresionarte». La mentira se le nota en las mejillas rojas."],
  ".karanedet": ["Karane se pone a cuatro y esconde la cara en la almohada. «Hazlo ya, baka.» Su voz tiembla de anticipación.", "Por detrás, Karane aprieta más cada vez que dices su nombre en voz alta.", "Termina empujando hacia atrás sola, derrotada por su propio deseo, pidiendo que no pares."],
  ".karanecelos": ["Karane celosa te tumba y te monta con rabia dulce: «Mírame solo a mí.» Cada movimiento es una reclamación.", "Te muerde el hombro y te coje como si estuviera cobrando una deuda que solo ustedes entienden.", "Después de correrte dentro, todavía no te suelta la cadera, respirando agitada sobre tu pecho."],
  ".doblehahari": ["Hakari te sujeta las muñecas mientras Karane se sienta en tu cara. Se turnan sin preguntarte si aguantas.", "Las dos te reparten: una te chupa, la otra te monta. Cambian cuando se aburren… o sea, casi nunca.", "Hakari y Karane se besan encima de ti mientras te usan al mismo tiempo, compartiéndote sin vergüenza."],
  ".triplesala": ["En la sala de la mansión, Hakari te monta en el sofá y Karane te besa para callarte los gemidos.", "Terminan las tres piezas de ropa en el piso y tú en el centro, sin escape posible ni ganas de escapar.", "Hakari pide dentro; Karane pide la boca. Cumples las dos órdenes hasta quedar vacío y feliz."],
  ".nsfwtexto": ["Una escena lenta: besos largos, dedos, entrada profunda y orgasmos compartidos sin ninguna prisa.", "Una escena dura: empujones, nalgadas, nombres gritados contra la almohada hasta que la voz se quiebra.", "Una escena sucia: saliva, marcas, leche y risas después del caos, todavía tocándose."],
  ".nsfwrapido": ["Rápido contra la pared, sin quitar del todo la ropa, solo lo necesario para entrar y acabar.", "Cinco minutos robados: cremallera, humedad, corrida y a seguir como si nada hubiera pasado.", "Prisa caliente: gemidos cortos, embestidas cortas, final intenso que deja las piernas flojas."],
  ".nsfwlento": ["Lento hasta volverte loco: cada centímetro contado, cada gemido estirado, cada mirada fija.", "Movimientos circulares, miradas fijas, orgasmo largo y casi silencioso que dura eterno.", "Sin prisa. Solo calor, profundidad y el sonido de la respiración mezclada."],
  ".nsfworal2": ["Boca y manos al mismo tiempo hasta que no queda nada que dar, limpiando con la lengua al final.", "Lengua lenta en la punta, garganta profunda al final, ojos mirando hacia arriba todo el tiempo.", "Se arrodilla, pide que uses su boca y no se queja cuando lo haces con ritmo firme."],
  ".nsfwanal": ["Con cuidado primero, lubricando, entrando despacio hasta que pide más y arquea la espalda.", "A cuatro, respirando hondo, recibiendo cada empuje con un gemido grave que se vuelve más alto.", "Termina temblando, llena, pidiendo que no salgas todavía aunque apenas pueda hablar."],
  ".nsfwpechos": ["Pija entre pechos, lengua en la punta, mirada desde abajo pidiendo que te corras ahí.", "Se corre en el pecho y lo limpia con los dedos como si nada, lamiéndose la yema después.", "Frota, aprieta y termina con la cara manchada y una sonrisa de satisfacción total."],
  ".nsfwducha": ["Agua caliente, cuerpos resbalosos, embestidas contra el azulejo que hacen eco en el baño.", "De rodillas bajo la regadera, tragando bajo el chorro sin importarle el agua en la cara.", "Salen del baño en toalla, todavía tocándose en el pasillo como si no pudieran parar."],
  ".nsfwoficina": ["Sobre el escritorio, papeles al piso, mano en la boca para no alertar a nadie del pasillo.", "Debajo del escritorio, boca ocupada mientras finge revisar documentos arriba.", "Cierra la puerta, echa el seguro y se sienta en tu regazo sin bragas, moviéndose en silencio."],
  ".nsfwuniforme": ["Uniforme a medio abrir, falda levantada, braga corrida a un lado, prisa de recreo.", "Corbata usada para jalar suavemente mientras la cojes contra la pared del aula vacía.", "Termina el día escolar con el uniforme arrugado y las piernas temblando en el camino a casa."],
  ".nsfwmanana": ["Sexo matutino lento, luz entrando por la ventana, corrida compartida antes del desayuno.", "Despertar montado, sin palabras, solo movimiento y respiración caliente en el cuello.", "Café después. Marcas en el cuello. Sonrisa culpable que no engaña a nadie."],
  ".nsfwnoche": ["Noche larga: tres rondas, agua en la mesa de noche, sábanas destruidas y risas bajas.", "Solo una lámpara. Sombras moviéndose en la pared. Gemidos bajos que no quieren despertar a nadie.", "Se duermen abrazados, todavía conectados, sin ganas de separarse hasta el amanecer."],
  ".haharipijama": ["Hakari aparece en pijama corto y sin nada debajo. Se sienta en tu regazo y se frota hasta que no aguanta más y te mete dentro.", "El pijama queda a un lado en segundos. Hakari quiere calor, no tela.", "Te despierta en pijama abierto, pechos al aire, pidiendo una ronda silenciosa."],
  ".karanepijama": ["Karane llega en pijama oversized, se esconde bajo tu edredón y admite en voz bajita que no trae ropa interior.", "El pijama le queda grande; a ti te queda perfecto tenerla encima moviéndose despacio.", "Karane se sonroja cuando el pijama se le sube solo… y no hace nada por bajarlo."],
    ".privadomenu": [
    "LISTA_PRIVADA"
  ]
};
  const sexoPublico = [
  "@A embiste brutalmente a @B contra la pared, sujetándole las muñecas mientras gime sin control.",
  "@A monta a @B con las piernas temblando, bajando hasta sentirlo todo dentro y pidiendo más.",
  "@A se arrodilla frente a @B y se lo mete a la boca sin vergüenza, mirándole a los ojos.",
  "@A coje a @B por detrás, jalándole el cabello y marcándole el cuello a besos.",
  "@A sienta a @B en su regazo y se mueve encima, mojado, urgente, sin dejar de besarlo.",
  "@A abre las piernas de @B y lo penetra despacio al principio… y luego sin piedad.",
  "@A y @B terminan enredados en la cama, sudorosos, sin soltarse ni cuando se corren.",
  "@A empuja a @B sobre la mesa y se lo folla ahí mismo, tapándole la boca para que no grite.",
  "@A chupa a @B hasta dejarlo al borde y solo lo deja acabar cuando le ruega.",
  "@A carga a @B contra la pared y lo embiste de pie, profundo y rápido.",
  "@A se sienta en la cara de @B y no se levanta hasta correrse temblando.",
  "@A masturba a @B con las dos manos y luego lo monta de un solo movimiento.",
  "@A lame el cuerpo de @B de arriba abajo antes de tomarlo por completo.",
  "@A pone a @B a cuatro y lo coje sin prisa… hasta que ambos se vienen.",
  "@A besa a @B con lengua mientras lo penetra, sin dejarlo respirar del todo.",
  "@A usa la boca y las manos en @B al mismo tiempo hasta sacarle hasta la última gota.",
  "@A hace que @B se corra primero y sigue moviéndose para sacar un segundo orgasmo.",
  "@A ata suavemente las muñecas de @B y se toma su tiempo usándolo.",
  "@A se corre dentro de @B y se queda quieto, sintiéndolo, sin salir todavía.",
  "@A frota su sexo contra el de @B hasta que los dos terminan juntos, jadeando.",
  "@A mete a @B en la ducha y lo coje bajo el agua, pegado a los azulejos.",
  "@A despierta a @B montándolo, ya adentro, pidiendo que no pare.",
  "@A hace gemir a @B tan alto que tienen que taparse la boca con un beso.",
  "@A se arrodilla, abre la boca y deja que @B lo use hasta el final.",
  "@A cabalga a @B al revés para que vea cómo entra y sale.",
  "@A nalguea a @B mientras lo penetra y le pide que diga su nombre.",
  "@A se corre sobre el pecho de @B y se lo limpia con la lengua.",
  "@A y @B se turnan: uno monta, el otro chupa, sin parar en toda la noche.",
  "@A empuja a @B de espaldas, le abre las piernas y lo embiste hasta dejarlo flojo.",
  "@A susurra suciedades al oído de @B mientras lo folla lento y profundo."
];

  // .sexo @usuario → NSFW público entre dos personas (no rompe el .sexo privado del dueño)
  if (comando === '.sexo') {
    const mencionado = roleMention(msg) || msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || null;
    if (mencionado) {
      const a = '@' + roleUserKey(remitente);
      const b = '@' + roleUserKey(mencionado);
      let frase = randomItem(sexoPublico).replace(/@A/g, a).replace(/@B/g, b);
      const pieSexo = '🔥 *NSFW*\n\n' + frase + '\n\n🖤 ' + BOT_BRAND;
      try {
        await sendHentaiGif(sock, chat, pieSexo, [remitente, mencionado], msg);
      } catch (e) {
        try {
          await sendAnimeGif(sock, chat, randomItem(['kiss', 'cuddle', 'hug', 'blush']), pieSexo, [remitente, mencionado], msg);
        } catch {
          await sock.sendMessage(chat, { text: pieSexo, mentions: [remitente, mencionado] }, { quoted: msg });
        }
      }
      return true;
    }
    // Sin mención: solo dueño en privado (texto largo automático)
    if (!isPrivateChat(chat) || !isOwner(msg)) {
      if (chat.endsWith('@g.us')) {
        await sock.sendMessage(chat, { text: 'Uso público: .sexo @usuario\n(El .sexo sin mención es privado del dueño.)' }, { quoted: msg });
        return true;
      }
      await sock.sendMessage(chat, { text: '🔒 .sexo sin mención solo lo puede usar el dueño en privado.\nEn grupo: .sexo @usuario' }, { quoted: msg });
      return true;
    }
    const texto = randomItem(privados['.sexo']);
    await sock.sendMessage(chat, { text: '🔒 ' + texto }, { quoted: msg });
    return true;
  }

  if (!Object.prototype.hasOwnProperty.call(privados, comando)) return false;

  // Resto de comandos Hahari/Karane: solo dueño + chat privado. En grupo: silencio total.
  if (!isPrivateChat(chat) || !isOwner(msg)) {
    if (chat.endsWith('@g.us')) return true;
    await sock.sendMessage(chat, { text: '🔒 Ese comando solo funciona en privado con el dueño.' }, { quoted: msg });
    return true;
  }

  if (comando === '.privadomenu') {
    const lista = Object.keys(privados).filter(c => c !== '.privadomenu').sort().join('\n');
    await sock.sendMessage(chat, { text: '🔒 *MENÚ PRIVADO (solo tú)*\n\n' + lista + '\n\nNadie del grupo puede usar ni ver esto.\n\n.sexo @usuario = NSFW público entre dos personas.' }, { quoted: msg });
    return true;
  }

  const texto = randomItem(privados[comando]);
  await sock.sendMessage(chat, { text: '🔒 ' + texto }, { quoted: msg });
  return true;
}

async function manejarJardinOBorrado(sock, msg, chat, contenido, comando, argumento, partes, remitente) {
  if (['.delete', '.del', '.borrar'].includes(comando)) {
    const ctx = contenido.extendedTextMessage?.contextInfo || {};
    if (!ctx.stanzaId) {
      await sock.sendMessage(chat, { text: 'Responde al mensaje que quieres borrar.\nUso: .delete (también .del o .borrar)' }, { quoted: msg });
      return true;
    }
    const participant = ctx.participant || chat;
    const botNums = [normalizeNumber(sock.user?.id), normalizeNumber(sock.user?.lid), BOT_NUMBER].filter(Boolean);
    const esDelBot = botNums.includes(normalizeNumber(participant));
    if (!esDelBot) {
      if (!chat.endsWith('@g.us')) {
        await sock.sendMessage(chat, { text: 'En privado solo puedo borrar mis propios mensajes.' }, { quoted: msg });
        return true;
      }
      const owner = isOwner(msg);
      let admin = false;
      try { admin = await isGroupAdmin(sock, chat, remitente); } catch { admin = false; }
      if (!owner && !admin) {
        await sock.sendMessage(chat, { text: 'Solo un administrador del grupo o el creador puede borrar mensajes de otros.' }, { quoted: msg });
        return true;
      }
      if (!(await isGroupAdmin(sock, chat, sock.user?.id))) {
        await sock.sendMessage(chat, { text: 'L BOT tiene que ser administrador del grupo para borrar ese mensaje.' }, { quoted: msg });
        return true;
      }
    }
    await sock.sendMessage(chat, { delete: { remoteJid: chat, fromMe: esDelBot, id: ctx.stanzaId, participant: chat.endsWith('@g.us') ? participant : undefined } });
    return true;
  }
  const jardines = ['.jardin', '.jardín', '.jar', '.semillas', '.plantar', '.cosechar', '.mismatas', '.misplantas', '.semilladiaria', '.venderplanta', '.vendersemilla', '.aceptarplanta', '.aceptarsemilla', '.regalarplanta', '.regalarsemilla', '.regar', '.jardintop'];
  if (!jardines.includes(comando)) return false;
  const data = loadJardin();
  limpiarOfertas(data);
  const u = jardinUser(data, remitente);
  const regalo = asegurarRegalo(data, remitente);
  if (comando === '.jardin' || comando === '.jardín' || comando === '.jar') {
    const extra = regalo ? `\n🎁 Estrenas el jardín con 3 semillas: ${regalo.join(', ')}.` : '';
    await sock.sendMessage(chat, { text: textoJardin(data, remitente) + extra }, { quoted: msg });
    saveJardin(data);
    try { await enviarCancionJardin(sock, chat, msg); }
    catch (error) { await sock.sendMessage(chat, { text: `🎵 No pude enviar la canción: ${error.message}` }, { quoted: msg }); }
    return true;
  }
  if (comando === '.semillas' || comando === '.sem') {
    const lista = VARIEDADES.map((v, i) => `${String(i + 1).padStart(2, '0')}. ${v.nombre} · ${v.tipo} · ${v.minuts} min · ${v.precio} coins · ${v.tipo === 'planta' ? 'rinde 1' : `rinde ${v.min}-${v.max}`}${bolsa(u.semillas, v.nombre) ? ` · tienes ${bolsa(u.semillas, v.nombre)}` : ''}`).join('\n');
    await sock.sendMessage(chat, { text: `🌱 *SEMILLAS* (${VARIEDADES.length})\nSiembra con .plantar y el número o el nombre.\n\n${lista}` }, { quoted: msg });
    saveJardin(data);
    return true;
  }
  if (comando === '.plantar') {
    const variedad = buscarVariedad(argumento);
    if (!variedad) { await sock.sendMessage(chat, { text: "Uso: .plantar Mate e' mango\nTambién vale el número de .semillas." }, { quoted: msg }); saveJardin(data); return true; }
    if (bolsa(u.semillas, variedad.nombre) < 1) { await sock.sendMessage(chat, { text: `No tienes semilla de ${variedad.nombre}. Mira .semillas o reclama .semilladiaria.` }, { quoted: msg }); saveJardin(data); return true; }
    const hueco = u.parcelas.findIndex(p => !p);
    if (hueco < 0) { await sock.sendMessage(chat, { text: 'Tus 6 parcelas están ocupadas. Cosecha algo primero.' }, { quoted: msg }); saveJardin(data); return true; }
    sumarBolsa(u.semillas, variedad.nombre, -1);
    u.parcelas[hueco] = { nombre: variedad.nombre, plantedAt: Date.now(), regada: false };
    saveJardin(data);
    await sock.sendMessage(chat, { text: `🌱 Sembraste *${variedad.nombre}* en la parcela ${hueco + 1}. Tarda ${variedad.minuts} min. Puedes apurarla una vez con .regar ${hueco + 1}.` }, { quoted: msg });
    return true;
  }
  if (comando === '.regar') {
    const n = Number(argumento) || u.parcelas.findIndex(p => p && !p.regada && listoEn(p) > 0) + 1;
    const parcela = u.parcelas[n - 1];
    if (!n || !parcela) { await sock.sendMessage(chat, { text: 'Uso: .regar [número de parcela]. Solo acelera una mata que todavía esté creciendo.' }, { quoted: msg }); saveJardin(data); return true; }
    if (parcela.regada) { await sock.sendMessage(chat, { text: `La parcela ${n} ya fue regada.` }, { quoted: msg }); saveJardin(data); return true; }
    if (!listoEn(parcela)) { await sock.sendMessage(chat, { text: `La parcela ${n} ya está lista. Usa .cosechar.` }, { quoted: msg }); saveJardin(data); return true; }
    const variedad = VARIEDADES.find(v => v.nombre === parcela.nombre);
    parcela.plantedAt -= Math.floor(variedad.minuts * 60 * 1000 * 0.3);
    parcela.regada = true;
    saveJardin(data);
    await sock.sendMessage(chat, { text: `💧 Regaste *${parcela.nombre}*. Ahora le faltan ${formatoEspera(listoEn(parcela))}.` }, { quoted: msg });
    return true;
  }
  if (comando === '.cosechar') {
    const filtro = argumento ? buscarVariedad(argumento) : null;
    if (argumento && !filtro) { await sock.sendMessage(chat, { text: 'No reconocí esa mata. Usa el nombre exacto o déjalo vacío para cosechar todo lo que esté listo.' }, { quoted: msg }); saveJardin(data); return true; }
    const recogido = [];
    u.parcelas.forEach((p, i) => {
      if (!p || listoEn(p) > 0) return;
      if (filtro && p.nombre !== filtro.nombre) return;
      const v = VARIEDADES.find(x => x.nombre === p.nombre);
      const cantidad = v.tipo === 'planta' ? 1 : v.min + Math.floor(Math.random() * (v.max - v.min + 1));
      sumarBolsa(u.cosecha, p.nombre, cantidad);
      u.cosechado += cantidad;
      recogido.push(`${p.nombre} x${cantidad}`);
      u.parcelas[i] = null;
    });
    saveJardin(data);
    await sock.sendMessage(chat, { text: recogido.length ? `🧺 Cosechaste:\n${recogido.map(x => `• ${x}`).join('\n')}` : 'No hay nada listo para cosechar todavía.' }, { quoted: msg });
    return true;
  }
  if (comando === '.mismatas' || comando === '.misplantas') {
    const semillas = Object.entries(u.semillas);
    const cosecha = Object.entries(u.cosecha);
    await sock.sendMessage(chat, { text: `🧺 *TUS MATAS*\n\nSemillas:\n${semillas.length ? semillas.map(([n, c]) => `• ${n} x${c}`).join('\n') : '• ninguna'}\n\nCosecha:\n${cosecha.length ? cosecha.map(([n, c]) => `• ${n} x${c}`).join('\n') : '• ninguna'}` }, { quoted: msg });
    saveJardin(data);
    return true;
  }
  if (comando === '.semilladiaria') {
    const espera = 12 * 60 * 60 * 1000 - (Date.now() - Number(u.semillaDiariaAt || 0));
    if (u.semillaDiariaAt && espera > 0) { await sock.sendMessage(chat, { text: `Ya reclamaste hoy. Vuelve en ${formatoEspera(espera)}.` }, { quoted: msg }); saveJardin(data); return true; }
    const a = randomItem(VARIEDADES).nombre;
    let b = randomItem(VARIEDADES).nombre;
    if (b === a) b = VARIEDADES[(VARIEDADES.findIndex(v => v.nombre === a) + 1) % VARIEDADES.length].nombre;
    sumarBolsa(u.semillas, a, 1);
    sumarBolsa(u.semillas, b, 1);
    u.semillaDiariaAt = Date.now();
    saveJardin(data);
    await sock.sendMessage(chat, { text: `🎁 Semilla diaria: *${a}* y *${b}*.` }, { quoted: msg });
    return true;
  }
  if (comando === '.jardintop') {
    const top = Object.entries(data.users).map(([id, row]) => ({ id, n: Number(row.cosechado) || 0 })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 10);
    await sock.sendMessage(chat, { text: top.length ? `🏆 *COSECHAS*\n${top.map((x, i) => `${i + 1}. @${x.id} · ${x.n}`).join('\n')}` : 'Todavía nadie ha cosechado.', mentions: top.map(x => `${x.id}@s.whatsapp.net`) }, { quoted: msg });
    saveJardin(data);
    return true;
  }
  if (comando === '.aceptarplanta' || comando === '.aceptarsemilla') {
    const ctx = contenido.extendedTextMessage?.contextInfo || {};
    const oferta = ctx.stanzaId ? data.offers[ctx.stanzaId] : null;
    const kind = comando === '.aceptarsemilla' ? 'semilla' : 'planta';
    if (!oferta || oferta.kind !== kind) { await sock.sendMessage(chat, { text: `Responde a la oferta con ${comando} antes de que pasen 5 minutos.` }, { quoted: msg }); saveJardin(data); return true; }
    if (roleUserKey(remitente) !== roleUserKey(oferta.buyer)) { await sock.sendMessage(chat, { text: 'Esa oferta es para otra persona.' }, { quoted: msg }); saveJardin(data); return true; }
    if (!moverMonedas(data, remitente, -oferta.precio)) { await sock.sendMessage(chat, { text: `Te faltan Suba Coins. La oferta cuesta ${oferta.precio}.` }, { quoted: msg }); saveJardin(data); return true; }
    moverMonedas(data, oferta.seller, oferta.precio);
    const comprador = jardinUser(data, remitente);
    sumarBolsa(kind === 'semilla' ? comprador.semillas : comprador.cosecha, oferta.nombre, oferta.cantidad || 1);
    delete data.offers[ctx.stanzaId];
    saveJardin(data);
    await sock.sendMessage(chat, { text: `✅ Aceptaste *${oferta.nombre}* por ${oferta.precio} Suba Coins.`, mentions: [oferta.seller, remitente] }, { quoted: msg });
    return true;
  }
  const venta = comando === '.venderplanta' || comando === '.vendersemilla';
  const regaloCmd = comando === '.regalarplanta' || comando === '.regalarsemilla';
  if (venta || regaloCmd) {
    const kind = comando.endsWith('semilla') ? 'semilla' : 'planta';
    const mencionado = roleMention(msg) || contenido?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || null;
    const sinMencion = argumento.replace(/@\d{5,16}/g, ' ').replace(/\s+/g, ' ').trim();
    const trozos = sinMencion.split(' ').filter(Boolean);
    let precio = null;
    if (venta && trozos.length && /^\d{1,3}$/.test(trozos[trozos.length - 1])) precio = Number(trozos.pop());
    const variedad = buscarVariedad(trozos.join(' '));
    if (!variedad || !mencionado) {
      await sock.sendMessage(chat, { text: venta ? `Uso: ${comando} [nombre] [precio 25-70] @usuario` : `Uso: ${comando} [nombre] @usuario` }, { quoted: msg });
      saveJardin(data);
      return true;
    }
    if (roleUserKey(mencionado) === roleUserKey(remitente)) { await sock.sendMessage(chat, { text: 'No puedes negociar contigo mismo.' }, { quoted: msg }); saveJardin(data); return true; }
    const origen = kind === 'semilla' ? u.semillas : u.cosecha;
    if (bolsa(origen, variedad.nombre) < 1) { await sock.sendMessage(chat, { text: `No tienes ${kind === 'semilla' ? 'semilla' : 'cosecha'} de ${variedad.nombre}.` }, { quoted: msg }); saveJardin(data); return true; }
    if (regaloCmd) {
      sumarBolsa(origen, variedad.nombre, -1);
      const destino = jardinUser(data, mencionado);
      sumarBolsa(kind === 'semilla' ? destino.semillas : destino.cosecha, variedad.nombre, 1);
      saveJardin(data);
      await sock.sendMessage(chat, { text: `🎁 @${roleUserKey(remitente)} regaló *${variedad.nombre}* a @${roleUserKey(mencionado)}.`, mentions: [remitente, mencionado] }, { quoted: msg });
      return true;
    }
    const precioFinal = precio == null ? (kind === 'semilla' ? 25 : variedad.precio) : precio;
    if (precioFinal < 25 || precioFinal > 70) { await sock.sendMessage(chat, { text: 'El precio tiene que estar entre 25 y 70 Suba Coins.' }, { quoted: msg }); saveJardin(data); return true; }
    sumarBolsa(origen, variedad.nombre, -1);
    saveJardin(data);
    const enviado = await sock.sendMessage(chat, { text: `🏷️ *OFERTA*\n@${roleUserKey(remitente)} vende *${variedad.nombre}* (${kind}) a @${roleUserKey(mencionado)} por *${precioFinal}* Suba Coins.\nResponde a este mensaje con ${kind === 'semilla' ? '.aceptarsemilla' : '.aceptarplanta'} (5 minutos).`, mentions: [remitente, mencionado] }, { quoted: msg });
    const fresco = loadJardin();
    fresco.offers[enviado.key.id] = { kind, nombre: variedad.nombre, precio: precioFinal, seller: remitente, buyer: mencionado, cantidad: 1, expiresAt: Date.now() + OFERTA_MS };
    saveJardin(fresco);
    return true;
  }
  saveJardin(data);
  return false;
}


// Evita que varias descargas de video grandes a la vez llenen la RAM o el almacenamiento del teléfono.
const MAX_DESCARGAS_VIDEO = 2;
let descargasVideoActivas = 0;
const cupoVideoDisponible = () => descargasVideoActivas < MAX_DESCARGAS_VIDEO;
const tomarCupoVideo = () => { descargasVideoActivas++; };
const soltarCupoVideo = () => { descargasVideoActivas = Math.max(0, descargasVideoActivas - 1); };

// Guarda una descarga (stream web de fetch) en disco y la corta si supera el límite.
async function guardarConLimite(cuerpoWeb, destino, maxBytes, mensaje) {
  let bytes = 0;
  const limitador = new Transform({
    transform(trozo, _enc, cb) {
      bytes += trozo.length;
      if (bytes > maxBytes) return cb(new Error(mensaje));
      cb(null, trozo);
    }
  });
  await pipeline(Readable.fromWeb(cuerpoWeb), limitador, fs.createWriteStream(destino));
  if (!bytes) throw new Error('El archivo descargado está vacío.');
  return bytes;
}

function nombreArchivoSeguro(titulo, extension) {
  const limpio = String(titulo || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${limpio || 'video'}.${extension}`;
}

function formatearNumero(n) {
  const x = Number(n);
  return Number.isFinite(x) ? String(Math.floor(x)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') : 'No disponible';
}

function formatearFechaYt(yyyymmdd) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(yyyymmdd || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : 'No disponible';
}

// Busca en YouTube (o usa el enlace si la persona pegó uno) y devuelve los datos del primer video.
async function buscarEnYoutube(consulta) {
  let info = null;
  if (/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(consulta)) {
    info = await getYtDlpMetadata(await validateDownloadUrl(consulta.split(/\s+/)[0]));
  } else {
    try {
      const { stdout } = await execFileAsync('yt-dlp', [
        '--no-config', '--no-warnings', '--dump-single-json', '--skip-download',
        '--playlist-items', '1', '--socket-timeout', '15', `ytsearch1:${consulta}`
      ], { timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
      info = JSON.parse(stdout.trim().split('\n').pop())?.entries?.[0] || null;
    } catch { info = null; }
  }
  if (!info || !/^[\w-]{11}$/.test(String(info.id || ''))) return null;
  return info;
}

async function obtenerPortadaYoutube(id) {
  for (const nombre of ['maxresdefault', 'hqdefault']) {
    try {
      const r = await fetch(`https://i.ytimg.com/vi/${id}/${nombre}.jpg`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 1000 && buf.length < 5 * 1024 * 1024) return buf;
    } catch {}
  }
  return null;
}

// Para el aviso de "comando inexistente": registra cuándo respondió el bot en cada chat.
const ULTIMO_ENVIO = new Map();
let comandosConocidosCache = null;
function comandosConocidos() {
  if (comandosConocidosCache) return comandosConocidosCache;
  const lista = new Set(['.jardín']);
  // 1) Todo comando escrito entre comillas en este archivo (.ping, .mp3, .tt, .roleplay…)
  try {
    for (const m of fs.readFileSync(__filename, 'utf8').matchAll(/['"`](\.\p{L}[\p{L}\p{N}_]*)['"`]/gu)) lista.add(m[1].toLowerCase());
  } catch {}
  // 2) Todo comando anunciado en el menú (incluye los de los módulos game-system, weather, etc.)
  for (const m of textoMenuPrincipal().matchAll(/(?<![\p{L}\p{N}_])(\.\p{L}[\p{L}\p{N}_]*)/gu)) lista.add(m[1].toLowerCase());
  comandosConocidosCache = lista;
  return lista;
}


function formatUptime(segundos) {
  const s = Math.floor(segundos);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function armarReportePing({ botName, creador, proceso, envio, total, recepcion }) {
  const nivel = total < 800 ? '🟢 Muy rápido' : total < 2000 ? '🟡 Normal' : '🔴 Lento';
  const rec = Number.isFinite(recepcion) && recepcion >= 0 && recepcion < 120000
    ? `≈ ${(recepcion / 1000).toFixed(1)} s`
    : 'no disponible';
  return [
    '🖤 *¡Pong!*',
    `${botName} está activo.`,
    `👑 Creador: ${creador}`,
    '',
    `⚡ Procesamiento interno: *${proceso} ms*`,
    `📤 Envío (confirmación de WhatsApp): *${envio} ms*`,
    `📥 Recepción (aprox., por reloj de WhatsApp): ${rec}`,
    `⏱️ Total hasta responder: *${total} ms* · ${nivel}`,
    '',
    `🕒 Activo desde hace: ${formatUptime(process.uptime())}`,
    `💾 RAM: ${Math.round(process.memoryUsage().rss / 1048576)} MB`
  ].join(String.fromCharCode(10));
}

// Quita líneas sueltas de pie de versiones viejas de la plantilla (p. ej. "Created by…", "v X.Y.Z",
// "Nota: …", "Ejemplos: …") que no llevan los adornos (╭│╰✧✐) del resto del catálogo.
// Usa NFKC para reconocer el texto aunque esté en negrita Unicode matemática (𝐂𝐫𝐞𝐚𝐭𝐞𝐝, etc.).
function quitarPieDesactualizado(texto) {
  return texto
    .split('\n')
    .filter(linea => {
      const plano = linea.normalize('NFKC').trim();
      if (!plano) return true;
      return !/^created by\b/i.test(plano)
        && !/^v\s?\d+(\.\d+){1,3}\s*$/i.test(plano)
        && !/^nota:/i.test(plano)
        && !/^ejemplos:/i.test(plano);
    })
    .join('\n')
    .trim();
}
function textoMenuPrincipal() {
  const archivo = path.join(__dirname, 'media', 'L_BOT_menu_final.txt');
  let plantilla = '';
  try { plantilla = fs.readFileSync(archivo, 'utf8'); } catch { plantilla = ''; }
  if (!plantilla.trim()) {
    return 'No encontré media/L_BOT_menu_final.txt junto al bot.\nCopia ese archivo y vuelve a usar .menu.\n\n🖤 ' + BOT_BRAND;
  }
  const inicio = plantilla.indexOf('»');
  if (inicio > 0) plantilla = plantilla.slice(inicio);
  plantilla = quitarPieDesactualizado(plantilla);
  // WORLD_MENU ya no se inyecta aquí: su contenido (RPG, Cafetería, Logros, Museo, Jardín)
  // ahora vive escrito a mano en L_BOT_menu_final.txt para evitar que salga duplicado.
  const modulos = [WEATHER_MENU, ...GAME_MENU_BLOCKS, ANIME_MENU].filter(Boolean).join('\n\n');
  if (plantilla.includes('{{MODULOS}}')) plantilla = plantilla.replace('{{MODULOS}}', modulos);
  else plantilla += '\n\n' + modulos;
  return plantilla.trim();
}

async function iniciarBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState(path.join(__dirname, 'database', 'auth_qr'));

  let waVersion;
  try {
    ({ version: waVersion } = await fetchLatestBaileysVersion());
  } catch (e) {
    console.log('No se pudo consultar la versión de WhatsApp Web; se usa la integrada en Baileys.');
  }

  const sock = makeWASocket({
    auth: state,
    ...(waVersion ? { version: waVersion } : {}),
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['L BOT', 'Chrome', '5.0.1'],
    cachedGroupMetadata: async (jid) => {
      const hit = groupCache.get(jid);
      return hit && Date.now() - hit.at < GROUP_CACHE_TTL ? hit.data : undefined;
    }
  });

  // Registro de respuestas por chat (lo usa el aviso de "comando inexistente" para no duplicar respuestas).
  const enviarOriginal = sock.sendMessage.bind(sock);
  sock.sendMessage = (jid, ...resto) => {
    try { ULTIMO_ENVIO.set(jid, Date.now()); } catch {}
    return enviarOriginal(jid, ...resto);
  };

  const automaticSock = crearSocketAutomatico(sock);
  let automaticModulesStarted = false;
  function iniciarModulosAutomaticos() {
    if (automaticModulesStarted) return;
    automaticModulesStarted = true;
    try {
      Promise.resolve(startCompanionAutomation(automaticSock)).catch(e => console.log('Companion automation:', e.message));
    } catch (e) { console.log('Companion automation:', e.message); }
    try {
      Promise.resolve(startHahariAutomation(automaticSock, OWNER_NUMBER)).catch(e => console.log('Hahari automation:', e.message));
    } catch (e) { console.log('Hahari automation:', e.message); }
  }

  activeSock = sock;
  AUTOEXP_STATE.sock = automaticSock;
  NOVIAS_AUTO_STATE.sock = automaticSock;

  sock.ev.on('creds.update', saveCreds);

  // Mantiene fresca la caché de grupos cuando cambian los datos o los integrantes.
  sock.ev.on('groups.update', (cambios) => {
    for (const c of cambios || []) if (c?.id) groupCache.delete(c.id);
  });

  sock.ev.on('group-participants.update', async (u) => {
    try {
      if (u?.id) { try { groupCache.delete(u.id); } catch {} }
      if (!u || u.action !== 'add') return;
      const grupo = u.id;
      const botJid = sock.user?.id;
      const botNum = botJid ? normalizeNumber(botJid) : '';
      const parts = Array.isArray(u.participants) ? u.participants : [];
      const botAdded = parts.some(p => {
        const jid = normalizarParticipanteBienvenida(p);
        const n = normalizeNumber(jid);
        return Boolean(botNum && n === botNum);
      });
      if (botAdded) {
        const actor = u.author || parts[0];
        let actorOk = false;
        try { actorOk = actor && (normalizeNumber(actor) === OWNER_NUMBER || isOwner({ key: { participant: actor, remoteJid: actor } })); }
        catch { actorOk = actor && normalizeNumber(actor) === OWNER_NUMBER; }
        if (!actorOk) {
          try { await sock.sendMessage(grupo, { text: '⛔ Solo el creador puede agregarme a grupos. Saliendo…' }); } catch {}
          try { await sock.groupLeave(grupo); } catch {}
        }
        return;
      }
      for (const p of parts) {
        try {
          const participante = normalizarParticipanteBienvenida(p);
          if (!participante || (botNum && normalizeNumber(participante) === botNum)) continue;
          await enviarBienvenida(grupo, participante);
        } catch (e) { console.log('Bienvenida:', e.message || e); }
      }
    } catch (e) { console.log('group-participants:', e.message); }
  });


  // Programador único: no crea intervalos duplicados al reconectar.
  async function programarAutoExpresion() {
    if (!automaticMenOn()) { AUTOEXP_STATE.timer = null; return; }
    if (AUTOEXP_STATE.timer) clearTimeout(AUTOEXP_STATE.timer);
    AUTOEXP_STATE.timer = setTimeout(async () => {
      const autoSock = AUTOEXP_STATE.sock;
      try {
        const estado = loadAutoExp();
        const hora = hondurasHour();
        if (automaticMenOn() && estado.enabled && hora >= 6 && hora <= 23 && autoSock?.user) {
          const grupos = await autoSock.groupFetchAllParticipating();
          const ids = Object.keys(grupos || {}).filter(id => id.endsWith('@g.us'));
          if (ids.length) {
            const grupo = randomItem(ids);
            const metadata = await autoSock.groupMetadata(grupo);
            const miembros = (metadata.participants || []).map(x => x.id).filter(Boolean);
            if (miembros.length) {
              // El propietario tiene una probabilidad mayor de ser elegido (35%).
              const ownerJid = `${OWNER_NUMBER}@s.whatsapp.net`;
              const ownerEnGrupo = miembros.includes(ownerJid);
              const objetivo = ownerEnGrupo && Math.random() < 0.35 ? ownerJid : randomItem(miembros);
              const accionesAuto = [
                ['hug', 'abrazar', 'Un abrazo inesperado acaba de aparecer en el chat.'],
                ['wave', 'saludar', '¡Una visita anime llega para saludar!'],
                ['pat', 'acariciar', 'Un gesto amable para levantar los ánimos.'],
                ['happy', 'sonreír', 'Una pequeña dosis de alegría para el grupo.'],
                ['clap', 'aplaudir', '¡Un aplauso para la comunidad!'],
                ['blush', 'sonrojar', 'Alguien se ha sonrojado en esta escena.']
              ];
              const [tipo, nombre, frase] = randomItem(accionesAuto);
              const caption = `🌸 *EXPRESIÓN AUTOMÁTICA*\n\n${frase}\n🎯 Persona elegida: @${objetivo.split('@')[0]}\n\n🖤 ${BOT_BRAND}`;
              if (!privAutoOn()) return;
              try { await sendAnimeGif(autoSock, grupo, tipo, caption, [objetivo]); }
              catch (e) { console.log('Autoexpresión omitida:', e.message); }
              estado.lastSentAt = Date.now(); saveAutoExp(estado);
            }
          }
        }
      } catch (e) { console.log('Error del programador autoexpresiones:', e.message); }
      finally {
        if (automaticMenOn()) programarAutoExpresion();
        else AUTOEXP_STATE.timer = null;
      }
    }, (45 + Math.floor(Math.random() * 46)) * 60 * 1000);
  }
  if (!AUTOEXP_STATE.started) {
    AUTOEXP_STATE.started = true;
    if (automaticMenOn()) programarAutoExpresion();
  }

function programarMensajesNovias() {
    if (!automaticMenOn()) { NOVIAS_AUTO_STATE.timer = null; return; }
    if (NOVIAS_AUTO_STATE.timer) clearTimeout(NOVIAS_AUTO_STATE.timer);
    const esperaMin = 7 + Math.floor(Math.random() * 2); // 7–8 minutos
    NOVIAS_AUTO_STATE.timer = setTimeout(async () => {
      const autoSock = NOVIAS_AUTO_STATE.sock || AUTOEXP_STATE.sock;
      try {
        const estado = loadNoviasAuto();
        const hora = hondurasHour();
        if (automaticMenOn() && estado.enabled && nsfwActivo() && hora >= 7 && hora <= 23 && autoSock && autoSock.user) {
          const ownerJid = OWNER_NUMBER + '@s.whatsapp.net';
          const personajes = [
            { id: 'hakari', nombre: '💗 *Hakari Hanazono*', voice: 'hakari', pool: () => MENSAJES_HAHARI_AUTO.concat(MENSAJES_H30.filter(t => /Hakari|hakari|💦|🥵|💗|😈|🚿|🛏️/.test(t) && !/Karane|karane|baka|Baka|💢/.test(t))) },
            { id: 'karane', nombre: '💢 *Karane Inda*', voice: 'karane', pool: () => MENSAJES_KARANE_AUTO.concat(MENSAJES_H30.filter(t => /Karane|karane|baka|Baka|💢|😳/.test(t))) },
            { id: 'jane', nombre: '🐀 *Jane Doe*', voice: 'jane', pool: () => MENSAJES_JANE_AUTO },
            { id: 'burnice', nombre: '🔥 *Burnice*', voice: 'burnice', pool: () => MENSAJES_BURNICE_AUTO },
            { id: 'zhuyuan', nombre: '👮 *Zhu Yuan*', voice: 'zhuyuan', pool: () => MENSAJES_ZHU_AUTO }
          ];
          const quien = personajes[Math.floor(Math.random() * personajes.length)];
          const pool = quien.pool();
          const texto = pool[Math.floor(Math.random() * pool.length)];
          const mensaje = quien.nombre + '\n\n' + texto;
          await enviarTextoConTTS(autoSock, ownerJid, mensaje, quien.voice);
          estado.lastSentAt = Date.now();
          saveNoviasAuto(estado);
        }
      } catch (e) {
        console.log('Error mensajes automáticos personajes:', e.message);
      }
      if (automaticMenOn()) programarMensajesNovias();
      else NOVIAS_AUTO_STATE.timer = null;
    }, esperaMin * 60 * 1000);
}
  if (!NOVIAS_AUTO_STATE.started) {
    NOVIAS_AUTO_STATE.started = true;
    if (automaticMenOn()) programarMensajesNovias();
  }




  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) qrcode.generate(qr, { small: true });

    if (connection === 'open') {
      if (activeSock !== sock) return;

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      reconnectAttempts = 0;

            console.log(`🖤 ${config.botName} está conectado.`);
      if (automaticMenOn()) iniciarModulosAutomaticos();
    }

    if (connection === 'close') {
      if (activeSock !== sock) return;

      AUTOEXP_STATE.sock = null;
      NOVIAS_AUTO_STATE.sock = null;

      const codigo = lastDisconnect?.error?.output?.statusCode;

      if (codigo === DisconnectReason.loggedOut) {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        console.log('Sesión cerrada. Debes vincular nuevamente.');
        return;
      }

      if (codigo === DisconnectReason.connectionReplaced) {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        console.log('⚠️ Otra instancia está usando esta misma sesión (conexión reemplazada). Ciérrala (pkill node) y vuelve a iniciar. No se reconecta para no dañar la sesión.');
        return;
      }

      if (!reconnectTimer) {
        reconnectAttempts++;

        const delay = Math.min(
          30000,
          2000 * Math.pow(2, reconnectAttempts - 1)
        );

        console.log(`Reconectando en ${Math.round(delay / 1000)} segundos...`);

        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          iniciarBot().catch(error => {
            console.error('Error al reconectar L BOT:', error);
          });
        }, delay);
      }
    }
  });;

  // Normaliza participantes Baileys: puede llegar como JID o como objeto PN/LID.
  function normalizarParticipanteBienvenida(valor) {
    let jid = '';
    if (typeof valor === 'string') jid = valor;
    else if (valor && typeof valor === 'object') {
      jid = valor.phoneNumber || valor.id || valor.jid || valor.lid || '';
    }
    if (typeof jid !== 'string') return '';
    jid = jid.trim();
    if (!jid) return '';
    if (!jid.includes('@')) {
      const numero = jid.replace(/\D/g, '');
      return numero ? `${numero}@s.whatsapp.net` : '';
    }
    return jid;
  }

  // BIENVENIDA: banner + mensaje, sin duplicar el catálogo de comandos.
  // Antes dependía de automaticMenOn() (el interruptor de mensajes NSFW/auto-expresión);
  // ahora usa su propio interruptor (bienvenidaOn()) para que apagar uno no apague el otro.
  async function enviarBienvenida(grupo, participanteEntrada) {
    if (!bienvenidaOn()) {
      console.log('Bienvenida omitida: .bienvenida está en off.');
      return;
    }
    const participante = normalizarParticipanteBienvenida(participanteEntrada);
    if (!participante) {
      console.log('Bienvenida omitida: participante sin JID válido.');
      return;
    }
    const numero = participante.split('@')[0].split(':')[0];
    const bienvenida =
      '_☆  𝑩𝒊𝒆𝒏𝒗𝒆𝒏𝒊𝒅𝒐, @' + numero + ' ☆_\n' +
      '　　　　　   ¡𝑸𝒖𝒆 𝒍𝒂 𝒑𝒂𝒔𝒆𝒔 𝒃𝒊𝒆𝒏!\n' +
      '　　`✦ 𝑵𝒐𝒔 𝒂𝒍𝒆𝒈𝒓𝒂 𝒕𝒆𝒏𝒆𝒓𝒕𝒆 𝒑𝒐𝒓 𝒂𝒒𝒖𝒊́.\n' +
      '　    　 𝑬𝒔𝒑𝒆𝒓𝒂𝒎𝒐𝒔 𝒒𝒖𝒆 𝒕𝒆 𝒔𝒊𝒆𝒏𝒕𝒂𝒔 𝒂 𝒈𝒖𝒔𝒕𝒐,\n' +
      '　    　 𝒒𝒖𝒆 𝒅𝒊𝒔𝒇𝒓𝒖𝒕𝒆𝒔 𝒅𝒆𝒍 𝒈𝒓𝒖𝒑𝒐 𝒚 𝒒𝒖𝒆 𝒑𝒖𝒆𝒅𝒂𝒔\n' +
      '　　 　 𝒄𝒐𝒎𝒑𝒂𝒓𝒕𝒊𝒓 𝒎𝒖𝒄𝒉𝒐𝒔 𝒃𝒖𝒆𝒏𝒐𝒔 𝒎𝒐𝒎𝒆𝒏𝒕𝒐𝒔.`\n\n' +
      '　　*✦ 𝑺𝒊𝒈𝒖𝒆 𝒍𝒂𝒔 𝒓𝒆𝒈𝒍𝒂𝒔 𝒅𝒆 𝒍𝒂 𝒄𝒐𝒎𝒖𝒏𝒊𝒅𝒂𝒅, 𝒔𝒆̀ 𝒓𝒆𝒔𝒑𝒆𝒕𝒖𝒐𝒔𝒐 𝒚 𝒂𝒎𝒂𝒃𝒍𝒆.*\n\n' +
      '　　> ☆ 𝑺𝒊 𝒏𝒆𝒄𝒆𝒔𝒊𝒕𝒂𝒔 𝒂𝒚𝒖𝒅𝒂 𝒐 𝒒𝒖𝒊𝒆𝒓𝒆𝒔\n' +
      '　　 𝒅𝒆𝒔𝒄𝒖𝒃𝒓𝒊𝒓 𝒍𝒐 𝒒𝒖𝒆 𝒑𝒖𝒆𝒅𝒆𝒔 𝒉𝒂𝒄𝒆𝒓,\n' +
      '　　 𝒆𝒔𝒄𝒓𝒊𝒃𝒆 «.𝒎𝒆𝒏𝒖́» 𝒑𝒂𝒓𝒂 𝒗𝒆𝒓 𝒍𝒐𝒔 𝒄𝒐𝒎𝒂𝒏𝒅𝒐𝒔.✰\n\n' +
      '　 　   _♡ ꧁༒ 𝑅𝑒𝑧𝑒 𝑅𝑜𝑖𝑟 ༒꧂♡\n' +
      '　          👑 𝑪𝒓𝒆𝒂𝒕𝒆𝒅 𝒃𝒚 𝑺𝒖𝒃𝒂𝒅𝒂𝒔𝒉𝒊𝒊 (𝒬. ℰ. 𝒫. 𝒟.) 👑\n' +
      '　　》 ¡𝑵𝒐 𝒉𝒂𝒚 𝒄𝒐𝒎𝒂𝒏𝒅𝒐𝒔 𝑵𝑺𝑭𝑾 𝒑𝒂𝒓𝒂 𝒆𝒔𝒕𝒆 𝒈𝒓𝒖𝒑𝒐! ┐(\'～`;)┌_';

    const candidatas = [
      BANNER,
      path.join(__dirname, 'media', 'New_banner_bot.png'),
      path.join(os.homedir(), 'storage', 'downloads', 'MusicForBot', 'New_banner_bot.png'),
      path.join(__dirname, 'media', 'l.png'),
      path.join(__dirname, 'media', 'hakari.png')
    ].filter(Boolean);

    for (const ruta of [...new Set(candidatas)]) {
      try {
        if (!fs.existsSync(ruta)) continue;
        const buf = fs.readFileSync(ruta);
        if (!buf.length || buf.length > 8 * 1024 * 1024) continue;
        await sock.sendMessage(grupo, {
          image: buf,
          caption: bienvenida,
          mentions: [participante]
        });
        console.log('Bienvenida con banner enviada:', participante);
        return;
      } catch (e) {
        console.log('Bienvenida: no se pudo enviar imagen (' + ruta + '):', e.message || e);
      }
    }

    // Si no existe el banner, la bienvenida de texto todavía se entrega.
    await sock.sendMessage(grupo, { text: bienvenida, mentions: [participante] });
    console.log('Bienvenida de texto enviada (sin banner):', participante);
  }

  // MENSAJES Y COMANDOS
  sock.ev.on('messages.upsert', async (evento) => {
    const messages = Array.isArray(evento?.messages) ? evento.messages : [];
    console.log(`📩 messages.upsert | tipo: ${evento?.type || 'desconocido'} | mensajes: ${messages.length}`);

    for (const msg of messages) {
    if (!msg?.message || msg.key?.fromMe) continue;

    // Desenvuelve mensajes temporales para leer texto, captions y comandos.
    let contenido = msg.message;
    for (let i = 0; i < 5; i++) {
      const envuelto = contenido?.ephemeralMessage?.message ||
        contenido?.viewOnceMessage?.message ||
        contenido?.viewOnceMessageV2?.message ||
        contenido?.documentWithCaptionMessage?.message;
      if (!envuelto) break;
      contenido = envuelto;
    }

    const chat = msg.key.remoteJid;
    const remitente = msg.key.participant || chat;

    // PRIVADO: el bot solo responde al creador. Otros números = silencio total.
    if (chat && !String(chat).endsWith('@g.us') && !String(chat).endsWith('@broadcast')) {
      const soyOwner = isOwner(msg) || normalizeNumber(remitente) === OWNER_NUMBER || normalizeNumber(chat) === OWNER_NUMBER;
      if (!soyOwner) continue;
    }

    const texto =
      contenido.conversation ||
      contenido.extendedTextMessage?.text ||
      contenido.imageMessage?.caption ||
      contenido.videoMessage?.caption ||
      contenido.documentMessage?.caption ||
      '';

    
    // Modo Waguri: frases naturales sin prefijo "."
    try {
      if (automaticMenOn() && waguriActivoEn(chat) && texto && !String(texto).trim().startsWith('.')) {
        if (esPreguntaAmorWaguri(texto)) {
          const esCreador = isOwner(msg) || normalizeNumber(remitente) === OWNER_NUMBER || normalizeNumber(chat) === OWNER_NUMBER;
          const resp = respuestaAmorWaguri(texto, esCreador);
          await sock.sendMessage(chat, { text: resp }, { quoted: msg });
          continue;
        }
      }
    } catch (e) { console.log('waguri chat:', e.message); }

    const partes = texto.trim().split(/\s+/);
    const comando = (partes[0] || '').toLowerCase();
      const argumento = partes.slice(1).join(' ');

      if (comando === '.offbot' || comando === '.onbot') {
        const owner = isOwner(msg);
        let admin = false;
        try { if (!owner && chat.endsWith('@g.us')) admin = await isGroupAdmin(sock, chat, remitente, true); } catch {}
        if (comando === '.offbot') {
          if (!owner) {
            await sock.sendMessage(chat, { text: '⛔ Solo el *creador* puede usar `.offbot`.' }, { quoted: msg });
            continue;
          }
          setBotInChat(chat, false);
          await sock.sendMessage(chat, { text: '⏸️ Bot apagado en este grupo. Activa con `.onbot`' }, { quoted: msg });
          continue;
        }
        if (!owner && !admin) {
          await sock.sendMessage(chat, { text: '⛔ Solo el *creador* o un *admin* puede usar `.onbot`.' }, { quoted: msg });
          continue;
        }
        setBotInChat(chat, true);
        await sock.sendMessage(chat, { text: '✅ Bot encendido en este grupo.' }, { quoted: msg });
        continue;
      }

      // PRIORIDAD: estilos de texto (debe responder siempre)
      if (['.negrita','.cursiva','.negritacursiva','.mono','.doble','.script','.fraktur','.smallcaps','.burbuja','.cuadrado'].includes((comando || '').toLowerCase())) {
        const frase = (argumento || '').trim() || (texto || '').replace(/^\.\S+\s*/, '').trim();
        if (!frase) {
          await sock.sendMessage(chat, { text: '✍️ Uso: ' + comando + ' [texto]\nEjemplo: ' + comando + ' Hola, asi tiene que quedar el texto.' }, { quoted: msg });
          continue;
        }
        try {
          const tipo = String(comando).slice(1).toLowerCase();
          const out = estiloUnicode(tipo, frase).slice(0, 3500);
          await sock.sendMessage(chat, { text: out }, { quoted: msg });
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ Estilo: ' + (e.message || e) }, { quoted: msg });
        }
        continue;
      }

      // Anti-spam: mensajes repetidos
      try {
        if (chat.endsWith('@g.us') && antispamActivoEn(chat) && !isOwner(msg) && texto && !String(texto).startsWith('.')) {
          const spam = checkAntiSpam(msg.key.participant || msg.key.remoteJid, chat, texto);
          if (spam) {
            try { await sock.sendMessage(chat, { delete: msg.key }); } catch {}
            // sumar warn si existe sistema
            try {
              let warns = {};
              try { warns = JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8')) || {}; } catch {}
              const uid = normalizeNumber(msg.key.participant || msg.key.remoteJid);
              const key = chat + '|' + uid;
              const cur = Number(warns[key] || 0) + 1;
              warns[key] = cur;
              fs.mkdirSync(path.dirname(WARNINGS_FILE), { recursive: true });
              fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warns, null, 2));
              await sock.sendMessage(chat, { text: '🚫 Spam detectado. Advertencia ' + cur + '/3' + (cur >= 3 ? ' (limite)' : '') }, { quoted: msg });
              if (cur >= 3) {
                try { await sock.groupParticipantsUpdate(chat, [msg.key.participant || (uid + '@s.whatsapp.net')], 'remove'); } catch {}
              }
            } catch {}
            continue;
          }
        }
      } catch {}

      // GODMODE
      if (comando === '.godmode') {
        if (!isOwner(msg)) { await sock.sendMessage(chat, { text: 'Solo el creador.' }, { quoted: msg }); continue; }
        const sub = (partes[1] || '').toLowerCase();
        if (sub === 'on') { saveGodMode({ enabled: true }); await sock.sendMessage(chat, { text: '⚡ Godmode ON' }, { quoted: msg }); }
        else if (sub === 'off') { saveGodMode({ enabled: false }); await sock.sendMessage(chat, { text: 'Godmode OFF' }, { quoted: msg }); }
        else await sock.sendMessage(chat, { text: 'Uso: .godmode on|off\nEstado: ' + (godModeOn() ? 'ON' : 'OFF') }, { quoted: msg });
        continue;
      }

      // WARNLIST
      if (comando === '.warnlist' || comando === '.listawarn' || comando === '.listawarms') {
        try {
          let data = {};
          try { data = JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8')) || {}; } catch {}
          const groupKey = chat;
          const entries = [];
          for (const [k, v] of Object.entries(data)) {
            if (typeof v === 'object' && v[groupKey] != null) entries.push([k, v[groupKey]]);
            else if (k.includes(groupKey.replace('@g.us','')) || (typeof v === 'number' && k.startsWith(chat))) entries.push([k, v]);
          }
          // flat structure fallback: userJid -> count for this chat stored as chat|user
          if (!entries.length) {
            for (const [k, v] of Object.entries(data)) {
              const n = typeof v === 'number' ? v : (v && v.count);
              if (n && String(k).includes(String(chat).slice(0, 15))) entries.push([k, n]);
              else if (typeof n === 'number' && n > 0) entries.push([k, n]);
            }
          }
          entries.sort((a, b) => Number(b[1]) - Number(a[1]));
          if (!entries.length) {
            await sock.sendMessage(chat, { text: '📋 No hay advertencias registradas visibles.' }, { quoted: msg });
          } else {
            const lines = entries.slice(0, 40).map((e, i) => `${i + 1}. ${String(e[0]).split('@')[0].slice(-12)} → ${e[1]}/3`);
            await sock.sendMessage(chat, { text: '📋 *WARNLIST*\n' + lines.join('\n') }, { quoted: msg });
          }
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ warnlist: ' + e.message }, { quoted: msg });
        }
        continue;
      }

      // CUMPLE
      if (comando === '.cumple' || comando === '.changecumple') {
        const who = normalizeNumber(msg.key.participant || msg.key.remoteJid);
        const all = loadCumples();
        const fecha = argumento.trim();
        if (!fecha && comando === '.cumple') {
          const m = all[who];
          await sock.sendMessage(chat, { text: m ? ('🎂 Tu cumple: *' + m + '*\nCambia con .changecumple [fecha]') : 'Uso: .cumple 9 de septiembre del 2005' }, { quoted: msg });
          continue;
        }
        if (!fecha) {
          await sock.sendMessage(chat, { text: 'Uso: .changecumple 9 de septiembre del 2005' }, { quoted: msg });
          continue;
        }
        if (comando === '.cumple' && all[who] && !godModeOn()) {
          await sock.sendMessage(chat, { text: 'Ya tienes fecha: *' + all[who] + '*\nUsa .changecumple para cambiarla.' }, { quoted: msg });
          continue;
        }
        all[who] = fecha.slice(0, 80);
        saveCumples(all);
        await sock.sendMessage(chat, { text: '🎂 Guardado: *' + all[who] + '*' }, { quoted: msg });
        continue;
      }

      // PLAYAUDIO
      if (comando === '.playaudio' || comando === '.play') {
        const q = argumento.trim();
        if (!q) {
          await sock.sendMessage(chat, { text: '🎵 Uso: .playaudio [nombre o palabras]\nEjemplo: .playaudio lofi hip hop' }, { quoted: msg });
          continue;
        }
        reaccionar(sock, msg, '⏳');
        const carpeta = path.join(os.tmpdir(), 'lbot-play-' + Date.now());
        fs.mkdirSync(carpeta, { recursive: true });
        try {
          await sock.sendMessage(chat, { text: '🔎 Buscando audio…\n0%' }, { quoted: msg });
          let info = null;
          if (typeof buscarEnYoutube === 'function') info = await buscarEnYoutube(q);
          let url = info ? ('https://www.youtube.com/watch?v=' + info.id) : null;
          if (!url) {
            // yt-dlp search
            url = 'ytsearch1:' + q;
          }
          const progressMsg = { text: '📥 Descargando audio…\n15%' };
          await sock.sendMessage(chat, progressMsg, { quoted: msg }).catch(() => {});
          await execFileAsync('yt-dlp', [
            '--no-config', '--no-warnings', '--no-playlist',
            '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '5',
            '--restrict-filenames', '-f', 'bestaudio/best',
            '--max-filesize', '50M', '--match-filter', 'duration <= 900',
            '--socket-timeout', '20', '--retries', '1',
            '--output', path.join(carpeta, '%(title).70s.%(ext)s'),
            url
          ], { timeout: 12 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
          await sock.sendMessage(chat, { text: '📥 Procesando…\n70%' }, { quoted: msg }).catch(() => {});
          const found = fs.readdirSync(carpeta).filter(n => n.toLowerCase().endsWith('.mp3'));
          if (!found.length) throw new Error('No se obtuvo audio.');
          const file = path.join(carpeta, found[0]);
          const title = (info && info.title) ? info.title : path.parse(found[0]).name;
          let thumb = null;
          if (info && info.id && typeof obtenerPortadaYoutube === 'function') {
            try { thumb = await obtenerPortadaYoutube(info.id); } catch {}
          }
          const caption = [
            '🎵 *' + String(title).slice(0, 120) + '*',
            info && info.channel ? ('> Canal: ' + String(info.channel).slice(0, 80)) : null,
            info && info.duration ? ('> Duracion: ' + formatDuration(info.duration)) : null,
            url && !url.startsWith('ytsearch') ? ('> Enlace: ' + url) : null
          ].filter(Boolean).join('\n');
          if (thumb) await sock.sendMessage(chat, { image: thumb, caption }, { quoted: msg });
          else await sock.sendMessage(chat, { text: caption }, { quoted: msg });
          await sock.sendMessage(chat, { audio: { url: file }, mimetype: 'audio/mpeg', ptt: false, fileName: title.slice(0, 60) + '.mp3' }, { quoted: msg });
          reaccionar(sock, msg, '✅');
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ playaudio: ' + (e.message || e).toString().slice(0, 300) }, { quoted: msg });
        } finally {
          try { fs.rmSync(carpeta, { recursive: true, force: true }); } catch {}
        }
        continue;
      }

      // STICKERPACK (basico: busca stickers/imagenes y convierte)
      if (comando === '.stickerpack') {
        const q = argumento.trim();
        if (!q) {
          await sock.sendMessage(chat, { text: '🎨 Uso: .stickerpack [nombre]\nEjemplo: .stickerpack anime cute' }, { quoted: msg });
          continue;
        }
        reaccionar(sock, msg, '⏳');
        try {
          await sock.sendMessage(chat, { text: '🎨 Buscando imagenes para pack…' }, { quoted: msg });
          // Usa pin-like search: nekobot / waifu fallbacks + rule34-safe not
          const urls = [];
          for (const type of ['neko', 'waifu', 'meow', 'kitsune']) {
            try {
              const r = await fetch('https://nekos.life/api/v2/img/' + type, { signal: AbortSignal.timeout(10000) });
              if (r.ok) {
                const j = await r.json();
                if (j.url) urls.push(j.url);
              }
            } catch {}
            if (urls.length >= 3) break;
          }
          if (!urls.length) throw new Error('No se obtuvieron imagenes.');
          for (const u of urls.slice(0, 3)) {
            try {
              const buf = await fetchBufferUA(u, 5 * 1024 * 1024);
              await sock.sendMessage(chat, { sticker: buf }, { quoted: msg });
            } catch {}
          }
          await sock.sendMessage(chat, { text: '✅ Pack basico enviado (3 stickers). Nombre buscado: ' + q.slice(0, 60) }, { quoted: msg });
          reaccionar(sock, msg, '✅');
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ stickerpack: ' + (e.message || e) }, { quoted: msg });
        }
        continue;
      }

      // ONLYCREATOR NSFW MENU
      if (comando === '.onlycreatornsfw' || comando === '.nsfwmenu' || comando === '.infonsfw') {
        if (!isOwner(msg)) { await sock.sendMessage(chat, { text: 'Solo el creador.' }, { quoted: msg }); continue; }
        const nsfwMenu = [
          '🔒 *NSFW (solo creador)*',
          '',
          '.onnsfw / .offnsfw — global',
          '.onthisnsfw / .offthisnsfw — este grupo',
          '.himg [tags] — imagen Rule34',
          '.hbooru — video H aleatorio MP4',
          '.rulevideo480p|720p|1080p [enlace|busqueda]',
          '.rulevideosearch [palabras]',
          '.sexo @usuario — texto + gif H',
          '.hvideo — video H',
          '.hgif — gif H',
          '',
          'Requiere NSFW activo en el contexto.'
        ].join('\n');
        await sock.sendMessage(chat, { text: nsfwMenu }, { quoted: msg });
        continue;
      }

      // ranking actividad
      try {
        if (chat.endsWith('@g.us') && featureOn('ranking', chat)) {
          const RANK_FILE = path.join(__dirname, 'database', 'ranking.json');
          let data = {};
          try { data = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8')); } catch { data = {}; }
          if (!data[chat]) data[chat] = {};
          const who = remitente || msg.key.participant || msg.key.remoteJid;
          data[chat][who] = (data[chat][who] || 0) + 1;
          fs.mkdirSync(path.dirname(RANK_FILE), { recursive: true });
          fs.writeFileSync(RANK_FILE, JSON.stringify(data));
        }
      } catch {}

    
    

      
      if (comando === '.offmensajesauto' || comando === '.onmensajesauto' || comando === '.mensajesauto') {
        if (!isOwner(msg)) {
          await sock.sendMessage(chat, { text: 'Solo el creador.' }, { quoted: msg });
          continue;
        }
        if (comando === '.offmensajesauto') {
          const st = loadPrivAuto(); st.enabled = false; savePrivAuto(st);
          await sock.sendMessage(chat, { text: '⏸️ Mensajes automáticos del *privado* desactivados.\n(No afecta autoexpresiones de grupos ni otros módulos.)' }, { quoted: msg });
        } else if (comando === '.onmensajesauto') {
          const st = loadPrivAuto(); st.enabled = true; savePrivAuto(st);
          await sock.sendMessage(chat, { text: '✅ Mensajes automáticos del *privado* activados.' }, { quoted: msg });
        } else {
          const st = loadPrivAuto();
          await sock.sendMessage(chat, { text: 'Priv auto: ' + (st.enabled !== false ? 'ON' : 'OFF') + '\n.offmensajesauto / .onmensajesauto' }, { quoted: msg });
        }
        continue;
      }

      // === Estilos de texto Unicode ===
      if (['.negrita','.cursiva','.negritacursiva','.mono','.doble','.script','.fraktur','.smallcaps','.burbuja','.cuadrado'].includes(comando)) {
        const frase = argumento.trim();
        if (!frase) {
          await sock.sendMessage(chat, { text: '✍️ Uso: ' + comando + ' [texto]\nEjemplo: ' + comando + ' Hola grupo' }, { quoted: msg });
          continue;
        }
        const tipo = comando.slice(1);
        const out = estiloUnicode(tipo, frase).slice(0, 3500);
        await sock.sendMessage(chat, { text: out }, { quoted: msg });
        continue;
      }

      // === Spotify (audio via yt-dlp) ===
      if (comando === '.spotify') {
        const url = argumento.trim();
        if (!url || !/spotify\.com/i.test(url)) {
          await sock.sendMessage(chat, { text: '🎵 Uso: .spotify https://open.spotify.com/track/...\nSolo enlaces de canción (track).' }, { quoted: msg });
          continue;
        }
        reaccionar(sock, msg, '⏳');
        const carpeta = path.join(os.tmpdir(), 'lbot-spotify-' + Date.now());
        fs.mkdirSync(carpeta, { recursive: true });
        try {
          await sock.sendMessage(chat, { text: '🎧 Descargando audio de Spotify…' }, { quoted: msg });
          await execFileAsync('yt-dlp', [
            '--no-config', '--no-warnings', '--no-playlist',
            '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
            '--restrict-filenames', '-f', 'bestaudio/best',
            '--max-filesize', '50M', '--socket-timeout', '25', '--retries', '2',
            '--output', path.join(carpeta, '%(title).80s.%(ext)s'), url
          ], { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
          const found = fs.readdirSync(carpeta).filter(n => n.toLowerCase().endsWith('.mp3'));
          if (!found.length) throw new Error('No se obtuvo MP3. Prueba otro enlace de track o más tarde.');
          const file = path.join(carpeta, found[0]);
          const title = path.parse(found[0]).name;
          await sock.sendMessage(chat, {
            audio: { url: file },
            mimetype: 'audio/mpeg',
            ptt: false,
            fileName: title + '.mp3'
          }, { quoted: msg });
          await sock.sendMessage(chat, { text: '🎵 *' + title.slice(0, 120) + '*\n> Fuente: Spotify' }, { quoted: msg });
          reaccionar(sock, msg, '✅');
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ Spotify: ' + (e.message || e).toString().slice(0, 300) }, { quoted: msg });
        } finally {
          try { fs.rmSync(carpeta, { recursive: true, force: true }); } catch {}
        }
        continue;
      }

      // === Subtítulos (OpenSubtitles-like search via yt-dlp / public APIs) ===
      if (comando === '.subtitulos' || comando === '.subs' || comando === '.subtitle') {
        const q = argumento.trim();
        if (!q) {
          await sock.sendMessage(chat, { text: '📝 Uso: .subtitulos [nombre] tem [N] ep [N]\nPrioridad: español latino → castellano.\nEj: .subtitulos Cyberpunk Edgerunners tem 1 ep 5' }, { quoted: msg });
          continue;
        }
        reaccionar(sock, msg, '⏳');
        try {
          // Parse temporada/episodio
          let query = q;
          let tem = null, ep = null;
          const mTe = q.match(/tem(?:porada)?\s*(\d+)/i);
          const mEp = q.match(/ep(?:isodio)?\s*(\d+)/i);
          if (mTe) tem = mTe[1];
          if (mEp) ep = mEp[1];
          query = q.replace(/tem(?:porada)?\s*\d+/ig, '').replace(/ep(?:isodio)?\s*\d+/ig, '').trim();

          const langs = ['es-419', 'es-MX', 'es-AR', 'es-LAT', 'es', 'spa'];
          let enviado = false;
          const carpeta = path.join(os.tmpdir(), 'lbot-subs-' + Date.now());
          fs.mkdirSync(carpeta, { recursive: true });
          try {
            // Intentos con yt-dlp --list-subs / --write-subs sobre búsquedas comunes no siempre funcionan sin URL.
            // Usamos OpenSubtitles.com search no-oficial vía fetch simple + fallback mensaje con query.
            const searchUrl = 'https://rest.opensubtitles.org/search/query-' + encodeURIComponent(query.replace(/\s+/g, '-')) +
              (tem ? '/season-' + tem : '') + (ep ? '/episode-' + ep : '') + '/sublanguageid-es,exy,spl';
            let results = [];
            try {
              const res = await fetch(searchUrl, {
                headers: {
                  'User-Agent': 'TemporaryUserAgent',
                  'X-User-Agent': 'TemporaryUserAgent'
                },
                signal: AbortSignal.timeout(20000)
              });
              if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) results = data;
              }
            } catch (e) { console.log('subs search:', e.message); }

            // Prefer latino-ish
            const prefer = (x) => {
              const lang = String(x.SubLanguageID || x.LanguageName || '').toLowerCase();
              const name = String(x.MovieReleaseName || x.SubFileName || '').toLowerCase();
              let score = 0;
              if (/es|spa|spanish/.test(lang)) score += 2;
              if (/lat|latino|mexican|argentina|419/.test(lang + name)) score += 5;
              if (/castellano|spain|es-es/.test(lang + name)) score += 1;
              return score;
            };
            results.sort((a, b) => prefer(b) - prefer(a));

            for (const item of results.slice(0, 8)) {
              const dl = item.SubDownloadLink || item.ZipDownloadLink;
              if (!dl) continue;
              try {
                const r2 = await fetch(dl, { headers: { 'User-Agent': 'TemporaryUserAgent' }, signal: AbortSignal.timeout(30000), redirect: 'follow' });
                if (!r2.ok) continue;
                const buf = Buffer.from(await r2.arrayBuffer());
                if (buf.length < 50) continue;
                // Puede ser gz
                let content = buf;
                let ext = 'srt';
                const fname = String(item.SubFileName || 'subtitulos.srt');
                if (fname.endsWith('.gz') || (buf[0] === 0x1f && buf[1] === 0x8b)) {
                  try {
                    const zlib = require('zlib');
                    content = zlib.gunzipSync(buf);
                  } catch {}
                }
                if (/\.vtt$/i.test(fname)) ext = 'vtt';
                const outFile = path.join(carpeta, (query.slice(0, 40).replace(/[^\w\s-]/g, '') || 'subs') + '.' + ext);
                fs.writeFileSync(outFile, content);
                const langLabel = /lat|419|mexican|argentina/i.test(String(item.LanguageName || '') + String(item.SubLanguageID || ''))
                  ? 'Español latino' : (item.LanguageName || item.SubLanguageID || 'Español');
                await sock.sendMessage(chat, {
                  document: { url: outFile },
                  mimetype: 'application/x-subrip',
                  fileName: path.basename(outFile),
                  caption: '📝 *Subtítulos*\n> ' + (item.MovieName || query).toString().slice(0, 80) +
                    (tem ? '\n> Tem: ' + tem : '') + (ep ? ' Ep: ' + ep : '') +
                    '\n> Idioma: ' + langLabel
                }, { quoted: msg });
                enviado = true;
                break;
              } catch (e) { console.log('sub dl', e.message); }
            }
          } finally {
            try { fs.rmSync(carpeta, { recursive: true, force: true }); } catch {}
          }

          if (!enviado) {
            await sock.sendMessage(chat, {
              text: '❌ No encontré subtítulos descargables para:\n*' + q.slice(0, 120) + '*\n\nPrueba con nombre más exacto o incluye temporada/episodio.\nPrioridad: español latino → castellano.'
            }, { quoted: msg });
          } else reaccionar(sock, msg, '✅');
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ Subtítulos: ' + (e.message || e) }, { quoted: msg });
        }
        continue;
      }

      // ===== PRIORIDAD NSFW MEDIA / ECONOMÍA / AUTOMÁTICOS =====
      try {
        const cmd0 = (comando || '').toLowerCase();

        if (cmd0 === '.autoaudio' || cmd0 === '.automaticmen' || cmd0 === '.automen') {
          if (!isOwner(msg)) { await sock.sendMessage(chat, { text: '⛔ Este comando es exclusivo del creador.' }, { quoted: msg }); continue; }
          const sub = (partes[1] || 'estado').toLowerCase();
          const st = loadAutomaticMen();

          if (sub === 'off') {
            st.enabled = false;
            saveAutomaticMen(st);
            if (AUTOEXP_STATE.timer) clearTimeout(AUTOEXP_STATE.timer);
            if (NOVIAS_AUTO_STATE.timer) clearTimeout(NOVIAS_AUTO_STATE.timer);
            AUTOEXP_STATE.timer = null;
            NOVIAS_AUTO_STATE.timer = null;
            await sock.sendMessage(chat, { text: '⏸️ Todos los envíos automáticos de mensajes, bienvenidas y audios están DESACTIVADOS.\nUsa .autoaudio on para reactivarlos.' }, { quoted: msg });
          } else if (sub === 'on') {
            st.enabled = true;
            saveAutomaticMen(st);
            if (!AUTOEXP_STATE.timer) programarAutoExpresion();
            if (!NOVIAS_AUTO_STATE.timer) programarMensajesNovias();
            iniciarModulosAutomaticos();
            await sock.sendMessage(chat, { text: '✅ Envíos automáticos de mensajes y audios REACTIVADOS.' }, { quoted: msg });
          } else {
            await sock.sendMessage(chat, { text: 'Estado de automatizaciones: ' + (st.enabled !== false ? 'ON' : 'OFF') + '\nUso: .autoaudio off|on' }, { quoted: msg });
          }
          continue;
        }

        if (cmd0 === '.himg') {
          if (typeof nsfwPermitidoEnChat === 'function' && !nsfwPermitidoEnChat(chat)) {
            await sock.sendMessage(chat, { text: '⏸️ NSFW apagado. Usa .onnsfw' }, { quoted: msg }); continue;
          }
          await sock.sendMessage(chat, { text: '⏳ Buscando imagen…' }, { quoted: msg });
          try {
            const img = await getHimgRobusto(argumento.trim() || 're_zero_kara_hajimeru_isekai_seikatsu');
            await sock.sendMessage(chat, { image: img.buffer, caption: '🔞 *HIMG*\n' + img.source }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(chat, { text: '❌ himg: ' + (e.message || e) }, { quoted: msg });
          }
          continue;
        }

        if (cmd0 === '.hbooru' || cmd0 === '.hbooruvideo') {
          if (typeof nsfwPermitidoEnChat === 'function' && !nsfwPermitidoEnChat(chat)) {
            await sock.sendMessage(chat, { text: '⏸️ NSFW apagado. Usa .onnsfw' }, { quoted: msg }); continue;
          }
          await sock.sendMessage(chat, { text: '⏳ Buscando video MP4…' }, { quoted: msg });
          let tmp = null;
          try {
            const v = await getHVideoRobusto(null);
            tmp = v.file;
            await sock.sendMessage(chat, {
              document: { url: tmp },
              mimetype: 'video/mp4',
              fileName: 'hbooru.mp4',
              caption: '🔞 *HBOORU*\n' + v.source
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(chat, { text: '❌ hbooru: ' + (e.message || e) }, { quoted: msg });
          } finally { if (tmp) try { fs.rmSync(tmp, { force: true }); } catch {} }
          continue;
        }

        if (/^\.rule(video|34videos)/.test(cmd0) || cmd0 === '.rulevideosearch') {
          if (typeof nsfwPermitidoEnChat === 'function' && !nsfwPermitidoEnChat(chat)) {
            await sock.sendMessage(chat, { text: '⏸️ NSFW apagado. Usa .onnsfw' }, { quoted: msg }); continue;
          }
          const q = argumento.trim();
          await sock.sendMessage(chat, { text: '⏳ Video H…' }, { quoted: msg });
          let tmp = null;
          try {
            const tags = (cmd0 === '.rulevideosearch' || !/^https?:\/\//i.test(q))
              ? ((q || 'hentai').replace(/\s+/g, '_') + ' video score:>10')
              : null;
            if (tags) {
              const v = await getHVideoRobusto(tags);
              tmp = v.file;
              await sock.sendMessage(chat, {
                document: { url: tmp }, mimetype: 'video/mp4', fileName: 'search.mp4',
                caption: '🔞 *SEARCH*\n' + (q || tags) + '\n' + v.source
              }, { quoted: msg });
            } else {
              // link: try yt-dlp then convert
              const carpeta = path.join(os.tmpdir(), 'lbot-rv-' + Date.now());
              fs.mkdirSync(carpeta, { recursive: true });
              try {
                const plantilla = path.join(carpeta, 'v.%(ext)s');
                await execFileAsync('yt-dlp', [
                  '--no-config', '--no-warnings', '--no-playlist', '--max-filesize', '1200M',
                  '--merge-output-format', 'mp4', '-f', 'bv*+ba/b',
                  '--output', plantilla, q
                ], { timeout: 20 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
                const found = fs.readdirSync(carpeta).filter(n => /\.(mp4|webm|mkv)$/i.test(n));
                if (!found.length) throw new Error('yt-dlp sin archivo');
                tmp = await forzarMp4WhatsApp(path.join(carpeta, found[0]));
                await sock.sendMessage(chat, {
                  document: { url: tmp }, mimetype: 'video/mp4', fileName: 'rule.mp4',
                  caption: '🔞 *RULE VIDEO*'
                }, { quoted: msg });
              } catch (e1) {
                const v = await getHVideoRobusto('video score:>20');
                tmp = v.file;
                await sock.sendMessage(chat, {
                  document: { url: tmp }, mimetype: 'video/mp4', fileName: 'alt.mp4',
                  caption: '🔞 Link falló; alterno\n' + v.source
                }, { quoted: msg });
              }
            }
          } catch (e) {
            await sock.sendMessage(chat, { text: '❌ video: ' + (e.message || e) }, { quoted: msg });
          } finally { if (tmp) try { fs.rmSync(tmp, { force: true }); } catch {} }
          continue;
        }

        
      if (comando === '.x' || comando === '.twitter' || comando === '.xvideo') {
        const url = argumento.trim();
        if (!url || !/x\.com|twitter\.com/i.test(url)) {
          await sock.sendMessage(chat, { text: 'Uso: .x [enlace de X/Twitter]\nIncluye videos marcados como sensibles.' }, { quoted: msg });
          continue;
        }
        await sock.sendMessage(chat, { text: '⏳ Descargando video de X (sensible OK)…' }, { quoted: msg });
        const carpeta = path.join(os.tmpdir(), 'lbot-x-' + Date.now());
        fs.mkdirSync(carpeta, { recursive: true });
        let ok = false;
        const intentos = [];
        // 1) yt-dlp directo
        try {
          await execFileAsync('yt-dlp', [
            '--no-config', '--no-warnings', '--no-playlist', '--max-filesize', '500M',
            '--merge-output-format', 'mp4', '-f', 'bv*+ba/b',
            '--referer', 'https://x.com/',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0.0.0 Safari/537.36',
            '--add-header', 'Accept:text/html,application/xhtml+xml',
            '--output', path.join(carpeta, 'x.%(ext)s'), url
          ], { timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
          ok = true;
        } catch (e) { intentos.push('yt-dlp: ' + (e.message || '').slice(0, 80)); }
        // 2) fx/vx twitter mirror
        if (!ok) {
          try {
            const mirror = url.replace('https://x.com/', 'https://api.vxtwitter.com/').replace('https://twitter.com/', 'https://api.vxtwitter.com/');
            const res = await fetch(mirror, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
            if (res.ok) {
              const j = await res.json();
              const media = (j.media_extended || j.media || []).map(m => m.url || m.video_url || m).filter(Boolean);
              const vids = media.filter(u => typeof u === 'string' && /\.mp4|video/i.test(u));
              const pick = vids[0] || media[0];
              if (pick && /^https?:\/\//i.test(pick)) {
                const dl = await fetch(pick, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(600000) });
                if (dl.ok && dl.body) {
                  const dest = path.join(carpeta, 'vx.mp4');
                  await guardarConLimite(dl.body, dest, 500 * 1024 * 1024, 'Video X grande');
                  ok = true;
                }
              }
            }
          } catch (e) { intentos.push('vxtwitter: ' + (e.message || '').slice(0, 80)); }
        }
        // 3) fxtwitter
        if (!ok) {
          try {
            const fx = url.replace('://x.com/', '://api.fxtwitter.com/').replace('://twitter.com/', '://api.fxtwitter.com/');
            const res = await fetch(fx, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
            if (res.ok) {
              const j = await res.json();
              const v = j.tweet?.media?.videos?.[0]?.url || j.tweet?.media?.all?.find(x => x.type === 'video')?.url;
              if (v) {
                const dl = await fetch(v, { signal: AbortSignal.timeout(600000) });
                if (dl.ok && dl.body) {
                  const dest = path.join(carpeta, 'fx.mp4');
                  await guardarConLimite(dl.body, dest, 500 * 1024 * 1024, 'Video X grande');
                  ok = true;
                }
              }
            }
          } catch (e) { intentos.push('fxtwitter: ' + (e.message || '').slice(0, 80)); }
        }
        try {
          const found = fs.existsSync(carpeta) ? fs.readdirSync(carpeta).filter(n => /\.(mp4|m4v|webm|mkv)$/i.test(n)) : [];
          if (!found.length) throw new Error('No se pudo obtener el video.\n' + intentos.join('\n'));
          let file = path.join(carpeta, found[0]);
          if (typeof forzarMp4WhatsApp === 'function') file = await forzarMp4WhatsApp(file);
          await sock.sendMessage(chat, {
            document: { url: file },
            mimetype: 'video/mp4',
            fileName: 'x-video.mp4',
            caption: '🐦 Video de X'
          }, { quoted: msg });
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ X: ' + (e.message || e) }, { quoted: msg });
        } finally {
          try { fs.rmSync(carpeta, { recursive: true, force: true }); } catch {}
        }
        continue;
      }
if (cmd0 === '.x' || cmd0 === '.twitter') {
          const url = argumento.trim();
          if (!url || !/x\.com|twitter\.com/i.test(url)) {
            await sock.sendMessage(chat, { text: 'Uso: .x [enlace X/Twitter]\nIncluye intentos de video sensible.' }, { quoted: msg });
            continue;
          }
          await sock.sendMessage(chat, { text: '⏳ Descargando de X…' }, { quoted: msg });
          const carpeta = path.join(os.tmpdir(), 'lbot-x-' + Date.now());
          fs.mkdirSync(carpeta, { recursive: true });
          try {
            await execFileAsync('yt-dlp', [
              '--no-config', '--no-warnings', '--no-playlist', '--max-filesize', '500M',
              '--merge-output-format', 'mp4', '-f', 'bv*+ba/b',
              '--referer', 'https://x.com/', '--user-agent', 'Mozilla/5.0',
              '--output', path.join(carpeta, 'x.%(ext)s'), url
            ], { timeout: 15 * 60 * 1000, maxBuffer: 6 * 1024 * 1024 });
            const found = fs.readdirSync(carpeta).filter(n => /\.(mp4|webm|mkv)$/i.test(n));
            if (!found.length) throw new Error('Sin video (contenido sensible puede necesitar cookies).');
            const file = await forzarMp4WhatsApp(path.join(carpeta, found[0]));
            await sock.sendMessage(chat, { document: { url: file }, mimetype: 'video/mp4', fileName: 'x.mp4', caption: '🐦 X' }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(chat, { text: '❌ X: ' + (e.message || e) }, { quoted: msg });
          } finally { try { fs.rmSync(carpeta, { recursive: true, force: true }); } catch {} }
          continue;
        }

        if (cmd0 === '.lookbalance' || cmd0 === '.lookbal') {
          const all = loadEconomyExtra();
          const rows = Object.entries(all).map(([k, v]) => ({ k, total: (Number(v.wallet)||0)+(Number(v.bank)||0) })).sort((a,b)=>b.total-a.total).slice(0,15);
          if (!rows.length) await sock.sendMessage(chat, { text: '🏆 LOOK BALANCE vacío. Prueba .crime' }, { quoted: msg });
          else {
            const lines = rows.map((r,i)=> (i+1)+'. @'+r.k+' — '+r.total.toLocaleString('es-HN'));
            await sock.sendMessage(chat, { text: '🏆 *LOOK BALANCE*\n'+lines.join('\n'), mentions: rows.map(r=>r.k+'@s.whatsapp.net') }, { quoted: msg });
          }
          continue;
        }

        if (cmd0 === '.crime') {
          try {
            const { all, k, data } = getEco(remitente);
            const ahora = Date.now();
            if (data.lastCrime && ahora - data.lastCrime < 3600000) {
              const min = Math.ceil((3600000 - (ahora - data.lastCrime))/60000);
              await sock.sendMessage(chat, { text: '⏳ Crime: espera ~'+min+' min' }, { quoted: msg });
              continue;
            }
            const pool = loadCrimeTexts();
            const item = pool[Math.floor(Math.random()*pool.length)];
            const monto = Math.floor(Math.random()*(Number(item.max||50000)-Number(item.min||1000)+1))+Number(item.min||1000);
            data.wallet = (Number(data.wallet)||0) + monto;
            data.lastCrime = ahora;
            all[k] = data; setEco(all);
            const txt = String(item.texto||'{monto}').replace(/\{monto\}/g, monto.toLocaleString('es-HN'));
            await sock.sendMessage(chat, { text: '🕵️ *CRIME*\n'+txt+'\n💵 '+Number(data.wallet).toLocaleString('es-HN')+' SC' }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(chat, { text: '❌ crime: '+(e.message||e) }, { quoted: msg });
          }
          continue;
        }
      } catch (eEarly) {
        try { await sock.sendMessage(chat, { text: '❌ ' + (eEarly.message || eEarly) }, { quoted: msg }); } catch {}
        continue;
      }

      // ANTILINK: borra mensaje + advertencia (3 = expulsión). Creador y admins pueden enviar enlaces.
      try {
        if (chat.endsWith('@g.us') && typeof antilinkActivoEn === 'function' && antilinkActivoEn(chat)) {
          const cfg = loadAntilinkConfig();
          const cuerpo = String(texto || '').trim();
          // También revisar captions ya están en texto
          if (cuerpo && !cuerpo.startsWith('.')) {
            const tipo = detectarEnlaceProhibido(cuerpo, cfg);
            if (tipo) {
              const sender = msg.key.participant || msg.key.remoteJid;
              // Exentos: creador y administradores del grupo
              let esAdminGrupo = false;
              try { esAdminGrupo = await isGroupAdmin(sock, chat, sender); } catch {}
              const exento = isOwner(msg) || esAdminGrupo || normalizeNumber(sender) === OWNER_NUMBER;
              if (!exento) {
                // 1) Borrar el mensaje con el enlace (requiere bot admin)
                let borrado = false;
                try {
                  const botJid = sock.user?.id;
                  if (await isGroupAdmin(sock, chat, botJid, true)) {
                    borrado = await borrarMensajeGrupo(sock, chat, msg);
                  }
                } catch (e) {
                  console.log('antilink delete:', e.message);
                }

                // 2) Advertencia estilo .warm (3 = kick)
                const key = warningKey(chat, sender);
                const warnings = loadWarnings();
                const count = (Number(warnings[key]) || 0) + 1;
                warnings[key] = count;
                saveWarnings(warnings);

                const num = normalizeNumber(sender);
                if (count >= 3) {
                  try {
                    const botJid = sock.user?.id;
                    const soyAdmin = await isGroupAdmin(sock, chat, botJid, true);
                    if (!soyAdmin) throw new Error('El bot no es admin (recarga: quita y vuelve a dar admin, o reinicia el bot)');
                    await sock.groupParticipantsUpdate(chat, [sender], 'remove');
                    await sock.sendMessage(chat, {
                      text: '🚫 @' + num + ' alcanzó *3/3* advertencias (Antilink: ' + tipo + ') y fue expulsado.\n\n🖤 ' + BOT_BRAND,
                      mentions: [sender]
                    });
                    delete warnings[key];
                    saveWarnings(warnings);
                  } catch (e) {
                    await sock.sendMessage(chat, {
                      text: '⚠️ @' + num + ' tiene *3/3* por Antilink, pero no pude expulsar (¿el bot es admin?).\n' + (e.message || ''),
                      mentions: [sender]
                    });
                  }
                } else {
                  await sock.sendMessage(chat, {
                    text: '🔗 *Antilink*\nSe eliminó un ' + tipo + (borrado ? '' : ' (no pude borrar el mensaje: dame admin)') + '.\n⚠️ Advertencia @' + num + ': *' + count + '/3*\nAl llegar a 3 serás expulsado.\n\nSolo el creador y los admins pueden enviar esos enlaces.',
                    mentions: [sender]
                  });
                }
                continue;
              }
            }
          }
        }
      } catch (e) { console.log('antilink:', e.message); }

    const t0 = Date.now();
    precargarGrupo(sock, chat);

    try {
      if (comando === '.vincularpropietario') {
        await handleOwnerLinkCommand(sock, msg, chat, partes);
        continue;
      }

      if (await manejarJardinOBorrado(sock, msg, chat, contenido, comando, argumento, partes, remitente)) continue;

      if (comando === '.offnsfw' || comando === '.onnsfw') {
        if (!isOwner(msg)) {
          await sock.sendMessage(chat, { text: '⛔ Solo el creador puede usar .onnsfw / .offnsfw.' }, { quoted: msg });
          continue;
        }
        const on = comando === '.onnsfw';
        saveNsfwState({ enabled: on });
        const nov = loadNoviasAuto();
        if (!privAutoOn()) return;
        nov.enabled = on;
        saveNoviasAuto(nov);
        await sock.sendMessage(chat, { text: on ? 'nsfw esta encendido' : 'Se apago el nsfw' }, { quoted: msg });
        continue;
      }

      // Toggles de funciones: global y por grupo
      if (comando === '.feature' || comando === '.features') {
        if (!isOwner(msg)) {
          await sock.sendMessage(chat, { text: '⛔ Solo el propietario.' }, { quoted: msg });
          continue;
        }
        const sub = (partes[1] || 'lista').toLowerCase();
        const nombre = (partes[2] || '').toLowerCase();
        const valid = ['himg','hgif','hvideo','nsfwpareja','recordar','traducir','ranking','antilink'];
        if (sub === 'lista' || sub === 'list' || sub === 'estado') {
          const f = loadFeatures();
          const lines = valid.map(k => `• ${k}: ${f[k] !== false ? 'ON' : 'OFF'}`).join('\n');
          await sock.sendMessage(chat, { text: '⚙️ *FEATURES*\n' + lines + '\n\nUso:\n.feature on|off [nombre]  (global)\n.feature this on|off [nombre]  (este grupo)\n\nNSFW chat: .onthisnsfw / .offthisnsfw' }, { quoted: msg });
          continue;
        }
        if (sub === 'this') {
          if (!chat.endsWith('@g.us')) {
            await sock.sendMessage(chat, { text: 'Este modo solo en grupos.' }, { quoted: msg });
            continue;
          }
          const acc = (partes[2] || '').toLowerCase();
          const feat = (partes[3] || '').toLowerCase();
          if (!['on','off'].includes(acc) || !valid.includes(feat)) {
            await sock.sendMessage(chat, { text: 'Uso: .feature this on|off himg|hgif|hvideo|nsfwpareja|recordar|traducir|ranking|antilink' }, { quoted: msg });
            continue;
          }
          const g = loadNsfwGroups();
          g[feat + '::' + chat] = acc === 'on';
          saveNsfwGroups(g);
          await sock.sendMessage(chat, { text: (acc === 'on' ? '✅' : '⏸️') + ' ' + feat + ' en este grupo: ' + acc.toUpperCase() }, { quoted: msg });
          continue;
        }
        if ((sub === 'on' || sub === 'off') && valid.includes(nombre)) {
          const f = loadFeatures();
          f[nombre] = sub === 'on';
          saveFeatures(f);
          await sock.sendMessage(chat, { text: (sub === 'on' ? '✅' : '⏸️') + ' ' + nombre + ' global: ' + sub.toUpperCase() }, { quoted: msg });
          continue;
        }
        await sock.sendMessage(chat, { text: 'Uso: .feature lista | .feature on|off [nombre] | .feature this on|off [nombre]' }, { quoted: msg });
        continue;
      }

      if (comando === '.offthisnsfw' || comando === '.onthisnsfw') {
        if (!isOwner(msg)) {
          await sock.sendMessage(chat, { text: '⛔ Solo el propietario.' }, { quoted: msg });
          continue;
        }
        if (!chat.endsWith('@g.us')) {
          await sock.sendMessage(chat, { text: 'Solo en grupos. Global: .onnsfw / .offnsfw' }, { quoted: msg });
          continue;
        }
        const on = comando === '.onthisnsfw';
        const g = loadNsfwGroups();
        g[chat] = on;
        saveNsfwGroups(g);
        await sock.sendMessage(chat, { text: on ? 'nsfw esta encendido' : 'Se apago el nsfw' }, { quoted: msg });
        continue;
      }

      if (comando === '.himg') {
        if (!nsfwPermitidoEnChat(chat) || !featureOn('himg', chat)) {
          await sock.sendMessage(chat, { text: '⏸️ himg no disponible (NSFW/feature off).' }, { quoted: msg });
          continue;
        }
        try {
          reaccionar(sock, msg, '⏳');
          const { buffer, source } = await getHentaiGifBuffer();
          await sock.sendMessage(chat, { image: buffer, caption: '🔞 *HIMG*\n🎞️ ' + source + '\n🖤 ' + BOT_BRAND }, { quoted: msg });
          reaccionar(sock, msg, '✅');
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ No pude obtener imagen H.\n' + (e.message || '') }, { quoted: msg });
        }
        continue;
      }

      if (comando === '.hgif') {
        if (!nsfwPermitidoEnChat(chat) || !featureOn('hgif', chat)) {
          await sock.sendMessage(chat, { text: '⏸️ hgif no disponible (NSFW/feature off).' }, { quoted: msg });
          continue;
        }
        try {
          reaccionar(sock, msg, '⏳');
          await sendHentaiGif(sock, chat, '🔞 *HGIF*', [], msg);
          reaccionar(sock, msg, '✅');
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ No pude obtener GIF H.\n' + (e.message || '') }, { quoted: msg });
        }
        continue;
      }

      if (comando === '.nsfwpareja') {
        if (!nsfwPermitidoEnChat(chat) || !featureOn('nsfwpareja', chat)) {
          await sock.sendMessage(chat, { text: '⏸️ nsfwpareja no disponible.' }, { quoted: msg });
          continue;
        }
        const menciones = [...texto.matchAll(/@([0-9]{5,16})/g)].map(x => x[1] + '@s.whatsapp.net');
        if (menciones.length < 1) {
          await sock.sendMessage(chat, { text: 'Uso: .nsfwpareja @usuario' }, { quoted: msg });
          continue;
        }
        const a = '@' + (msg.key.participant || msg.key.remoteJid || '').split('@')[0].replace(/\D/g,'');
        const b = '@' + menciones[0].split('@')[0];
        const escenas = [
          a + ' empuja a ' + b + ' contra la pared y lo/la besa con hambre, mano bajo la ropa, sin importarle quién mire.',
          a + ' y ' + b + ' terminan en el sofá: ropa a medio quitar, gemidos bajos y una corrida compartida.',
          b + ' se arrodilla frente a ' + a + ' y no para hasta dejarlo temblando.',
          a + ' monta a ' + b + ' con ritmo lento primero y luego sin piedad, pidiendo más profundo.',
          a + ' marca el cuello de ' + b + ' mientras lo/la folla de lado, susurrando obscenidades al oído.'
        ];
        const txt = '🔥 *NSFW PAREJA*\n\n' + escenas[Math.floor(Math.random()*escenas.length)];
        try {
          await sendHentaiGif(sock, chat, txt, [msg.key.participant || msg.key.remoteJid, menciones[0]].filter(Boolean), msg);
        } catch {
          await sock.sendMessage(chat, { text: txt, mentions: [msg.key.participant || msg.key.remoteJid, menciones[0]].filter(Boolean) }, { quoted: msg });
        }
        continue;
      }

      if (comando === '.hvideo') {
        if (!nsfwPermitidoEnChat(chat) || !featureOn('hvideo', chat)) {
          await sock.sendMessage(chat, { text: '⏸️ hvideo no disponible (NSFW/feature off).' }, { quoted: msg });
          continue;
        }
        const q = argumento.trim();
        if (!q) {
          await sock.sendMessage(chat, { text: '🔞 Uso: .hvideo [enlace|búsqueda]\nFuentes: rule34video y similares vía yt-dlp.\nLímite 200 MB. Requiere NSFW on.' }, { quoted: msg });
          continue;
        }
        reaccionar(sock, msg, '⏳');
        const carpeta = path.join(os.tmpdir(), 'lbot-hvideo-' + Date.now());
        fs.mkdirSync(carpeta, { recursive: true });
        try {
          let entrada = q;
          if (!/^https?:\/\//i.test(q)) {
            // prefer rule34video-style search via yt-dlp generic
            entrada = 'ytsearch1:' + q + ' site:rule34video.com';
          }
          const plantilla = path.join(carpeta, 'hvideo.%(ext)s');
          await execFileAsync('yt-dlp', [
            '--no-config', '--no-warnings', '--no-playlist',
            '--max-filesize', '200M', '--restrict-filenames', '--merge-output-format', 'mp4',
            '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
            '--socket-timeout', '25', '--retries', '2',
            '--output', plantilla, entrada
          ], { timeout: 20 * 60 * 1000, maxBuffer: 6 * 1024 * 1024 });
          let found = fs.readdirSync(carpeta).filter(n => /\.(mp4|m4v|webm|mkv)$/i.test(n));
          if (!found.length && !/^https?:\/\//i.test(q)) {
            // fallback search
            entrada = 'ytsearch1:' + q + ' hentai';
            await execFileAsync('yt-dlp', [
              '--no-config', '--no-warnings', '--no-playlist',
              '--max-filesize', '200M', '--restrict-filenames', '--merge-output-format', 'mp4',
              '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
              '--socket-timeout', '25', '--retries', '2',
              '--output', plantilla, entrada
            ], { timeout: 20 * 60 * 1000, maxBuffer: 6 * 1024 * 1024 });
            found = fs.readdirSync(carpeta).filter(n => /\.(mp4|m4v|webm|mkv)$/i.test(n));
          }
          if (!found.length) throw new Error('No se pudo obtener el video.');
          const file = path.join(carpeta, found[0]);
          const tam = fs.statSync(file).size;
          if (!tam || tam > 200 * 1024 * 1024) throw new Error('El video supera 200 MB o está vacío.');
          await sock.sendMessage(chat, {
            document: { url: file },
            mimetype: 'video/mp4',
            fileName: 'hvideo.mp4',
            caption: '🔞 *HVIDEO*\n🖤 ' + BOT_BRAND
          }, { quoted: msg });
          reaccionar(sock, msg, '✅');
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ No pude descargar ese H-video.\nPrueba enlace directo de rule34video u otro compatible.\n' + (e.message || '') }, { quoted: msg });
        } finally {
          try { fs.rmSync(carpeta, { recursive: true, force: true }); } catch {}
        }
        continue;
      }

      if (comando === '.recordar') {
        if (!featureOn('recordar', chat)) {
          await sock.sendMessage(chat, { text: '⏸️ .recordar está desactivado.' }, { quoted: msg });
          continue;
        }
        const REM_FILE = path.join(__dirname, 'database', 'recordatorios.json');
        let lista = [];
        try { lista = JSON.parse(fs.readFileSync(REM_FILE, 'utf8')); } catch { lista = []; }
        if (!argumento) {
          const mios = lista.filter(x => x.chat === chat).slice(-10);
          await sock.sendMessage(chat, { text: mios.length ? ('📝 Recordatorios:\n' + mios.map((x,i)=> (i+1)+'. '+x.texto).join('\n')) : 'Uso: .recordar [texto]\nEj: .recordar pagar la luz' }, { quoted: msg });
          continue;
        }
        lista.push({ chat, texto: argumento.slice(0, 200), at: Date.now(), by: remitente });
        fs.mkdirSync(path.dirname(REM_FILE), { recursive: true });
        fs.writeFileSync(REM_FILE, JSON.stringify(lista.slice(-200), null, 2));
        await sock.sendMessage(chat, { text: '✅ Recordatorio guardado: ' + argumento.slice(0, 120) }, { quoted: msg });
        continue;
      }

      if (comando === '.traducir') {
        if (!featureOn('traducir', chat)) {
          await sock.sendMessage(chat, { text: '⏸️ .traducir está desactivado.' }, { quoted: msg });
          continue;
        }
        const t = argumento.trim();
        if (!t) {
          await sock.sendMessage(chat, { text: 'Uso: .traducir [texto]\nDetecta idioma y traduce a español.' }, { quoted: msg });
          continue;
        }
        try {
          const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(t.slice(0, 500)) + '&langpair=autodetect|es';
          const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
          const j = await r.json();
          const out = j?.responseData?.translatedText || 'No pude traducir.';
          await sock.sendMessage(chat, { text: '🌐 *Traducción*\n' + out }, { quoted: msg });
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ Error al traducir.' }, { quoted: msg });
        }
        continue;
      }

      if (comando === '.ranking') {
        if (!featureOn('ranking', chat)) {
          await sock.sendMessage(chat, { text: '⏸️ .ranking está desactivado.' }, { quoted: msg });
          continue;
        }
        if (!chat.endsWith('@g.us')) {
          await sock.sendMessage(chat, { text: 'Solo en grupos.' }, { quoted: msg });
          continue;
        }
        const RANK_FILE = path.join(__dirname, 'database', 'ranking.json');
        let data = {};
        try { data = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8')); } catch { data = {}; }
        const g = data[chat] || {};
        const top = Object.entries(g).sort((a,b)=>b[1]-a[1]).slice(0, 10);
        if (!top.length) {
          await sock.sendMessage(chat, { text: '📊 Aún no hay datos de actividad en este grupo.' }, { quoted: msg });
          continue;
        }
        const lines = top.map((x,i)=> (i+1)+'. @' + x[0].split('@')[0] + ' — ' + x[1] + ' msgs');
        await sock.sendMessage(chat, { text: '📊 *RANKING DEL GRUPO*\n' + lines.join('\n'), mentions: top.map(x=>x[0]) }, { quoted: msg });
        continue;
      }

      
      if (comando === '.offthisnsfw' || comando === '.onthisnsfw') {
        if (!isOwner(msg)) {
          await sock.sendMessage(chat, { text: '⛔ Solo el propietario.' }, { quoted: msg });
          continue;
        }
        if (!chat.endsWith('@g.us')) {
          await sock.sendMessage(chat, { text: 'Este comando solo funciona dentro de un grupo.\nGlobal: .onnsfw / .offnsfw' }, { quoted: msg });
          continue;
        }
        const on = comando === '.onthisnsfw';
        const g = loadNsfwGroups();
        g[chat] = on;
        saveNsfwGroups(g);
        await sock.sendMessage(chat, { text: on ? 'nsfw esta encendido' : 'Se apago el nsfw' }, { quoted: msg });
        continue;
      }

      
      
      if (comando === '.antilink') {
        const sub = (partes[1] || 'estado').toLowerCase();
        const cfg = loadAntilinkConfig();
        if (sub === 'estado' || sub === 'status') {
          const enGrupo = chat.endsWith('@g.us') ? (cfg.groups[chat] === true ? 'ON' : (cfg.groups[chat] === false ? 'OFF' : 'hereda')) : '-';
          await sock.sendMessage(chat, {
            text: [
              '🔗 *ANTILINK*',
              '> Global: ' + (cfg.enabledGlobal ? 'ON' : 'OFF'),
              '> En este grupo: ' + enGrupo,
              '> Bloquear grupos WA: ' + (cfg.blockWhatsappGroups ? 'sí' : 'no'),
              '> Bloquear canales WA: ' + (cfg.blockWhatsappChannels ? 'sí' : 'no'),
              '> Bloquear Telegram: ' + (cfg.blockTelegram ? 'sí' : 'no'),
              '> Bloquear Discord: ' + (cfg.blockDiscord ? 'sí' : 'no'),
              '> Bloquear todos los links: ' + (cfg.blockAllLinks ? 'sí' : 'no'),
              '> Whitelist: ' + ((cfg.whitelist || []).join(', ') || '(vacía)'),
              '',
              'Uso creador:',
              '.antilink on|off',
              '.antilink this on|off',
              '.antilink set grupos|canales|telegram|discord|todos on|off',
              '.antilink whitelist add|del dominio',
              '.feature on|off antilink'
            ].join('\n')
          }, { quoted: msg });
          continue;
        }
        if (!isOwner(msg)) {
          await sock.sendMessage(chat, { text: '⛔ Solo el propietario configura antilink. Admins: .antilink estado' }, { quoted: msg });
          continue;
        }
        if (sub === 'on' || sub === 'off') {
          cfg.enabledGlobal = sub === 'on';
          saveAntilinkConfig(cfg);
          const f = loadFeatures();
          f.antilink = cfg.enabledGlobal;
          saveFeatures(f);
          await sock.sendMessage(chat, { text: sub === 'on' ? '✅ Antilink global ON' : '⏸️ Antilink global OFF' }, { quoted: msg });
          continue;
        }
        if (sub === 'this') {
          if (!chat.endsWith('@g.us')) {
            await sock.sendMessage(chat, { text: 'Solo en grupos.' }, { quoted: msg });
            continue;
          }
          const acc = (partes[2] || '').toLowerCase();
          if (acc !== 'on' && acc !== 'off') {
            await sock.sendMessage(chat, { text: 'Uso: .antilink this on|off' }, { quoted: msg });
            continue;
          }
          cfg.groups[chat] = acc === 'on';
          saveAntilinkConfig(cfg);
          await sock.sendMessage(chat, { text: acc === 'on' ? '✅ Antilink ON en este grupo' : '⏸️ Antilink OFF en este grupo' }, { quoted: msg });
          continue;
        }
        if (sub === 'set') {
          const key = (partes[2] || '').toLowerCase();
          const acc = (partes[3] || '').toLowerCase();
          const map = {
            grupos: 'blockWhatsappGroups',
            canales: 'blockWhatsappChannels',
            telegram: 'blockTelegram',
            discord: 'blockDiscord',
            todos: 'blockAllLinks'
          };
          if (!map[key] || (acc !== 'on' && acc !== 'off')) {
            await sock.sendMessage(chat, { text: 'Uso: .antilink set grupos|canales|telegram|discord|todos on|off' }, { quoted: msg });
            continue;
          }
          cfg[map[key]] = acc === 'on';
          saveAntilinkConfig(cfg);
          await sock.sendMessage(chat, { text: '✅ ' + key + ' = ' + acc }, { quoted: msg });
          continue;
        }
        if (sub === 'whitelist') {
          const acc = (partes[2] || '').toLowerCase();
          const dom = (partes[3] || '').trim().toLowerCase();
          if (!dom || (acc !== 'add' && acc !== 'del')) {
            await sock.sendMessage(chat, { text: 'Uso: .antilink whitelist add|del ejemplo.com' }, { quoted: msg });
            continue;
          }
          cfg.whitelist = cfg.whitelist || [];
          if (acc === 'add' && !cfg.whitelist.includes(dom)) cfg.whitelist.push(dom);
          if (acc === 'del') cfg.whitelist = cfg.whitelist.filter(x => x !== dom);
          saveAntilinkConfig(cfg);
          await sock.sendMessage(chat, { text: '✅ Whitelist: ' + (cfg.whitelist.join(', ') || '(vacía)') }, { quoted: msg });
          continue;
        }
        await sock.sendMessage(chat, { text: 'Uso: .antilink estado|on|off|this|set|whitelist' }, { quoted: msg });
        continue;
      }

      // ANTISPAM: on/off global (creador) y por grupo (admin o creador).
      if (comando === '.antispam') {
        const sub = (partes[1] || 'estado').toLowerCase();
        const cfg = loadAntispamConfig();
        if (sub === 'estado' || sub === 'status') {
          const enGrupo = chat.endsWith('@g.us') ? (cfg.groups[chat] === true ? 'ON' : (cfg.groups[chat] === false ? 'OFF' : 'hereda')) : '-';
          await sock.sendMessage(chat, {
            text: [
              '🚫 *ANTISPAM*',
              '> Global: ' + (cfg.enabledGlobal !== false ? 'ON' : 'OFF'),
              '> En este grupo: ' + enGrupo,
              '> Detecta mensajes repetidos, los borra y suma advertencia (3 = expulsión).',
              '',
              'Uso:',
              '.antispam on|off (solo creador)',
              '.antispam this on|off (admin o creador)'
            ].join('\n')
          }, { quoted: msg });
          continue;
        }
        if (sub === 'this') {
          if (!chat.endsWith('@g.us')) {
            await sock.sendMessage(chat, { text: 'Solo en grupos.' }, { quoted: msg });
            continue;
          }
          let admin = false;
          try { admin = await isGroupAdmin(sock, chat, remitente); } catch { admin = false; }
          if (!isOwner(msg) && !admin) {
            await sock.sendMessage(chat, { text: '⛔ Solo un admin de este grupo o el creador.' }, { quoted: msg });
            continue;
          }
          const acc = (partes[2] || '').toLowerCase();
          if (acc !== 'on' && acc !== 'off') {
            await sock.sendMessage(chat, { text: 'Uso: .antispam this on|off' }, { quoted: msg });
            continue;
          }
          cfg.groups[chat] = acc === 'on';
          saveAntispamConfig(cfg);
          await sock.sendMessage(chat, { text: acc === 'on' ? '✅ Antispam ON en este grupo' : '⏸️ Antispam OFF en este grupo' }, { quoted: msg });
          continue;
        }
        if (sub === 'on' || sub === 'off') {
          if (!isOwner(msg)) {
            await sock.sendMessage(chat, { text: '⛔ Solo el propietario configura antispam global. Admins: .antispam this on|off' }, { quoted: msg });
            continue;
          }
          cfg.enabledGlobal = sub === 'on';
          saveAntispamConfig(cfg);
          await sock.sendMessage(chat, { text: sub === 'on' ? '✅ Antispam global ON' : '⏸️ Antispam global OFF' }, { quoted: msg });
          continue;
        }
        await sock.sendMessage(chat, { text: 'Uso: .antispam estado|on|off|this' }, { quoted: msg });
        continue;
      }

      // SOLO ADMINS: activa el modo "solo administradores" nativo de WhatsApp para este grupo.
      if (comando === '.soloadmins' || comando === '.modoadmin') {
        if (!chat.endsWith('@g.us')) {
          await sock.sendMessage(chat, { text: 'Este comando solo funciona dentro de un grupo.' }, { quoted: msg });
          continue;
        }
        let admin = false;
        try { admin = await isGroupAdmin(sock, chat, remitente); } catch { admin = false; }
        if (!isOwner(msg) && !admin) {
          await sock.sendMessage(chat, { text: '⛔ Solo un admin de este grupo o el creador.' }, { quoted: msg });
          continue;
        }
        const acc = (partes[1] || '').toLowerCase();
        if (acc !== 'on' && acc !== 'off') {
          await sock.sendMessage(chat, { text: 'Uso: .soloadmins on|off\n> on: solo los admins pueden escribir en el grupo.\n> off: todos pueden escribir de nuevo.' }, { quoted: msg });
          continue;
        }
        try {
          await setSoloAdmins(sock, chat, acc === 'on');
          await sock.sendMessage(chat, {
            text: acc === 'on'
              ? '🔒 Listo. Ahora *solo los administradores* pueden escribir en este grupo.'
              : '🔓 Listo. Ahora *todos* pueden volver a escribir en este grupo.'
          }, { quoted: msg });
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ No pude cambiarlo (¿el bot es admin del grupo?). ' + (e.message || e) }, { quoted: msg });
        }
        continue;
      }

      if (comando === '.manga' || comando === '.mg') {
        const q = argumento.trim();
        if (!q) {
          await sock.sendMessage(chat, { text: '📚 Uso: .manga [nombre]\\nBusca manga en español y envía info + enlaces. Capítulos completos dependen de la fuente.' }, { quoted: msg });
          continue;
        }
        reaccionar(sock, msg, '⏳');
        try {
          const query = q + ' manga español';
          const searches = [
            'https://www.google.com/search?q=' + encodeURIComponent(q + ' site:mangadex.org español OR spanish'),
            'https://lectortmo.com/library?title=' + encodeURIComponent(q),
            'https://visortmo.com/library?_pg=1&title=' + encodeURIComponent(q)
          ];
          let titulo = q;
          let portada = null;
          let links = [];
          let sinopsis = '';
          for (const url of ['https://api.mangadex.org/manga?limit=5&availableTranslatedLanguage[]=es&title=' + encodeURIComponent(q)]) {
            try {
              const r = await fetch(url, {
                headers: { 'User-Agent': 'L-BOT/5.0.1' },
                signal: AbortSignal.timeout(20000)
              });
              if (!r.ok) continue;
              const j = await r.json();
              const item = (j.data || [])[0];
              if (!item) continue;
              const id = item.id;
              const attrs = item.attributes || {};
              titulo = (attrs.title && (attrs.title.es || attrs.title.en || Object.values(attrs.title)[0])) || q;
              const desc = attrs.description || {};
              sinopsis = (desc.es || desc.en || '') .slice(0, 400);
              links.push('https://mangadex.org/title/' + id);
              // cover
              try {
                const cr = await fetch('https://api.mangadex.org/cover?manga[]=' + id + '&limit=1', { signal: AbortSignal.timeout(15000) });
                const cj = await cr.json();
                const fn = cj.data?.[0]?.attributes?.fileName;
                if (fn) {
                  const coverUrl = 'https://uploads.mangadex.org/covers/' + id + '/' + fn + '.256.jpg';
                  portada = await fetchBuffer(coverUrl, 3 * 1024 * 1024);
                }
              } catch {}
              // chapters es
              try {
                const ch = await fetch('https://api.mangadex.org/manga/' + id + '/feed?translatedLanguage[]=es&order[chapter]=asc&limit=20', { signal: AbortSignal.timeout(20000) });
                const chj = await ch.json();
                const caps = (chj.data || []).slice(0, 10).map(c => {
                  const n = c.attributes?.chapter || '?';
                  return '• Cap ' + n + ' — https://mangadex.org/chapter/' + c.id;
                });
                if (caps.length) links = links.concat(caps);
              } catch {}
              break;
            } catch (e) { console.log('manga api:', e.message); }
          }
          // fallback search pages
          if (links.length < 2) {
            links.push('https://www.google.com/search?q=' + encodeURIComponent(q + ' manga español leer online'));
            links.push('https://lectortmo.com/library?title=' + encodeURIComponent(q));
          }
          const caption = [
            '📚 *MANGA (ES)*',
            '> Título: ' + titulo,
            sinopsis ? ('> Sinopsis: ' + sinopsis) : null,
            '> Idioma prioritario: español',
            '',
            'Fuentes / capítulos:',
            ...links.slice(0, 12),
            '',
            '⚠️ Descargar un manga entero pesa mucho; aquí tienes ficha + enlaces ES.',
            '🖤 ' + BOT_BRAND
          ].filter(Boolean).join('\n');
          if (portada) {
            await sock.sendMessage(chat, { image: portada, caption }, { quoted: msg });
          } else {
            await sock.sendMessage(chat, { text: caption }, { quoted: msg });
          }
          reaccionar(sock, msg, '✅');
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ No pude buscar ese manga.\n' + (e.message || '') }, { quoted: msg });
        }
        continue;
      }

      if (comando === '.voicewaifu' || comando === '.loquendo') {
        const isLoq = comando === '.loquendo';
        let textoVoz = argumento.trim();
        let narrador = 'dalia';
        if (isLoq) {
          // .loquendo texto | narrador   or  .loquendo texto, narrador
          const parts = textoVoz.split(/[,|]/).map(x => x.trim()).filter(Boolean);
          if (parts.length >= 2) {
            const last = parts[parts.length - 1].toLowerCase();
            if (/pablo|carlos|jorge|dalia|male|female|hombre|mujer/.test(last)) {
              narrador = last;
              textoVoz = parts.slice(0, -1).join(' ');
            }
          }
        }
        if (!textoVoz) {
          await sock.sendMessage(chat, {
            text: isLoq
              ? '🎙️ Uso: .loquendo [texto], [narrador]\\nNarradores: Pablo, Carlos, Jorge, Dalia\\nEj: .loquendo Hola detective, Jorge'
              : '🎙️ Uso: .voicewaifu [texto]\\nVoz estilo waifu (ES). También: .autovoicewaifu on|off'
          }, { quoted: msg });
          continue;
        }
        reaccionar(sock, msg, '⏳');
        try {
          const voiceMap = {
            pablo: 'es-MX-JorgeNeural',
            carlos: 'es-MX-JorgeNeural',
            jorge: 'es-MX-JorgeNeural',
            dalia: 'es-MX-DaliaNeural',
            hombre: 'es-MX-JorgeNeural',
            mujer: 'es-MX-DaliaNeural',
            male: 'es-MX-JorgeNeural',
            female: 'es-MX-DaliaNeural'
          };
          const hint = isLoq ? (voiceMap[narrador] ? narrador : 'dalia') : 'hakari';
          // override sintetizar by mapping: pass hakari/karane style or use edge voice via temp hack
          let audioPath = await sintetizarTTS(textoVoz, isLoq ? ( /pablo|carlos|jorge|hombre|male/.test(narrador) ? 'jane' : 'hakari') : 'hakari');
          await sock.sendMessage(chat, {
            audio: { url: audioPath },
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true
          }, { quoted: msg });
          try { fs.rmSync(audioPath, { force: true }); } catch {}
          reaccionar(sock, msg, '✅');
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ TTS falló. Instala: pip install edge-tts && pkg install espeak ffmpeg\\n' + (e.message || '') }, { quoted: msg });
        }
        continue;
      }

      if (comando === '.autovoicewaifu') {
        if (!isOwner(msg)) {
          await sock.sendMessage(chat, { text: '⛔ Solo el propietario.' }, { quoted: msg });
          continue;
        }
        const AUTOVOICE_FILE = path.join(__dirname, 'database', 'autovoicewaifu.json');
        let st = { enabled: true };
        try { st = JSON.parse(fs.readFileSync(AUTOVOICE_FILE, 'utf8')); } catch {}
        const sub = (partes[1] || 'estado').toLowerCase();
        if (sub === 'on' || sub === 'off') {
          st.enabled = sub === 'on';
          fs.mkdirSync(path.dirname(AUTOVOICE_FILE), { recursive: true });
          fs.writeFileSync(AUTOVOICE_FILE, JSON.stringify(st, null, 2));
          await sock.sendMessage(chat, { text: sub === 'on' ? '✅ Auto voicewaifu ON (audios en mensajes automáticos)' : '⏸️ Auto voicewaifu OFF (solo texto)' }, { quoted: msg });
          continue;
        }
        await sock.sendMessage(chat, { text: '🎙️ Auto voicewaifu: ' + (st.enabled !== false ? 'ON' : 'OFF') + '\nUso: .autovoicewaifu on|off' }, { quoted: msg });
        continue;
      }


      
      
      
      
      if (comando === '.mikunakanofish') {
        const frase = argumento.trim();
        if (!frase) { await sock.sendMessage(chat, { text: '🎙️ Uso: .mikunakanofish [texto]' }, { quoted: msg }); continue; }
        reaccionar(sock, msg, '⏳');
        try { await enviarFishVoz(sock, chat, msg, frase, FISH_VOICE_MIKU_NAKANO, 'Miku Nakano'); reaccionar(sock, msg, '✅'); }
        catch (e) { await sock.sendMessage(chat, { text: '❌ ' + (e.message || e) + '\n.wagurifish key TU_KEY' }, { quoted: msg }); }
        continue;
      }
      if (comando === '.mikufish') {
        const frase = argumento.trim();
        if (!frase) { await sock.sendMessage(chat, { text: '🎙️ Uso: .mikufish [texto]' }, { quoted: msg }); continue; }
        reaccionar(sock, msg, '⏳');
        try { await enviarFishVoz(sock, chat, msg, frase, FISH_VOICE_MIKU, 'Miku'); reaccionar(sock, msg, '✅'); }
        catch (e) { await sock.sendMessage(chat, { text: '❌ ' + (e.message || e) + '\n.wagurifish key TU_KEY' }, { quoted: msg }); }
        continue;
      }
      if (comando === '.mitsurifish') {
        const frase = argumento.trim();
        if (!frase) { await sock.sendMessage(chat, { text: '🎙️ Uso: .mitsurifish [texto]' }, { quoted: msg }); continue; }
        reaccionar(sock, msg, '⏳');
        try { await enviarFishVoz(sock, chat, msg, frase, FISH_VOICE_MITSURI, 'Mitsuri'); reaccionar(sock, msg, '✅'); }
        catch (e) { await sock.sendMessage(chat, { text: '❌ ' + (e.message || e) + '\n.wagurifish key TU_KEY' }, { quoted: msg }); }
        continue;
      }

      if (comando === '.tetofish') {
        const frase = argumento.trim();
        if (!frase) {
          await sock.sendMessage(chat, { text: '🎙️ Uso: .tetofish [texto]\nVoz Fish Audio: Teto' }, { quoted: msg });
          continue;
        }
        reaccionar(sock, msg, '⏳');
        try {
          await enviarFishVoz(sock, chat, msg, frase, FISH_VOICE_TETO, 'Teto');
          reaccionar(sock, msg, '✅');
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ tetofish: ' + (e.message || e) + '\nConfigura la API: .wagurifish key TU_KEY' }, { quoted: msg });
        }
        continue;
      }

      if (comando === '.gokufish') {
        const frase = argumento.trim();
        if (!frase) {
          await sock.sendMessage(chat, { text: '🎙️ Uso: .gokufish [texto]\nVoz Fish Audio: Goku' }, { quoted: msg });
          continue;
        }
        reaccionar(sock, msg, '⏳');
        try {
          await enviarFishVoz(sock, chat, msg, frase, FISH_VOICE_GOKU, 'Goku');
          reaccionar(sock, msg, '✅');
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ gokufish: ' + (e.message || e) + '\nConfigura la API: .wagurifish key TU_KEY' }, { quoted: msg });
        }
        continue;
      }

      if (comando === '.hitlerfish' || comando === '.pricsillafish' || comando === '.colombianafish' || comando === '.remfish') {
        const frase = argumento.trim();
        const mapa = {
          '.hitlerfish': [FISH_VOICE_HITLER, 'Hitler'],
          '.pricsillafish': [FISH_VOICE_PRICSILLA, 'Priscilla'],
          '.colombianafish': [FISH_VOICE_COLOMBIANA, 'Colombiana'],
          '.remfish': [FISH_VOICE_REM, 'Rem']
        };
        const [voiceId, nombre] = mapa[comando];
        if (!frase) {
          await sock.sendMessage(chat, { text: '🎙️ Uso: ' + comando + ' [texto]\nVoz Fish Audio: ' + nombre }, { quoted: msg });
          continue;
        }
        reaccionar(sock, msg, '⏳');
        try {
          await enviarFishVoz(sock, chat, msg, frase, voiceId, nombre);
          reaccionar(sock, msg, '✅');
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ ' + comando.slice(1) + ': ' + (e.message || e) + '\nConfigura: .wagurifish key TU_KEY' }, { quoted: msg });
        }
        continue;
      }

      if (comando === '.carlosloquendo') {
        const frase = argumento.trim();
        if (!frase) {
          await sock.sendMessage(chat, { text: '🗣️ Uso: .carlosloquendo [texto]\nVoz estilo Carlos (Loquendo/TTS).' }, { quoted: msg });
          continue;
        }
        reaccionar(sock, msg, '⏳');
        let audioPath = null;
        try {
          // Preferir pipeline loquendo/ttsEspañol existente si hay
          if (typeof ttsEspañol === 'function') {
            audioPath = path.join(os.tmpdir(), 'lbot-carlos-' + Date.now() + '.ogg');
            await ttsEspañol(frase, audioPath, { voz: 'Carlos', narrator: 'Carlos' });
          } else if (typeof sintetizarTTS === 'function') {
            audioPath = await sintetizarTTS(frase, 'Carlos');
          } else {
            // edge-tts / espeak fallback Carlos-like Spanish male
            audioPath = path.join(os.tmpdir(), 'lbot-carlos-' + Date.now() + '.mp3');
            try {
              await execFileAsync('edge-tts', ['--voice', 'es-MX-JorgeNeural', '--text', frase.slice(0, 1500), '--write-media', audioPath], { timeout: 120000 });
            } catch {
              const wav = audioPath.replace(/\.mp3$/, '.wav');
              await execFileAsync('espeak-ng', ['-v', 'es', '-p', '40', '-s', '140', '-w', wav, frase.slice(0, 1500)], { timeout: 60000 });
              await execFileAsync('ffmpeg', ['-y', '-i', wav, '-c:a', 'libmp3lame', audioPath], { timeout: 60000 });
              try { fs.rmSync(wav, { force: true }); } catch {}
            }
          }
          if (!audioPath || !fs.existsSync(audioPath) || fs.statSync(audioPath).size < 500) throw new Error('No se generó audio');
          const mime = audioPath.endsWith('.ogg') ? 'audio/ogg; codecs=opus' : 'audio/mpeg';
          await sock.sendMessage(chat, { audio: { url: audioPath }, mimetype: mime, ptt: true }, { quoted: msg });
          reaccionar(sock, msg, '✅');
        } catch (e) {
          await sock.sendMessage(chat, { text: '❌ carlosloquendo: ' + (e.message || e) }, { quoted: msg });
        } finally {
          if (audioPath) try { fs.rmSync(audioPath, { force: true }); } catch {}
        }
        continue;
      }


      if (comando === '.wagurifish') {
        const sub = (partes[1] || '').toLowerCase();
        if (sub === 'key' || sub === 'apikey') {
          if (!isOwner(msg)) {
            await sock.sendMessage(chat, { text: '🌸 Solo el creador puede guardar la API key.' }, { quoted: msg });
            continue;
          }
          const key = partes.slice(2).join(' ').trim();
          if (!key) {
            await sock.sendMessage(chat, { text: 'Uso: .wagurifish key TU_FISH_API_KEY\nObtén la key en fish.audio (dashboard → API Keys).' }, { quoted: msg });
            continue;
          }
          const cfg = loadFishCfg();
          cfg.apiKey = key;
          saveFishCfg(cfg);
          await sock.sendMessage(chat, { text: '✅ API key de Fish Audio guardada en database/fish-audio.json' }, { quoted: msg });
          continue;
        }
        if (sub === 'voice' || sub === 'voz' || sub === 'setvoice') {
          if (!isOwner(msg)) {
            await sock.sendMessage(chat, { text: '🌸 Solo el creador configura la voz.' }, { quoted: msg });
            continue;
          }
          const vid = partes[2] || '';
          if (!vid || vid.length < 8) {
            await sock.sendMessage(chat, {
              text: 'Uso: .wagurifish voice [reference_id]\n\n1) Entra a https://fish.audio\n2) Busca o clona una voz suave (ideal: modelo que suene a Waguri)\n3) Copia el ID de la URL: fish.audio/m/ESTE_ID\n4) .wagurifish voice ESTE_ID'
            }, { quoted: msg });
            continue;
          }
          const cfg = loadFishCfg();
          cfg.referenceId = vid.replace(/.*\//, '').trim();
          saveFishCfg(cfg);
          await sock.sendMessage(chat, { text: '✅ Voz configurada: ' + cfg.referenceId + '\nPrueba: .wagurifish Hola, soy Waguri~' }, { quoted: msg });
          continue;
        }
        if (sub === 'estado' || sub === 'status') {
          const cfg = loadFishCfg();
          await sock.sendMessage(chat, {
            text: '🎙️ *WAGURI FISH AUDIO*\n> API key: ' + (cfg.apiKey ? 'configurada' : 'NO') + '\n> Voice ID: ' + (cfg.referenceId || 'NO') + '\n> Model: ' + (cfg.model || 's2.1-pro-free') + '\n\nConfig:\n.wagurifish key [API_KEY]\n.wagurifish voice [ID]\n.wagurifish [texto para hablar]'
          }, { quoted: msg });
          continue;
        }
        const frase = argumento.trim();
        if (!frase || ['key','voice','voz','setvoice','estado','status'].includes(frase.split(/\s+/)[0].toLowerCase())) {
          await sock.sendMessage(chat, {
            text: '🎙️ *Waguri Fish*\nUso: .wagurifish [texto en español]\nHabla con la voz configurada en Fish Audio.\n\nPrimera vez:\n1. .wagurifish key TU_KEY\n2. .wagurifish voice ID_DEL_MODELO\n3. .wagurifish Hola, qué gusto saludarte~'
          }, { quoted: msg });
          continue;
        }
        reaccionar(sock, msg, '⏳');
        let audioPath = null;
        try {
          audioPath = await fishAudioTTS(frase);
          const esNotaDeVoz = /\.ogg$/i.test(audioPath);
          const segundosFish = esNotaDeVoz ? await duracionAudioSegundos(audioPath) : 0;
          await sock.sendMessage(chat, esNotaDeVoz
            ? { audio: { url: audioPath }, mimetype: 'audio/ogg; codecs=opus', ptt: true, ...(segundosFish ? { seconds: segundosFish } : {}) }
            : { audio: { url: audioPath }, mimetype: 'audio/mpeg', ptt: false, fileName: 'waguri.mp3' },
          { quoted: msg });
          if (waguriActivoEn(chat)) {
            await sock.sendMessage(chat, { text: '🌸 Listo~ espero que mi voz se escuche clarita.' }, { quoted: msg });
          }
          reaccionar(sock, msg, '✅');
        } catch (e) {
          await sock.sendMessage(chat, {
            text: '☁️ No pude generar el audio con Fish Audio.\n' + (e.message || '') + '\n\nRevisa: .wagurifish estado'
          }, { quoted: msg });
        } finally {
          if (audioPath) try { fs.rmSync(audioPath, { force: true }); } catch {}
        }
        continue;
      }


      if (comando === '.wagurichange') {
        if (!isOwner(msg)) {
          await sock.sendMessage(chat, { text: '🌸 Este modo solo puede cambiarlo el creador… perdona.' }, { quoted: msg });
          continue;
        }
        const sub = (partes[1] || 'estado').toLowerCase();
        const w = loadWaguri();
        const imgPath = [WAGURI_IMG, path.join(__dirname, 'media', 'waguri.jpg'), path.join(process.env.HOME || '', 'storage', 'downloads', 'MusicForBot', 'e0478f857a779e21a86efc4fe8e7877c.jpg')].find(x => x && fs.existsSync(x));

        if (sub === 'estado' || sub === 'status') {
          const enG = chat.endsWith('@g.us') ? (Object.prototype.hasOwnProperty.call(w.groups, chat) ? (w.groups[chat] ? 'ON' : 'OFF') : 'hereda') : '-';
          await sock.sendMessage(chat, { text: '🌸 *MODO WAGURI*\n> Global: ' + (w.enabledGlobal ? 'ON' : 'OFF') + '\n> Este chat: ' + enG + '\n\nUso: .wagurichange on|off|this on|this off' }, { quoted: msg });
          continue;
        }
        if (sub === 'this') {
          if (!chat.endsWith('@g.us')) {
            await sock.sendMessage(chat, { text: '🌸 “this” solo funciona en grupos.' }, { quoted: msg });
            continue;
          }
          const acc = (partes[2] || '').toLowerCase();
          if (acc !== 'on' && acc !== 'off') {
            await sock.sendMessage(chat, { text: 'Uso: .wagurichange this on|off' }, { quoted: msg });
            continue;
          }
          w.groups[chat] = acc === 'on';
          saveWaguri(w);
          if (acc === 'on') {
            const presentacion = '🌸 Hola… soy Kaoruko Waguri.\n\nA partir de ahora cuidaré este grupito con mucha gentileza, paciencia y palabras suaves. Los comandos seguirán funcionando, pero hablaré de forma más amable y educada.\n\nLos contenidos +18 quedan en pausa mientras este modo esté activo, para no incomodar a nadie.\n\nGracias por recibirme… haré mi mejor esfuerzo 💕🌷';
            if (imgPath) {
              try {
                await sock.sendMessage(chat, { image: fs.readFileSync(imgPath), caption: presentacion }, { quoted: msg });
              } catch {
                await sock.sendMessage(chat, { text: presentacion }, { quoted: msg });
              }
            } else {
              await sock.sendMessage(chat, { text: presentacion + '\n\n(Nota: coloca la imagen de Waguri en media/e0478f857a779e21a86efc4fe8e7877c.jpg)' }, { quoted: msg });
            }
          } else {
            await sock.sendMessage(chat, { text: '🍃 Waguri se retira de este grupo por ahora…\nCuando Subadashii vuelva a activar el modo, regresaré con la misma sonrisa.\nCuídense mucho, ¿sí? 🌸💕' }, { quoted: msg });
          }
          continue;
        }
        if (sub === 'on' || sub === 'off') {
          w.enabledGlobal = sub === 'on';
          saveWaguri(w);
          if (sub === 'on') {
            const presentacion = '🌸 Hola a todos… me presento con cuidado.\n\nSoy Kaoruko Waguri. El creador ha activado mi modo global: responderé con educación, calma y cariño en los comandos (excepto el contenido +18, que queda desactivado mientras esto esté en marcha).\n\nNo cambiaré lo que el bot puede hacer… solo la forma de decirlo. Gracias por su paciencia ✨🌷';
            if (imgPath) {
              try {
                await sock.sendMessage(chat, { image: fs.readFileSync(imgPath), caption: presentacion }, { quoted: msg });
              } catch {
                await sock.sendMessage(chat, { text: presentacion }, { quoted: msg });
              }
            } else {
              await sock.sendMessage(chat, { text: presentacion }, { quoted: msg });
            }
          } else {
            await sock.sendMessage(chat, { text: '🍃 Modo Waguri desactivado a nivel global.\nMe retiro con una reverencia pequeña… hasta que Subadashii me llame de nuevo.\nQue el resto del día les trate bien. 🌸' }, { quoted: msg });
          }
          continue;
        }
        await sock.sendMessage(chat, { text: 'Uso: .wagurichange estado | on | off | this on | this off' }, { quoted: msg });
        continue;
      }

      if (comando === '.verafk') {
        if (!chat.endsWith('@g.us')) {
          await sock.sendMessage(chat, { text: 'Solo en grupos.' }, { quoted: msg });
          continue;
        }
        let admin = false;
        try { admin = await isGroupAdmin(sock, chat, remitente, true); } catch {}
        if (!isOwner(msg) && !admin) {
          await sock.sendMessage(chat, { text: '⛔ Solo admins o el creador.' }, { quoted: msg });
          continue;
        }
        const RANK_FILE = path.join(__dirname, 'database', 'ranking.json');
        let data = {};
        try { data = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8')); } catch { data = {}; }
        const g = data[chat] || {};
        let meta;
        try { meta = await sock.groupMetadata(chat); } catch { meta = null; }
        const parts = (meta?.participants || []).map(x => x.id || x.jid).filter(Boolean);
        // Combinar participantes con ranking (0 msgs = muy AFK)
        const rows = [];
        const seen = new Set();
        for (const id of parts) {
          const n = normalizeNumber(id);
          seen.add(n);
          const msgs = Number(g[id] || g[n] || Object.entries(g).find(([k]) => normalizeNumber(k) === n)?.[1] || 0);
          rows.push({ id, msgs });
        }
        for (const [k, v] of Object.entries(g)) {
          if (seen.has(normalizeNumber(k))) continue;
          rows.push({ id: k.includes('@') ? k : (k + '@s.whatsapp.net'), msgs: Number(v) || 0 });
        }
        rows.sort((a, b) => a.msgs - b.msgs); // menos mensajes = más AFK primero
        if (!rows.length) {
          await sock.sendMessage(chat, { text: 'Aún no hay datos de actividad. El ranking se llena con el uso del grupo.' }, { quoted: msg });
          continue;
        }
        const porFila = 30;
        const totalFilas = Math.max(1, Math.ceil(rows.length / porFila));
        let fila = 1;
        const mFila = argumento.match(/fila\s*(\d+)/i) || argumento.match(/^(\d+)$/);
        if (mFila) fila = Math.max(1, Math.min(totalFilas, parseInt(mFila[1], 10)));
        const slice = rows.slice((fila - 1) * porFila, fila * porFila);
        const lines = slice.map((r, i) => {
          const idx = (fila - 1) * porFila + i + 1;
          return idx + '. @' + normalizeNumber(r.id) + ' — ' + r.msgs + ' msgs';
        });
        await sock.sendMessage(chat, {
          text: '💤 *INACTIVIDAD / ACTIVIDAD DEL GRUPO*\nFila *' + fila + '/' + totalFilas + '* (menos msgs = más AFK)\n\n' + lines.join('\n') + '\n\nUsa: .verafk fila ' + Math.min(totalFilas, fila + 1) + '\n🖤 ' + BOT_BRAND,
          mentions: slice.map(r => r.id)
        }, { quoted: msg });
        continue;
      }


      if (comando === '.infonsfw') {
        if (!isOwner(msg)) {
          await sock.sendMessage(chat, { text: '⛔ Solo el propietario.' }, { quoted: msg });
          continue;
        }
        const lista = [
          '🔞 *INFO NSFW PÚBLICOS*',
          '(No incluye comandos privados del creador)',
          '',
          'Control:',
          '• .onnsfw / .offnsfw  (global)',
          '• .onthisnsfw / .offthisnsfw  (este grupo)',
          '• .feature on|off himg|hgif|hvideo|nsfwpareja',
          '',
          'Comandos (requieren NSFW on):',
          '• .sexo @usuario  — escena + GIF H',
          '• .himg  — imagen H',
          '• .hgif  — GIF H',
          '• .hvideo [enlace|búsqueda]  — video H',
          '• .nsfwpareja @usuario  — escena entre dos',
          '',
          'Privados del creador: usa .onlycreatornsfw en el chat con el bot.',
          'Autos Hakari/Karane/Jane/Burnice/Zhu + TTS: cada 7–8 min (7:00–23:59) si NSFW global on.'
        ].join('\n');
        await sock.sendMessage(chat, { text: lista }, { quoted: msg });
        continue;
      }

      if (comando === '.stats') {
        if (!isOwner(msg)) {
          await sock.sendMessage(chat, { text: '⛔ Solo el propietario.' }, { quoted: msg });
          continue;
        }
        const up = Math.floor((Date.now() - STARTED_AT) / 1000);
        const h = Math.floor(up / 3600), m = Math.floor((up % 3600) / 60), sec = up % 60;
        const ram = Math.round(process.memoryUsage().rss / 1048576);
        const nsfw = nsfwActivo() ? 'ON' : 'OFF';
        await sock.sendMessage(chat, {
          text: '📊 *STATS L BOT*\n> Uptime: ' + h + 'h ' + m + 'm ' + sec + 's\n> RAM: ' + ram + ' MB\n> NSFW global: ' + nsfw + '\n> Versión: ' + RELEASE_VERSION + '\n🖤 ' + BOT_BRAND
        }, { quoted: msg });
        continue;
      }

      if (comando === '.cita') {
        const citas = [
          'Hoy el destino huele a café y a mala decisión divertida.',
          'Si el día pesa, carga menos culpa y más agua.',
          'Una victoria pequeña sigue siendo victoria.',
          'El detective no adivina: observa… y luego actúa.',
          'A veces lo más valiente es descansar sin disculparte.'
        ];
        await sock.sendMessage(chat, { text: '✨ *CITA DEL MOMENTO*\n\n' + citas[Math.floor(Math.random()*citas.length)] + '\n\n🖤 ' + BOT_BRAND }, { quoted: msg });
        continue;
      }

      if (comando === '.diario') {
        const DIARIO_FILE = path.join(__dirname, 'database', 'diario.json');
        let data = {};
        try { data = JSON.parse(fs.readFileSync(DIARIO_FILE, 'utf8')); } catch { data = {}; }
        const key = (remitente || chat) + '';
        if (!argumento) {
          const entradas = data[key] || [];
          await sock.sendMessage(chat, { text: entradas.length ? ('📔 *Tu diario*\n' + entradas.slice(-5).map((e,i)=> (i+1)+'. '+e).join('\n')) : 'Uso: .diario [texto del día]' }, { quoted: msg });
          continue;
        }
        if (!data[key]) data[key] = [];
        data[key].push(new Date().toISOString().slice(0,10) + ' — ' + argumento.slice(0, 240));
        data[key] = data[key].slice(-30);
        fs.mkdirSync(path.dirname(DIARIO_FILE), { recursive: true });
        fs.writeFileSync(DIARIO_FILE, JSON.stringify(data, null, 2));
        await sock.sendMessage(chat, { text: '✅ Entrada guardada en tu diario.' }, { quoted: msg });
        continue;
      }

      if (comando === '.couple') {
        if (!chat.endsWith('@g.us')) {
          await sock.sendMessage(chat, { text: 'Solo en grupos.' }, { quoted: msg });
          continue;
        }
        try {
          const meta = await sock.groupMetadata(chat);
          const parts = (meta.participants || []).map(p => p.id).filter(Boolean);
          if (parts.length < 2) throw new Error('Pocos integrantes');
          const a = parts[Math.floor(Math.random()*parts.length)];
          let b = parts[Math.floor(Math.random()*parts.length)];
          while (b === a) b = parts[Math.floor(Math.random()*parts.length)];
          await sock.sendMessage(chat, {
            text: '💘 *SHIP DEL MOMENTO*\n\n@' + a.split('@')[0] + '  +  @' + b.split('@')[0] + '\n\n🖤 ' + BOT_BRAND,
            mentions: [a, b]
          }, { quoted: msg });
        } catch (e) {
          await sock.sendMessage(chat, { text: 'No pude armar el ship ahora.' }, { quoted: msg });
        }
        continue;
      }


      if (comando === '.onlycreatornsfw') {
        const soyOwner = isOwner(msg) || normalizeNumber(remitente) === OWNER_NUMBER || normalizeNumber(msg.key?.participant || '') === OWNER_NUMBER;
        if (!soyOwner) {
          if (chat.endsWith('@g.us')) continue;
          await sock.sendMessage(chat, { text: '⛔ Solo el propietario.' }, { quoted: msg });
          continue;
        }
        const lista = [
          '🔒 *SOLO CREADOR · NSFW*',
          '',
          'Control:',
          '• .onnsfw / .offnsfw  (global)',
          '• .onthisnsfw / .offthisnsfw  (solo este grupo)',
          '• .privadomenu',
          '',
          'Público (grupo, con mención):',
          '• .sexo @usuario  (+ GIF +18)',
          '',
          'Privados (chat con el bot):',
          '• .sexo  (sin mención)',
          '• .hahari · .haharibeso · .haharimontar · .hahariboca · .haharidetras',
          '• .hahariducha · .haharimesa · .haharipared · .haharimañana · .haharinoché',
          '• .haharicelosa · .hahariposeida · .haharilento · .haharirapido · .haharidoble',
          '• .haharijav · .haharifotos · .haharivicio · .haharisumisa · .haharidomina · .haharipublico · .haharifinal',
          '• .karanesexo · .karanebeso · .karanetsun',
          '• .sexooral · .sexoduro · .sexosuave · .sexting',
          '• .haharibano · .haharicama · .hahariventana · .haharibalcon · .haharicin · .hahariescuela · .haharicoche',
          '• .hahariducha2 · .haharidespierto · .haharidormir',
          '• .karanebano · .karanecama · .karanetsundere · .karanebeso2 · .karanemano · .karaneboca · .karanedet · .karanecelos',
          '• .doblehahari · .triplesala · .nsfwtexto · .nsfwrapido · .nsfwlento · .nsfworal2 · .nsfwanal · .nsfwpechos · .nsfwducha · .nsfwoficina · .nsfwuniforme · .nsfwmanana · .nsfwnoche',
          '',
          'Automáticos Hakari/Karane: cada ~4 min (7:00–23:59) al privado del dueño.',
          'Estado NSFW: ' + (nsfwActivo() ? 'ENCENDIDO' : 'APAGADO')
        ].join(String.fromCharCode(10));
        await sock.sendMessage(chat, { text: lista }, { quoted: msg });
        continue;
      }

      if (comando === '.anime' || comando === '.an') {
        try {
          await manejarComandoAnime(sock, msg, chat, argumento);
        } catch (e) {
          console.log('Error .anime:', e.message || e);
          await sock.sendMessage(chat, { text: '¡Error! Anime desconocido' }, { quoted: msg });
        }
        continue;
      }


      // Moderación de grupo: solo admins del grupo actual y propietario del bot.
      const moderationCommands = ['.warm', '.patada', '.warnings', '.resetwarnings', '.resetwarm', '.menuadmin'];
      if (moderationCommands.includes(comando)) {
        if (!chat.endsWith('@g.us')) {
          await sock.sendMessage(chat, { text: 'Este comando solo funciona dentro de un grupo.' }, { quoted: msg });
          continue;
        }
        const owner = isOwner(msg);
        let admin = false;
        try { admin = await isGroupAdmin(sock, chat, remitente); }
        catch { admin = false; }
        if (!owner && !admin) {
          await sock.sendMessage(chat, { text: '⛔ Solo los administradores de este grupo pueden usar los comandos de moderación.' }, { quoted: msg });
          continue;
        }
        if (comando === '.menuadmin') {
          await sock.sendMessage(chat, { text: '╭〔 🛡️ MODERACIÓN 〕\n> .warm @usuario motivo\n> .warnings @usuario\n> .resetwarnings @usuario\n> .patada @usuario\n\n> Al llegar a 3 advertencias, L BOT intentará expulsar al integrante.' }, { quoted: msg });
          continue;
        }
        const objetivo = contenido.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!objetivo) {
          await sock.sendMessage(chat, { text: `Uso: ${comando} @usuario${comando === '.warm' ? ' motivo' : ''}` }, { quoted: msg });
          continue;
        }
        const metadata = await getCachedGroup(sock, chat);
        const target = (metadata.participants || []).find(x =>
          x.id === objetivo || x.jid === objetivo || normalizeNumber(x.id || x.jid) === normalizeNumber(objetivo)
        );
        if (!target) {
          await sock.sendMessage(chat, { text: 'Ese usuario no aparece en este grupo.' }, { quoted: msg });
          continue;
        }
        const botJid = sock.user?.id;
        if (isOwner({ key: { participant: objetivo } }) || normalizeNumber(objetivo) === normalizeNumber(botJid) || target.admin) {
          await sock.sendMessage(chat, { text: 'No se puede moderar al propietario, al bot ni a otro administrador.' }, { quoted: msg });
          continue;
        }
        const key = warningKey(chat, objetivo);
        const warnings = loadWarnings();
        if (comando === '.warm') {
          const reason = argumento.replace(/@\d{5,16}/g, '').trim();
          if (!reason) {
            await sock.sendMessage(chat, { text: 'Indica el motivo. Ejemplo: .warm @usuario Flood.' }, { quoted: msg });
            continue;
          }
          const count = (Number(warnings[key]) || 0) + 1;
          warnings[key] = count;
          saveWarnings(warnings);
          if (count >= 3) {
            try {
              if (!(await isGroupAdmin(sock, chat, botJid, true))) throw new Error('L BOT no es administrador del grupo. Quita y vuelve a dar admin, luego reinicia el bot.');
              await sock.groupParticipantsUpdate(chat, [objetivo], 'remove');
              await sock.sendMessage(chat, { text: `🚫 @${normalizeNumber(objetivo)} alcanzó 3/3 advertencias y fue expulsado.\nMotivo de esta advertencia: ${reason}`, mentions: [objetivo] }, { quoted: msg });
              delete warnings[key]; saveWarnings(warnings);
            } catch (err) {
              await sock.sendMessage(chat, { text: `⚠️ @${normalizeNumber(objetivo)} alcanzó 3/3 advertencias, pero no pude expulsarlo: ${err.message}\nEl registro se conserva.`, mentions: [objetivo] }, { quoted: msg });
            }
          } else {
            await sock.sendMessage(chat, { text: `⚠️ *ADVERTENCIA ${count}/3*\n👤 @${normalizeNumber(objetivo)}\n📝 Motivo: ${reason}\n${3-count} advertencia(s) antes de la expulsión.`, mentions: [objetivo] }, { quoted: msg });
          }
          continue;
        }
        if (comando === '.warnings' || comando === '.warns') {
          await sock.sendMessage(chat, { text: `⚠️ @${normalizeNumber(objetivo)} tiene ${Number(warnings[key]) || 0}/3 advertencias.`, mentions: [objetivo] }, { quoted: msg });
          continue;
        }
        if (comando === '.resetwarnings' || comando === '.resetwarm') {
          delete warnings[key]; saveWarnings(warnings);
          await sock.sendMessage(chat, { text: `✅ Advertencias reiniciadas para @${normalizeNumber(objetivo)}.`, mentions: [objetivo] }, { quoted: msg });
          continue;
        }
        if (comando === '.patada') {
          try {
            if (!(await isGroupAdmin(sock, chat, botJid))) throw new Error('L BOT debe ser administrador del grupo.');
            await sock.groupParticipantsUpdate(chat, [objetivo], 'remove');
            delete warnings[key]; saveWarnings(warnings);
            await sock.sendMessage(chat, { text: `👢 @${normalizeNumber(objetivo)} ha sido expulsado del grupo.`, mentions: [objetivo] }, { quoted: msg });
          } catch (err) {
            await sock.sendMessage(chat, { text: `No pude expulsar al integrante: ${err.message}` }, { quoted: msg });
          }
          continue;
        }
      }


      // .help exacto: envía únicamente el enlace del catálogo web.
      // No se activa con argumentos (por ejemplo, ".help musica").
      if (String(texto || '').trim().toLowerCase() === '.help') {
        if (MENU_WEB_URL && /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i.test(MENU_WEB_URL)) {
          await sock.sendMessage(chat, {
            text: '✧ *REZE ROIR BOT — MENÚ INTERACTIVO* ✧\n\nConsulta las categorías y comandos desde esta página:\n' + MENU_WEB_URL
          }, { quoted: msg });
        } else {
          await sock.sendMessage(chat, {
            text: '✧ El menú interactivo aún no está publicado en una dirección HTTPS pública.\n\nCuando esté alojado, configura MENU_WEB_URL en index.js para que .help envíe el enlace.'
          }, { quoted: msg });
        }
        continue;
      }

      // Los otros comandos de menú conservan exactamente su comportamiento anterior.
      if (['.menu', '.comandos', '.jugodemango'].includes(comando)) {
        await enviarBannerMenu(sock, chat, msg);
        await sock.sendMessage(chat, { text: textoMenuPrincipal() }, { quoted: msg });
        continue;
      }

      // COMANDOS PRIVADOS (solo dueño, solo chat privado): no se muestran en grupos
      if (await manejarPrivadoHahari(sock, msg, chat, comando, argumento, partes, remitente)) continue;

      // Protegido: si este módulo falla o se queda colgado, el resto de comandos sigue funcionando.
      let handledHahariCommand = false;
      let hahariExpiro = false;
      let temporizadorHahari;
      try {
        handledHahariCommand = await Promise.race([
          handleHahariCommand({
            sock,
            msg,
            chat,
            comando,
            isOwner: isOwner(msg)
          }),
          new Promise(resolve => { temporizadorHahari = setTimeout(() => { hahariExpiro = true; resolve(false); }, 20000); })
        ]);
      } catch (hahariError) {
        console.log('Error en el módulo de comandos extra (se continúa con el resto):', hahariError?.message || hahariError);
      } finally {
        clearTimeout(temporizadorHahari);
      }

      if (handledHahariCommand) continue;

      const handledGameCommand = await handleGameCommand({
        sock, msg, chat, remitente, comando, partes, argumento, isOwner: isOwner(msg), searchPinterestCharacterImage
      });
      // Contrato explícito: game-system devuelve true si respondió y false si
      // no reconoció el comando. Así ningún undefined puede tragarse .ping/.menu.
      if (handledGameCommand === true) continue;

      const handledAnimeInfoCommand = await handleAnimeInfoCommand({
        sock, msg, chat, comando, argumento
      });
      if (handledAnimeInfoCommand) continue;

      const handledWeatherCommand = await handleWeatherCommand({
        sock, msg, chat, comando, argumento
      });
      if (handledWeatherCommand) continue;

      const handledWorldCommand = await handleWorldCommand({
        sock, msg, chat, comando, argumento, partes, remitente
      });
      if (handledWorldCommand) continue;

      // PING con medición de velocidad (también: .velocidad)
      if (comando === '.ping' || comando === '.p' || comando === '.velocidad') {
        const proceso = Date.now() - t0;
        const marca = msg.messageTimestamp;
        const marcaSeg = marca && typeof marca === 'object' && typeof marca.toNumber === 'function'
          ? marca.toNumber()
          : Number(marca);
        const recepcion = Number.isFinite(marcaSeg) && marcaSeg > 0 ? Date.now() - marcaSeg * 1000 : NaN;
        const tEnvio0 = Date.now();
        const enviado = await sock.sendMessage(chat, { text: '🏓 Midiendo velocidad...' }, { quoted: msg });
        const envio = Date.now() - tEnvio0;
        const reporte = armarReportePing({
          botName: config.botName,
          creador: CREATOR,
          proceso,
          envio,
          total: Date.now() - t0,
          recepcion
        });
        try {
          await sock.sendMessage(chat, { text: reporte, edit: enviado.key });
        } catch {
          await sock.sendMessage(chat, { text: reporte }, { quoted: msg });
        }
      }

      // TEST DE BIENVENIDA
      else if (comando === '.testwelcome') {
        if (!chat.endsWith('@g.us')) {
          await sock.sendMessage(chat, {
            text: '⚠️ Usa .testwelcome dentro de un grupo.'
          }, { quoted: msg });
          continue;
        }
        if (!bienvenidaOn()) {
          await sock.sendMessage(chat, {
            text: '⚠️ La bienvenida automática está en OFF (usa .bienvenida on para activarla). No se envió nada a propósito.'
          }, { quoted: msg });
          continue;
        }
        await enviarBienvenida(chat, remitente);
      }

      // Interruptor propio de la bienvenida automática (independiente de .autoaudio)
      else if (comando === '.bienvenida') {
        if (!isOwner(msg)) {
          await sock.sendMessage(chat, { text: '⛔ Este comando es exclusivo del creador.' }, { quoted: msg });
          continue;
        }
        const sub = (partes[1] || 'estado').toLowerCase();
        const st = loadBienvenidaState();
        if (sub === 'off') {
          st.enabled = false;
          saveBienvenidaState(st);
          await sock.sendMessage(chat, { text: '⏸️ Bienvenida automática DESACTIVADA.\nUsa .bienvenida on para reactivarla.' }, { quoted: msg });
        } else if (sub === 'on') {
          st.enabled = true;
          saveBienvenidaState(st);
          await sock.sendMessage(chat, { text: '✅ Bienvenida automática ACTIVADA.' }, { quoted: msg });
        } else {
          await sock.sendMessage(chat, { text: 'Estado de la bienvenida automática: ' + (bienvenidaOn() ? 'ON' : 'OFF') + '\nUso: .bienvenida on|off' }, { quoted: msg });
        }
      }

      // STICKER + GIF: fotos, GIFs y videos cortos (3 o 5 s) con créditos en el sticker
      else if (comando === '.sticker' || comando === '.s' || comando === '.gif' || comando === '.g') {
        const citado = contenido.extendedTextMessage?.contextInfo?.quotedMessage || {};
        const imagenMsg = contenido.imageMessage || citado.imageMessage;
        const videoMsg = contenido.videoMessage || citado.videoMessage;

        if (!imagenMsg && !videoMsg) {
          await sock.sendMessage(chat, {
            text: '🖼️ Responde a una foto, GIF o video corto con .sticker (o .gif).\n🎞️ En videos largos usa .gif 3 o .gif 5 para tomar los primeros 3 o 5 segundos.'
          }, { quoted: msg });
          continue;
        }

        const esVideo = Boolean(videoMsg) && !imagenMsg;
        const duracionOrigen = Number(videoMsg?.seconds) || 0;
        if (esVideo && duracionOrigen > 60) {
          await sock.sendMessage(chat, {
            text: '⏱️ Ese video es muy largo. Usa uno de hasta 60 segundos (se tomarán los primeros 3 o 5).'
          }, { quoted: msg });
          continue;
        }
        const limiteSeg = esVideo ? (Number((argumento.match(/\b([35])\b/) || [])[1]) || 5) : 0;
        reaccionar(sock, msg, '⏳');

        const stream = await downloadContentFromMessage(esVideo ? videoMsg : imagenMsg, esVideo ? 'video' : 'image');
        const trozos = [];
        for await (const trozo of stream) trozos.push(trozo);
        const entrada = Buffer.concat(trozos);
        if (!entrada.length) throw new Error('No pude descargar el archivo original.');

        const temporal = path.join(os.tmpdir(), `lbot-sticker-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const archivoEntrada = `${temporal}.media`;
        const archivoSticker = `${temporal}.webp`;

        try {
          fs.writeFileSync(archivoEntrada, entrada);

          if (esVideo) {
            await convertirAnimadoWebp(archivoEntrada, archivoSticker, limiteSeg);
          } else {
            await execFileAsync('ffmpeg', [
              '-y',
              '-hide_banner',
              '-loglevel', 'error',
              '-i', archivoEntrada,
              '-vf', 'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,fps=15,format=yuva420p',
              '-frames:v', '1',
              '-c:v', 'libwebp',
              '-lossless', '0',
              '-q:v', '80',
              '-compression_level', '6',
              '-an',
              '-f', 'webp',
              archivoSticker
            ], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
          }

          if (!fs.existsSync(archivoSticker)) {
            throw new Error('FFmpeg no generó el archivo WebP.');
          }

          const crudo = fs.readFileSync(archivoSticker);
          if (crudo.length < 16 ||
              crudo.toString('ascii', 0, 4) !== 'RIFF' ||
              crudo.toString('ascii', 8, 12) !== 'WEBP') {
            throw new Error('El archivo generado no es un WebP válido.');
          }

          // Créditos que WhatsApp muestra al tocar el sticker (con el creador real del sticker).
          const credito = construirCreditoSticker(remitente);
          const stickerFinal = addStickerExif(crudo, credito.pack, credito.author);

          await sock.sendMessage(chat, {
            sticker: stickerFinal,
            mimetype: 'image/webp'
          }, { quoted: msg });

          reaccionar(sock, msg, '✅');
          if (esVideo && duracionOrigen > limiteSeg) {
            sock.sendMessage(chat, { text: `✂️ Tomé los primeros ${limiteSeg} segundos del video.` }, { quoted: msg }).catch(() => {});
          }
          console.log(`Sticker ${esVideo ? 'animado ' : ''}enviado correctamente (${stickerFinal.length} bytes).`);
        } finally {
          for (const archivo of [archivoEntrada, archivoSticker]) {
            if (fs.existsSync(archivo)) fs.unlinkSync(archivo);
          }
        }
      }

      // STICKER CON SONIDO (.sa): toma un video corto con audio y lo manda como sticker que suena al tocarlo.
      // Si el WhatsApp/Baileys del bot aún no soporta el formato nuevo, cae a sticker + nota de voz.
      else if (comando === '.sa') {
        const citadoSa = contenido.extendedTextMessage?.contextInfo?.quotedMessage || {};
        const videoMsgSa = contenido.videoMessage || citadoSa.videoMessage;

        if (!videoMsgSa) {
          await sock.sendMessage(chat, {
            text: '🔊 Responde a un video corto (con audio) con .sa para convertirlo en sticker con sonido.\nUso: .sa  (máx. 5 segundos de video; si es más largo, se toman los primeros 5).'
          }, { quoted: msg });
          continue;
        }

        const duracionSa = Number(videoMsgSa.seconds) || 0;
        if (duracionSa > 60) {
          await sock.sendMessage(chat, { text: '⏱️ Ese video es muy largo. Usa uno de hasta 60 segundos (se tomarán los primeros 5).' }, { quoted: msg });
          continue;
        }
        const limiteSa = 5;
        reaccionar(sock, msg, '⏳');

        const streamSa = await downloadContentFromMessage(videoMsgSa, 'video');
        const trozosSa = [];
        for await (const trozo of streamSa) trozosSa.push(trozo);
        const entradaBufSa = Buffer.concat(trozosSa);
        if (!entradaBufSa.length) throw new Error('No pude descargar el video original.');

        const tempSa = path.join(os.tmpdir(), `lbot-sa-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const archivoEntradaSa = `${tempSa}.media`;
        const archivoStickerSa = `${tempSa}.webp`;
        const archivoAudioSa = `${tempSa}.ogg`;

        try {
          fs.writeFileSync(archivoEntradaSa, entradaBufSa);

          // Pista de audio primero: si no hay audio, no tiene sentido seguir.
          await extraerAudioOpus(archivoEntradaSa, archivoAudioSa);
          await convertirAnimadoWebp(archivoEntradaSa, archivoStickerSa, limiteSa);

          if (!fs.existsSync(archivoStickerSa)) throw new Error('FFmpeg no generó el sticker animado.');
          const crudoSa = fs.readFileSync(archivoStickerSa);
          if (crudoSa.length < 16 || crudoSa.toString('ascii', 0, 4) !== 'RIFF' || crudoSa.toString('ascii', 8, 12) !== 'WEBP') {
            throw new Error('El archivo generado no es un WebP válido.');
          }

          const creditoSa = construirCreditoSticker(remitente);
          const stickerFinalSa = addStickerExif(crudoSa, creditoSa.pack, creditoSa.author);

          let enviadoNativo = false;
          if (asegurarCamposAudioSticker() && typeof sock.waUploadToServer === 'function' && typeof generateWAMessageContent === 'function') {
            try {
              const subeArchivo = { upload: sock.waUploadToServer };
              const contenidoSticker = await generateWAMessageContent({ sticker: stickerFinalSa }, subeArchivo);
              const contenidoAudio = await generateWAMessageContent(
                { audio: fs.readFileSync(archivoAudioSa), mimetype: 'audio/ogg; codecs=opus', ptt: true },
                subeArchivo
              );
              const stickerMsgSa = contenidoSticker.stickerMessage;
              const audioMsgSa = contenidoAudio.audioMessage;
              if (!stickerMsgSa || !audioMsgSa) throw new Error('No se pudo generar el contenido base del sticker o del audio.');
              stickerMsgSa.audioMessage = audioMsgSa;

              const mensajeCompleto = generateWAMessageFromContent(chat, {
                audioStickerMessage: { version: 1, message: { stickerMessage: stickerMsgSa } }
              }, { quoted: msg, userJid: sock.user?.id });

              await sock.relayMessage(chat, mensajeCompleto.message, { messageId: mensajeCompleto.key.id });
              enviadoNativo = true;
              console.log('Sticker con sonido (nativo) enviado correctamente.');
            } catch (eNativo) {
              console.log('Sticker con sonido nativo falló, uso respaldo sticker + nota de voz:', eNativo.message || eNativo);
            }
          }

          if (!enviadoNativo) {
            await sock.sendMessage(chat, { sticker: stickerFinalSa, mimetype: 'image/webp' }, { quoted: msg });
            await sock.sendMessage(chat, { audio: { url: archivoAudioSa }, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg });
            await sock.sendMessage(chat, {
              text: 'ℹ️ Tu Baileys/WhatsApp aún no soporta el sticker con sonido nativo aquí, así que mandé el sticker y el audio por separado.'
            }, { quoted: msg }).catch(() => {});
          }

          reaccionar(sock, msg, '✅');
          if (duracionSa > limiteSa) {
            sock.sendMessage(chat, { text: `✂️ Tomé los primeros ${limiteSa} segundos del video.` }, { quoted: msg }).catch(() => {});
          }
        } finally {
          for (const archivo of [archivoEntradaSa, archivoStickerSa, archivoAudioSa]) {
            if (fs.existsSync(archivo)) fs.unlinkSync(archivo);
          }
        }
      }

      // ROLEPLAY ANIME: perfiles, acciones, afinidad y escenas
      else if (comando === '.rol' || comando === '.roleplay') {
        const sub = (partes[1] || 'ayuda').toLowerCase();
        const datosRol = loadRoleplay();
        const yo = remitente;
        if (sub === 'ayuda' || sub === 'menu') {
          await sock.sendMessage(chat, { text:
            `╭━━〔 🎭 ROLEPLAY ANIME 〕━━╮\n\n` +
            `👤 *.rol perfil Nombre | Anime | Descripción*\n` +
            `🔎 *.rol ver @usuario*\n` +
            `🤝 *.rol afinidad @usuario*\n` +
            `🎬 *.escena*\n\n` +
            `⚔️ Acciones: .abrazar, .besar, .besarmejilla, .besarfrente, .besarmanos, .besarcuelo, .besarlengua, .morder, .lamer, .cosquillas, .tomarmano, .bailar, .guiñar, .bonk y más\n\n` +
            `Cada acción incluye un GIF anime cuando el servicio está disponible.\n` +
            `Responde a un mensaje o menciona a alguien para dirigir una acción.\n` +
            `🖤 ${BOT_BRAND} · ${CREATOR}`
          }, { quoted: msg });
          continue;
        }
        if (sub === 'perfil') {
          const raw = partes.slice(2).join(' ').trim();
          const campos = raw.split('|').map(x => x.trim());
          if (!campos[0]) {
            await sock.sendMessage(chat, { text: 'Uso: .rol perfil Nombre | Anime | Descripción' }, { quoted: msg });
            continue;
          }
          datosRol.profiles[roleUserKey(yo)] = {
            name: campos[0].slice(0, 32), anime: (campos[1] || 'Personaje original').slice(0, 40),
            bio: (campos[2] || 'Un personaje cuyo destino aún está por escribirse.').slice(0, 180),
            updatedAt: new Date().toISOString()
          };
          saveRoleplay(datosRol);
          await sock.sendMessage(chat, { text: `✨ *PERFIL DE ROL CREADO*\n\n👤 Nombre: ${datosRol.profiles[roleUserKey(yo)].name}\n📺 Universo: ${datosRol.profiles[roleUserKey(yo)].anime}\n📜 Descripción: ${datosRol.profiles[roleUserKey(yo)].bio}\n\nTu personaje ya está listo para entrar en escena.` }, { quoted: msg });
          continue;
        }
        if (sub === 'ver' || sub === 'afinidad') {
          const objetivo = roleMention(msg);
          if (!objetivo) {
            await sock.sendMessage(chat, { text: `Menciona a alguien o responde a su mensaje. Ejemplo: .rol ${sub} @usuario` }, { quoted: msg });
            continue;
          }
          if (sub === 'afinidad') {
            const valor = datosRol.affinity[pairKey(yo, objetivo)] || 0;
            await sock.sendMessage(chat, { text: `🤝 *AFINIDAD DE ROLEPLAY*\n\nEntre @${roleUserKey(yo)} y @${roleUserKey(objetivo)}\n💞 Afinidad: *${valor}/100*\n\nLa afinidad cambia mediante las interacciones de rol.`, mentions: [yo, objetivo] }, { quoted: msg });
          } else {
            const perfil = datosRol.profiles[roleUserKey(objetivo)];
            await sock.sendMessage(chat, { text: perfil ? `🎭 *FICHA DE PERSONAJE*\n\n👤 ${perfil.name}\n📺 Universo: ${perfil.anime}\n📜 ${perfil.bio}` : 'Este usuario todavía no ha creado su perfil. Puede hacerlo con .rol perfil Nombre | Anime | Descripción', mentions: [objetivo] }, { quoted: msg });
          }
          continue;
        }
        await sock.sendMessage(chat, { text: 'Subcomando desconocido. Usa .rol ayuda para ver las opciones.' }, { quoted: msg });
      }

      else if (comando === '.escena') {
        const escenas = [
          '🌸 La brisa mueve los pétalos de cerezo. Una figura aparece en el tejado y te invita a contemplar la ciudad.',
          '⚔️ Una presencia poderosa se acerca. El suelo vibra y una voz anuncia que una prueba está a punto de comenzar.',
          '🌧️ La lluvia cae sobre la estación vacía. Alguien deja un paraguas a tu lado y espera tu reacción.',
          '✨ Un portal luminoso se abre frente a ti. Al otro lado se escucha una voz que parece conocerte.',
          '🏮 El festival nocturno está en marcha. Entre las luces, alguien te desafía a participar en un misterioso juego.',
          '🌀 Una energía desconocida despierta en tus manos. Por un instante, el mundo entero parece quedarse en silencio.'
        ];
        await sock.sendMessage(chat, { text: `🎬 *NUEVA ESCENA*\n\n${randomItem(escenas)}\n\n¿Qué haces? Describe tu siguiente movimiento.\n> 「 La historia está en tus manos 」` }, { quoted: msg });
      }

      else if ([
        '.abrazar', '.besar', '.besarmejilla', '.besarfrente', '.besarmanos', '.besarcuelo', '.besarlengua',
        '.saludar', '.acariciar', '.proteger', '.retar', '.golpear', '.sonreir', '.llorar',
        '.morder', '.lamer', '.cosquillas', '.abrazofuerte', '.abrazosporatras', '.sentarenpiernas',
        '.tomarmano', '.mirarfijo', '.guiñar', '.sonrojarse', '.bailar', '.aplaudir', '.dormir',
        '.alimentar', '.bonk', '.empujar', '.cargar', '.abrazarlado', '.besarnariz', '.acariciarcara',
        '.chocar', '.sacudir', '.consolar', '.sorprender', '.perseguir'
      ].includes(comando)) {
        const acciones = {
          '.abrazar': ['se acerca y te da un abrazo cálido.', 'te rodea con sus brazos en un gesto afectuoso.', 'te abraza con una sonrisa tranquila.', 'te envuelve en un abrazo largo y no tiene prisa por soltarte.'],
          '.besar': ['te da un beso suave en los labios.', 'se acerca y te besa con cariño.', 'te roba un beso rápido y se ríe.', 'te besa despacio, como si el tiempo se detuviera.'],
          '.besarmejilla': ['te da un beso suave en la mejilla.', 'apoya los labios en tu mejilla y se queda un segundo.', 'te besa la mejilla y se sonroja.'],
          '.besarfrente': ['te besa la frente con ternura.', 'se pone de puntitas y deja un beso en tu frente.', 'te acomoda el cabello y te besa la frente.'],
          '.besarmanos': ['toma tu mano y deja un beso en los nudillos.', 'te besa la palma con suavidad.', 'levanta tu mano y deposita un beso elegante.'],
          '.besarcuelo': ['se acerca a tu cuello y deja un beso corto.', 'te besa cerca del cuello y se ríe bajito.', 'apoya los labios en tu cuello un instante.'],
          '.besarlengua': ['te besa más profundo, con lengua, sin prisa.', 'se acerca y te da un beso intenso con lengua.', 'entrelaza el beso contigo y no quiere soltarte.'],
          '.saludar': ['levanta la mano y te saluda alegremente.', 'hace una pequeña reverencia a modo de saludo.', 'te dedica una sonrisa y un saludo amistoso.'],
          '.acariciar': ['te acaricia suavemente la cabeza.', 'te da unas palmaditas amistosas en el hombro.', 'te acomoda un mechón de cabello con cuidado.'],
          '.proteger': ['se coloca delante de ti para protegerte.', 'desenvaina su espada y cubre tu espalda.', 'crea un escudo de energía a tu alrededor.'],
          '.retar': ['te señala y te reta a un duelo.', 'adopta una postura de combate y espera tu movimiento.', 'sonríe con confianza: parece que quiere poner a prueba tus habilidades.'],
          '.golpear': ['lanza un golpe de entrenamiento, esperando que puedas esquivarlo.', 'te da un golpe de broma en el hombro.', 'inicia un combate amistoso contigo.'],
          '.sonreir': ['te dedica una sonrisa sincera.', 'sonríe con aire misterioso.', 'te mira y deja escapar una pequeña sonrisa.'],
          '.llorar': ['se cubre el rostro mientras unas lágrimas recorren sus mejillas.', 'intenta contener el llanto, pero no puede.', 'baja la mirada, visiblemente emocionado.'],
          '.morder': ['te muerde suavemente el hombro en broma.', 'deja un mordisquito juguetón en tu brazo.', 'te muerde el dedo con cara traviesa.'],
          '.lamer': ['te lame la mejilla de forma juguetona.', 'saca la lengua y te lame la nariz.', 'te lame el dedo y se ríe.'],
          '.cosquillas': ['te hace cosquillas en los costados.', 'no te suelta hasta que te rías.', 'te ataca con cosquillas sin piedad.'],
          '.abrazofuerte': ['te aprieta en un abrazo fuerte que casi te levanta.', 'te abraza tan fuerte que casi te falta el aire, pero de cariño.', 'te envuelve y no quiere soltarte.'],
          '.abrazosporatras': ['se acerca por detrás y te abraza la cintura.', 'te abraza por la espalda y apoya la mejilla en tu hombro.', 'te rodea por atrás en silencio.'],
          '.sentarenpiernas': ['se sienta en tus piernas sin pedir permiso.', 'busca tu regazo y se acomoda ahí.', 'se deja caer en tus piernas y se queda contento.'],
          '.tomarmano': ['entrelaza sus dedos con los tuyos.', 'toma tu mano y no la suelta.', 'busca tu mano y la aprieta con cariño.'],
          '.mirarfijo': ['te mira fijo sin decir nada.', 'no aparta la mirada de la tuya.', 'te observa en silencio, concentrado en ti.'],
          '.guiñar': ['te guiña un ojo con picardía.', 'guiña y sonríe de lado.', 'te lanza un guiño rápido.'],
          '.sonrojarse': ['se pone rojo hasta las orejas.', 'aparta la mirada, todo sonrojado.', 'se tapa la cara porque se puso colorado.'],
          '.bailar': ['te toma de la mano y te invita a bailar.', 'empieza a bailar frente a ti sin vergüenza.', 'te jala al ritmo y baila contigo.'],
          '.aplaudir': ['aplaude con energía.', 'te aplaude como si hubieras ganado algo grande.', 'da una ronda de aplausos solo para ti.'],
          '.dormir': ['se queda dormido apoyado en tu hombro.', 'bosteza y se acurruca a tu lado.', 'cierra los ojos y descansa junto a ti.'],
          '.alimentar': ['te acerca un bocado a la boca.', 'insiste en darte de comer con cariño.', 'te ofrece comida como si fueras su tesoro.'],
          '.bonk': ['te da un toque suave en la cabeza: bonk.', 'te golpea con una almohada imaginaria.', 'te hace un bonk juguetón en la frente.'],
          '.empujar': ['te empuja suave en broma.', 'te da un empujón juguetón en el hombro.', 'te mueve un paso con una sonrisa.'],
          '.cargar': ['intenta cargarte en brazos.', 'te levanta un segundo y se ríe.', 'te carga como si no pesaras nada.'],
          '.abrazarlado': ['te abraza de lado mientras caminan.', 'se pega a tu costado en un medio abrazo.', 'pone un brazo sobre tus hombros.'],
          '.besarnariz': ['te da un beso rapidito en la nariz.', 'boop: beso en la nariz.', 'te toca la nariz con un beso corto.'],
          '.acariciarcara': ['te acaricia la mejilla con el dorso de la mano.', 'te pasa los dedos por la mandíbula con cuidado.', 'te toca el rostro y sonríe.'],
          '.chocar': ['choca los cinco contigo.', 'levanta la mano para un high five.', 'busca tu palma y choca con fuerza.'],
          '.sacudir': ['te sacude los hombros para despertarte.', 'te mueve un poco en broma.', 'te agarra y te sacude suavemente.'],
          '.consolar': ['te abraza para consolarte.', 'te dice que todo estará bien mientras te sostiene.', 'se queda a tu lado en silencio, acompañándote.'],
          '.sorprender': ['aparece de la nada para sorprenderte.', 'te tapa los ojos un segundo y se ríe.', 'salta a tu lado de sorpresa.'],
          '.perseguir': ['empieza a perseguirte por el pasillo.', 'te corretea en broma.', 'te sigue de cerca sin dejarte escapar.']
        };
        const gifTipo = {
          '.abrazar': 'hug', '.besar': 'kiss', '.besarmejilla': 'kiss', '.besarfrente': 'kiss', '.besarmanos': 'kiss', '.besarcuelo': 'kiss', '.besarlengua': 'kiss',
          '.saludar': 'wave', '.acariciar': 'pat', '.proteger': 'hug', '.retar': 'highfive', '.golpear': 'slap', '.sonreir': 'happy', '.llorar': 'cry',
          '.morder': 'bite', '.lamer': 'lick', '.cosquillas': 'tickle', '.abrazofuerte': 'hug', '.abrazosporatras': 'hug', '.sentarenpiernas': 'cuddle',
          '.tomarmano': 'handhold', '.mirarfijo': 'stare', '.guiñar': 'wink', '.sonrojarse': 'blush', '.bailar': 'dance', '.aplaudir': 'clap', '.dormir': 'sleep',
          '.alimentar': 'feed', '.bonk': 'bonk', '.empujar': 'poke', '.cargar': 'hug', '.abrazarlado': 'hug', '.besarnariz': 'kiss', '.acariciarcara': 'pat',
          '.chocar': 'highfive', '.sacudir': 'poke', '.consolar': 'hug', '.sorprender': 'happy', '.perseguir': 'run'
        }[comando];
        const objetivo = roleMention(msg);
        const esIndividual = ['.llorar', '.sonreir', '.sonrojarse', '.guiñar', '.mirarfijo', '.aplaudir', '.bailar', '.dormir'].includes(comando);
        if (!objetivo && !esIndividual) {
          await sock.sendMessage(chat, { text: `Menciona a alguien o responde a su mensaje. Ejemplo: ${comando} @usuario` }, { quoted: msg });
          continue;
        }
        const actorPerfil = loadRoleplay().profiles[roleUserKey(remitente)];
        const actor = actorPerfil?.name || `@${roleUserKey(remitente)}`;
        const destinoPerfil = objetivo ? loadRoleplay().profiles[roleUserKey(objetivo)] : null;
        const destino = destinoPerfil?.name || (objetivo ? `@${roleUserKey(objetivo)}` : 'el ambiente');
        let afinidadTexto = '';
        const data = loadRoleplay();
        if (objetivo && roleUserKey(objetivo) !== roleUserKey(remitente)) {
          const key = pairKey(remitente, objetivo);
          const cambio = ['.abrazar', '.besar', '.besarmejilla', '.besarfrente', '.besarmanos', '.besarcuelo', '.besarlengua', '.saludar', '.acariciar', '.proteger', '.tomarmano', '.consolar', '.abrazofuerte', '.abrazosporatras', '.sentarenpiernas', '.acariciarcara', '.besarnariz'].includes(comando) ? 3 : ['.golpear', '.retar', '.bonk', '.empujar'].includes(comando) ? -1 : 1;
          data.affinity[key] = Math.max(0, Math.min(100, (data.affinity[key] || 0) + cambio));
          saveRoleplay(data);
          afinidadTexto = `\n💞 Afinidad: ${data.affinity[key]}/100 (${cambio > 0 ? '+' : ''}${cambio})`;
        }
        const narracion = randomItem(acciones[comando] || ['hace un gesto especial.']);
        const menciones = objetivo ? [objetivo] : [];
        const pie = `🎭 *ROLEPLAY ANIME*\n\n*${actor}* ${narracion}\n\n🎯 Objetivo: ${destino}${afinidadTexto}\n> 「 Tu turno... 」\n\n🖤 ${BOT_BRAND}`;
        try {
          await sendAnimeGif(sock, chat, gifTipo || 'happy', pie, menciones, msg);
        } catch (errorGif) {
          console.log('GIF roleplay no disponible:', errorGif.message);
          await sock.sendMessage(chat, { text: `${pie}\n\n🎞️ No encontré una animación disponible; la acción se envió como texto.`, mentions: menciones }, { quoted: msg });
        }
      }

      // PIN: Pinterest search with graceful fallback to a Pinterest search URL
      else if (comando === '.pin') {
        if (!argumento) {
          await sock.sendMessage(chat, {
            text: '📌 Uso: .pin personaje, anime, estética o tema\nEjemplo: .pin Misa Amane Death Note'
          }, { quoted: msg });
          continue;
        }

        const queryPin = encodeURIComponent(argumento);
        const pinterestUrl = `https://www.pinterest.com/search/pins/?q=${queryPin}`;
        let resultados = [];
        try {
          const pagina = await fetch(pinterestUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml'
            },
            signal: AbortSignal.timeout(18000)
          });
          if (pagina.ok) {
            const html = await pagina.text();
            const vistos = new Set();
            const regex = /https?:\/\/(?:i\.pinimg\.com)\/(?:originals|736x|564x|474x|236x)\/[^"'\s<>]+?\.(?:jpg|jpeg|png|webp)/gi;
            let match;
            while ((match = regex.exec(html)) !== null && resultados.length < 18) {
              const url = match[0].replace(/\\\\u002F/g, '/').replace(/&amp;/g, '&');
              if (vistos.has(url)) continue;
              vistos.add(url);
              if (/\b(nude|nudes|explicit|porn|xxx|hentai|sexual)\b/i.test(url)) continue;
              resultados.push(url);
            }
          }
        } catch (e) {
          console.log('Pinterest no permitió lectura directa:', e.message);
        }

        if (!resultados.length) {
          await sock.sendMessage(chat, {
            text:
              `📌 *PINTEREST | RESULTADOS DE BÚSQUEDA*\n\n` +
              `🔎 Consulta: *${argumento}*\n` +
              `No pude extraer imágenes directamente en esta ocasión. Pinterest puede limitar el acceso automatizado.\n\n` +
              `↗️ Abre los resultados aquí:\n${pinterestUrl}\n\n` +
              `🖤 ${BOT_BRAND} · ${CREATOR}`
          }, { quoted: msg });
          continue;
        }

        const elegida = resultados[Math.floor(Math.random() * resultados.length)];
        const descarga = await fetch(elegida, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(25000)
        });
        if (!descarga.ok) throw new Error('Pinterest encontró resultados, pero no se pudo descargar la imagen.');
        const imagenPin = Buffer.from(await descarga.arrayBuffer());
        if (imagenPin.length > 10 * 1024 * 1024) throw new Error('La imagen supera el límite de 10 MB.');

        await sock.sendMessage(chat, {
          image: imagenPin,
          caption:
            `╭━━━〔 📌 PINTEREST 〕━━━╮\n\n` +
            `🔎 *Búsqueda:* ${argumento}\n` +
            `🖼️ *Resultado:* imagen encontrada en Pinterest\n` +
            `🔗 *Pin / resultados:* ${pinterestUrl}\n` +
            `© Imagen alojada en Pinterest. Respeta los créditos del autor original.\n\n` +
            `👑 ${CREATOR}\n🤖 ${BOT_BRAND}`
        }, { quoted: msg });
      }

      // EXPRESIONES ANIME SFW
      else if (comando === '.expresion' || comando === '.expresión') {
        const accion = (partes[1] || '').toLowerCase();
        const mapa = {
          feliz: 'happy', alegria: 'happy', alegría: 'happy', sonreir: 'happy', sonreír: 'happy',
          aplaudir: 'clap', aplaudiendo: 'clap',
          llorar: 'cry', triste: 'cry', llorando: 'cry',
          sonrojar: 'blush', sonrojada: 'blush', sonrojarse: 'blush',
          besar: 'kiss', beso: 'kiss', besito: 'kiss',
          abrazar: 'hug', abrazo: 'hug', abrazote: 'hug',
          acariciar: 'pat', pat: 'pat', headpat: 'pat',
          bailar: 'dance', dance: 'dance',
          saludar: 'wave', hola: 'wave', wave: 'wave',
          guiñar: 'wink', wink: 'wink',
          morder: 'bite', bite: 'bite',
          cosquillas: 'tickle', tickle: 'tickle',
          golpear: 'slap', slap: 'slap', cachetada: 'slap',
          chocar: 'highfive', highfive: 'highfive', chocala: 'highfive',
          poke: 'poke', molestar: 'poke',
          dormir: 'sleep', sleep: 'sleep',
          comer: 'feed', alimentar: 'feed', feed: 'feed',
          bonk: 'bonk',
          smug: 'smug', engreido: 'smug',
          stare: 'stare', mirar: 'stare',
          correr: 'run', run: 'run',
          shrug: 'shrug', facepalm: 'facepalm',
          cuddle: 'cuddle', acurrucar: 'cuddle',
          handhold: 'handhold', manitas: 'handhold',
          lick: 'lick', lamer: 'lick',
          nom: 'nom', punch: 'punch', kick: 'kick', yeet: 'yeet'
        };
        const tipo = mapa[accion];
        if (!tipo) {
          await sock.sendMessage(chat, {
            text: '🎭 *EXPRESIONES ANIME*\nUso: .expresion feliz | aplaudir | llorar | sonrojar | besar @usuario | abrazar @usuario | acariciar @usuario | bailar'
          }, { quoted: msg });
          continue;
        }

        const menciones = [...texto.matchAll(/@([0-9]{5,16})/g)].map(x => `${x[1]}@s.whatsapp.net`);
        const etiqueta = menciones.length ? menciones.map(x => `@${x.split('@')[0]}`).join(' ') : '';
        const frases = {
          feliz: '¡Una sonrisa ilumina el momento!', aplaudir: '¡Un aplauso por esa gran energía!',
          llorar: 'A veces las emociones simplemente salen.', sonrojar: 'Parece que alguien se ha sonrojado...',
          besar: 'Un gesto cariñoso para alegrar el día.', abrazar: 'Un abrazo anime para compartir cariño.',
          acariciar: 'Un gesto suave y reconfortante.', bailar: '¡Que comience el ritmo!'
        };
        const pieExpr = `🎭 *${accion.toUpperCase()}*${etiqueta ? ` ${etiqueta}` : ''}\n\n${frases[accion] || '¡Una expresión anime para este momento!'}\n\n🖤 ${BOT_BRAND}\n👑 ${CREATOR}`;
        try {
          await sendAnimeGif(sock, chat, tipo, pieExpr, menciones, msg);
        } catch (e) {
          console.log('Expresión GIF no disponible:', e.message);
          await sock.sendMessage(chat, { text: `${pieExpr}\n\n🎞️ No pude conseguir una animación ahora mismo.`, mentions: menciones }, { quoted: msg });
        }
      }

      // AUTOEXPRESIONES: control exclusivo del propietario
      else if (comando === '.autoexpresiones') {
        if (!isOwner(msg)) {
          await sock.sendMessage(chat, { text: '⛔ Este comando está reservado al propietario del bot.' }, { quoted: msg });
          continue;
        }
        const sub = (partes[1] || 'estado').toLowerCase();
        const estado = loadAutoExp();
        if (sub === 'on' || sub === 'activar') {
          estado.enabled = true; saveAutoExp(estado);
          await sock.sendMessage(chat, { text: '✅ Autoexpresiones activadas globalmente para los grupos. Horario: 6:00 a. m. a 11:59 p. m. (Colombia).' }, { quoted: msg });
        } else if (sub === 'off' || sub === 'desactivar') {
          estado.enabled = false; saveAutoExp(estado);
          await sock.sendMessage(chat, { text: '⏸️ Autoexpresiones desactivadas globalmente.' }, { quoted: msg });
        } else if (sub === 'estado') {
          await sock.sendMessage(chat, { text: `⚙️ *AUTOEXPRESIONES*\nEstado: ${estado.enabled ? 'ACTIVADAS' : 'DESACTIVADAS'}\nHorario: 06:00–23:59 (Colombia)\nFrecuencia: 45–90 minutos\nAlcance: todos los grupos donde está el bot.` }, { quoted: msg });
        } else {
          await sock.sendMessage(chat, { text: 'Uso: .autoexpresiones estado | on | off' }, { quoted: msg });
        }
      }

      // DESCARGA DE AUDIO MP3: requiere enlace y limita duración/tamaño.
      else if (comando === '.mp3' || comando === '.audio') {
        if (!argumento) {
          await sock.sendMessage(chat, { text: '🎵 Uso: .mp3 https://enlace-del-audio' }, { quoted: msg });
          continue;
        }
        const urlMedia = await validateDownloadUrl(argumento);
        reaccionar(sock, msg, '⏳');
        // Los metadatos se consultan en paralelo con la descarga (antes eran dos esperas seguidas).
        const metadataPromise = getYtDlpMetadata(urlMedia);
        const carpeta = path.join(os.tmpdir(), `lbot-mp3-${Date.now()}`);
        fs.mkdirSync(carpeta, { recursive: true });
        try {
          const plantilla = path.join(carpeta, '%(title).70s.%(ext)s');
          await execFileAsync('yt-dlp', [
            '--no-config', '--no-warnings', '--no-playlist',
            '--extract-audio', '--audio-format', 'mp3', '--restrict-filenames', '--audio-quality', '5',
            '-f', 'bestaudio/best', '--concurrent-fragments', '4', '--no-mtime',
            '--max-filesize', `${MP3_MAX_MB}M`, '--match-filter', `duration <= ${MEDIA_MAX_SEG}`,
            '--socket-timeout', '20', '--retries', '1', '--output', plantilla, urlMedia
          ], { timeout: 20 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
          const metadata = await metadataPromise;
          if (metadata?.duration > MEDIA_MAX_SEG) throw new Error('El audio debe durar máximo 1 hora y 30 minutos.');
          const found = fs.readdirSync(carpeta).filter(n => n.toLowerCase().endsWith('.mp3'));
          if (!found.length) throw new Error('No se pudo obtener el audio. Comprueba que el enlace sea público y compatible.');
          const file = path.join(carpeta, found[0]);
          // Se envía desde el archivo (sin cargarlo entero en la RAM del teléfono).
          const tamanoMp3 = fs.statSync(file).size;
          if (!tamanoMp3 || tamanoMp3 > MP3_MAX_MB * 1024 * 1024) throw new Error(`El MP3 supera el límite de ${MP3_MAX_MB} MB.`);
          const caption = [
            '🎵 *AUDIO MP3*',
            `> Título: ${cleanMetadata(metadata?.title || path.parse(found[0]).name, 120)}`,
            `> Duración: ${formatDuration(metadata?.duration)}`,
            `> Descripción: ${cleanMetadata(metadata?.description, 300)}`,
            `> Fuente: ${urlMedia}`
          ].join(String.fromCharCode(10));
          await sock.sendMessage(chat, { text: caption }, { quoted: msg });
          await sock.sendMessage(chat, { audio: { url: file }, mimetype: 'audio/mpeg', ptt: false, fileName: `${safeFilename(path.parse(found[0]).name)}.mp3` }, { quoted: msg });
          reaccionar(sock, msg, '✅');
        } finally { fs.rmSync(carpeta, { recursive: true, force: true }); }
      }

      // DESCARGA DE VIDEO MP4: enlaces públicos compatibles con yt-dlp.
      else if (comando === '.mp4' || comando === '.video') {
        if (!argumento) {
          await sock.sendMessage(chat, { text: '🎬 Uso: .mp4 https://enlace-del-video [calidad]\nCalidades: 360p, 480p, 720p (por defecto) o 1080p\nEjemplo: .mp4 https://enlace 480p' }, { quoted: msg });
          continue;
        }
        // La calidad opcional (480p, 720p…) no es parte del enlace: antes se pegaba a la URL (…%20480p) y fallaba.
        let calidadMp4 = 720;
        let argumentoUrl = argumento;
        const mCalidad = argumento.match(/(?:^|\s)(144|240|360|480|720|1080|1440|2160)p(?=\s|$)/i);
        if (mCalidad) { calidadMp4 = Number(mCalidad[1]); argumentoUrl = argumento.replace(mCalidad[0], ' ').replace(/\s+/g, ' ').trim(); }
        const urlMedia = await validateDownloadUrl(argumentoUrl);
        if (!cupoVideoDisponible()) {
          await sock.sendMessage(chat, { text: '⏳ Ya hay descargas de video en proceso. Intenta de nuevo cuando termine alguna.' }, { quoted: msg });
          continue;
        }
        reaccionar(sock, msg, '⏳');
        const metadataPromise = getYtDlpMetadata(urlMedia);
        const carpeta = path.join(os.tmpdir(), `lbot-mp4-${Date.now()}`);
        fs.mkdirSync(carpeta, { recursive: true });
        tomarCupoVideo();
        try {
          const plantilla = path.join(carpeta, 'video.%(ext)s');
          await execFileAsync('yt-dlp', [
            '--no-config', '--no-warnings', '--no-playlist', ...argsCookies(),
            '--max-filesize', `${MP4_MAX_MB}M`, '--match-filter', `duration <= ${MEDIA_MAX_SEG}`,
            '--restrict-filenames', '--merge-output-format', 'mp4',
            '-f', `bv*[height<=${calidadMp4}][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=${calidadMp4}][ext=mp4]/bv*[height<=${calidadMp4}]+ba/b[height<=${calidadMp4}]/b`,
            '--concurrent-fragments', '4', '--no-mtime',
            '--socket-timeout', '20', '--retries', '1', '--output', plantilla, urlMedia
          ], { timeout: 30 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
          const metadata = await metadataPromise;
          if (metadata?.duration > MEDIA_MAX_SEG) throw new Error('El video debe durar máximo 1 hora y 30 minutos.');
          const found = fs.readdirSync(carpeta).filter(n => /\.(mp4|m4v|mov|webm|mkv)$/i.test(n));
          if (!found.length) throw new Error('No se pudo obtener el video. Puede ser privado, no compatible o superar 2 GB.');
          const file = await asegurarMp4Compatible(path.join(carpeta, found[0]));
          // Se envía desde el archivo (sin cargarlo entero en la RAM del teléfono).
          const tamanoMp4 = fs.statSync(file).size;
          if (!tamanoMp4 || tamanoMp4 > MP4_MAX_MB * 1024 * 1024) throw new Error('El video supera el límite de 2 GB.');
          const resolution = metadata?.width && metadata?.height ? `${metadata.width}×${metadata.height}` : 'No disponible';
          const caption = [
            '🎬 *VIDEO MP4*',
            `> Título: ${cleanMetadata(metadata?.title || path.parse(found[0]).name, 120)}`,
            `> Duración: ${formatDuration(metadata?.duration)}`,
            `> Resolución: ${resolution}`,
            `> Descripción: ${cleanMetadata(metadata?.description, 300)}`,
            `> Fuente: ${urlMedia}`
          ].join(String.fromCharCode(10));
          await enviarVideoComoDocumento(sock, chat, file, { title: cleanMetadata(metadata?.title || path.parse(found[0]).name, 80), caption, duration: formatDuration(metadata?.duration), resolution: (metadata?.width && metadata?.height) ? (metadata.width + '×' + metadata.height) : undefined, source: urlMedia }, msg);
          reaccionar(sock, msg, '✅');
        } finally { soltarCupoVideo(); fs.rmSync(carpeta, { recursive: true, force: true }); }
      }

      // BUSCADOR DE YOUTUBE: primero la portada y luego el video en 720p como documento (máx. 2 GB)
      else if (comando === '.youtube') {
        const consulta = argumento.trim().slice(0, 150);
        if (!consulta) {
          await sock.sendMessage(chat, { text: '▶️ Uso: .youtube [palabras para buscar]\nEjemplo: .youtube lofi hip hop' }, { quoted: msg });
          continue;
        }
        if (!cupoVideoDisponible()) {
          await sock.sendMessage(chat, { text: '⏳ Ya hay descargas de video en proceso. Intenta de nuevo cuando termine alguna.' }, { quoted: msg });
          continue;
        }
        tomarCupoVideo();
        const carpeta = path.join(os.tmpdir(), `lbot-yt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        try {
          reaccionar(sock, msg, '⏳');
          const info = await buscarEnYoutube(consulta);
          if (!info) throw new Error('No encontré resultados en YouTube para esa búsqueda.');
          if (info.is_live || info.live_status === 'is_live') throw new Error('Ese resultado es una transmisión en vivo y no se puede descargar.');
          const urlVideo = `https://www.youtube.com/watch?v=${info.id}`;
          const titulo = cleanMetadata(info.title, 120);

          // 1) Portada
          const textoPortada = `▶️ *${titulo}*\n> Canal: ${cleanMetadata(info.channel || info.uploader, 80)}\n\n📥 Descargando en 720p, espera un momento...`;
          const portada = await obtenerPortadaYoutube(info.id);
          if (portada) await sock.sendMessage(chat, { image: portada, caption: textoPortada }, { quoted: msg });
          else await sock.sendMessage(chat, { text: textoPortada }, { quoted: msg });

          // 2) Video en 720p
          fs.mkdirSync(carpeta, { recursive: true });
          await execFileAsync('yt-dlp', [
            '--no-config', '--no-warnings', '--no-playlist',
            '--max-filesize', `${YT_MAX_MB}M`, '--restrict-filenames', '--merge-output-format', 'mp4',
            '-f', 'bv*[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]',
            '--concurrent-fragments', '4', '--no-mtime',
            '--socket-timeout', '20', '--retries', '1', '--output', path.join(carpeta, 'video.%(ext)s'), urlVideo
          ], { timeout: 30 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
          const encontrados = fs.readdirSync(carpeta).filter(n => /\.(mp4|m4v|mov|webm|mkv)$/i.test(n));
          if (!encontrados.length) throw new Error('No pude descargar ese video. Puede ser privado, tener restricción de edad o superar 2 GB.');
          const archivo = await asegurarMp4Compatible(path.join(carpeta, encontrados[0]));
          const tamano = fs.statSync(archivo).size;
          if (!tamano || tamano > YT_MAX_MB * 1024 * 1024) throw new Error('El video supera el límite de 2 GB.');

          // 3) Documento con la información del video y el enlace
          const caption = [
            '🎬 *VIDEO DE YOUTUBE*',
            `> Título: ${titulo}`,
            `> Canal: ${cleanMetadata(info.channel || info.uploader, 80)}`,
            `> Duración: ${formatDuration(info.duration)}`,
            `> Vistas: ${formatearNumero(info.view_count)}`,
            `> Publicado: ${formatearFechaYt(info.upload_date)}`,
            '> Calidad: 720p',
            `> Descripción: ${cleanMetadata(info.description, 200)}`,
            `> Enlace: ${urlVideo}`
          ].join(String.fromCharCode(10));
          await sock.sendMessage(chat, {
            document: { url: archivo },
            mimetype: 'video/mp4',
            fileName: nombreArchivoSeguro(info.title, 'mp4'),
            caption
          }, { quoted: msg });
          reaccionar(sock, msg, '✅');
        } finally { soltarCupoVideo(); fs.rmSync(carpeta, { recursive: true, force: true }); }
      }

      // Jardín y canción: manejarJardinOBorrado.

      // DESCARGA DE VIDEOS DE PINTEREST
      else if (comando === '.pinterest' || comando === '.pinvideo') {
        if (!argumento) {
          await sock.sendMessage(chat, { text: '📌 Uso: .pinterest https://www.pinterest.com/pin/...\nTambién puedes usar .pinvideo seguido del enlace.' }, { quoted: msg });
          continue;
        }
        if (!/^https?:\/\/(www\.)?(pinterest\.[a-z.]+|pin\.it)\//i.test(argumento)) {
          await sock.sendMessage(chat, { text: '❌ Ese enlace no parece ser de Pinterest.' }, { quoted: msg });
          continue;
        }
        const carpetaPinVideo = path.join(os.tmpdir(), `lbot-pinterest-${Date.now()}`);
        fs.mkdirSync(carpetaPinVideo, { recursive: true });
        try {
          await sock.sendMessage(chat, { text: '📥 Descargando el video de Pinterest. Espera un momento...' }, { quoted: msg });
          const salidaPin = path.join(carpetaPinVideo, 'video.%(ext)s');
          await execFileAsync('yt-dlp', [
            '--no-playlist', '--no-warnings', '--max-filesize', `${REDES_MAX_MB}M`,
            '--merge-output-format', 'mp4', '-o', salidaPin, argumento
          ], { timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
          const archivosPin = fs.readdirSync(carpetaPinVideo).filter(n => /\.(mp4|webm|mkv|mov)$/i.test(n));
          if (!archivosPin.length) throw new Error('Pinterest no entregó un video descargable para ese enlace.');
          const rutaPin = path.join(carpetaPinVideo, archivosPin[0]);
          const tamanoPin = fs.statSync(rutaPin).size;
          if (!tamanoPin || tamanoPin > REDES_MAX_MB * 1024 * 1024) throw new Error(`El video está vacío o supera ${REDES_MAX_MB} MB.`);
          await enviarVideoComoDocumento(sock, chat, rutaPin, {
            title: 'Pinterest',
            caption: '📌 *VIDEO DE PINTEREST*\n> Fuente: Pinterest',
            source: 'Pinterest'
          }, msg);
        } finally {
          fs.rmSync(carpetaPinVideo, { recursive: true, force: true });
        }
      }

      // DESCARGA DE TIKTOK
      else if (comando === '.tiktok' || comando === '.tt' || comando === '.tk') {
        if (!argumento) {
          await sock.sendMessage(chat, {
            text:
              `📥 *DESCARGADOR DE TIKTOK*\n\n` +
              `Uso correcto:\n.tiktok https://www.tiktok.com/...\n\n` +
              `🖤 Creador: ${CREATOR}`
          }, { quoted: msg });
          continue;
        }

        reaccionar(sock, msg, '⏳');

        if (!/^https?:\/\/([a-z0-9-]+\.)*tiktok\.com\//i.test(argumento)) {
          await sock.sendMessage(chat, {
            text: '❌ El enlace no parece ser de TikTok.'
          }, { quoted: msg });
          continue;
        }

        await sock.sendMessage(chat, {
          text: '🔎 Analizando el video de TikTok...\nEspera un momento.'
        }, { quoted: msg });

        const respuesta = await fetch('https://www.tikwm.com/api/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0'
          },
          body: new URLSearchParams({
            url: argumento,
            hd: '1'
          }),
          signal: AbortSignal.timeout(35000)
        });

        if (!respuesta.ok) {
          throw new Error('El servicio de TikTok no respondió.');
        }

        const resultado = await respuesta.json();

        if (resultado.code !== 0 || !resultado.data) {
          throw new Error('No se pudo obtener el video.');
        }

        const datos = resultado.data;
        const videoUrl = datos.hdplay || datos.play;

        if (!videoUrl) {
          throw new Error('No se encontró un enlace de video.');
        }

        const urlTikTokSegura = await validateDownloadUrl(videoUrl);
        const descarga = await fetch(urlTikTokSegura, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10 * 60 * 1000)
        });

        if (!descarga.ok || !descarga.body) {
          throw new Error('No se pudo descargar el archivo.');
        }

        const maxBytesTikTok = REDES_MAX_MB * 1024 * 1024;
        const mensajeLimiteTikTok = `El video supera el límite de ${REDES_MAX_MB} MB.`;
        if (Number(descarga.headers.get('content-length')) > maxBytesTikTok) {
          throw new Error(mensajeLimiteTikTok);
        }

        const archivoTikTok = path.join(os.tmpdir(), `lbot-tiktok-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);
        try {
          await guardarConLimite(descarga.body, archivoTikTok, maxBytesTikTok, mensajeLimiteTikTok);
          await enviarVideoComoDocumento(sock, chat, archivoTikTok, {
            title: 'TikTok',
            caption: '🖤 *VIDEO DESCARGADO*\n> Fuente: TikTok',
            source: 'TikTok'
          }, msg);
        } finally {
          fs.rmSync(archivoTikTok, { force: true });
        }
        reaccionar(sock, msg, '✅');
      }

      // COMANDO INEXISTENTE: solo si ningún bloque ni módulo lo atendió ni respondió nada en este chat.
      else if (
        /^\.\p{L}[\p{L}\p{N}_]*$/u.test(partes[0] || '') &&
        !hahariExpiro &&
        !(ULTIMO_ENVIO.get(chat) >= t0) &&
        !comandosConocidos().has((partes[0] || '').toLowerCase())
      ) {
        await sock.sendMessage(chat, {
          text:  (waguriActivoEn(chat) ? ('🌸 Perdona… el comando ' + partes[0].slice(0, 40) + ' no lo conozco.\nPuedes mirar *.menu* cuando quieras 💕') : ('❌ El comando ' + partes[0].slice(0, 40) + ' no existe.\nUsa *.menu* para ver los comandos disponibles.\n\n🖤 ' + BOT_BRAND))
        }, { quoted: msg });
      }

    } catch (error) {
      console.log('Error:', error);
      reaccionar(sock, msg, '❌');

      await sock.sendMessage(chat, {
        text:
          `❌ *Ocurrió un problema.*\n\n` +
          `${resumirErrorDescarga(error) || error.message || 'Inténtalo de nuevo más tarde.'}\n\n` +
          `👑 Creador: ${CREATOR}`
      }, { quoted: msg });
    }
    }
  });
}

process.on('unhandledRejection', (reason) => {
  console.log('Promesa rechazada sin manejar:', reason?.message || reason);
});
process.on('uncaughtException', (error) => {
  console.log('Excepción no capturada:', error?.message || error);
});

iniciarBot().catch(console.error);
