// AirTag Arena - servidor (Node puro, sem dependências). Estado em memória.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const START_COINS = 1000;
const COUNTDOWN_S = 20;

// range em metros, tol = tolerância angular em graus, cd = recarga em ms
const WEAPONS = {
  pistola: { name: 'Pistola', price: 200, range: 30, tol: 12, cd: 1500 },
  ak47: { name: 'AK-47', price: 500, range: 60, tol: 8, cd: 800 },
  sniper: { name: 'Sniper', price: 800, range: 150, tol: 3, cd: 3000 },
};

const users = new Map(); // nome minúsculo -> usuário
const tokens = new Map(); // token -> usuário
const matches = new Map();
let nextMatch = 1;

const key = (n) => String(n || '').trim().toLowerCase();
const now = () => Date.now();

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };

// ---------- geometria ----------
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
function distance(a, b) {
  const R = 6371000;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// ---------- helpers ----------
function auth(req) {
  const u = tokens.get(req.headers['x-token']);
  if (!u) fail(401, 'Sessão inválida. Faça login de novo.');
  u.lastSeen = now();
  return u;
}
function getUser(name) {
  const u = users.get(key(name));
  if (!u) fail(404, 'Jogador não encontrado.');
  return u;
}
function myMatch(u) {
  return u.matchId ? matches.get(u.matchId) : null;
}
function refreshMatch(m) {
  if (m.status === 'countdown' && now() >= m.goAt) {
    m.status = 'playing';
    m.log.push({ t: now(), text: 'VALENDO! Boa sorte.' });
  }
  if (m.status === 'playing') checkEnd(m);
}
function checkEnd(m) {
  const alive = Object.entries(m.players).filter(([, p]) => p.alive);
  if (alive.length <= 1) {
    m.status = 'ended';
    m.winner = alive[0] ? alive[0][0] : null;
    m.log.push({ t: now(), text: m.winner ? `${m.winner} venceu a partida!` : 'Fim de jogo, sem vencedor.' });
  }
}
function leaveMatch(u) {
  const m = myMatch(u);
  u.matchId = null;
  if (!m) return;
  const p = m.players[u.name];
  if (p) {
    if (m.status === 'lobby') {
      delete m.players[u.name];
      if (m.host === u.name) {
        const rest = Object.keys(m.players);
        if (rest.length) m.host = rest[0];
      }
    } else if (p.alive) {
      p.alive = false;
      m.log.push({ t: now(), text: `${u.name} saiu da partida.` });
      if (m.status === 'playing') checkEnd(m);
    }
  }
  const stillIn = Object.keys(m.players).some((n) => users.get(key(n))?.matchId === m.id);
  if (!stillIn) matches.delete(m.id);
}

// ---------- ações ----------
const routes = {};

routes['POST /api/login'] = (req, body) => {
  const name = String(body.name || '').trim();
  if (name.length < 2 || name.length > 16) fail(400, 'O nome precisa ter de 2 a 16 caracteres.');
  if (!/^[\p{L}\p{N}_.\- ]+$/u.test(name)) fail(400, 'Use apenas letras, números, espaço, _ . -');
  const existing = users.get(key(name));
  if (existing) {
    if (body.token && body.token === existing.token) return { token: existing.token, name: existing.name };
    fail(409, 'Esse nome já está em uso. Escolha outro.');
  }
  const u = {
    name, token: crypto.randomBytes(16).toString('hex'), coins: START_COINS, owned: {},
    friends: new Set(), incoming: new Set(), invites: new Set(), matchId: null, pos: null, lastSeen: now(),
  };
  users.set(key(name), u);
  tokens.set(u.token, u);
  return { token: u.token, name: u.name };
};

routes['POST /api/logout'] = (req) => {
  const u = auth(req);
  leaveMatch(u);
  for (const f of u.friends) users.get(key(f))?.friends.delete(u.name);
  users.delete(key(u.name));
  tokens.delete(u.token);
  return { ok: true };
};

routes['POST /api/buy'] = (req, body) => {
  const u = auth(req);
  const w = WEAPONS[body.weapon];
  if (!w) fail(400, 'Arma inválida.');
  if (u.owned[body.weapon]) fail(400, 'Você já tem essa arma.');
  if (u.coins < w.price) fail(400, 'Moedas insuficientes.');
  u.coins -= w.price;
  u.owned[body.weapon] = true;
  return { ok: true };
};

routes['POST /api/friends/request'] = (req, body) => {
  const u = auth(req);
  const t = getUser(body.name);
  if (t === u) fail(400, 'Você não pode adicionar a si mesmo.');
  if (u.friends.has(t.name)) fail(400, 'Vocês já são amigos.');
  if (u.incoming.has(t.name)) { // ele já tinha pedido: aceita direto
    u.incoming.delete(t.name); u.friends.add(t.name); t.friends.add(u.name);
    return { ok: true, accepted: true };
  }
  t.incoming.add(u.name);
  return { ok: true };
};
routes['POST /api/friends/accept'] = (req, body) => {
  const u = auth(req);
  if (!u.incoming.has(body.name)) fail(400, 'Pedido não encontrado.');
  const t = getUser(body.name);
  u.incoming.delete(t.name); u.friends.add(t.name); t.friends.add(u.name);
  return { ok: true };
};
routes['POST /api/friends/decline'] = (req, body) => {
  const u = auth(req);
  u.incoming.delete(body.name);
  return { ok: true };
};

routes['POST /api/match/create'] = (req, body) => {
  const u = auth(req);
  if (u.matchId) fail(400, 'Você já está em uma sala.');
  const list = Array.isArray(body.invite) ? body.invite : [];
  if (!list.length) fail(400, 'Escolha pelo menos um amigo.');
  const m = { id: nextMatch++, host: u.name, status: 'lobby', players: {}, log: [], winner: null, goAt: 0 };
  m.players[u.name] = { weapon: null, alive: true, kills: 0, lastShot: 0 };
  for (const n of list) {
    if (!u.friends.has(n)) fail(400, `${n} não é seu amigo.`);
    getUser(n).invites.add(m.id);
  }
  matches.set(m.id, m);
  u.matchId = m.id;
  return { ok: true };
};
routes['POST /api/match/accept'] = (req, body) => {
  const u = auth(req);
  const m = matches.get(body.id);
  if (!u.invites.has(body.id) || !m || m.status !== 'lobby') { u.invites.delete(body.id); fail(400, 'Convite expirado.'); }
  if (u.matchId) fail(400, 'Você já está em uma sala.');
  u.invites.delete(m.id);
  m.players[u.name] = { weapon: null, alive: true, kills: 0, lastShot: 0 };
  u.matchId = m.id;
  return { ok: true };
};
routes['POST /api/match/decline'] = (req, body) => {
  auth(req).invites.delete(body.id);
  return { ok: true };
};
routes['POST /api/match/weapon'] = (req, body) => {
  const u = auth(req);
  const m = myMatch(u);
  if (!m || m.status !== 'lobby') fail(400, 'Você não está em uma sala aberta.');
  if (!u.owned[body.weapon]) fail(400, 'Compre essa arma primeiro.');
  m.players[u.name].weapon = body.weapon;
  return { ok: true };
};
routes['POST /api/match/start'] = (req) => {
  const u = auth(req);
  const m = myMatch(u);
  if (!m || m.host !== u.name) fail(403, 'Só o dono da sala pode começar.');
  if (m.status !== 'lobby') fail(400, 'A partida já começou.');
  const names = Object.keys(m.players);
  if (names.length < 2) fail(400, 'Precisa de pelo menos 2 jogadores na sala.');
  const without = names.filter((n) => !m.players[n].weapon);
  if (without.length) fail(400, `Falta escolher arma: ${without.join(', ')}`);
  m.status = 'countdown';
  m.goAt = now() + COUNTDOWN_S * 1000;
  for (const n of names) users.get(key(n)).invites.clear();
  for (const x of users.values()) x.invites.delete(m.id);
  m.log.push({ t: now(), text: 'Contagem regressiva! Corram!' });
  return { ok: true };
};
routes['POST /api/match/leave'] = (req) => {
  leaveMatch(auth(req));
  return { ok: true };
};

routes['POST /api/shoot'] = (req, body) => {
  const u = auth(req);
  const m = myMatch(u);
  if (!m) fail(400, 'Você não está em partida.');
  refreshMatch(m);
  if (m.status !== 'playing') fail(400, 'A partida não está valendo.');
  const me = m.players[u.name];
  if (!me.alive) fail(400, 'Você está morto.');
  const w = WEAPONS[me.weapon];
  if (now() - me.lastShot < w.cd) return { hit: null, cooldown: true };
  me.lastShot = now();
  const lat = Number(body.lat), lng = Number(body.lng), heading = Number(body.heading);
  if (![lat, lng, heading].every(Number.isFinite)) fail(400, 'Sem GPS ou bússola.');
  u.pos = { lat, lng, t: now(), acc: Number(body.acc) || 10 };
  let best = null;
  for (const [name, p] of Object.entries(m.players)) {
    if (name === u.name || !p.alive) continue;
    const t = users.get(key(name));
    if (!t?.pos || now() - t.pos.t > 20000) continue;
    const d = distance(u.pos, t.pos);
    if (d > w.range) continue;
    const slack = deg(Math.atan2(Math.min(15, Math.max(u.pos.acc, t.pos.acc, 5)), Math.max(d, 1)));
    const diff = angleDiff(bearing(u.pos, t.pos), heading);
    if (diff <= w.tol + slack && (!best || d < best.d)) best = { name, d };
  }
  if (best) {
    m.players[best.name].alive = false;
    me.kills++;
    m.log.push({ t: now(), text: `${u.name} eliminou ${best.name} (${Math.round(best.d)} m)` });
    checkEnd(m);
    return { hit: best.name, distance: Math.round(best.d) };
  }
  return { hit: null };
};

routes['POST /api/state'] = (req, body) => {
  const u = auth(req);
  if (Number.isFinite(Number(body.lat)) && Number.isFinite(Number(body.lng)) && body.lat !== null) {
    u.pos = { lat: Number(body.lat), lng: Number(body.lng), t: now(), acc: Number(body.acc) || 10 };
  }
  const m = myMatch(u);
  if (m) refreshMatch(m);
  const out = {
    me: { name: u.name, coins: u.coins, owned: Object.keys(u.owned) },
    weapons: WEAPONS,
    friends: [...u.friends].sort(),
    requests: [...u.incoming],
    invites: [...u.invites].map((id) => matches.get(id)).filter((x) => x && x.status === 'lobby')
      .map((x) => ({ id: x.id, host: x.host })),
    match: null,
  };
  if (m) {
    const mine = m.players[u.name];
    const showMap = m.status === 'ended' || (m.status === 'playing' && !mine.alive);
    out.match = {
      id: m.id, host: m.host, status: m.status, winner: m.winner, alive: mine.alive, weapon: mine.weapon,
      countdown: m.status === 'countdown' ? Math.max(0, Math.ceil((m.goAt - now()) / 1000)) : 0,
      players: Object.entries(m.players).map(([name, p]) => {
        const pu = users.get(key(name));
        return {
          name, weapon: p.weapon, alive: p.alive, kills: p.kills,
          pos: showMap && pu?.pos ? { lat: pu.pos.lat, lng: pu.pos.lng } : undefined,
        };
      }),
      log: m.log.slice(-8),
    };
    // quem ainda está vivo não vê o armamento dos outros durante o jogo
    if (m.status === 'playing' && mine.alive) out.match.players.forEach((p) => { if (p.name !== u.name) p.weapon = undefined; });
  }
  return out;
};

// limpeza de jogadores inativos
setInterval(() => {
  for (const u of [...users.values()]) {
    if (now() - u.lastSeen > 10 * 60 * 1000) {
      leaveMatch(u);
      users.delete(key(u.name));
      tokens.delete(u.token);
    }
  }
}, 60 * 1000).unref();

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const handler = routes[`${req.method} ${url}`];
  if (handler) {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        const out = handler(req, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) {
        const status = e instanceof HttpError ? e.status : e instanceof SyntaxError ? 400 : 500;
        if (status === 500) console.error(e);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: status === 500 ? 'Erro interno.' : e.message }));
      }
    });
    return;
  }
  const file = path.join(__dirname, 'public', url === '/' ? 'index.html' : url);
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Não encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`AirTag Arena rodando em http://localhost:${PORT}`));
}
module.exports = { server, distance, bearing, angleDiff };
