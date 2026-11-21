// AirTag Arena - servidor (Node puro, sem dependências). Estado em memória.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const START_COINS = 1000;
const COUNTDOWN_S = Number(process.env.COUNTDOWN_S) || 20;
const SPAWN_RADIUS = 20;                                   // metros
const REVIVE_MS = Number(process.env.REVIVE_MS) || 3000;   // tempo parado no spawn para voltar ao jogo
const RADIO_MAX = 400000;                                  // tamanho máximo de um áudio (texto base64)

// range em metros, tol = tolerância angular em graus, cd = recarga em ms
const WEAPONS = {
  pistola: { name: 'Pistola', price: 200, range: 30, tol: 12, cd: 1500 },
  ak47: { name: 'AK-47', price: 500, range: 60, tol: 8, cd: 800 },
  sniper: { name: 'Sniper', price: 800, range: 150, tol: 3, cd: 3000 },
};
const MODES = {
  ffa: { name: 'Todos contra todos', teams: false, min: 2 },
  ffaspawn: { name: 'Todos contra todos com ponto', teams: false, min: 2 },
  team: { name: 'Equipe', teams: true, min: 4 },
  spawn: { name: 'Ponto de equipe', teams: true, min: 4 },
};
const TEAM_NAMES = { 1: 'Azul', 2: 'Vermelho' };

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

// ---------- contas (nome + senha) ----------
// As contas (moedas, armas, amigos) ficam num arquivo. No plano grátis do Render o disco é apagado
// quando o servidor reinicia; para guardar de verdade seria preciso um disco/banco de dados.
const DATA_FILE = process.env.DATA_FILE === undefined ? path.join(__dirname, 'accounts.json') : process.env.DATA_FILE;
function makeUser(a) {
  return {
    name: a.name, salt: a.salt, hash: a.hash, coins: a.coins ?? START_COINS,
    owned: Object.fromEntries((a.owned || []).map((w) => [w, true])),
    friends: new Set(a.friends || []), incoming: new Set(a.incoming || []), invites: new Set(),
    token: null, matchId: null, pos: null, lastSeen: now(),
  };
}
let saveTimer = null;
function save() {
  if (!DATA_FILE || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const data = [...users.values()].map((u) => ({
      name: u.name, salt: u.salt, hash: u.hash, coins: u.coins,
      owned: Object.keys(u.owned), friends: [...u.friends], incoming: [...u.incoming],
    }));
    fs.writeFile(DATA_FILE, JSON.stringify(data), () => {});
  }, 1000);
  saveTimer.unref();
}
function load() {
  if (!DATA_FILE) return;
  try { for (const a of JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))) users.set(key(a.name), makeUser(a)); } catch { /* sem arquivo ainda */ }
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
function startSession(u) {
  if (u.token) tokens.delete(u.token);
  u.token = crypto.randomBytes(16).toString('hex');
  tokens.set(u.token, u);
  u.lastSeen = now();
  return { token: u.token, name: u.name };
}

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
const newPlayer = () => ({ weapon: null, alive: true, kills: 0, deaths: 0, shots: 0, hits: 0, maxDist: 0, revives: 0, lastShot: 0, team: 0, spawnSince: null, left: false });
const isTeamMode = (m) => MODES[m.mode].teams;
// modos com ponto de spawn: 'spawn' (um por time) e 'ffaspawn' (um só, para todos)
const usesSpawn = (m) => m.mode === 'spawn' || m.mode === 'ffaspawn';
const spawnOf = (m, p) => (m.mode === 'ffaspawn' ? m.spawns[1] : m.spawns[p.team]);
const tag = (m, name) => (isTeamMode(m) && m.players[name]?.team ? `[${TEAM_NAMES[m.players[name].team]}] ${name}` : name);

function freshPos(name) {
  const t = users.get(key(name));
  return t?.pos && now() - t.pos.t < 20000 ? t.pos : null;
}
// Está dentro do spawn do próprio time? (só no modo Ponto de equipe)
function inSpawn(m, name) {
  if (!usesSpawn(m)) return false;
  const p = m.players[name];
  const sp = p && spawnOf(m, p);
  const pos = freshPos(name);
  return !!(sp && pos && distance(pos, sp) <= SPAWN_RADIUS);
}
// Quem morreu volta ao jogo depois de ficar REVIVE_MS dentro do spawn do seu time
function tickMatch(m) {
  if (!usesSpawn(m)) return;
  for (const [name, p] of Object.entries(m.players)) {
    if (p.left || p.alive) { p.spawnSince = null; continue; }
    if (inSpawn(m, name)) {
      if (!p.spawnSince) p.spawnSince = now();
      else if (now() - p.spawnSince >= REVIVE_MS) {
        p.alive = true; p.spawnSince = null; p.revives++;
        m.log.push({ t: now(), text: `${tag(m, name)} voltou ao jogo!` });
      }
    } else p.spawnSince = null;
  }
}
function refreshMatch(m) {
  if (m.status === 'countdown' && now() >= m.goAt) {
    m.status = 'playing';
    m.log.push({ t: now(), text: 'VALENDO! Boa sorte.' });
  }
  if (m.status === 'playing') { tickMatch(m); checkEnd(m); }
}
function finish(m, winnerTeam, winner, text) {
  m.status = 'ended';
  m.winnerTeam = winnerTeam || 0;
  m.winner = winner || null;
  m.log.push({ t: now(), text });
}
function checkEnd(m) {
  if (m.status !== 'playing') return;
  const act = Object.entries(m.players).filter(([, p]) => !p.left);
  if (m.mode === 'ffa') {
    const alive = act.filter(([, p]) => p.alive);
    if (alive.length <= 1) finish(m, 0, alive[0]?.[0], alive[0] ? `${alive[0][0]} venceu a partida!` : 'Fim de jogo, sem vencedor.');
    return;
  }
  if (m.mode === 'ffaspawn') {
    const top = act.find(([, p]) => p.kills >= m.goal);
    if (top) finish(m, 0, top[0], `${top[0]} venceu com ${top[1].kills} abates!`);
    else if (act.length <= 1) finish(m, 0, act[0]?.[0], act[0] ? `${act[0][0]} venceu, os outros saíram.` : 'Fim de jogo.');
    return;
  }
  const members = (t) => act.filter(([, p]) => p.team === t).length;
  const aliveT = (t) => act.filter(([, p]) => p.team === t && p.alive).length;
  const win = (t) => finish(m, t, null, `Time ${TEAM_NAMES[t]} venceu!`);
  if (members(1) === 0 && members(2) === 0) return finish(m, 0, null, 'Fim de jogo.');
  if (members(1) === 0) return win(2);
  if (members(2) === 0) return win(1);
  if (m.mode === 'team') {
    if (aliveT(1) === 0 && aliveT(2) === 0) finish(m, 0, null, 'Empate!');
    else if (aliveT(1) === 0) win(2);
    else if (aliveT(2) === 0) win(1);
  } else {
    for (const t of [1, 2]) {
      if (m.score[t] >= m.goal) return finish(m, t, null, `Time ${TEAM_NAMES[t]} venceu por ${m.score[t]} a ${m.score[3 - t]}!`);
    }
  }
}
function leaveMatch(u) {
  const m = myMatch(u);
  u.matchId = null;
  if (!m) return;
  const p = m.players[u.name];
  if (p) {
    if (m.status === 'lobby') delete m.players[u.name];
    else {
      p.left = true; p.alive = false; p.spawnSince = null;
      if (m.status !== 'ended') {
        m.log.push({ t: now(), text: `${tag(m, u.name)} saiu da partida.` });
        checkEnd(m);
      }
    }
    if (m.host === u.name) {
      const rest = Object.keys(m.players).filter((n) => !m.players[n].left);
      if (rest.length) m.host = rest[0];
    }
  }
  const stillIn = Object.keys(m.players).some((n) => users.get(key(n))?.matchId === m.id);
  if (!stillIn) matches.delete(m.id);
}
function hostMatch(req, status) {
  const u = auth(req);
  const m = myMatch(u);
  if (!m || m.host !== u.name) fail(403, 'Só o dono da sala pode fazer isso.');
  if (status && m.status !== status) fail(400, status === 'lobby' ? 'A partida já começou.' : 'A partida não está valendo.');
  return { u, m };
}

// ---------- ações ----------
const routes = {};

routes['POST /api/register'] = (req, body) => {
  const name = String(body.name || '').trim();
  if (name.length < 2 || name.length > 16) fail(400, 'O nome precisa ter de 2 a 16 caracteres.');
  if (!/^[\p{L}\p{N}_.\- ]+$/u.test(name)) fail(400, 'Use apenas letras, números, espaço, _ . -');
  const pw = body.password;
  if (typeof pw !== 'string' || pw.length < 4 || pw.length > 40) fail(400, 'A senha precisa ter de 4 a 40 caracteres.');
  if (users.has(key(name))) fail(409, 'Esse nome já existe. Escolha outro, ou toque em "Entrar com uma conta".');
  const salt = crypto.randomBytes(16).toString('hex');
  const u = makeUser({ name, salt, hash: hashPw(pw, salt) });
  users.set(key(name), u);
  return startSession(u);
};

routes['POST /api/login'] = (req, body) => {
  const u = users.get(key(body.name));
  const ok = u && typeof body.password === 'string' && body.password.length <= 40 &&
    crypto.timingSafeEqual(Buffer.from(hashPw(body.password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
  if (!ok) fail(403, 'Nome ou senha incorretos.');
  return startSession(u);
};

routes['POST /api/logout'] = (req) => {
  const u = auth(req);
  leaveMatch(u);
  tokens.delete(u.token);
  u.token = null;
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
  const m = {
    id: nextMatch++, host: u.name, status: 'lobby', mode: 'ffa', radio: true, goal: 10,
    spawns: { 1: null, 2: null }, score: { 1: 0, 2: 0 }, players: {}, log: [],
    winner: null, winnerTeam: 0, goAt: 0, radioMsgs: [], radioSeq: 0,
  };
  m.players[u.name] = newPlayer();
  for (const n of list) {
    if (!u.friends.has(n)) fail(400, `${n} não é seu amigo.`);
    getUser(n).invites.add(m.id);
  }
  matches.set(m.id, m);
  u.matchId = m.id;
  return { ok: true };
};
// o dono escolhe mais convidados depois que a sala já existe
routes['POST /api/match/invite'] = (req, body) => {
  const { u, m } = hostMatch(req, 'lobby');
  const list = Array.isArray(body.names) ? body.names : [];
  if (!list.length) fail(400, 'Escolha pelo menos um amigo.');
  for (const n of list) {
    if (!u.friends.has(n)) fail(400, `${n} não é seu amigo.`);
    if (m.players[n]) continue;
    getUser(n).invites.add(m.id);
  }
  return { ok: true };
};
routes['POST /api/match/accept'] = (req, body) => {
  const u = auth(req);
  const m = matches.get(body.id);
  if (!u.invites.has(body.id) || !m || m.status !== 'lobby') { u.invites.delete(body.id); fail(400, 'Convite expirado.'); }
  if (u.matchId) fail(400, 'Você já está em uma sala.');
  u.invites.delete(m.id);
  m.players[u.name] = newPlayer();
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

// --- opções da sala (só o dono) ---
routes['POST /api/match/mode'] = (req, body) => {
  const { m } = hostMatch(req, 'lobby');
  if (!MODES[body.mode]) fail(400, 'Modo inválido.');
  m.mode = body.mode;
  return { ok: true };
};
routes['POST /api/match/options'] = (req, body) => {
  const { m } = hostMatch(req, 'lobby');
  if (typeof body.radio === 'boolean') m.radio = body.radio;
  if (body.goal !== undefined) {
    const g = Math.round(Number(body.goal));
    if (!(g >= 1 && g <= 50)) fail(400, 'Meta inválida.');
    m.goal = g;
  }
  return { ok: true };
};
routes['POST /api/match/spawn'] = (req, body) => {
  const { m } = hostMatch(req, 'lobby');
  const team = Number(body.team), lat = Number(body.lat), lng = Number(body.lng);
  if (![1, 2].includes(team)) fail(400, 'Time inválido.');
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180) || !Number.isFinite(lat) || !Number.isFinite(lng)) fail(400, 'Local inválido.');
  m.spawns[team] = { lat, lng };
  return { ok: true };
};

routes['POST /api/match/start'] = (req) => {
  const { m } = hostMatch(req, 'lobby');
  const mode = MODES[m.mode];
  const names = Object.keys(m.players);
  if (names.length < mode.min) fail(400, `O modo ${mode.name} precisa de pelo menos ${mode.min} jogadores na sala.`);
  const without = names.filter((n) => !m.players[n].weapon);
  if (without.length) fail(400, `Falta escolher arma: ${without.join(', ')}`);
  if (m.mode === 'spawn' && (!m.spawns[1] || !m.spawns[2])) fail(400, 'Marque o spawn dos dois times no mapa antes de começar.');
  if (m.mode === 'ffaspawn' && !m.spawns[1]) fail(400, 'Marque o ponto de spawn no mapa antes de começar.');
  if (mode.teams) { // sorteia os times
    const sh = [...names];
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    const half = Math.ceil(sh.length / 2);
    sh.forEach((n, i) => { m.players[n].team = i < half ? 1 : 2; });
    m.log.push({ t: now(), text: 'Times sorteados! Veja o seu time na tela.' });
  }
  m.score = { 1: 0, 2: 0 };
  m.status = 'countdown';
  m.goAt = now() + COUNTDOWN_S * 1000;
  for (const x of users.values()) x.invites.delete(m.id);
  m.log.push({ t: now(), text: 'Contagem regressiva! Corram!' });
  return { ok: true };
};
routes['POST /api/match/end'] = (req) => {
  const { m } = hostMatch(req, 'playing');
  let wt = 0, wn = null;
  const act = Object.entries(m.players).filter(([, p]) => !p.left);
  if (m.mode === 'spawn') {
    if (m.score[1] !== m.score[2]) wt = m.score[1] > m.score[2] ? 1 : 2;
  } else if (m.mode === 'team') {
    const a = (t) => act.filter(([, p]) => p.team === t && p.alive).length;
    if (a(1) !== a(2)) wt = a(1) > a(2) ? 1 : 2;
  } else {
    const top = [...act].sort((x, y) => y[1].kills - x[1].kills);
    if (top[0] && top[0][1].kills > 0 && (!top[1] || top[1][1].kills < top[0][1].kills)) wn = top[0][0];
  }
  finish(m, wt, wn, `O dono encerrou a partida. ${wt ? `Time ${TEAM_NAMES[wt]} venceu!` : wn ? `${wn} venceu!` : 'Empate.'}`);
  return { ok: true };
};
routes['POST /api/match/leave'] = (req) => {
  leaveMatch(auth(req));
  return { ok: true };
};

// --- rádio (walkie-talkie): vivos falam com o próprio time, mortos falam entre si ---
routes['POST /api/radio/send'] = (req, body) => {
  const u = auth(req);
  const m = myMatch(u);
  if (!m || !['countdown', 'playing', 'ended'].includes(m.status)) fail(400, 'O rádio só funciona durante a partida.');
  if (!m.radio) fail(400, 'O rádio está desligado nesta sala.');
  const me = m.players[u.name];
  let channel;
  if (!me.alive) channel = 'dead';
  else if (isTeamMode(m) && me.team) channel = 'team' + me.team;
  else fail(400, 'Neste modo só quem morreu usa o rádio.');
  const audio = String(body.audio || '');
  if (!audio.startsWith('data:audio/') || audio.length > RADIO_MAX) fail(400, 'Áudio inválido ou muito grande.');
  m.radioMsgs.push({ id: ++m.radioSeq, from: u.name, channel, audio, t: now() });
  m.radioMsgs = m.radioMsgs.filter((x) => now() - x.t < 90000).slice(-30);
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
  const lat = Number(body.lat), lng = Number(body.lng), heading = Number(body.heading);
  if (![lat, lng, heading].every(Number.isFinite)) fail(400, 'Sem GPS ou bússola.');
  u.pos = { lat, lng, t: now(), acc: Number(body.acc) || 10 };
  if (inSpawn(m, u.name)) fail(400, 'Você está no spawn: saia dele para atirar.');
  me.lastShot = now();
  me.shots++;
  let best = null;
  for (const [name, p] of Object.entries(m.players)) {
    if (name === u.name || !p.alive || p.left) continue;
    if (isTeamMode(m) && p.team === me.team) continue;   // sem fogo amigo
    if (inSpawn(m, name)) continue;                      // protegido no spawn
    const t = users.get(key(name));
    if (!t?.pos || now() - t.pos.t > 20000) continue;
    const d = distance(u.pos, t.pos);
    if (d > w.range) continue;
    const slack = deg(Math.atan2(Math.min(15, Math.max(u.pos.acc, t.pos.acc, 5)), Math.max(d, 1)));
    const diff = angleDiff(bearing(u.pos, t.pos), heading);
    if (diff <= w.tol + slack && (!best || d < best.d)) best = { name, d };
  }
  if (best) {
    const target = m.players[best.name];
    target.alive = false;
    target.spawnSince = null;
    target.deaths++;
    me.kills++;
    me.hits++;
    me.maxDist = Math.max(me.maxDist, best.d);
    if (m.mode === 'spawn') m.score[me.team]++;
    m.log.push({ t: now(), text: `${tag(m, u.name)} eliminou ${tag(m, best.name)} (${Math.round(best.d)} m)` });
    checkEnd(m);
    return { hit: best.name, distance: Math.round(best.d) };
  }
  return { hit: null };
};

routes['POST /api/state'] = (req, body) => {
  const u = auth(req);
  if (body.lat !== null && body.lat !== undefined && Number.isFinite(Number(body.lat)) && Number.isFinite(Number(body.lng))) {
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
    radio: [], radioSeq: 0,
  };
  if (m) {
    const mine = m.players[u.name];
    const started = m.status !== 'lobby';
    const showMap = m.status === 'ended' || (m.status === 'playing' && !mine.alive);
    let spawns = {};
    if (m.mode === 'spawn') {
      if (!started || m.status === 'ended') spawns = { 1: m.spawns[1], 2: m.spawns[2] };
      else if (mine.team && m.spawns[mine.team]) spawns = { [mine.team]: m.spawns[mine.team] };
    } else if (m.mode === 'ffaspawn' && m.spawns[1]) spawns = { 1: m.spawns[1] }; // spawn único: todos veem
    out.match = {
      id: m.id, host: m.host, status: m.status, mode: m.mode, radio: m.radio, goal: m.goal, score: m.score,
      winner: m.winner, winnerTeam: m.winnerTeam, alive: mine.alive, weapon: mine.weapon,
      team: mine.team, spawns, radius: SPAWN_RADIUS,
      invited: m.host === u.name ? [...u.friends].filter((f) => users.get(key(f))?.invites.has(m.id)) : [],
      protected: mine.alive && inSpawn(m, u.name),
      respawnIn: !mine.alive && mine.spawnSince ? Math.max(0, Math.ceil((REVIVE_MS - (now() - mine.spawnSince)) / 1000)) : null,
      countdown: m.status === 'countdown' ? Math.max(0, Math.ceil((m.goAt - now()) / 1000)) : 0,
      players: Object.entries(m.players).filter(([, p]) => !p.left || started).map(([name, p]) => {
        const pu = users.get(key(name));
        return {
          name, weapon: p.weapon, alive: p.alive, kills: p.kills, deaths: p.deaths, shots: p.shots, hits: p.hits, maxDist: Math.round(p.maxDist), revives: p.revives,
          left: p.left, team: started ? p.team : 0,
          pos: showMap && !p.left && pu?.pos ? { lat: pu.pos.lat, lng: pu.pos.lng } : undefined,
        };
      }),
      log: m.log.slice(-12),
    };
    // quem ainda está vivo não vê o armamento dos outros durante o jogo
    if (m.status === 'playing' && mine.alive) out.match.players.forEach((p) => { if (p.name !== u.name) p.weapon = undefined; });
    // rádio: só chegam os áudios novos do canal em que você está
    out.radioSeq = m.radioSeq;
    const chan = !m.radio ? null : !mine.alive ? 'dead' : isTeamMode(m) && mine.team ? 'team' + mine.team : null;
    if (chan && started) {
      const since = Number(body.radioSince) || 0;
      out.radio = m.radioMsgs.filter((x) => x.id > since && x.channel === chan && x.from !== u.name)
        .map((x) => ({ id: x.id, from: x.from, audio: x.audio }));
    }
  }
  return out;
};

// limpeza de jogadores inativos
setInterval(() => {
  for (const u of [...users.values()]) {
    if (u.token && now() - u.lastSeen > 10 * 60 * 1000) { // a conta fica; só encerra a sessão
      leaveMatch(u);
      tokens.delete(u.token);
      u.token = null;
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
    req.on('data', (c) => { raw += c; if (raw.length > 700000) req.destroy(); });
    req.on('end', () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        const out = handler(req, body);
        if (url !== '/api/state') save();
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
  load();
  server.listen(PORT, () => console.log(`AirTag Arena rodando em http://localhost:${PORT}`));
}
module.exports = { server, load, distance, bearing, angleDiff };
