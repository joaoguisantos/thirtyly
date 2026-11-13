'use strict';
/* Regras do jogo do Thirtyly. Tudo que o painel mostra ou muda passa por aqui
 * e fica gravado no banco (veja schema.sql). O navegador só pede e exibe.
 *
 * Este arquivo NÃO é servido ao navegador: só o servidor.js o usa.
 */

const { TROFEUS, MISSOES, CARTAS, METAS_OFICIAIS } = require('./dados.js');

const FUSO = process.env.THIRTYLY_FUSO || 'America/Sao_Paulo';

const XP_DIA = 50;
const XP_SALVAMENTO = 30;
const XP_CONCLUIR = 100;
const XP_FANTASMA = -50;
const XP_POR_NIVEL = 1000;
const MAX_PESSOAS = 8;
const MAX_METAS_ATIVAS = 5;
const MAX_ARQUIVO = 26214400; // 25 MB
const TIPOS_PROVA = ['foto', 'video', 'audio'];

class ErroApi extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

// ---------- datas (sempre no fuso do Brasil, como texto AAAA-MM-DD) ----------

const fmtData = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
});
const fmtHora = new Intl.DateTimeFormat('en-GB', {
  timeZone: FUSO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function hoje() {
  return fmtData.format(new Date());
}

function horaMinutoAgora() {
  const partes = fmtHora.formatToParts(new Date());
  const h = Number(partes.find((p) => p.type === 'hour').value);
  const m = Number(partes.find((p) => p.type === 'minute').value);
  return [h, m];
}

function horasAteFimDoDia() {
  const [h, m] = horaMinutoAgora();
  return Math.max(1, Math.ceil((24 * 60 - (h * 60 + m)) / 60));
}

function somarDias(data, n) {
  const d = new Date(data + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function diffDias(a, b) {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
}

// ---------- validação ----------

function texto(valor) {
  return typeof valor === 'string' ? valor.trim() : '';
}

function inteiro(valor) {
  return typeof valor === 'number' && Number.isInteger(valor) ? valor : null;
}

// O banco não gera IDs sozinho (para o schema.sql valer igual no MySQL e no SQLite):
// o próximo ID é o maior que existe + 1. Só as tabelas abaixo têm ID.
const TABELAS_COM_ID = ['usuarios', 'metas', 'mensagens'];

function proximoId(db, tabela) {
  if (!TABELAS_COM_ID.includes(tabela)) throw new Error('tabela sem id: ' + tabela);
  return Number(db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM ' + tabela).get().id);
}

function nivelDe(xpTotal) {
  return { nivel: 1 + Math.floor(xpTotal / XP_POR_NIVEL), xp_nivel: xpTotal % XP_POR_NIVEL };
}

// =====================================================================

function criarApi(db) {
  const um = (sql, ...p) => db.prepare(sql).get(...p);
  const todos = (sql, ...p) => db.prepare(sql).all(...p);
  const rodar = (sql, ...p) => db.prepare(sql).run(...p);

  function tx(funcao) {
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

  // ---------- XP ----------

  function xpDe(uid) {
    const linha = um('SELECT xp_total FROM perfis WHERE usuario_id = ?', uid);
    if (linha) return linha.xp_total;
    rodar('INSERT INTO perfis (usuario_id) VALUES (?)', uid); // conta antiga sem perfil
    return 0;
  }

  // Nunca deixa o XP ficar negativo. Devolve quanto realmente mudou.
  function darXp(uid, qtd) {
    const delta = Math.max(qtd, -xpDe(uid));
    if (delta === 0) return 0;
    rodar('UPDATE perfis SET xp_total = xp_total + ? WHERE usuario_id = ?', delta, uid);
    return delta;
  }

  // ---------- sequências ----------

  function sequencias(uid) {
    const datas = todos('SELECT DISTINCT dia FROM checks WHERE usuario_id = ? ORDER BY dia', uid)
      .map((r) => r.dia);
    let melhor = 0;
    let corrida = 0;
    let anterior = null;
    for (const d of datas) {
      corrida = anterior && diffDias(d, anterior) === 1 ? corrida + 1 : 1;
      if (corrida > melhor) melhor = corrida;
      anterior = d;
    }
    const h = hoje();
    let atual = 0;
    if (datas.length) {
      const ultimo = datas[datas.length - 1];
      if (ultimo === h || ultimo === somarDias(h, -1)) atual = corrida;
    }
    return { atual, melhor };
  }

  // ---------- lápide e fantasma (lido do calendário, não de um relógio) ----------
  //
  // Dia perdido = o primeiro dia depois do último check (ou o dia em que entrou)
  // que já passou sem check. No dia seguinte a pessoa fica na lápide e pode salvar.
  // Passado esse dia (ou sem salvamentos), vira fantasma e perde 50 XP.
  function atualizarEstados(uid) {
    const h = hoje();
    const linhas = todos(
      `SELECT mm.meta_id, mm.estado, mm.entrou_em, mm.salvamentos,
              (SELECT MAX(c.dia) FROM checks c
                WHERE c.meta_id = mm.meta_id AND c.usuario_id = mm.usuario_id) AS ultimo
         FROM membros_meta mm
        WHERE mm.usuario_id = ? AND mm.estado IN ('ativa', 'lapide')`, uid);
    for (const r of linhas) {
      const perdido = r.ultimo ? somarDias(r.ultimo, 1) : r.entrou_em;
      if (perdido >= h) continue; // ainda dá tempo de marcar hoje
      if (h >= somarDias(perdido, 2) || r.salvamentos === 0) {
        tx(() => {
          rodar(`UPDATE membros_meta SET estado = 'fantasma', fantasma_em = ?
                  WHERE meta_id = ? AND usuario_id = ?`, h, r.meta_id, uid);
          darXp(uid, XP_FANTASMA);
        });
      } else if (r.estado !== 'lapide') {
        rodar(`UPDATE membros_meta SET estado = 'lapide' WHERE meta_id = ? AND usuario_id = ?`,
          r.meta_id, uid);
      }
    }
  }

  // ---------- missões ----------

  function avancarMissao(uid, chave, n) {
    const missao = MISSOES.find((x) => x.chave === chave);
    const h = hoje();
    const linha = um('SELECT progresso FROM missoes_usuario WHERE usuario_id = ? AND missao = ? AND dia = ?',
      uid, chave, h);
    if (!linha) {
      rodar('INSERT INTO missoes_usuario (usuario_id, missao, dia, progresso) VALUES (?, ?, ?, ?)',
        uid, chave, h, Math.min(missao.quantidade, n || 1));
      return;
    }
    rodar('UPDATE missoes_usuario SET progresso = ? WHERE usuario_id = ? AND missao = ? AND dia = ?',
      Math.min(missao.quantidade, linha.progresso + (n || 1)), uid, chave, h);
  }

  // ---------- troféus ----------

  function avaliarTrofeus(uid) {
    const n = (sql, ...p) => Number(um(sql, ...p).n);
    const xp = xpDe(uid);
    const posicao = 1 + n('SELECT COUNT(*) AS n FROM perfis WHERE xp_total > ?', xp);
    const cond = {
      primeiro_passo: n('SELECT COUNT(*) AS n FROM checks WHERE usuario_id = ?', uid) >= 1,
      semana_de_fogo: sequencias(uid).melhor >= 7,
      prova_real: n('SELECT COUNT(*) AS n FROM checks WHERE usuario_id = ? AND tipo_prova IS NOT NULL', uid) >= 10,
      voz_da_meta: n("SELECT COUNT(*) AS n FROM checks WHERE usuario_id = ? AND tipo_prova = 'audio'", uid) >= 5,
      voltei_dos_mortos: n('SELECT COUNT(*) AS n FROM checks WHERE usuario_id = ? AND salvamento = 1', uid) >= 1,
      meta_cumprida: n("SELECT COUNT(*) AS n FROM membros_meta WHERE usuario_id = ? AND estado = 'concluida'", uid) >= 1,
      time_unido: n(`SELECT COUNT(*) AS n FROM membros_meta mm
                      WHERE mm.usuario_id = ?
                        AND (SELECT COUNT(*) FROM membros_meta x WHERE x.meta_id = mm.meta_id) >= 5`, uid) >= 1,
      mes_perfeito: n(`SELECT COUNT(*) AS n FROM membros_meta mm JOIN metas m ON m.id = mm.meta_id
                        WHERE mm.usuario_id = ? AND mm.estado = 'concluida'
                          AND m.dias >= 30 AND mm.salvamentos = 2`, uid) >= 1,
      rei_das_cobrancas: n('SELECT COUNT(*) AS n FROM cutucadas WHERE de_id = ?', uid) >= 20,
      madrugador: n('SELECT COUNT(*) AS n FROM checks WHERE usuario_id = ? AND hora < 7 AND tipo_prova IS NOT NULL', uid) >= 7,
      meta_de_ferro: n(`SELECT COUNT(*) AS n FROM membros_meta mm JOIN metas m ON m.id = mm.meta_id
                         WHERE mm.usuario_id = ? AND mm.estado = 'concluida' AND m.dias = 90`, uid) >= 1,
      top_10: xp > 0 && posicao <= 10,
      corrente: n("SELECT COUNT(*) AS n FROM membros_meta WHERE usuario_id = ? AND estado = 'concluida'", uid) >= 3,
      mestre_das_provas: n('SELECT COUNT(*) AS n FROM checks WHERE usuario_id = ? AND tipo_prova IS NOT NULL', uid) >= 100,
      nivel_20: nivelDe(xp).nivel >= 20,
      sobrevivente:
        n("SELECT COUNT(*) AS n FROM membros_meta WHERE usuario_id = ? AND estado = 'concluida'", uid) >= 1 &&
        n("SELECT COUNT(*) AS n FROM membros_meta WHERE usuario_id = ? AND estado = 'fantasma'", uid) === 0,
    };
    const novos = [];
    for (const t of TROFEUS) {
      if (!cond[t.chave]) continue;
      if (um('SELECT 1 AS x FROM trofeus_usuario WHERE usuario_id = ? AND trofeu = ?', uid, t.chave)) continue;
      rodar('INSERT INTO trofeus_usuario (usuario_id, trofeu) VALUES (?, ?)', uid, t.chave);
      novos.push(t.nome);
    }
    return novos;
  }

  // ---------- resumo do usuário (topo da tela) ----------

  function resumo(uid) {
    const xp = xpDe(uid);
    const seq = sequencias(uid);
    return Object.assign({
      xp_total: xp,
      sequencia: seq.atual,
      melhor_sequencia: seq.melhor,
      provas: Number(um('SELECT COUNT(*) AS n FROM checks WHERE usuario_id = ?', uid).n),
      trofeus: Number(um('SELECT COUNT(*) AS n FROM trofeus_usuario WHERE usuario_id = ?', uid).n),
    }, nivelDe(xp));
  }

  // ---------- metas ----------

  function membroDe(metaId, uid) {
    return um('SELECT * FROM membros_meta WHERE meta_id = ? AND usuario_id = ?', metaId, uid);
  }

  function metasAtivasDe(uid) {
    return Number(um(
      "SELECT COUNT(*) AS n FROM membros_meta WHERE usuario_id = ? AND estado IN ('ativa', 'lapide')",
      uid).n);
  }

  function cartoesDasMetas(uid) {
    const h = hoje();
    const metas = todos(
      `SELECT m.id, m.categoria, m.nome, m.dias, m.modo_prova,
              mm.estado, mm.dias_cumpridos, mm.salvamentos,
              EXISTS (SELECT 1 FROM checks c WHERE c.meta_id = m.id AND c.usuario_id = mm.usuario_id
                       AND c.dia = ?) AS feito_hoje
         FROM membros_meta mm JOIN metas m ON m.id = mm.meta_id
        WHERE mm.usuario_id = ?
        ORDER BY m.id DESC`, h, uid);
    const nomes = todos(
      `SELECT mm.meta_id, us.usuario
         FROM membros_meta mm JOIN usuarios us ON us.id = mm.usuario_id
        WHERE mm.meta_id IN (SELECT meta_id FROM membros_meta WHERE usuario_id = ?)
        ORDER BY mm.entrou_em, us.id`, uid);
    const porMeta = {};
    for (const x of nomes) (porMeta[x.meta_id] = porMeta[x.meta_id] || []).push(x.usuario);
    return metas.map((m) => ({
      id: m.id,
      categoria: m.categoria,
      nome: m.nome,
      dias: m.dias,
      modo_prova: Boolean(m.modo_prova),
      estado: m.estado,
      dias_cumpridos: m.dias_cumpridos,
      salvamentos: m.salvamentos,
      feito_hoje: Boolean(m.feito_hoje),
      horas_restantes: m.estado === 'lapide' ? horasAteFimDoDia() : 0,
      membros: porMeta[m.id] || [],
    }));
  }

  function rotaPainel(u) {
    const cutucadas = todos(
      `SELECT DISTINCT us.usuario FROM cutucadas c JOIN usuarios us ON us.id = c.de_id
        WHERE c.para_id = ? AND c.dia = ?`, u.id, hoje()).map((r) => r.usuario);
    return [200, { ok: true, eu: resumo(u.id), metas: cartoesDasMetas(u.id), cutucadas_hoje: cutucadas }];
  }

  function rotaDetalheMeta(u, dados, idTexto) {
    const id = Number(idTexto);
    if (!membroDe(id, u.id)) throw new ErroApi(404, 'Meta não encontrada.');
    for (const x of todos('SELECT usuario_id FROM membros_meta WHERE meta_id = ?', id)) {
      atualizarEstados(x.usuario_id);
    }
    const h = hoje();
    const cartao = cartoesDasMetas(u.id).find((m) => m.id === id);
    const membros = todos(
      `SELECT us.usuario, mm.estado, mm.dias_cumpridos,
              EXISTS (SELECT 1 FROM checks c WHERE c.meta_id = mm.meta_id AND c.usuario_id = mm.usuario_id
                       AND c.dia = ?) AS feito_hoje
         FROM membros_meta mm JOIN usuarios us ON us.id = mm.usuario_id
        WHERE mm.meta_id = ?
        ORDER BY mm.entrou_em, us.id`, h, id)
      .map((m) => ({ usuario: m.usuario, estado: m.estado, dias_cumpridos: m.dias_cumpridos, feito_hoje: Boolean(m.feito_hoje) }));
    const chat = todos(
      `SELECT m.id, us.usuario, m.texto, m.tipo_prova
         FROM mensagens m
         JOIN usuarios us ON us.id = m.usuario_id
        WHERE m.meta_id = ?
        ORDER BY m.id DESC LIMIT 100`, id).reverse();
    return [200, { ok: true, meta: cartao, membros, chat }];
  }

  function listaDeConvidados(valor) {
    let lista = [];
    if (Array.isArray(valor)) lista = valor;
    else if (typeof valor === 'string') lista = valor.split(',');
    const vistos = new Set();
    const saida = [];
    for (const item of lista) {
      const nome = texto(item);
      if (!nome || vistos.has(nome.toLowerCase())) continue;
      vistos.add(nome.toLowerCase());
      saida.push(nome);
    }
    return saida;
  }

  function rotaCriarMeta(u, d) {
    let modelo = null;
    if (d.modelo !== undefined && d.modelo !== null) {
      modelo = METAS_OFICIAIS.find((x) => x.chave === d.modelo) || null;
      if (!modelo) throw new ErroApi(404, 'Meta oficial não encontrada.');
    }
    const nome = modelo ? modelo.nome : texto(d.nome);
    if (nome.length < 3 || nome.length > 60) {
      throw new ErroApi(400, 'O nome precisa ter de 3 a 60 caracteres.');
    }
    const dias = modelo ? modelo.dias : inteiro(d.dias);
    if (dias === null || dias < 7 || dias > 90) {
      throw new ErroApi(400, 'A duração precisa ser de 7 a 90 dias.');
    }
    const modoProva = modelo ? (modelo.modo_prova ? 1 : 0) : (d.modo_prova === true ? 1 : 0);
    const categoria = modelo ? modelo.categoria : 'Nova';

    const convidados = [];
    for (const nomeConvidado of modelo ? [] : listaDeConvidados(d.convidados)) {
      const outro = um('SELECT id, usuario FROM usuarios WHERE LOWER(usuario) = LOWER(?)', nomeConvidado);
      if (!outro) throw new ErroApi(404, `Não existe ninguém com o usuário "${nomeConvidado}".`);
      if (outro.id !== u.id) convidados.push(outro);
    }
    if (convidados.length + 1 > MAX_PESSOAS) {
      throw new ErroApi(400, `Máximo de ${MAX_PESSOAS} pessoas por meta.`);
    }
    if (metasAtivasDe(u.id) >= MAX_METAS_ATIVAS) {
      throw new ErroApi(409, `Limite de ${MAX_METAS_ATIVAS} metas ativas atingido.`);
    }
    for (const c of convidados) {
      atualizarEstados(c.id);
      if (metasAtivasDe(c.id) >= MAX_METAS_ATIVAS) {
        throw new ErroApi(409, `${c.usuario} já está com ${MAX_METAS_ATIVAS} metas ativas.`);
      }
    }

    const h = hoje();
    const id = tx(() => {
      const metaId = proximoId(db, 'metas');
      rodar(
        `INSERT INTO metas (id, criador_id, modelo, categoria, nome, dias, modo_prova)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        metaId, u.id, modelo ? modelo.chave : null, categoria, nome, dias, modoProva);
      for (const pessoa of [u.id].concat(convidados.map((c) => c.id))) {
        rodar('INSERT INTO membros_meta (meta_id, usuario_id, entrou_em) VALUES (?, ?, ?)',
          metaId, pessoa, h);
      }
      return metaId;
    });
    return [201, { ok: true, id: id }];
  }

  function rotaCheck(u, d, idTexto) {
    const metaId = Number(idTexto);
    const mm = membroDe(metaId, u.id);
    if (!mm) throw new ErroApi(404, 'Meta não encontrada.');
    const meta = um('SELECT * FROM metas WHERE id = ?', metaId);
    if (mm.estado === 'fantasma') throw new ErroApi(403, 'Você virou fantasma nesta meta.');
    if (mm.estado === 'concluida') throw new ErroApi(409, 'Você já concluiu esta meta.');
    const salvando = mm.estado === 'lapide';
    if (salvando && mm.salvamentos < 1) throw new ErroApi(403, 'Sem salvamentos restantes.');
    const h = hoje();
    if (um('SELECT 1 AS x FROM checks WHERE meta_id = ? AND usuario_id = ? AND dia = ?', metaId, u.id, h)) {
      throw new ErroApi(409, 'Você já marcou esta meta hoje.');
    }

    let tipo = null;
    if (d.tipo_prova !== undefined && d.tipo_prova !== null) {
      if (!TIPOS_PROVA.includes(d.tipo_prova)) throw new ErroApi(400, 'Tipo de prova inválido.');
      tipo = d.tipo_prova;
    }
    if ((meta.modo_prova || salvando) && !tipo) {
      throw new ErroApi(400, 'Esta meta exige prova: foto, vídeo ou áudio.');
    }
    let arquivoBytes = null;
    if (d.arquivo_bytes !== undefined && d.arquivo_bytes !== null) {
      arquivoBytes = inteiro(d.arquivo_bytes);
      if (arquivoBytes === null || arquivoBytes < 0) throw new ErroApi(400, 'Tamanho de arquivo inválido.');
      if (arquivoBytes > MAX_ARQUIVO) throw new ErroApi(400, 'O arquivo passa de 25 MB.');
    }
    const arquivoNome = texto(d.arquivo_nome).slice(0, 120) || null;

    const xpAntes = xpDe(u.id);
    const [hora] = horaMinutoAgora();
    const resposta = tx(() => {
      const numero = mm.dias_cumpridos + 1;
      const concluiu = numero >= meta.dias;
      rodar(
        `INSERT INTO checks (meta_id, usuario_id, dia, numero, hora, tipo_prova, arquivo_nome, arquivo_bytes, salvamento)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        metaId, u.id, h, numero, hora, tipo, arquivoNome, arquivoBytes, salvando ? 1 : 0);
      rodar(
        `UPDATE membros_meta
            SET dias_cumpridos = ?, estado = ?, salvamentos = salvamentos - ?, concluida_em = ?
          WHERE meta_id = ? AND usuario_id = ?`,
        numero, concluiu ? 'concluida' : 'ativa', salvando ? 1 : 0, concluiu ? h : null, metaId, u.id);
      let ganho = darXp(u.id, salvando ? XP_SALVAMENTO : XP_DIA);
      if (concluiu) ganho += darXp(u.id, XP_CONCLUIR);
      if (tipo) {
        rodar('INSERT INTO mensagens (id, meta_id, usuario_id, texto, tipo_prova) VALUES (?, ?, ?, ?, ?)',
          proximoId(db, 'mensagens'), metaId, u.id, 'Prova do dia ' + numero, tipo);
      }
      if (tipo) avancarMissao(u.id, 'provas', 1); // só prova de verdade conta para a missão
      const trofeus = avaliarTrofeus(u.id);
      return { ok: true, xp: ganho, numero: numero, salvou: salvando, concluiu: concluiu, trofeus: trofeus };
    });
    const nivelDepois = nivelDe(xpDe(u.id)).nivel;
    resposta.subiu_nivel = nivelDepois > nivelDe(xpAntes).nivel ? nivelDepois : null;
    return [201, resposta];
  }

  function rotaMensagem(u, d, idTexto) {
    const metaId = Number(idTexto);
    const mm = membroDe(metaId, u.id);
    if (!mm) throw new ErroApi(404, 'Meta não encontrada.');
    if (mm.estado === 'fantasma') throw new ErroApi(403, 'Fantasmas não falam no chat.');
    const msg = texto(d.texto);
    if (msg.length < 1 || msg.length > 500) {
      throw new ErroApi(400, 'A mensagem precisa ter de 1 a 500 caracteres.');
    }
    tx(() => {
      rodar('INSERT INTO mensagens (id, meta_id, usuario_id, texto) VALUES (?, ?, ?, ?)',
        proximoId(db, 'mensagens'), metaId, u.id, msg);
      avancarMissao(u.id, 'mensagem', 1);
    });
    return [201, { ok: true }];
  }

  // ---------- cutucar ----------

  function rotaCutucar(u, d) {
    const alvoNome = texto(d.usuario);
    const alvo = alvoNome ? um('SELECT id, usuario FROM usuarios WHERE LOWER(usuario) = LOWER(?)', alvoNome) : null;
    if (!alvo) throw new ErroApi(404, 'Usuário não encontrado.');
    if (alvo.id === u.id) throw new ErroApi(400, 'Você não pode cutucar a si mesmo.');
    const juntos = um(
      `SELECT 1 AS x FROM membros_meta a JOIN membros_meta b ON b.meta_id = a.meta_id
        WHERE a.usuario_id = ? AND b.usuario_id = ?`, u.id, alvo.id);
    if (!juntos) throw new ErroApi(403, 'Você só pode cutucar quem participa de uma meta com você.');
    const h = hoje();
    try {
      tx(() => {
        rodar('INSERT INTO cutucadas (de_id, para_id, dia) VALUES (?, ?, ?)', u.id, alvo.id, h);
        avancarMissao(u.id, 'cutucar', 1);
      });
    } catch (e) {
      throw new ErroApi(409, `Você já cutucou ${alvo.usuario} hoje.`);
    }
    return [201, { ok: true, usuario: alvo.usuario, trofeus: avaliarTrofeus(u.id) }];
  }

  // ---------- perfil ----------

  function rotaPerfil(u, d, nomeUsuario) {
    const alvo = um('SELECT id, usuario FROM usuarios WHERE LOWER(usuario) = LOWER(?)', nomeUsuario);
    if (!alvo) throw new ErroApi(404, 'Usuário não encontrado.');
    const eu = alvo.id === u.id;
    const r = resumo(alvo.id);
    const metas = todos(
      `SELECT m.id, m.nome, m.categoria FROM metas m
         JOIN membros_meta a ON a.meta_id = m.id AND a.usuario_id = ?
         JOIN membros_meta b ON b.meta_id = m.id AND b.usuario_id = ?
        ORDER BY m.id DESC`, u.id, alvo.id);
    const provas = todos(
      `SELECT c.tipo_prova, c.numero, m.nome
         FROM checks c JOIN metas m ON m.id = c.meta_id
        WHERE c.usuario_id = ? AND c.tipo_prova IS NOT NULL
          AND c.meta_id IN (SELECT meta_id FROM membros_meta WHERE usuario_id = ?)
        ORDER BY c.dia DESC, c.numero DESC LIMIT 3`, alvo.id, u.id);
    const conquistados = new Set(
      todos('SELECT trofeu FROM trofeus_usuario WHERE usuario_id = ?', alvo.id).map((x) => x.trofeu));
    const trofeus = TROFEUS.filter((x) => conquistados.has(x.chave)).map((x) => ({ chave: x.chave, nome: x.nome }));
    return [200, {
      ok: true,
      usuario: alvo.usuario,
      eu: eu,
      bio: um('SELECT bio FROM perfis WHERE usuario_id = ?', alvo.id).bio,
      nivel: r.nivel,
      xp_total: r.xp_total,
      sequencia: r.sequencia,
      provas: r.provas,
      trofeus: trofeus,
      provas_recentes: provas,
      metas: metas,
      pode_cutucar: !eu && metas.length > 0,
    }];
  }

  function rotaBio(u, d) {
    const bio = texto(d.bio);
    if (bio.length > 140) throw new ErroApi(400, 'A bio pode ter no máximo 140 caracteres.');
    rodar('UPDATE perfis SET bio = ? WHERE usuario_id = ?', bio, u.id);
    return [200, { ok: true, bio: bio }];
  }

  // ---------- telas de consulta ----------

  function rotaTrofeus(u) {
    const meus = new Set(
      todos('SELECT trofeu FROM trofeus_usuario WHERE usuario_id = ?', u.id).map((x) => x.trofeu));
    const lista = TROFEUS.map((x) => ({
      chave: x.chave, nome: x.nome, descricao: x.descricao, raridade: x.raridade, conquistado: meus.has(x.chave),
    }));
    return [200, { ok: true, trofeus: lista }];
  }

  function rotaRanking(u) {
    const top = todos(
      `SELECT us.usuario, p.xp_total FROM perfis p JOIN usuarios us ON us.id = p.usuario_id
        ORDER BY p.xp_total DESC, us.id ASC LIMIT 20`)
      .map((x) => ({ usuario: x.usuario, xp_total: x.xp_total, nivel: nivelDe(x.xp_total).nivel }));
    const meu = xpDe(u.id);
    const posicao = 1 + Number(um('SELECT COUNT(*) AS n FROM perfis WHERE xp_total > ?', meu).n);
    return [200, { ok: true, top: top, eu: { usuario: u.usuario, xp_total: meu, posicao: posicao } }];
  }

  function garantirMissoes(uid) {
    const h = hoje();
    for (const m of MISSOES) {
      if (!um('SELECT 1 AS x FROM missoes_usuario WHERE usuario_id = ? AND missao = ? AND dia = ?', uid, m.chave, h)) {
        rodar('INSERT INTO missoes_usuario (usuario_id, missao, dia) VALUES (?, ?, ?)', uid, m.chave, h);
      }
    }
  }

  function rotaMissoes(u) {
    garantirMissoes(u.id);
    const h = hoje();
    const linhas = todos('SELECT missao, progresso, resgatada FROM missoes_usuario WHERE usuario_id = ? AND dia = ?', u.id, h);
    const missoes = MISSOES.map((m) => {
      const l = linhas.find((x) => x.missao === m.chave);
      return {
        chave: m.chave, titulo: m.titulo, quantidade: m.quantidade, xp: m.xp,
        progresso: l ? l.progresso : 0, resgatada: Boolean(l && l.resgatada),
      };
    });
    const sorteada = um('SELECT carta FROM carta_do_dia WHERE usuario_id = ? AND dia = ?', u.id, h);
    return [200, { ok: true, missoes: missoes, carta: sorteada ? CARTAS[sorteada.carta] || '' : '' }];
  }

  function rotaResgatar(u, d, chave) {
    garantirMissoes(u.id);
    const h = hoje();
    const missao = MISSOES.find((x) => x.chave === chave);
    if (!missao) throw new ErroApi(404, 'Missão não encontrada.');
    const l = um('SELECT progresso, resgatada FROM missoes_usuario WHERE usuario_id = ? AND missao = ? AND dia = ?',
      u.id, chave, h);
    if (l.resgatada) throw new ErroApi(409, 'Missão já resgatada.');
    if (l.progresso < missao.quantidade) throw new ErroApi(400, 'Missão ainda não concluída.');
    const antes = nivelDe(xpDe(u.id)).nivel;
    const resposta = tx(() => {
      rodar('UPDATE missoes_usuario SET resgatada = 1 WHERE usuario_id = ? AND missao = ? AND dia = ?',
        u.id, chave, h);
      const ganho = darXp(u.id, missao.xp);
      return { ok: true, xp: ganho, trofeus: avaliarTrofeus(u.id) };
    });
    const depois = nivelDe(xpDe(u.id)).nivel;
    resposta.subiu_nivel = depois > antes ? depois : null;
    return [200, resposta];
  }

  function rotaCarta(u) {
    const indice = Math.floor(Math.random() * CARTAS.length);
    tx(() => {
      rodar('DELETE FROM carta_do_dia WHERE usuario_id = ? AND dia = ?', u.id, hoje());
      rodar('INSERT INTO carta_do_dia (usuario_id, dia, carta) VALUES (?, ?, ?)', u.id, hoje(), indice);
    });
    return [200, { ok: true, carta: CARTAS[indice] }];
  }

  function rotaCalendario(u) {
    const h = hoje();
    const inicio = somarDias(h, -83);
    const porDia = {};
    for (const r of todos(
      'SELECT dia, COUNT(*) AS n FROM checks WHERE usuario_id = ? AND dia >= ? GROUP BY dia', u.id, inicio)) {
      porDia[r.dia] = Number(r.n);
    }
    const dias = [];
    for (let i = 0; i < 84; i++) {
      const data = somarDias(inicio, i);
      dias.push({ data: data, qtd: porDia[data] || 0 });
    }
    const criado = um('SELECT criado_em FROM usuarios WHERE id = ?', u.id).criado_em.slice(0, 10);
    const periodo = Math.min(84, Math.max(1, diffDias(h, criado) + 1));
    const cumpridos = dias.slice(84 - periodo).filter((x) => x.qtd > 0).length;

    // Dia perfeito = em todas as metas em que a pessoa estava ativa naquele dia, ela marcou.
    const membros = todos(
      `SELECT meta_id, entrou_em, fantasma_em, concluida_em FROM membros_meta WHERE usuario_id = ?`, u.id);
    const marcados = new Set(todos(
      'SELECT meta_id, dia FROM checks WHERE usuario_id = ? AND dia >= ?', u.id, inicio)
      .map((c) => c.meta_id + '|' + c.dia));
    let perfeitos = 0;
    for (const x of dias) {
      const ativas = membros.filter((m) =>
        m.entrou_em <= x.data && (!m.fantasma_em || x.data < m.fantasma_em) &&
        (!m.concluida_em || x.data <= m.concluida_em));
      x.ativas = ativas.length;
      x.perfeito = ativas.length > 0 && ativas.every((m) => marcados.has(m.meta_id + '|' + x.data));
      if (x.perfeito) perfeitos++;
    }
    const seq = sequencias(u.id);
    return [200, {
      ok: true,
      hoje: h,
      criado: criado,
      dias: dias,
      sequencia: seq.atual,
      melhor_sequencia: seq.melhor,
      pct_cumpridos: Math.round((100 * cumpridos) / periodo),
      dias_perfeitos: perfeitos,
    }];
  }

  function rotaCemiterio(u) {
    const lista = todos(
      `SELECT m.nome, mm.dias_cumpridos FROM membros_meta mm JOIN metas m ON m.id = mm.meta_id
        WHERE mm.usuario_id = ? AND mm.estado = 'fantasma'
        ORDER BY mm.fantasma_em DESC, m.id DESC`, u.id);
    return [200, { ok: true, metas: lista }];
  }

  function rotaDescobrir() {
    const contagem = {};
    for (const r of todos(
      `SELECT m.modelo, COUNT(DISTINCT mm.usuario_id) AS n
         FROM metas m JOIN membros_meta mm ON mm.meta_id = m.id
        WHERE m.modelo IS NOT NULL GROUP BY m.modelo`)) {
      contagem[r.modelo] = Number(r.n);
    }
    const modelos = METAS_OFICIAIS.map((m) => ({
      chave: m.chave, nome: m.nome, dias: m.dias, modo_prova: m.modo_prova,
      descricao: m.descricao, categoria: m.categoria, participantes: contagem[m.chave] || 0,
    }));
    return [200, { ok: true, modelos: modelos }];
  }

  // ---------- tabela de rotas ----------

  const ID = '(\\d{1,10})';
  const rotas = [
    ['GET', /^\/api\/resumo$/, (u) => [200, { ok: true, eu: resumo(u.id) }]],
    ['GET', /^\/api\/painel$/, rotaPainel],
    ['GET', new RegExp('^/api/metas/' + ID + '$'), rotaDetalheMeta],
    ['POST', /^\/api\/metas$/, rotaCriarMeta],
    ['POST', new RegExp('^/api/metas/' + ID + '/check$'), rotaCheck],
    ['POST', new RegExp('^/api/metas/' + ID + '/mensagens$'), rotaMensagem],
    ['POST', /^\/api\/cutucar$/, rotaCutucar],
    ['GET', /^\/api\/perfil\/([A-Za-z0-9_.]{3,20})$/, rotaPerfil],
    ['POST', /^\/api\/perfil\/bio$/, rotaBio],
    ['GET', /^\/api\/trofeus$/, rotaTrofeus],
    ['GET', /^\/api\/ranking$/, rotaRanking],
    ['GET', /^\/api\/missoes$/, rotaMissoes],
    ['POST', /^\/api\/missoes\/([a-z_]{1,20})\/resgatar$/, rotaResgatar],
    ['POST', /^\/api\/missoes\/carta$/, rotaCarta],
    ['GET', /^\/api\/calendario$/, rotaCalendario],
    ['GET', /^\/api\/cemiterio$/, rotaCemiterio],
    ['GET', /^\/api\/descobrir$/, rotaDescobrir],
  ];

  // Devolve null se a rota não existe; senão { executar(usuario, dados) -> [status, corpo] }.
  function acharRota(metodo, caminho) {
    for (const [m, regex, funcao] of rotas) {
      if (m !== metodo) continue;
      const achou = regex.exec(caminho);
      if (!achou) continue;
      return {
        executar(u, dados) {
          xpDe(u.id); // garante que a conta tem perfil
          atualizarEstados(u.id);
          return funcao(u, dados || {}, ...achou.slice(1));
        },
      };
    }
    return null;
  }

  return { acharRota, resumo };
}

module.exports = { criarApi, ErroApi, proximoId };
