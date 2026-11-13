'use strict';
/* Envio de e-mail (SMTP) sem instalar nada: só usa o que já vem no Node.
 *
 * Para o Thirtyly mandar o código de "esqueci minha senha" de verdade, crie o
 * arquivo email.json (copie o email.exemplo.json) com seu Gmail e uma
 * "senha de app" do Google. Sem esse arquivo, o servidor roda em MODO LOCAL:
 * o código aparece no terminal em vez de ir por e-mail.
 *
 * Este arquivo NÃO é servido ao navegador.
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');

// Lê a configuração de e-mail (variáveis de ambiente ou email.json). null = modo local.
function lerConfig(pasta) {
  const env = process.env;
  let arq = {};
  try {
    arq = JSON.parse(fs.readFileSync(path.join(pasta, 'email.json'), 'utf-8'));
  } catch (e) {
    arq = {};
  }
  const usuario = String(env.THIRTYLY_EMAIL_USUARIO || arq.usuario || '').trim();
  const senha = String(env.THIRTYLY_EMAIL_SENHA || arq.senha || '').replace(/\s+/g, '');
  if (!usuario || !senha) return null;
  return {
    host: String(env.THIRTYLY_EMAIL_HOST || arq.host || 'smtp.gmail.com'),
    porta: parseInt(env.THIRTYLY_EMAIL_PORTA || arq.porta || '465', 10),
    usuario: usuario,
    senha: senha,
    de: String(env.THIRTYLY_EMAIL_DE || arq.de || usuario),
    tls: true,
  };
}

function limpar(s) {
  return String(s).replace(/[\r\n]+/g, ' ').trim();
}

function montarMensagem(cfg, para, assunto, texto) {
  const corpo = Buffer.from(texto, 'utf-8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    'From: Thirtyly <' + limpar(cfg.de) + '>',
    'To: <' + limpar(para) + '>',
    'Subject: =?UTF-8?B?' + Buffer.from(limpar(assunto), 'utf-8').toString('base64') + '?=',
    'Date: ' + new Date().toUTCString(),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    corpo,
    '',
  ].join('\r\n');
}

// Envia um e-mail. Devolve uma Promise que falha se o servidor de e-mail recusar.
function enviarEmail(cfg, para, assunto, texto) {
  return new Promise((resolve, reject) => {
    const opcoes = { host: cfg.host, port: cfg.porta };
    const socket = cfg.tls ? tls.connect(Object.assign({ servername: cfg.host }, opcoes)) : net.connect(opcoes);
    let pendente = '';
    let esperando = null;
    let terminou = false;

    const acabar = (erro) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(limite);
      socket.destroy();
      if (erro) reject(erro); else resolve();
    };
    const limite = setTimeout(() => acabar(new Error('o servidor de e-mail demorou demais')), 20000);

    socket.setEncoding('utf-8');
    socket.on('error', (e) => acabar(e));
    socket.on('close', () => acabar(new Error('conexão com o servidor de e-mail encerrada')));
    socket.on('data', (pedaco) => {
      pendente += pedaco;
      const linhas = pendente.split('\r\n');
      pendente = linhas.pop();
      for (const l of linhas) {
        // Resposta termina na linha "NNN texto" (com espaço); "NNN-texto" continua.
        const m = /^(\d{3})([ -])/.exec(l);
        if (m && m[2] === ' ' && esperando) {
          const f = esperando;
          esperando = null;
          f(Number(m[1]), l);
        }
      }
    });

    const resposta = () => new Promise((ok) => { esperando = (codigo, linha) => ok({ codigo, linha }); });
    const passo = async (comando, esperado) => {
      if (comando !== null) socket.write(comando + '\r\n');
      const r = await resposta();
      if (r.codigo !== esperado) throw new Error('o servidor de e-mail respondeu: ' + r.linha);
    };

    (async () => {
      await passo(null, 220);
      await passo('EHLO thirtyly.local', 250);
      await passo('AUTH LOGIN', 334);
      await passo(Buffer.from(cfg.usuario).toString('base64'), 334);
      await passo(Buffer.from(cfg.senha).toString('base64'), 235);
      await passo('MAIL FROM:<' + limpar(cfg.usuario) + '>', 250);
      await passo('RCPT TO:<' + limpar(para) + '>', 250);
      await passo('DATA', 354);
      socket.write(montarMensagem(cfg, para, assunto, texto) + '.\r\n');
      const fim = await resposta();
      if (fim.codigo !== 250) throw new Error('o servidor de e-mail respondeu: ' + fim.linha);
      socket.write('QUIT\r\n');
    })().then(() => acabar(null), (e) => acabar(e));
  });
}

module.exports = { lerConfig, enviarEmail };
