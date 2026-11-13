#!/usr/bin/env node
/* Servidor do Thirtyly: entrega o site e controla as contas (SQLite).
 *
 * Usa só o que já vem no Node.js 22.13 ou mais novo (nada para instalar).
 * Para rodar:   node servidor.js
 * Para abrir:   http://127.0.0.1:8000
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { criarApi, ErroApi, proximoId } = require('./api.js');
const { lerConfig, enviarEmail } = require('./email.js');

const PASTA = __dirname;
const BANCO = process.env.THIRTYLY_BANCO || path.join(PASTA, 'thirtyly.db');
const PORTA = parseInt(process.env.PORT || '8000', 10);

const DURACAO_SESSAO = 7 * 24 * 3600;
const MAX_FALHAS_EMAIL = 5;
const MAX_FALHAS_IP = 30;
const JANELA_FALHAS = 15 * 60;
const LIMITE_CORPO = 10000;
const VALIDADE_CODIGO = 15 * 60; // código de recuperação vale 15 minutos
const MAX_TENTATIVAS_CODIGO = 5;
const MAX_PEDIDOS_CODIGO_EMAIL = 3; // por e-mail, a cada 15 minutos
const MAX_PEDIDOS_CODIGO_IP = 10; // por IP, a cada 15 minutos
const MSG_CODIGO_RUIM = 'Código inválido ou expirado. Peça um novo código.';

// Páginas que qualquer um pode abrir (só o login).
const PUBLICOS = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/estilo.css': 'estilo.css',
  '/script.js': 'script.js',
};
// Páginas do painel: só com sessão válida.
const PRIVADOS = {
  '/painel.html': 'painel.html',
  '/painel.css': 'painel.css',
  '/painel.js': 'painel.js',
};
const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const RE_USUARIO = /^[A-Za-z0-9_.]{3,20}$/;
const RE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

// ---------- senha ----------

const N_SCRYPT = 16384;

function scrypt(senha, sal, n, r, p, tamanho) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      senha, sal, tamanho,
      { N: n, r: r, p: p, maxmem: 256 * n * r + 1024 * 1024 },
      (erro, chave) => (erro ? reject(erro) : resolve(chave))
    );
  });
}

async function gerarHash(senha) {
  const sal = crypto.randomBytes(16);
  const h = await scrypt(senha, sal, N_SCRYPT, 8, 1, 32);
  return `scrypt$${N_SCRYPT}$8$1$${sal.toString('hex')}$${h.toString('hex')}`;
}

async function conferirSenha(senha, guardado) {
  try {
    const partes = guardado.split('$');
    if (partes.length !== 6) return false;
    const [, n, r, p, sal, esperado] = partes;
    const esperadoBytes = Buffer.from(esperado, 'hex');
    const h = await scrypt(senha, Buffer.from(sal, 'hex'),
      parseInt(n, 10), parseInt(r, 10), parseInt(p, 10), esperadoBytes.length);
    return crypto.timingSafeEqual(h, esperadoBytes);
  } catch (e) {
    return false;
  }
}

// Usado quando o e-mail não existe, para o tempo de resposta ser parecido.
let HASH_FALSO = '';

function tamanhoTexto(s) {
  return Array.from(s).length;
}

function validarCadastro(usuario, email, senha, confirmar) {
  if (!RE_USUARIO.test(usuario)) {
    return 'Usuário: de 3 a 20 caracteres (letras, números, _ ou .).';
  }
  if (email.length > 254 || !RE_EMAIL.test(email)) {
    return 'Digite um e-mail válido.';
  }
  return validarSenha(senha, confirmar);
}

function validarSenha(senha, confirmar) {
  if (typeof senha !== 'string' || tamanhoTexto(senha) < 8) {
    return 'A senha precisa ter pelo menos 8 caracteres.';
  }
  if (tamanhoTexto(senha) > 128) {
    return 'A senha pode ter no máximo 128 caracteres.';
  }
  if (!/\p{L}/u.test(senha) || !/\p{Nd}/u.test(senha)) {
    return 'A senha precisa ter letras e números.';
  }
  if (senha !== confirmar) {
    return 'As senhas não conferem.';
  }
  return '';
}

// ---------- banco ----------

let db = null;
let api = null;
let configEmail = null; // null = modo local (código aparece no terminal)

// Um banco de uma versão antiga do projeto (com tabelas que não existem mais)
// não é apagado: ganha outro nome e um banco novo é criado no lugar.
function guardarBancoAntigo() {
  if (!fs.existsSync(BANCO)) return;
  const antigo = new DatabaseSync(BANCO);
  let temTabelaAntiga = false;
  try {
    temTabelaAntiga = Number(antigo.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' " +
      "AND name IN ('trofeus', 'modelos_meta', 'xp_eventos', 'missoes_modelo', 'cartas_desafio')").get().n) > 0;
  } finally {
    antigo.close();
  }
  if (!temTabelaAntiga) return;
  const novoNome = BANCO + '.antigo-' + new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  for (const sufixo of ['', '-wal', '-shm']) {
    if (fs.existsSync(BANCO + sufixo)) fs.renameSync(BANCO + sufixo, novoNome + sufixo);
  }
  console.log('Banco de uma versão antiga guardado como: ' + novoNome);
}

function iniciarBanco() {
  guardarBancoAntigo();
  db = new DatabaseSync(BANCO);
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA foreign_keys = ON');
  // O mesmo schema.sql que vale para o MySQL, sem nenhuma troca.
  db.exec(fs.readFileSync(path.join(PASTA, 'schema.sql'), 'utf-8'));
  db.exec('PRAGMA journal_mode = WAL');
  api = criarApi(db);
}

function agora() {
  return Math.floor(Date.now() / 1000);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf-8').digest('hex');
}

function criarSessao(usuarioId) {
  const t = agora();
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessoes WHERE expira_em < ?').run(t);
  db.prepare('INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?, ?, ?)')
    .run(hashToken(token), usuarioId, t + DURACAO_SESSAO);
  return token;
}

function usuarioDaSessao(token) {
  if (!token) return null;
  return db.prepare(
    'SELECT u.id, u.usuario, u.email FROM sessoes s ' +
    'JOIN usuarios u ON u.id = s.usuario_id ' +
    'WHERE s.token_hash = ? AND s.expira_em > ?'
  ).get(hashToken(token), agora()) || null;
}

function falhasRecentes(chave) {
  const desde = agora() - JANELA_FALHAS;
  const linha = db.prepare('SELECT COUNT(*) AS total FROM tentativas_login WHERE chave = ? AND em > ?')
    .get(chave, desde);
  return Number(linha.total);
}

function texto(valor) {
  return typeof valor === 'string' ? valor.trim() : '';
}

function transacao(funcao) {
  db.exec('BEGIN');
  try {
    const resultado = funcao();
    db.exec('COMMIT');
    return resultado;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* nada a desfazer */ }
    throw e;
  }
}

// ---------- servidor ----------

function enviar(res, status, corpo, tipo, opcoes) {
  const o = opcoes || {};
  res.statusCode = status;
  res.setHeader('Content-Type', tipo);
  res.setHeader('Content-Length', String(corpo.length));
  res.setHeader('Cache-Control', o.cache || 'no-store');
  if (o.cookie) res.setHeader('Set-Cookie', o.cookie);
  if (o.local) res.setHeader('Location', o.local);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self'; script-src 'self'; " +
    "img-src 'self' data:; frame-ancestors 'none'; " +
    "form-action 'self'; base-uri 'self'");
  res.end(corpo);
}

function enviarJson(res, status, dados, cookie) {
  const corpo = Buffer.from(JSON.stringify(dados), 'utf-8');
  enviar(res, status, corpo, 'application/json; charset=utf-8', { cookie: cookie });
}

function enviarErro(res, status, mensagem) {
  enviarJson(res, status, { ok: false, erro: mensagem });
}

function enviarArquivo(res, nome, privado) {
  const corpo = fs.readFileSync(path.join(PASTA, nome));
  enviar(res, 200, corpo, TIPOS[path.extname(nome)],
    { cache: privado ? 'no-store' : 'no-cache' });
}

function tokenDoCookie(req) {
  const cabecalho = req.headers.cookie || '';
  for (const parte of cabecalho.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === 'sessao') {
      return parte.slice(i + 1).trim().replace(/^"|"$/g, '');
    }
  }
  return null;
}

function cookieSessao(token, duracao) {
  return `sessao=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${duracao}`;
}

function caminhoDe(req) {
  const url = req.url || '/';
  const corte = url.search(/[?#]/);
  return corte < 0 ? url : url.slice(0, corte);
}

function lerCorpo(req, tamanho) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let lido = 0;
    req.on('data', (p) => {
      pedacos.push(p);
      lido += p.length;
      if (lido >= tamanho) resolve(Buffer.concat(pedacos).subarray(0, tamanho));
    });
    req.on('end', () => resolve(Buffer.concat(pedacos)));
    req.on('error', reject);
  });
}

// Roda uma rota da API (já com o usuário logado) e responde.
function responderApi(res, rota, usuario, dados) {
  try {
    const [status, corpo] = rota.executar(usuario, dados);
    return enviarJson(res, status, corpo);
  } catch (e) {
    if (e instanceof ErroApi) return enviarErro(res, e.status, e.message);
    throw e;
  }
}

// --- GET ---
function tratarGet(req, res) {
  const caminho = caminhoDe(req);
  if (caminho === '/api/eu') {
    const u = usuarioDaSessao(tokenDoCookie(req));
    if (!u) return enviarErro(res, 401, 'Faça login para continuar.');
    return enviarJson(res, 200, { ok: true, usuario: u.usuario, email: u.email });
  }
  if (caminho.startsWith('/api/')) {
    const rota = api.acharRota('GET', caminho);
    if (!rota) return enviarErro(res, 404, 'Página não encontrada.');
    const u = usuarioDaSessao(tokenDoCookie(req));
    if (!u) return enviarErro(res, 401, 'Faça login para continuar.');
    return responderApi(res, rota, u, {});
  }
  if (Object.prototype.hasOwnProperty.call(PUBLICOS, caminho)) {
    return enviarArquivo(res, PUBLICOS[caminho], false);
  }
  if (Object.prototype.hasOwnProperty.call(PRIVADOS, caminho)) {
    const u = usuarioDaSessao(tokenDoCookie(req));
    if (!u) {
      if (caminho.endsWith('.html')) {
        return enviar(res, 302, Buffer.alloc(0), 'text/plain', { local: '/index.html' });
      }
      return enviarErro(res, 401, 'Faça login para continuar.');
    }
    return enviarArquivo(res, PRIVADOS[caminho], true);
  }
  return enviarErro(res, 404, 'Página não encontrada.');
}

// --- POST ---
async function tratarPost(req, res) {
  const caminho = caminhoDe(req);
  const rotas = {
    '/api/cadastro': cadastro, '/api/login': login, '/api/logout': logout,
    '/api/esqueci': esqueci, '/api/redefinir': redefinir,
  };
  const ehConta = Object.prototype.hasOwnProperty.call(rotas, caminho);
  const rotaApi = ehConta ? null : api.acharRota('POST', caminho);
  if (!ehConta && !rotaApi) {
    req.resume();
    return enviarErro(res, 404, 'Página não encontrada.');
  }
  const origem = req.headers.origin;
  if (origem) {
    let host = null;
    try { host = new URL(origem).host; } catch (e) { host = null; }
    if (host !== req.headers.host) {
      req.resume();
      return enviarErro(res, 403, 'Origem não permitida.');
    }
  }
  const tipo = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (tipo !== 'application/json') {
    req.resume();
    return enviarErro(res, 415, 'Envie os dados em JSON.');
  }
  const tamanho = parseInt(req.headers['content-length'] || '0', 10);
  if (!Number.isFinite(tamanho) || tamanho <= 0 || tamanho > LIMITE_CORPO) {
    req.resume();
    return enviarErro(res, 400, 'Pedido inválido.');
  }
  let dados;
  try {
    const bruto = await lerCorpo(req, tamanho);
    dados = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bruto));
  } catch (e) {
    return enviarErro(res, 400, 'Pedido inválido.');
  }
  if (dados === null || typeof dados !== 'object' || Array.isArray(dados)) {
    return enviarErro(res, 400, 'Pedido inválido.');
  }
  if (rotaApi) {
    const u = usuarioDaSessao(tokenDoCookie(req));
    if (!u) return enviarErro(res, 401, 'Faça login para continuar.');
    return responderApi(res, rotaApi, u, dados);
  }
  return rotas[caminho](req, res, dados);
}

async function cadastro(req, res, dados) {
  const usuario = texto(dados.usuario);
  const email = texto(dados.email).toLowerCase();
  const senha = dados.senha;
  const erro = validarCadastro(usuario, email, senha, dados.confirmar);
  if (erro) return enviarErro(res, 400, erro);
  const senhaHash = await gerarHash(senha);
  let token;
  try {
    token = transacao(() => {
      if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) {
        throw new ErroApi(409, 'Este e-mail já tem uma conta.');
      }
      // nome de usuário não repete nem trocando maiúsculas por minúsculas
      if (db.prepare('SELECT 1 FROM usuarios WHERE LOWER(usuario) = LOWER(?)').get(usuario)) {
        throw new ErroApi(409, 'Este nome de usuário já está em uso.');
      }
      const id = proximoId(db, 'usuarios');
      db.prepare('INSERT INTO usuarios (id, usuario, email, senha_hash) VALUES (?, ?, ?, ?)')
        .run(id, usuario, email, senhaHash);
      db.prepare('INSERT INTO perfis (usuario_id) VALUES (?)').run(id);
      return criarSessao(id);
    });
  } catch (e) {
    if (e instanceof ErroApi) return enviarErro(res, e.status, e.message);
    // outra pessoa criou a mesma conta no mesmo instante (a regra UNIQUE do banco barrou)
    const temEmail = db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email);
    if (temEmail) return enviarErro(res, 409, 'Este e-mail já tem uma conta.');
    return enviarErro(res, 409, 'Este nome de usuário já está em uso.');
  }
  return enviarJson(res, 201, { ok: true, usuario: usuario},
    cookieSessao(token, DURACAO_SESSAO));
}

async function login(req, res, dados) {
  const email = texto(dados.email).toLowerCase().slice(0, 254);
  const senha = dados.senha;
  if (!email || typeof senha !== 'string' || !senha || tamanhoTexto(senha) > 128) {
    return enviarErro(res, 400, 'Informe e-mail e senha.');
  }
  const chaveIp = 'ip:' + (req.socket.remoteAddress || '');
  if (falhasRecentes(email) >= MAX_FALHAS_EMAIL || falhasRecentes(chaveIp) >= MAX_FALHAS_IP) {
    return enviarErro(res, 429, 'Muitas tentativas. Tente de novo em 15 minutos.');
  }
  const linha = db.prepare('SELECT id, usuario, senha_hash FROM usuarios WHERE email = ?').get(email);
  const guardado = linha ? linha.senha_hash : HASH_FALSO;
  const correta = (await conferirSenha(senha, guardado)) && Boolean(linha);
  let token = null;
  if (correta) {
    token = transacao(() => {
      db.prepare('DELETE FROM tentativas_login WHERE chave = ?').run(email);
      return criarSessao(Number(linha.id));
    });
  } else {
    transacao(() => {
      const t = agora();
      db.prepare('DELETE FROM tentativas_login WHERE em < ?').run(t - JANELA_FALHAS);
      const ins = db.prepare('INSERT INTO tentativas_login (chave, em) VALUES (?, ?)');
      ins.run(email, t);
      ins.run(chaveIp, t);
    });
    return enviarErro(res, 401, 'E-mail ou senha incorretos.');
  }
  return enviarJson(res, 200, { ok: true, usuario: linha.usuario },
    cookieSessao(token, DURACAO_SESSAO));
}

// ---------- recuperação de senha ----------

function registrarTentativa(...chaves) {
  const t = agora();
  db.prepare('DELETE FROM tentativas_login WHERE em < ?').run(t - JANELA_FALHAS);
  const ins = db.prepare('INSERT INTO tentativas_login (chave, em) VALUES (?, ?)');
  for (const c of chaves) ins.run(c, t);
}

function hashCodigo(sal, codigo) {
  return crypto.createHash('sha256').update(sal + ':' + codigo, 'utf-8').digest('hex');
}

// Manda o código por e-mail (ou mostra no terminal, no modo local).
function entregarCodigo(email, usuario, codigo) {
  if (!configEmail) {
    console.log(`[MODO LOCAL] Código de recuperação para ${email}: ${codigo}  (vale 15 minutos)`);
    return;
  }
  const mensagem =
    `Olá, ${usuario}!\n\n` +
    `Seu código para redefinir a senha do Thirtyly é: ${codigo}\n\n` +
    `Ele vale por 15 minutos e só pode ser usado uma vez.\n` +
    `Se não foi você que pediu, ignore este e-mail: sua senha continua a mesma.\n`;
  enviarEmail(configEmail, email, 'Thirtyly: código para redefinir sua senha', mensagem)
    .catch((e) => console.error('Não consegui enviar o e-mail de recuperação:', e.message));
}

// Passo 1: a pessoa informa o e-mail e recebe um código. A resposta é sempre a
// mesma, exista a conta ou não, para ninguém descobrir quais e-mails têm conta.
async function esqueci(req, res, dados) {
  const email = texto(dados.email).toLowerCase();
  if (email.length > 254 || !RE_EMAIL.test(email)) {
    return enviarErro(res, 400, 'Digite um e-mail válido.');
  }
  const chaveEmail = 'rec:' + email;
  const chaveIp = 'recip:' + (req.socket.remoteAddress || '');
  if (falhasRecentes(chaveEmail) >= MAX_PEDIDOS_CODIGO_EMAIL ||
      falhasRecentes(chaveIp) >= MAX_PEDIDOS_CODIGO_IP) {
    return enviarErro(res, 429, 'Muitos pedidos de código. Tente de novo em 15 minutos.');
  }
  registrarTentativa(chaveEmail, chaveIp);

  const linha = db.prepare('SELECT id, usuario FROM usuarios WHERE email = ?').get(email);
  if (linha) {
    const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const sal = crypto.randomBytes(16).toString('hex');
    const t = agora();
    transacao(() => {
      // um código novo cancela os anteriores
      db.prepare('DELETE FROM recuperacoes_senha WHERE usuario_id = ?').run(linha.id);
      db.prepare(
        'INSERT INTO recuperacoes_senha (usuario_id, sal, codigo_hash, criado_em, expira_em) VALUES (?, ?, ?, ?, ?)'
      ).run(linha.id, sal, hashCodigo(sal, codigo), t, t + VALIDADE_CODIGO);
    });
    entregarCodigo(email, linha.usuario, codigo); // sem esperar: o tempo de resposta não revela nada
  }
  return enviarJson(res, 200, {
    ok: true,
    mensagem: 'Se existir uma conta com esse e-mail, enviamos um código de 6 dígitos.',
  });
}

// Passo 2: e-mail + código + nova senha.
async function redefinir(req, res, dados) {
  const email = texto(dados.email).toLowerCase().slice(0, 254);
  const codigo = texto(dados.codigo);
  const erroSenha = validarSenha(dados.senha, dados.confirmar);
  if (!RE_EMAIL.test(email) || !/^[0-9]{6}$/.test(codigo)) {
    return enviarErro(res, 400, MSG_CODIGO_RUIM);
  }
  if (erroSenha) return enviarErro(res, 400, erroSenha);

  const chaveEmail = 'cod:' + email;
  const chaveIp = 'ip:' + (req.socket.remoteAddress || '');
  if (falhasRecentes(chaveEmail) >= MAX_TENTATIVAS_CODIGO || falhasRecentes(chaveIp) >= MAX_FALHAS_IP) {
    return enviarErro(res, 429, 'Muitas tentativas. Tente de novo em 15 minutos.');
  }
  const falhar = () => {
    registrarTentativa(chaveEmail, chaveIp);
    return enviarErro(res, 400, MSG_CODIGO_RUIM);
  };

  const usuario = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  const rec = usuario && db.prepare(
    'SELECT sal, codigo_hash, tentativas FROM recuperacoes_senha WHERE usuario_id = ? AND expira_em > ?'
  ).get(usuario.id, agora());
  if (!rec || rec.tentativas >= MAX_TENTATIVAS_CODIGO) return falhar();

  const confere = crypto.timingSafeEqual(
    Buffer.from(hashCodigo(rec.sal, codigo), 'hex'), Buffer.from(rec.codigo_hash, 'hex'));
  if (!confere) {
    db.prepare('UPDATE recuperacoes_senha SET tentativas = tentativas + 1 WHERE usuario_id = ?').run(usuario.id);
    return falhar();
  }

  const novoHash = await gerarHash(dados.senha);
  transacao(() => {
    db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(novoHash, usuario.id);
    db.prepare('DELETE FROM recuperacoes_senha WHERE usuario_id = ?').run(usuario.id);
    // quem entrou com a senha antiga é desconectado
    db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(usuario.id);
    db.prepare('DELETE FROM tentativas_login WHERE chave IN (?, ?, ?)')
      .run(email, chaveEmail, 'rec:' + email);
  });
  return enviarJson(res, 200, { ok: true, mensagem: 'Senha redefinida! Entre com a nova senha.' });
}

function logout(req, res) {
  const token = tokenDoCookie(req);
  if (token) {
    db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(hashToken(token));
  }
  return enviarJson(res, 200, { ok: true }, cookieSessao('', 0));
}

async function manipulador(req, res) {
  try {
    if (req.method === 'GET') return tratarGet(req, res);
    if (req.method === 'POST') return await tratarPost(req, res);
    return enviarErro(res, 501, 'Método não suportado.');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) enviarErro(res, 500, 'Erro interno.');
  }
}

async function main() {
  iniciarBanco();
  configEmail = lerConfig(PASTA);
  HASH_FALSO = await gerarHash('senha-falsa-1');
  const servidor = http.createServer(manipulador);
  servidor.listen(PORTA, '127.0.0.1', () => {
    console.log(`Thirtyly rodando em http://127.0.0.1:${PORTA}  (Ctrl+C para parar)`);
    console.log('Banco de dados:', BANCO);
    console.log(configEmail
      ? 'E-mail de recuperação de senha: ativo (' + configEmail.usuario + ')'
      : 'E-mail de recuperação de senha: MODO LOCAL (o código aparece aqui no terminal). Veja email.exemplo.json');
  });
  process.on('SIGINT', () => {
    console.log('\nServidor encerrado.');
    process.exit(0);
  });
}

main();
