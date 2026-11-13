#!/usr/bin/env node
/* Testes automáticos do Thirtyly (servidor + banco de dados).
 *
 * Sobe um servidor de teste com um banco temporário (não mexe no seu thirtyly.db).
 * Para rodar:   node testar.js
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const PASTA = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thirtyly-'));
const BANCO = path.join(TMP, 'teste.db');
let PORTA = 0;
let processo = null;
let total = 0;
let saidaServidor = ''; // o que o servidor escreveu no terminal (inclui os códigos do modo local)
const falhas = [];

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function portaLivre() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function conectou() {
  return new Promise((resolve) => {
    const c = net.connect(PORTA, '127.0.0.1');
    c.on('connect', () => { c.destroy(); resolve(true); });
    c.on('error', () => resolve(false));
  });
}

async function subir() {
  processo = spawn(process.execPath, ['--no-warnings', path.join(PASTA, 'servidor.js')], {
    cwd: PASTA,
    env: Object.assign({}, process.env, { PORT: String(PORTA), THIRTYLY_BANCO: BANCO, THIRTYLY_EMAIL_USUARIO: '', THIRTYLY_EMAIL_SENHA: '' }),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  processo.stdout.on('data', (d) => { saidaServidor += d.toString('utf-8'); });
  for (let i = 0; i < 100; i++) {
    if (await conectou()) return;
    await esperar(100);
  }
  throw new Error('servidor não subiu');
}

function parar() {
  return new Promise((resolve) => {
    if (!processo) return resolve();
    processo.once('exit', () => resolve());
    processo.kill('SIGTERM');
  });
}

// Devolve [status, cabecalhos, json, corpoBruto]
function req(metodo, caminho, opcoes) {
  const o = opcoes || {};
  const tipo = o.tipo === undefined ? 'application/json' : o.tipo;
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, o.headers || {});
    let dados = null;
    if (o.corpo !== undefined) dados = JSON.stringify(o.corpo);
    if (o.bruto !== undefined) dados = o.bruto;
    if (dados !== null && tipo) h['Content-Type'] = tipo;
    if (dados !== null) h['Content-Length'] = String(Buffer.byteLength(dados));
    if (o.cookie) h['Cookie'] = o.cookie;
    const r = http.request(
      { host: '127.0.0.1', port: PORTA, method: metodo, path: caminho, headers: h, agent: false, timeout: 20000 },
      (resp) => {
        const pedacos = [];
        resp.on('data', (p) => pedacos.push(p));
        resp.on('end', () => {
          const corpo = Buffer.concat(pedacos);
          let js = null;
          try { js = JSON.parse(corpo.toString('utf-8')); } catch (e) { js = null; }
          resolve([resp.statusCode, resp.headers, js, corpo]);
        });
      }
    );
    r.on('error', reject);
    if (dados !== null) r.write(dados);
    r.end();
  });
}

function cookieDe(cab) {
  const sc = cab['set-cookie'] ? cab['set-cookie'][0] : '';
  return sc.startsWith('sessao=') ? sc.split(';')[0] : null;
}

function ok(nome, condicao, detalhe) {
  total++;
  if (condicao) {
    console.log('  ok   ' + nome);
  } else {
    console.log('  FALHOU  ' + nome + (detalhe !== undefined ? '  -> ' + JSON.stringify(detalhe) : ''));
    falhas.push(nome);
  }
}

function sql(consulta, params) {
  const con = new DatabaseSync(BANCO);
  try {
    con.exec('PRAGMA busy_timeout = 10000');
    return con.prepare(consulta).all(...(params || [])).map((l) => Object.values(l));
  } finally {
    con.close();
  }
}

function cadastrar(usuario, email, senha, confirmar) {
  const s = senha === undefined ? 'Senha123' : senha;
  return req('POST', '/api/cadastro', {
    corpo: { usuario: usuario, email: email, senha: s, confirmar: confirmar === undefined ? s : confirmar },
  });
}

function login(email, senha) {
  return req('POST', '/api/login', { corpo: { email: email, senha: senha } });
}

function titulo(t) {
  console.log('\n' + t);
}

async function main() {
  PORTA = await portaLivre();
  await subir();
  try {
    await testes();
  } finally {
    await parar();
  }
  console.log(`\n${total} testes, ${falhas.length} falhas`);
  falhas.forEach((f) => console.log('  - ' + f));
  process.exit(falhas.length ? 1 : 0);
}

async function testes() {
  let s, cab, js, corpo, js1, js2;

  titulo('1. Acesso sem conta');
  [s, cab, , corpo] = await req('GET', '/');
  ok('login abre sem conta', s === 200 && corpo.includes('formulario_login'));
  ok('estilo.css e script.js abrem', (await req('GET', '/estilo.css'))[0] === 200 && (await req('GET', '/script.js'))[0] === 200);
  [s, cab] = await req('GET', '/painel.html');
  ok('painel.html sem login redireciona para o login', s === 302 && cab['location'] === '/index.html', s);
  ok('painel.css sem login é bloqueado', (await req('GET', '/painel.css'))[0] === 401);
  ok('painel.js sem login é bloqueado', (await req('GET', '/painel.js'))[0] === 401);
  ok('/api/eu sem login é 401', (await req('GET', '/api/eu'))[0] === 401);
  for (const caminho of ['/servidor.js', '/servidor.py', '/thirtyly.db', '/teste.db', '/schema.sql', '/testar.js',
    '/../servidor.js', '/%2e%2e/servidor.js', '/painel.html/..', '//etc/passwd']) {
    ok('arquivo interno não é servido: ' + caminho, [404, 400].includes((await req('GET', caminho))[0]));
  }
  ok('cookie falso não dá acesso', (await req('GET', '/painel.html', { cookie: 'sessao=abc' }))[0] === 302);
  ok('cookie quebrado não derruba o servidor', (await req('GET', '/api/eu', { cookie: 'sessao==;;;"' }))[0] === 401);

  titulo('2. Cadastro: validações (nada deve ser criado)');
  const invalidos = [
    ['usuário curto', () => cadastrar('ab', 'a@b.com')],
    ['usuário com espaço', () => cadastrar('a b c', 'a@b.com')],
    ['usuário com acento', () => cadastrar('joão', 'a@b.com')],
    ['usuário com 21 letras', () => cadastrar('x'.repeat(21), 'a@b.com')],
    ['usuário vazio', () => cadastrar('', 'a@b.com')],
    ['e-mail sem @', () => cadastrar('teste1', 'abc')],
    ['e-mail sem domínio', () => cadastrar('teste1', 'a@b')],
    ['e-mail com espaço', () => cadastrar('teste1', 'a b@c.com')],
    ['senha curta', () => cadastrar('teste1', 'a@b.com', 'Ab1')],
    ['senha sem número', () => cadastrar('teste1', 'a@b.com', 'SomenteLetras')],
    ['senha sem letra', () => cadastrar('teste1', 'a@b.com', '12345678')],
    ['senha longa demais', () => cadastrar('teste1', 'a@b.com', 'A1'.repeat(65))],
    ['confirmação diferente', () => cadastrar('teste1', 'a@b.com', 'Senha123', 'Senha124')],
    ['sem confirmação', () => req('POST', '/api/cadastro', { corpo: { usuario: 'teste1', email: 'a@b.com', senha: 'Senha123' } })],
    ['senha não é texto', () => req('POST', '/api/cadastro', { corpo: { usuario: 'teste1', email: 'a@b.com', senha: 12345678, confirmar: 12345678 } })],
    ['quebra de linha no usuário', () => cadastrar('ab\ncd', 'a@b.com')],
  ];
  for (const [nome, chamar] of invalidos) {
    [s, , js] = await chamar();
    ok('recusa ' + nome, s === 400 && js && js.ok === false && Boolean(js.erro), [s, js]);
  }
  ok('nenhuma conta foi criada', sql('SELECT COUNT(*) FROM usuarios')[0][0] === 0);

  titulo('3. Cadastro: conta válida');
  [s, cab, js] = await cadastrar('Fernando', 'Fernando@Email.com', 'Senha123');
  ok('cria a conta (201)', s === 201 && js.ok && js.usuario === 'Fernando', [s, js]);
  const cookie = cookieDe(cab);
  const sc = (cab['set-cookie'] || [''])[0];
  ok('cookie de sessão HttpOnly + SameSite', sc.includes('HttpOnly') && sc.includes('SameSite=Lax') && Boolean(cookie));
  [s, , js] = await req('GET', '/api/eu', { cookie: cookie });
  ok('/api/eu devolve usuário e e-mail', s === 200 && js.usuario === 'Fernando' && js.email === 'fernando@email.com', js);
  [s, cab, , corpo] = await req('GET', '/painel.html', { cookie: cookie });
  ok('painel.html abre com login', s === 200 && corpo.includes('painel.js'));
  ok('painel.css e painel.js abrem com login',
    (await req('GET', '/painel.css', { cookie: cookie }))[0] === 200 && (await req('GET', '/painel.js', { cookie: cookie }))[0] === 200);
  ok('cabeçalhos de segurança no painel',
    'content-security-policy' in cab && cab['x-content-type-options'] === 'nosniff' && cab['cache-control'] === 'no-store');

  titulo('4. O que fica gravado no banco');
  const linha = sql('SELECT usuario, email, senha_hash FROM usuarios')[0];
  ok('e-mail gravado em minúsculas', linha[1] === 'fernando@email.com', linha);
  ok('senha NÃO está em texto puro', !linha[2].includes('Senha123') && linha[2].startsWith('scrypt$'), linha[2]);
  const token = cookie.split('=').slice(1).join('=');
  const sessoes = sql('SELECT token_hash FROM sessoes');
  ok('token da sessão não é guardado em texto puro',
    sessoes.length === 1 && sessoes[0][0] !== token &&
    sessoes[0][0] === crypto.createHash('sha256').update(token).digest('hex'));
  await cadastrar('Outro', 'outro@email.com', 'Senha123');
  const hashes = sql('SELECT senha_hash FROM usuarios').map((r) => r[0]);
  ok('mesma senha gera hashes diferentes (sal)', new Set(hashes).size === hashes.length && hashes.length === 2);

  titulo('5. Duplicados');
  [s, , js] = await cadastrar('Novo', 'FERNANDO@email.com');
  ok('e-mail repetido (maiúsculas) é recusado', s === 409 && js.erro.includes('e-mail'), [s, js]);
  [s, , js] = await cadastrar('FERNANDO', 'novo@email.com');
  ok('usuário repetido (maiúsculas) é recusado', s === 409 && js.erro.includes('usuário'), [s, js]);
  ok('continuam só 2 contas', sql('SELECT COUNT(*) FROM usuarios')[0][0] === 2);

  titulo('6. Login');
  [s, cab, js] = await login('fernando@email.com', 'Senha123');
  ok('login correto', s === 200 && js.ok && Boolean(cookieDe(cab)));
  [s] = await login('FERNANDO@EMAIL.COM', 'Senha123');
  ok('e-mail não diferencia maiúsculas', s === 200);
  [s, , js1] = await login('fernando@email.com', 'senha123');
  ok('senha errada (maiúscula/minúscula) é recusada', s === 401, s);
  [s, , js2] = await login('naoexiste@email.com', 'Senha123');
  ok('e-mail inexistente é recusado com a mesma mensagem', s === 401 && js1.erro === js2.erro);
  ok('login vazio é 400', (await login('', ''))[0] === 400);
  ok('senha que não é texto é 400', (await req('POST', '/api/login', { corpo: { email: 'a@b.com', senha: 123 } }))[0] === 400);
  ok('JSON que não é objeto é 400', (await req('POST', '/api/login', { corpo: ['a'] }))[0] === 400);
  ok('JSON inválido é 400', (await req('POST', '/api/login', { bruto: '{nao e json' }))[0] === 400);
  ok('tipo de conteúdo errado é 415',
    (await req('POST', '/api/login', { bruto: 'email=a', tipo: 'application/x-www-form-urlencoded' }))[0] === 415);
  ok('corpo gigante é recusado', (await req('POST', '/api/login', { bruto: '{"a":"' + 'x'.repeat(20000) + '"}' }))[0] === 400);
  ok('origem de outro site é recusada (403)',
    (await req('POST', '/api/login', { corpo: { email: 'a@b.com', senha: 'x' }, headers: { Origin: 'http://site-malvado.com' } }))[0] === 403);
  ok('rota inexistente é 404', (await req('POST', '/api/qualquer', { corpo: {} }))[0] === 404);

  titulo('7. Tentativas de invasão (SQL injection)');
  for (const [email, senha] of [["' OR '1'='1", 'x'], ['fernando@email.com', "' OR '1'='1"], ["fernando@email.com' --", 'x']]) {
    [s, cab] = await login(email, senha);
    ok(`injection no login falha: ${email} / ${senha}`, [400, 401].includes(s) && !cookieDe(cab), s);
  }
  [s] = await cadastrar("a'; DROP TABLE usuarios;--", 'x@y.com');
  ok('injection no usuário é recusada', s === 400);
  await cadastrar('Injetor', "x@y.zz');DROP--");
  const tabelas = sql("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r[0]);
  ok('tabelas continuam existindo', ['usuarios', 'sessoes', 'tentativas_login'].every((t) => tabelas.includes(t)), tabelas);
  ok('contas anteriores continuam lá',
    sql("SELECT COUNT(*) FROM usuarios WHERE usuario IN ('Fernando','Outro')")[0][0] === 2);

  titulo('8. Bloqueio por muitas tentativas');
  await cadastrar('Vitima', 'vitima@email.com', 'Senha123');
  const codigos = [];
  for (let i = 0; i < 5; i++) codigos.push((await login('vitima@email.com', 'errada' + i))[0]);
  ok('5 erros seguidos dão 401', JSON.stringify(codigos) === JSON.stringify([401, 401, 401, 401, 401]), codigos);
  [s, cab, js] = await login('vitima@email.com', 'Senha123');
  ok('6ª tentativa (até com a senha certa) é bloqueada: 429', s === 429 && !cookieDe(cab), [s, js]);
  ok('outro e-mail não é afetado', (await login('outro@email.com', 'Senha123'))[0] === 200);
  let con = new DatabaseSync(BANCO);
  con.exec('PRAGMA busy_timeout = 10000');
  con.prepare('UPDATE tentativas_login SET em = em - 3600 WHERE chave = ?').run('vitima@email.com');
  con.close();
  ok('depois da janela de 15 min o bloqueio passa', (await login('vitima@email.com', 'Senha123'))[0] === 200);
  ok('login certo apaga as falhas antigas',
    sql("SELECT COUNT(*) FROM tentativas_login WHERE chave='vitima@email.com'")[0][0] === 0);

  titulo('9. Sair e expirar');
  [s, cab] = await login('fernando@email.com', 'Senha123');
  const c1 = cookieDe(cab);
  ok('sessão válida antes de sair', (await req('GET', '/api/eu', { cookie: c1 }))[0] === 200);
  [s, cab, js] = await req('POST', '/api/logout', { corpo: {}, cookie: c1 });
  ok('logout responde 200 e limpa o cookie', s === 200 && ((cab['set-cookie'] || [''])[0]).includes('Max-Age=0'));
  ok('cookie antigo não funciona mais',
    (await req('GET', '/api/eu', { cookie: c1 }))[0] === 401 && (await req('GET', '/painel.html', { cookie: c1 }))[0] === 302);
  ok('logout sem sessão não dá erro', (await req('POST', '/api/logout', { corpo: {} }))[0] === 200);
  [s, cab] = await login('fernando@email.com', 'Senha123');
  const c2 = cookieDe(cab);
  con = new DatabaseSync(BANCO);
  con.exec('PRAGMA busy_timeout = 10000');
  con.exec('UPDATE sessoes SET expira_em = 1');
  con.close();
  ok('sessão expirada é recusada',
    (await req('GET', '/api/eu', { cookie: c2 }))[0] === 401 && (await req('GET', '/painel.js', { cookie: c2 }))[0] === 401);

  titulo('10. Regras do próprio banco (mesmo sem passar pelo servidor)');
  ok('o servidor confere tamanho: usuário curto e e-mail inválido são recusados', (await cadastrar('ab', 'q@w.com'))[0] === 400 && (await cadastrar('qwerty', 'qwerty'))[0] === 400);
  con = new DatabaseSync(BANCO);
  con.exec('PRAGMA busy_timeout = 10000');
  con.exec('PRAGMA foreign_keys = ON');
  const ins = 'INSERT INTO usuarios (id, usuario, email, senha_hash) VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM usuarios), ?, ?, ?)';
  const h = 'scrypt$' + 'x'.repeat(60);
  const casos = [
    ['usuário repetido', ['Fernando', 'q@w.com', h]],
    ['e-mail repetido', ['qwerty', 'fernando@email.com', h]],
    ['sem usuário', [null, 'q@w.com', h]],
    ['sem e-mail', ['qwerty', null, h]],
    ['sem senha', ['qwerty', 'q@w.com', null]],
  ];
  for (const [nome, args] of casos) {
    try {
      con.prepare(ins).run(...args);
      ok('banco recusa ' + nome, false);
    } catch (e) {
      ok('banco recusa ' + nome, true);
    }
  }
  try {
    con.prepare('INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?, ?, ?)').run('t', 99999, 1);
    ok('banco recusa sessão de usuário inexistente', false);
  } catch (e) {
    ok('banco recusa sessão de usuário inexistente', true);
  }
  con.exec("DELETE FROM usuarios WHERE usuario = 'Outro'");
  const orfas = con.prepare('SELECT COUNT(*) AS n FROM sessoes WHERE usuario_id NOT IN (SELECT id FROM usuarios)').get().n;
  ok('apagar usuário apaga as sessões dele', Number(orfas) === 0);
  con.close();

  titulo('11. Corrida: pedidos ao mesmo tempo');
  let resultados = await Promise.all(
    Array.from({ length: 8 }, (_, i) => cadastrar('Par' + i, 'mesmo@email.com').then((r) => r[0]))
  );
  ok('8 cadastros simultâneos do mesmo e-mail: só 1 passa',
    resultados.filter((c) => c === 201).length === 1 && resultados.filter((c) => c === 409).length === 7, resultados);
  ok('só 1 linha no banco para esse e-mail',
    sql("SELECT COUNT(*) FROM usuarios WHERE email='mesmo@email.com'")[0][0] === 1);
  resultados = await Promise.all(
    Array.from({ length: 8 }, (_, i) => cadastrar('Par' + (i + 20), `par${i + 20}@email.com`).then((r) => r[0]))
  );
  ok('8 cadastros simultâneos diferentes: todos passam', resultados.filter((c) => c === 201).length === 8, resultados);

  // ---------------------------------------------------------------
  titulo('14. Metas, regras do jogo e banco de dados');
  const conta = async (nome) => {
    await cadastrar(nome, nome.toLowerCase() + '@jogo.com');
    const [, c] = await login(nome.toLowerCase() + '@jogo.com', 'Senha123');
    return cookieDe(c);
  };
  const G = (ck, url) => req('GET', url, { cookie: ck });
  const P = (ck, url, corpo) => req('POST', url, { cookie: ck, corpo: corpo || {} });
  const ana = await conta('Ana'), beto = await conta('Beto'), cris = await conta('Cris');

  ok('API sem login: 401', (await req('GET', '/api/painel'))[0] === 401);
  ok('POST da API sem login: 401', (await req('POST', '/api/cutucar', { corpo: { usuario: 'Beto' } }))[0] === 401);
  ok('rota de API inexistente: 404', (await G(ana, '/api/nada'))[0] === 404);

  // painel vazio
  [s, , js] = await G(ana, '/api/painel');
  ok('painel novo: nível 1, 0 XP, sem metas', s === 200 && js.eu.nivel === 1 && js.eu.xp_total === 0 && js.metas.length === 0, js);

  // criar meta
  ok('meta com nome curto é recusada', (await P(ana, '/api/metas', { nome: 'ab', dias: 30 }))[0] === 400);
  ok('meta com 6 dias é recusada', (await P(ana, '/api/metas', { nome: 'Correr', dias: 6 }))[0] === 400);
  ok('meta com 91 dias é recusada', (await P(ana, '/api/metas', { nome: 'Correr', dias: 91 }))[0] === 400);
  [s, , js] = await P(ana, '/api/metas', { nome: 'Correr <b>hoje</b>', dias: 7, convidados: ['Beto'] });
  const metaA = js && js.id;
  ok('meta criada com convidado', s === 201 && metaA > 0, [s, js]);
  [s, , js] = await G(beto, '/api/metas/' + metaA);
  ok('convidado enxerga a meta', s === 200 && js.membros.length === 2, js);
  ok('nome guardado sem alterar (escape é no navegador)', js.meta.nome === 'Correr <b>hoje</b>');
  ok('quem não participa não lê a meta (404)', (await G(cris, '/api/metas/' + metaA))[0] === 404);
  ok('quem não participa não manda mensagem', (await P(cris, '/api/metas/' + metaA + '/mensagens', { texto: 'oi' }))[0] === 404);
  ok('quem não participa não faz check', (await P(cris, '/api/metas/' + metaA + '/check'))[0] === 404);
  ok('convidar usuário inexistente falha', (await P(ana, '/api/metas', { nome: 'Outra', dias: 7, convidados: ['fantasmaquenaoexiste'] }))[0] >= 400);

  // check do dia
  [s, , js] = await P(ana, '/api/metas/' + metaA + '/check');
  ok('check do dia dá 50 XP', s === 201 && js.xp === 50 && js.numero === 1, js);
  ok('2º check no mesmo dia é recusado (409)', (await P(ana, '/api/metas/' + metaA + '/check'))[0] === 409);
  ok('XP aparece no resumo e no ranking', (await G(ana, '/api/resumo'))[2].eu.xp_total >= 50);
  ok('XP guardado na tabela do banco', sql("SELECT xp_total FROM perfis p JOIN usuarios u ON u.id=p.usuario_id WHERE u.usuario='Ana'")[0][0] >= 50);

  // modo prova
  [s, , js] = await P(beto, '/api/metas', { nome: 'Foto diária', dias: 7, modo_prova: true });
  const metaP = js.id;
  ok('modo prova: sem arquivo é recusado', (await P(beto, '/api/metas/' + metaP + '/check'))[0] === 400);
  ok('modo prova: tipo inválido é recusado', (await P(beto, '/api/metas/' + metaP + '/check', { tipo_prova: 'texto' }))[0] === 400);
  ok('modo prova: arquivo > 25 MB é recusado', (await P(beto, '/api/metas/' + metaP + '/check', { tipo_prova: 'foto', arquivo_bytes: 26 * 1024 * 1024 }))[0] === 400);
  [s, , js] = await P(beto, '/api/metas/' + metaP + '/check', { tipo_prova: 'foto', arquivo_nome: 'a.jpg', arquivo_bytes: 1000 });
  ok('modo prova: foto vale check', s === 201 && js.xp === 50, js);
  [s, , js] = await G(beto, '/api/metas/' + metaP);
  ok('prova aparece no chat', js.chat.some((m) => m.tipo_prova === 'foto'), js.chat);

  // chat
  ok('mensagem vazia recusada', (await P(ana, '/api/metas/' + metaA + '/mensagens', { texto: '   ' }))[0] === 400);
  ok('mensagem > 500 caracteres recusada', (await P(ana, '/api/metas/' + metaA + '/mensagens', { texto: 'x'.repeat(501) }))[0] === 400);
  ok('mensagem normal enviada', (await P(ana, '/api/metas/' + metaA + '/mensagens', { texto: 'bora <script>alert(1)</script>' }))[0] === 201);
  [, , js] = await G(beto, '/api/metas/' + metaA);
  ok('o outro membro vê a mensagem', js.chat.some((m) => m.usuario === 'Ana' && m.texto.startsWith('bora')));

  // cutucar
  ok('cutucar a si mesmo: 400', (await P(ana, '/api/cutucar', { usuario: 'Ana' }))[0] === 400);
  ok('cutucar quem não existe: 404', (await P(ana, '/api/cutucar', { usuario: 'ninguemaqui' }))[0] === 404);
  ok('cutucar quem não divide meta: 403', (await P(ana, '/api/cutucar', { usuario: 'Cris' }))[0] === 403);
  ok('cutucar colega de meta: 201', (await P(ana, '/api/cutucar', { usuario: 'Beto' }))[0] === 201);
  ok('cutucar de novo no mesmo dia: 409', (await P(ana, '/api/cutucar', { usuario: 'Beto' }))[0] === 409);
  ok('cutucada aparece no painel do Beto', (await G(beto, '/api/painel'))[2].cutucadas_hoje.includes('Ana'));

  // missões
  [, , js] = await G(ana, '/api/missoes');
  ok('3 missões do dia', js.missoes.length === 3, js);
  const mCut = js.missoes.find((m) => m.titulo.toLowerCase().includes('cutuque'));
  ok('missão de cutucar com progresso', mCut && mCut.progresso >= 1, js.missoes);
  ok('resgatar missão inexistente: 404', (await P(ana, '/api/missoes/inexistente/resgatar'))[0] === 404);
  const incompleta = js.missoes.find((m) => m.progresso < m.quantidade);
  if (incompleta) ok('resgatar missão incompleta: 400', (await P(ana, '/api/missoes/' + incompleta.chave + '/resgatar'))[0] === 400);
  const pronta = js.missoes.find((m) => m.progresso >= m.quantidade);
  if (pronta) {
    const antes = (await G(ana, '/api/resumo'))[2].eu.xp_total;
    [s, , js2] = await P(ana, '/api/missoes/' + pronta.chave + '/resgatar');
    ok('resgatar missão pronta dá XP', s === 200 && js2.xp === pronta.xp, js2);
    ok('XP subiu no banco', (await G(ana, '/api/resumo'))[2].eu.xp_total === antes + pronta.xp);
    ok('resgatar duas vezes: 409', (await P(ana, '/api/missoes/' + pronta.chave + '/resgatar'))[0] === 409);
  }
  ok('carta-desafio sorteada', (await P(ana, '/api/missoes/carta'))[2].carta.length > 0);

  // troféus, ranking, perfil
  [, , js] = await G(ana, '/api/trofeus');
  ok('16 troféus listados', js.trofeus.length === 16);
  ok('"Primeiro passo" conquistado após o 1º check', js.trofeus.find((t) => t.nome.toLowerCase().includes('primeiro')).conquistado === true, js.trofeus.map((t) => t.nome));
  [, , js] = await G(ana, '/api/ranking');
  ok('ranking só tem usuários reais, em ordem', js.top.length >= 3 && js.top.every((x, i, a) => i === 0 || a[i - 1].xp_total >= x.xp_total));
  ok('minha posição existe', js.eu.posicao >= 1);
  [s, , js] = await G(ana, '/api/perfil/Beto');
  ok('perfil de colega abre e permite cutucar', s === 200 && js.pode_cutucar === true && js.eu === false, js);
  ok('perfil não vaza e-mail', !JSON.stringify(js).includes('@jogo.com'));
  [, , js] = await G(ana, '/api/perfil/Cris');
  ok('perfil de estranho: sem metas em comum nem cutucar', js.metas.length === 0 && js.pode_cutucar === false);
  ok('perfil inexistente: 404', (await G(ana, '/api/perfil/naoexiste'))[0] === 404);
  ok('bio de 141 caracteres recusada', (await P(ana, '/api/perfil/bio', { bio: 'x'.repeat(141) }))[0] === 400);
  ok('bio salva', (await P(ana, '/api/perfil/bio', { bio: 'Corro todo dia' }))[0] === 200);
  ok('bio aparece no perfil', (await G(beto, '/api/perfil/Ana'))[2].bio === 'Corro todo dia');
  ok('provas de metas alheias não aparecem no perfil', (await G(cris, '/api/perfil/Beto'))[2].provas_recentes.length === 0);

  // calendário, descobrir, cemitério
  [, , js] = await G(ana, '/api/calendario');
  ok('calendário tem 84 dias e hoje conta 1', js.dias.length === 84 && js.dias[83].qtd >= 1, js.dias[83]);
  ok('calendário informa hoje, criado, ativas e perfeito por dia', typeof js.hoje === 'string' && js.hoje === js.dias[83].data && typeof js.criado === 'string' && js.dias.every((x) => Number.isInteger(x.ativas) && typeof x.perfeito === 'boolean') && js.dias.filter((x) => x.perfeito).length === js.dias_perfeitos, js.dias[83]);
  [, , js] = await G(ana, '/api/descobrir');
  ok('8 metas oficiais', js.modelos.length === 8);
  [s, , js2] = await P(cris, '/api/metas', { modelo: js.modelos[0].chave });
  ok('começar meta oficial', s === 201, js2);
  ok('cemitério começa vazio', (await G(ana, '/api/cemiterio'))[2].metas.length === 0);

  // limites
  const lim = await conta('Lim');
  for (let i = 0; i < 5; i++) await P(lim, '/api/metas', { nome: 'Meta ' + i, dias: 7 });
  ok('6ª meta ativa é recusada', (await P(lim, '/api/metas', { nome: 'Meta 6', dias: 7 }))[0] >= 400);
  ok('só 5 metas no banco para esse usuário', sql("SELECT COUNT(*) FROM membros_meta mm JOIN usuarios u ON u.id=mm.usuario_id WHERE u.usuario='Lim'")[0][0] === 5);
  const nomes8 = [];
  for (let i = 0; i < 8; i++) { await cadastrar('Grp' + i, `grp${i}@jogo.com`); nomes8.push('Grp' + i); }
  [s] = await P(ana, '/api/metas', { nome: 'Grupo cheio', dias: 7, convidados: nomes8.slice(0, 8) });
  ok('mais de 8 pessoas na meta é recusado', s >= 400, s);
  [s, , js] = await P(ana, '/api/metas', { nome: 'Grupo ok', dias: 7, convidados: nomes8.slice(0, 7) });
  ok('exatamente 8 pessoas passa', s === 201, [s, js]);

  // banco: regras que valem mesmo sem passar pela API
  const bd = (q, p) => { try { sql(q, p); return true; } catch (e) { return false; } };
  const exec = (q) => { const c = new DatabaseSync(BANCO); try { c.exec('PRAGMA foreign_keys=ON'); c.exec(q); return true; } catch (e) { return false; } finally { c.close(); } };
  ok('banco recusa meta com 3 dias', !exec("INSERT INTO metas (id, criador_id, categoria, nome, dias, modo_prova) VALUES (999,1,'Nova','Teste',3,0)"));
  ok('banco recusa XP negativo', !exec('UPDATE perfis SET xp_total = -5 WHERE usuario_id = 1'));
  ok('banco recusa 3 salvamentos', !exec('UPDATE membros_meta SET salvamentos = 3'));
  ok('banco recusa check repetido no mesmo dia', (() => {
    const r = sql('SELECT meta_id, usuario_id, dia, numero FROM checks LIMIT 1')[0];
    return !exec(`INSERT INTO checks (meta_id, usuario_id, dia, numero, hora) VALUES (${r[0]}, ${r[1]}, '${r[2]}', 99, 1)`);
  })());
  ok('apagar usuário apaga perfil e checks dele', (() => {
    const id = sql("SELECT id FROM usuarios WHERE usuario='Cris'")[0][0];
    exec('DELETE FROM usuarios WHERE id = ' + id);
    return sql('SELECT COUNT(*) FROM perfis WHERE usuario_id = ' + id)[0][0] === 0 &&
      sql('SELECT COUNT(*) FROM membros_meta WHERE usuario_id = ' + id)[0][0] === 0;
  })());

  // ---------------------------------------------------------------
  titulo('15. Lápide, fantasma e salvamento (datas mexidas direto no banco)');
  const lp = await conta('Lapide');
  [, , js] = await P(lp, '/api/metas', { nome: 'Perder o dia', dias: 10 });
  const metaL = js.id;
  await P(lp, '/api/metas/' + metaL + '/check');
  const idL = sql("SELECT id FROM usuarios WHERE usuario='Lapide'")[0][0];
  const recuar = (dias) => exec(`UPDATE checks SET dia = date(dia,'-${dias} days') WHERE usuario_id = ${idL}; UPDATE membros_meta SET entrou_em = date(entrou_em,'-${dias} days') WHERE usuario_id = ${idL};`);
  recuar(2); // último check há 2 dias: ontem foi o dia perdido => lápide
  [, , js] = await G(lp, '/api/painel');
  let cartao = js.metas.find((m) => m.id === metaL);
  ok('dia perdido ontem: meta vira lápide', cartao.estado === 'lapide', cartao);
  ok('lápide mostra horas restantes', cartao.horas_restantes > 0 && cartao.salvamentos === 2, cartao);
  ok('salvar sem prova é recusado', (await P(lp, '/api/metas/' + metaL + '/check'))[0] === 400);
  [s, , js] = await P(lp, '/api/metas/' + metaL + '/check', { tipo_prova: 'audio' });
  ok('salvar com prova: +30 XP e volta a ativa', s === 201 && js.salvou === true && js.xp === 30, js);
  [, , js] = await G(lp, '/api/painel');
  cartao = js.metas.find((m) => m.id === metaL);
  ok('depois de salvar: ativa com 1 salvamento a menos', cartao.estado === 'ativa' && cartao.salvamentos === 1, cartao);

  // fantasma por prazo vencido
  const xpAntes = (await G(lp, '/api/resumo'))[2].eu.xp_total;
  recuar(5);
  [, , js] = await G(lp, '/api/painel');
  cartao = js.metas.find((m) => m.id === metaL);
  ok('prazo da lápide vencido: vira fantasma', cartao.estado === 'fantasma', cartao);
  const xpDepois = (await G(lp, '/api/resumo'))[2].eu.xp_total;
  ok('fantasma perde 50 XP (sem ficar negativo)', xpDepois === Math.max(0, xpAntes - 50), [xpAntes, xpDepois]);
  ok('fantasma não faz check', (await P(lp, '/api/metas/' + metaL + '/check', { tipo_prova: 'foto' }))[0] === 403);
  ok('fantasma não fala no chat', (await P(lp, '/api/metas/' + metaL + '/mensagens', { texto: 'oi' }))[0] === 403);
  ok('cemitério mostra a meta', (await G(lp, '/api/cemiterio'))[2].metas.some((m) => m.nome === 'Perder o dia'));
  ok('recarregar não tira XP duas vezes', (await G(lp, '/api/resumo'))[2].eu.xp_total === xpDepois);
  ok('fantasma liberou vaga nas metas ativas', sql(`SELECT COUNT(*) FROM membros_meta WHERE usuario_id=${idL} AND estado IN ('ativa','lapide')`)[0][0] === 0);

  // fantasma por falta de salvamento
  [, , js] = await P(lp, '/api/metas', { nome: 'Sem salvamentos', dias: 10 });
  const metaS = js.id;
  await P(lp, '/api/metas/' + metaS + '/check');
  exec(`UPDATE membros_meta SET salvamentos = 0 WHERE meta_id = ${metaS}; UPDATE checks SET dia = date(dia,'-2 days') WHERE meta_id = ${metaS}; UPDATE membros_meta SET entrou_em = date(entrou_em,'-2 days') WHERE meta_id = ${metaS};`);
  [, , js] = await G(lp, '/api/painel');
  ok('sem salvamentos: vira fantasma direto', js.metas.find((m) => m.id === metaS).estado === 'fantasma');

  // concluir meta
  const cc = await conta('Conclui');
  [, , js] = await P(cc, '/api/metas', { nome: 'Sprint de 7', dias: 7 });
  const metaC = js.id, idC = sql("SELECT id FROM usuarios WHERE usuario='Conclui'")[0][0];
  for (let i = 0; i < 6; i++) {
    // 6 dias seguidos de histórico, terminando ontem
    exec(`INSERT INTO checks (meta_id, usuario_id, dia, numero, hora) VALUES (${metaC}, ${idC}, date('now','-3 hours','-${6 - i} days'), ${i + 1}, 8)`);
  }
  exec(`UPDATE membros_meta SET dias_cumpridos = 6, entrou_em = date('now','-3 hours','-6 days') WHERE meta_id = ${metaC}`);
  [s, , js] = await P(cc, '/api/metas/' + metaC + '/check');
  ok('7º dia conclui a meta: +50 +100 XP', s === 201 && js.concluiu === true && js.xp === 150, js);
  ok('meta concluída aparece como concluida', (await G(cc, '/api/painel'))[2].metas.find((m) => m.id === metaC).estado === 'concluida');
  ok('"Meta cumprida" conquistado', (await G(cc, '/api/trofeus'))[2].trofeus.some((t) => t.conquistado && t.nome.toLowerCase().includes('meta cumprida')));
  ok('nível calculado pelo XP total', (await G(cc, '/api/resumo'))[2].eu.nivel === 1 + Math.floor((await G(cc, '/api/resumo'))[2].eu.xp_total / 1000));

  // senhas e sessões continuam só no banco, nunca em texto puro
  ok('nenhuma senha em texto puro no banco', sql("SELECT COUNT(*) FROM usuarios WHERE senha_hash NOT LIKE 'scrypt$%'")[0][0] === 0);

  // ---------------------------------------------------------------
  titulo('16. Esqueci minha senha (código por e-mail)');
  const codigoDe = async (email) => {
    for (let i = 0; i < 30; i++) {
      const todos = [...saidaServidor.matchAll(new RegExp('Código de recuperação para ' + email.replace(/[.]/g, '\\.') + ': (\\d{6})', 'g'))];
      if (todos.length) return todos[todos.length - 1][1];
      await esperar(50);
    }
    return null;
  };
  const pedirCod = (email) => req('POST', '/api/esqueci', { corpo: { email: email } });
  const redef = (email, codigo, senha, conf) =>
    req('POST', '/api/redefinir', { corpo: { email: email, codigo: codigo, senha: senha, confirmar: conf === undefined ? senha : conf } });

  ok('arquivos internos não são servidos',
    (await req('GET', '/email.js'))[0] === 404 && (await req('GET', '/email.json'))[0] === 404 && (await req('GET', '/api.js'))[0] === 404 && (await req('GET', '/dados.js'))[0] === 404);
  ok('esqueci: e-mail inválido é recusado', (await pedirCod('isso-nao-e-email'))[0] === 400);
  ok('esqueci: origem de outro site é bloqueada',
    (await req('POST', '/api/esqueci', { corpo: { email: 'a@b.com' }, headers: { Origin: 'http://site-malvado.com' } }))[0] === 403);

  await cadastrar('Recupera', 'recupera@gmail.com');
  const [, cabR] = await login('recupera@gmail.com', 'Senha123');
  const sessaoAntiga = cookieDe(cabR);
  [s, , js1] = await pedirCod('recupera@gmail.com');
  [, , js2] = await pedirCod('ninguem-existe@gmail.com');
  ok('resposta igual para e-mail que existe e que não existe', s === 200 && JSON.stringify(js1) === JSON.stringify(js2), [js1, js2]);
  const cod1 = await codigoDe('recupera@gmail.com');
  ok('código de 6 dígitos foi gerado', /^\d{6}$/.test(cod1 || ''), cod1);
  ok('e-mail sem conta não recebe código', !saidaServidor.includes('ninguem-existe@gmail.com: '));
  ok('banco guarda só o hash do código',
    (() => { const l = sql('SELECT codigo_hash FROM recuperacoes_senha')[0]; return l[0].length === 64 && l[0] !== cod1; })());
  ok('código vale por 15 minutos',
    (() => { const l = sql('SELECT expira_em - criado_em FROM recuperacoes_senha')[0]; return l[0] === 900; })());

  ok('código errado é recusado', (await redef('recupera@gmail.com', cod1 === '000000' ? '111111' : '000000', 'NovaSenha1'))[0] === 400);
  ok('código com letras é recusado', (await redef('recupera@gmail.com', 'abcdef', 'NovaSenha1'))[0] === 400);
  ok('senha fraca é recusada (e o código não é gasto)', (await redef('recupera@gmail.com', cod1, 'curta'))[0] === 400);
  ok('senhas diferentes são recusadas', (await redef('recupera@gmail.com', cod1, 'NovaSenha1', 'Outra1234'))[0] === 400);
  ok('código de outro e-mail não serve', (await redef('ninguem-existe@gmail.com', cod1, 'NovaSenha1'))[0] === 400);

  [s, , js] = await redef('recupera@gmail.com', cod1, 'NovaSenha1');
  ok('código certo + senha boa: senha trocada', s === 200 && js.ok === true, [s, js]);
  ok('senha antiga não entra mais', (await login('recupera@gmail.com', 'Senha123'))[0] === 401);
  ok('senha nova entra', (await login('recupera@gmail.com', 'NovaSenha1'))[0] === 200);
  ok('sessão antiga foi encerrada', (await req('GET', '/api/eu', { cookie: sessaoAntiga }))[0] === 401);
  ok('o mesmo código não funciona duas vezes', (await redef('recupera@gmail.com', cod1, 'OutraSenha2'))[0] === 400);
  ok('hash novo no banco (nunca texto puro)', sql("SELECT COUNT(*) FROM usuarios WHERE email='recupera@gmail.com' AND senha_hash LIKE 'scrypt$%'")[0][0] === 1);

  // código novo cancela o anterior
  await cadastrar('Recupera2', 'recupera2@gmail.com');
  await pedirCod('recupera2@gmail.com');
  const velho = await codigoDe('recupera2@gmail.com');
  await esperar(20);
  await pedirCod('recupera2@gmail.com');
  await esperar(100);
  const novo = await (async () => { for (let i = 0; i < 30; i++) { const t = [...saidaServidor.matchAll(/recupera2@gmail\.com: (\d{6})/g)]; if (t.length >= 2) return t[t.length - 1][1]; await esperar(50); } return null; })();
  if (velho !== novo) ok('pedir outro código invalida o anterior', (await redef('recupera2@gmail.com', velho, 'NovaSenha1'))[0] === 400);
  ok('só 1 código ativo por usuário', sql("SELECT COUNT(*) FROM recuperacoes_senha r JOIN usuarios u ON u.id=r.usuario_id WHERE u.email='recupera2@gmail.com'")[0][0] === 1);

  // código expirado
  exec("UPDATE recuperacoes_senha SET criado_em = criado_em - 2000, expira_em = expira_em - 2000 WHERE usuario_id = (SELECT id FROM usuarios WHERE email='recupera2@gmail.com')");
  ok('código expirado é recusado', (await redef('recupera2@gmail.com', novo, 'NovaSenha1'))[0] === 400);

  // tentativas: 5 erros queimam o código, mesmo que depois acerte
  await cadastrar('Recupera3', 'recupera3@gmail.com');
  await pedirCod('recupera3@gmail.com');
  const cod3 = await codigoDe('recupera3@gmail.com');
  const errado = cod3 === '123456' ? '654321' : '123456';
  let ultimo = 0;
  for (let i = 0; i < 5; i++) ultimo = (await redef('recupera3@gmail.com', errado, 'NovaSenha1'))[0];
  ok('5 códigos errados seguidos', ultimo === 400, ultimo);
  s = (await redef('recupera3@gmail.com', cod3, 'NovaSenha1'))[0];
  ok('depois de 5 erros, nem o código certo vale', s === 400 || s === 429, s);
  ok('senha da conta não mudou', (await login('recupera3@gmail.com', 'Senha123'))[0] === 200);

  // limite de pedidos
  await pedirCod('limite@gmail.com'); await pedirCod('limite@gmail.com'); await pedirCod('limite@gmail.com');
  ok('4º pedido de código para o mesmo e-mail: 429', (await pedirCod('limite@gmail.com'))[0] === 429);

  // envio de e-mail de verdade (SMTP) contra um servidor falso
  const { enviarEmail, lerConfig } = require('./email.js');
  const comandos = [];
  const smtp = net.createServer((c) => {
    let fase = 'cmd'; let buf = '';
    c.write('220 falso pronto\r\n');
    c.on('data', (d) => {
      buf += d.toString('utf-8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0 || (fase === 'dados' && buf.includes('\r\n.\r\n'))) {
        if (fase === 'dados') {
          const fim = buf.indexOf('\r\n.\r\n');
          if (fim < 0) break;
          comandos.push('DADOS:' + buf.slice(0, fim));
          buf = buf.slice(fim + 5); fase = 'cmd'; c.write('250 ok\r\n'); continue;
        }
        const l = buf.slice(0, i); buf = buf.slice(i + 2);
        comandos.push(l);
        if (l.startsWith('EHLO')) c.write('250-falso\r\n250 AUTH LOGIN\r\n');
        else if (l === 'AUTH LOGIN') c.write('334 VXNlcm5hbWU6\r\n');
        else if (comandos[comandos.length - 2] === 'AUTH LOGIN') c.write('334 UGFzc3dvcmQ6\r\n');
        else if (comandos[comandos.length - 3] === 'AUTH LOGIN') c.write(Buffer.from(l, 'base64').toString() === 'segredo' ? '235 ok\r\n' : '535 senha errada\r\n');
        else if (l.startsWith('MAIL FROM') || l.startsWith('RCPT TO')) c.write('250 ok\r\n');
        else if (l === 'DATA') { fase = 'dados'; c.write('354 manda\r\n'); }
        else if (l === 'QUIT') c.end('221 tchau\r\n');
      }
    });
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  const cfgFalso = { host: '127.0.0.1', porta: smtp.address().port, usuario: 'thirtyly@gmail.com', senha: 'segredo', de: 'thirtyly@gmail.com', tls: false };
  let erroSmtp = null;
  try { await enviarEmail(cfgFalso, 'cliente@gmail.com', 'Código: ação', 'Seu código é 123456'); } catch (e) { erroSmtp = e; }
  ok('SMTP: e-mail enviado sem erro', erroSmtp === null, erroSmtp && erroSmtp.message);
  ok('SMTP: remetente e destinatário corretos', comandos.includes('MAIL FROM:<thirtyly@gmail.com>') && comandos.includes('RCPT TO:<cliente@gmail.com>'), comandos);
  const dadosMsg = (comandos.find((c) => c.startsWith('DADOS:')) || '');
  ok('SMTP: corpo contém o código (base64, UTF-8)', Buffer.from(dadosMsg.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf-8') === 'Seu código é 123456');
  ok('SMTP: assunto com acento vai codificado', dadosMsg.includes('Subject: =?UTF-8?B?'));
  let erroAuth = null;
  try { await enviarEmail(Object.assign({}, cfgFalso, { senha: 'errada' }), 'cliente@gmail.com', 'x', 'y'); } catch (e) { erroAuth = e; }
  ok('SMTP: senha de e-mail errada dá erro', erroAuth !== null && /535/.test(erroAuth.message), erroAuth && erroAuth.message);
  let erroInj = null;
  comandos.length = 0;
  try { await enviarEmail(cfgFalso, 'a@b.com\r\nRCPT TO:<outro@x.com>', 'x', 'y'); } catch (e) { erroInj = e; }
  ok('SMTP: quebra de linha no destinatário não injeta comandos', !comandos.some((c) => c === 'RCPT TO:<outro@x.com>'), comandos);
  smtp.close();
  delete process.env.THIRTYLY_EMAIL_USUARIO; delete process.env.THIRTYLY_EMAIL_SENHA;
  ok('sem configuração, o servidor roda em modo local', lerConfig(path.join(TMP, 'pasta-vazia')) === null);

  titulo('17. Um único schema.sql (MySQL e projeto) e dados no JavaScript');
  {
    const semComentario = (x) => x.replace(/--.*$/gm, '');
    const bruto = fs.readFileSync(path.join(PASTA, 'schema.sql'), 'utf-8');
    const sqlPuro = semComentario(bruto);
    const dados = require('./dados.js');
    const servidorFonte = fs.readFileSync(path.join(PASTA, 'servidor.js'), 'utf-8');

    ok('existe só um arquivo SQL e não existe banco.js',
      fs.readdirSync(PASTA).filter((n) => n.endsWith('.sql')).join() === 'schema.sql' && !fs.existsSync(path.join(PASTA, 'banco.js')));
    ok('servidor.js carrega o schema.sql direto, sem trocas', /db\.exec\(fs\.readFileSync\(path\.join\(PASTA, 'schema\.sql'\), 'utf-8'\)\)/.test(servidorFonte) && !/adaptar|banco\.js/.test(servidorFonte));
    ok('nenhuma coluna TEXT (só VARCHAR)', !/\bTEXT\b/.test(sqlPuro));
    ok('sem emojis no SQL', !/\p{Extended_Pictographic}/u.test(bruto));
    ok('sem sintaxe só de SQLite (AUTOINCREMENT, PRAGMA, strftime, INSERT OR, COLLATE NOCASE, ON CONFLICT)',
      !/AUTOINCREMENT|PRAGMA|strftime|INSERT OR|COLLATE NOCASE|WITHOUT ROWID|ON CONFLICT/i.test(sqlPuro));
    ok('sem sintaxe só de MySQL (AUTO_INCREMENT, ENGINE, CHARSET, COLLATE, INSERT IGNORE, DELIMITER, TRIGGER, crases)',
      !/AUTO_INCREMENT|ENGINE\s*=|CHARSET|COLLATE|INSERT IGNORE|ON DUPLICATE|DELIMITER|TRIGGER|SIGNAL|UNSIGNED|`/i.test(sqlPuro));
    ok('sem CREATE DATABASE/USE dentro (o SQLite não tem)', !/CREATE DATABASE|^\s*USE\s/im.test(sqlPuro));
    ok('simples: sem INSERT de dados e sem CREATE INDEX', !/\bINSERT\b|CREATE INDEX|CREATE (UNIQUE )?INDEX/i.test(sqlPuro));
    const tiposUsados = new Set([...sqlPuro.matchAll(/^\s{2}\w+ (INTEGER|BIGINT|TINYINT|VARCHAR\(\d+\)|DATETIME)(?=[\s,]|$)/gm)].map((m) => m[1].replace(/\(\d+\)/, '')));
    ok('só tipos que existem nos dois bancos: INTEGER, BIGINT, TINYINT, VARCHAR, DATETIME', [...tiposUsados].sort().join() === 'BIGINT,DATETIME,INTEGER,TINYINT,VARCHAR', [...tiposUsados]);
    ok('toda chave estrangeira é FOREIGN KEY no fim da tabela (REFERENCES em linha é ignorado pelo MySQL)',
      !/^\s{2}(?!FOREIGN)\w+ [A-Z]+(\(\d+\))?[^,\n]*\bREFERENCES\b/m.test(sqlPuro) && (sqlPuro.match(/FOREIGN KEY/g) || []).length === 13);

    const corpo = [...sqlPuro.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)];
    ok('13 tabelas', corpo.length === 13, corpo.map((m) => m[1]));
    const criadas = []; let ordemOk = true;
    for (const m of corpo) {
      for (const x of m[2].matchAll(/REFERENCES (\w+) \(/g)) if (!criadas.includes(x[1])) { ordemOk = false; console.log('   FK para tabela ainda não criada:', m[1], '->', x[1]); }
      criadas.push(m[1]);
    }
    ok('MySQL: toda tabela só referencia tabelas criadas antes dela', ordemOk);
    const conflito = [];
    for (const m of corpo) {
      const fk = new Set();
      for (const x of m[2].matchAll(/FOREIGN KEY \(([^)]*)\)/g)) x[1].split(',').forEach((c) => fk.add(c.trim()));
      for (const c of m[2].matchAll(/CHECK \(([^\n]*?)\)(?:,|\s*$)/gm)) for (const col of fk) if (new RegExp('\\b' + col + '\\b').test(c[1])) conflito.push(m[1] + '.' + col);
    }
    ok('MySQL: nenhuma coluna de chave estrangeira dentro de um CHECK', conflito.length === 0, conflito);
    ok('MySQL: tabelas sem AUTO_INCREMENT têm o id gerado pelo JavaScript (INTEGER PRIMARY KEY só em usuarios, metas, mensagens)',
      [...sqlPuro.matchAll(/^\s{2}id INTEGER PRIMARY KEY/gm)].length === 3);

    // o arquivo, do jeito que está, roda duas vezes num SQLite novo
    const mem = new DatabaseSync(':memory:');
    mem.exec('PRAGMA foreign_keys = ON');
    let erroRodar = null;
    try { mem.exec(bruto); mem.exec(bruto); } catch (e) { erroRodar = e.message; }
    ok('o schema.sql, sem nenhuma troca, roda duas vezes seguidas sem erro', erroRodar === null, erroRodar);
    ok('13 tabelas criadas no SQLite', Number(mem.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n) === 13);
    mem.close();

    // dados no JavaScript
    const unicas = (lista) => new Set(lista.map((x) => x.chave)).size === lista.length;
    ok('dados.js: 16 troféus, 3 missões, 4 cartas, 8 metas oficiais (chaves únicas)',
      dados.TROFEUS.length === 16 && dados.MISSOES.length === 3 && dados.CARTAS.length === 4 && dados.METAS_OFICIAIS.length === 8 &&
      unicas(dados.TROFEUS) && unicas(dados.MISSOES) && unicas(dados.METAS_OFICIAIS));
    ok('dados.js: sem emojis e metas oficiais dentro dos limites (7 a 90 dias, nome de 3 a 60)',
      !/\p{Extended_Pictographic}/u.test(JSON.stringify(dados)) && dados.METAS_OFICIAIS.every((m) => m.dias >= 7 && m.dias <= 90 && m.nome.length >= 3 && m.nome.length <= 60));
    ok('chaves do dados.js cabem nas colunas VARCHAR',
      dados.TROFEUS.every((x) => x.chave.length <= 30) && dados.MISSOES.every((x) => x.chave.length <= 20) && dados.METAS_OFICIAIS.every((x) => x.chave.length <= 30));
    ok('dados.js e schema.sql não são servidos ao navegador', (await req('GET', '/dados.js'))[0] === 404 && (await req('GET', '/schema.sql'))[0] === 404);

    // banco antigo é guardado, não apagado
    const pastaVelha = fs.mkdtempSync(path.join(os.tmpdir(), 'velho-'));
    const bancoVelho = path.join(pastaVelha, 't.db');
    const velho = new DatabaseSync(bancoVelho);
    velho.exec("CREATE TABLE usuarios (id INTEGER PRIMARY KEY, usuario TEXT); CREATE TABLE trofeus (id INTEGER PRIMARY KEY, emoji TEXT); INSERT INTO usuarios VALUES (1, 'Antigo')");
    velho.close();
    const filho = spawn(process.execPath, ['--no-warnings', path.join(PASTA, 'servidor.js')],
      { env: Object.assign({}, process.env, { PORT: String(PORTA + 7), THIRTYLY_BANCO: bancoVelho }), stdio: 'ignore' });
    await esperar(1800);
    filho.kill();
    const arquivos = fs.readdirSync(pastaVelha);
    const guardado = arquivos.find((n) => n.includes('.antigo-'));
    ok('banco de versão antiga é guardado com outro nome (nada é apagado)', Boolean(guardado), arquivos);
    ok('os dados antigos continuam no arquivo guardado',
      (() => { if (!guardado) return false; const c = new DatabaseSync(path.join(pastaVelha, guardado)); const n = Number(c.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n); c.close(); return n === 1; })());
    ok('e um banco novo foi criado no lugar',
      (() => { const c = new DatabaseSync(bancoVelho); const n = Number(c.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n); c.close(); return n === 13; })());
  }

  titulo('12. Reiniciar o servidor');
  [s, cab] = await login('fernando@email.com', 'Senha123');
  const c3 = cookieDe(cab);
  await parar();
  await subir();
  ok('conta continua existindo depois de reiniciar', (await login('fernando@email.com', 'Senha123'))[0] === 200);
  ok('sessão continua valida depois de reiniciar', (await req('GET', '/api/eu', { cookie: c3 }))[0] === 200);

  titulo('13. Bloqueio por IP');
  for (let i = 0; i < 35; i++) await login(`ninguem${i}@email.com`, 'qualquer');
  [s] = await login('fernando@email.com', 'Senha123');
  ok('muitas falhas do mesmo IP bloqueiam novos logins (429)', s === 429, s);
}

main().catch((e) => {
  console.error(e);
  parar().then(() => process.exit(1));
});
