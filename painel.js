// Thirtyly - painel. Todos os dados vêm do servidor (banco de dados) pela API.
// O navegador só mostra a tela e manda os pedidos; as regras ficam no servidor.
(function () {
  'use strict';

  var S = {
    view: 'painel',
    sel: null, // id da meta aberta
    dias: 30, // duração escolhida na tela "Nova meta"
    audio: false, // modo prova na tela "Nova meta"
    f: 'todas', // filtro do painel
    pf: 'Você', // perfil aberto
    eu: null, // resumo (XP, nível, sequência...)
    metas: {}, // cache das metas já carregadas, por id
  };
  var NOME = '';
  var pedidoAtual = 0;

  var TITULOS = ['Novato', 'Aprendiz', 'Persistente', 'Focado', 'Imparável', 'Mestre', 'Lenda'];
  var IC = {
    Saúde: '💧',
    Estudo: '📚',
    Fitness: '💪',
    Família: '👨‍👩‍👧',
    Nova: '🎯',
    Mente: '🧘',
    Rotina: '🌅',
    Finanças: '💰',
  };

  // Os ícones ficam aqui na tela; o banco de dados guarda só texto.
  var EMOJI_TROFEU = {
    primeiro_passo: '🌱', semana_de_fogo: '🔥', prova_real: '📸', voz_da_meta: '🎙️',
    voltei_dos_mortos: '🪦', meta_cumprida: '🎯', time_unido: '👥', mes_perfeito: '🏅',
    rei_das_cobrancas: '🌍', madrugador: '⚡', meta_de_ferro: '🧱', top_10: '👑',
    corrente: '🔗', mestre_das_provas: '🧠', nivel_20: '🚀', sobrevivente: '👻',
  };
  var EMOJI_MISSAO = { provas: '📸', cutucar: '👈', mensagem: '💬' };

  var $ = function (s) {
    return document.querySelector(s);
  };

  // Todo texto que veio do servidor (nome de meta, mensagem, usuário, bio...)
  // passa por aqui antes de entrar no HTML, para ninguém injetar código.
  function esc(t) {
    return String(t === null || t === undefined ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var tm;
  function aviso(t) {
    var a = $('#av');
    a.textContent = t;
    a.classList.add('on');
    clearTimeout(tm);
    tm = setTimeout(function () {
      a.classList.remove('on');
    }, t.length > 40 ? 4200 : 2400);
  }

  function falha(e) {
    if (e && e.sessaoExpirada) return;
    aviso(e instanceof TypeError ? 'Não consegui falar com o servidor.' : (e && e.message) || 'Algo deu errado.');
  }

  // Pede algo ao servidor. Devolve o JSON; se der erro, rejeita com a mensagem.
  function api(metodo, url, corpo) {
    var opcoes = { method: metodo, credentials: 'same-origin', headers: {} };
    if (metodo !== 'GET') {
      opcoes.headers['Content-Type'] = 'application/json';
      opcoes.body = JSON.stringify(corpo || {});
    }
    return fetch(url, opcoes).then(function (r) {
      if (r.status === 401) {
        location.href = 'index.html';
        var erro = new Error('Sessão expirada.');
        erro.sessaoExpirada = true;
        throw erro;
      }
      return r.json().then(
        function (j) {
          if (!r.ok || !j.ok) throw new Error(j.erro || 'Algo deu errado.');
          return j;
        },
        function () {
          throw new Error('Resposta inválida do servidor.');
        }
      );
    });
  }

  function titulo(nivel) {
    return TITULOS[Math.min(6, Math.floor(nivel / 2))];
  }

  function topo(eu) {
    if (eu) S.eu = eu;
    eu = S.eu;
    if (!eu) return;
    $('#xpb').style.width = Math.round(eu.xp_nivel / 10) + '%';
    $('#xpt').textContent = eu.xp_nivel + ' / 1000 XP';
    $('#nv').textContent = 'Nível ' + eu.nivel + ' · ' + titulo(eu.nivel);
    $('#n2').textContent = eu.nivel;
    $('#sq').textContent = eu.sequencia;
  }

  function atualizarTopo() {
    return api('GET', '/api/resumo').then(function (j) {
      topo(j.eu);
    });
  }

  function barra(m) {
    return (
      '<div class="barra"><div data-largura="' +
      Math.round((m.dias_cumpridos / m.dias) * 100) +
      '"></div></div>'
    );
  }

  function prova(t, l) {
    var b = '';
    for (var i = 0; i < 18; i++) b += '<i class="b" data-altura="' + (6 + ((i * 7) % 16)) + '"></i>';
    var m = {
      foto: '<div class="pv foto">📷</div>',
      video: '<div class="pv vid">▶<span class="t">0:12</span></div>',
      audio: '<div class="pv aud">▶ ' + b + '<span class="t">0:08</span></div>',
    };
    return (m[t] || '') + '✅ ' + esc(l);
  }

  function inicial(nome) {
    return esc(String(nome).charAt(0).toUpperCase());
  }

  function cartao(m, detalhe) {
    S.metas[m.id] = m;
    var info = 'Dia ' + m.dias_cumpridos + ' de ' + m.dias + (m.modo_prova ? ' · 🎙️ prova obrigatória' : '');
    var cab =
      '<div class="ct"><span class="ico">' +
      (IC[m.categoria] || '🎯') +
      '</span><div><span class="tag">' +
      esc(m.categoria) +
      '</span><h3>' +
      esc(m.nome) +
      '</h3></div></div>';
    var h =
      '<div class="card ' +
      (m.estado == 'lapide' ? 'lapide ' : '') +
      (m.estado == 'fantasma' ? 'fantasma ' : '') +
      (detalhe ? '' : 'clic') +
      '" ' +
      (detalhe ? '' : 'data-abrir="' + m.id + '"') +
      '>' +
      cab;
    if (m.estado == 'fantasma')
      return (
        h +
        '<p class="meta">👻 Você virou fantasma no dia ' +
        m.dias_cumpridos +
        '. O grupo segue sem você e a meta acabou para você.</p></div>'
      );
    if (m.estado == 'concluida')
      return h + barra(m) + '<p class="ok">🎯 Meta concluída! Parabéns!</p></div>';
    if (m.estado == 'lapide')
      return (
        h +
        '<div class="alerta">🪦 Você esqueceu de marcar. Restam ' +
        m.horas_restantes +
        'h para salvar a meta. Salvamentos restantes: ' +
        m.salvamentos +
        ' de 2.</div><div class="env"><button class="bt" data-salvar="' +
        m.id +
        '">Salvar meta</button></div></div>'
      );
    h +=
      barra(m) +
      '<div class="rodape"><div class="pilha">' +
      m.membros
        .slice(0, 4)
        .map(function (n) {
          return '<div class="av">' + inicial(n) + '</div>';
        })
        .join('') +
      '</div><span class="meta">' +
      info +
      '</span></div>';
    h += m.feito_hoje
      ? '<p class="ok">✅ Concluída hoje</p>'
      : '<button class="bt" data-fazer="' +
        m.id +
        '">' +
        (m.modo_prova ? 'Enviar prova do dia' : 'Marcar como feito') +
        '</button>';
    return h + '</div>';
  }

  function saudacao() {
    var h = new Date().getHours();
    return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  }

  var V = {
    painel: function () {
      return api('GET', '/api/painel').then(function (j) {
        topo(j.eu);
        S.metas = {};
        var L = j.metas.filter(function (m) {
          return S.f == 'todas' || m.estado == S.f;
        });
        var vivas = j.metas.filter(function (m) {
          return m.estado != 'fantasma' && !(m.estado == 'concluida' && !m.feito_hoje);
        });
        var fe = vivas.filter(function (m) {
          return m.feito_hoje;
        }).length;
        var tl = function (i, n, t) {
          return '<div class="tile"><b>' + i + ' ' + esc(n) + '</b><span>' + t + '</span></div>';
        };
        var fl = [
          ['todas', 'Todas'],
          ['ativa', 'Ativas'],
          ['lapide', 'Na lápide'],
          ['fantasma', 'Fantasma'],
          ['concluida', 'Concluídas'],
        ]
          .map(function (x) {
            return (
              '<button class="chip' +
              (S.f == x[0] ? ' on' : '') +
              '" data-f="' +
              x[0] +
              '">' +
              x[1] +
              '</button>'
            );
          })
          .join('');
        var cut = j.cutucadas_hoje.length
          ? '<div class="alerta mb_22">👈 ' +
            esc(j.cutucadas_hoje.join(', ')) +
            (j.cutucadas_hoje.length > 1 ? ' cutucaram' : ' cutucou') +
            ' você hoje. Bora marcar!</div>'
          : '';
        L.forEach(function (m) {
          S.metas[m.id] = m;
        });
        j.metas.forEach(function (m) {
          S.metas[m.id] = m;
        });
        return (
          '<div class="hero"><div><h2>' +
          saudacao() +
          ', ' +
          esc(NOME) +
          '! ☀️</h2><p>Você concluiu ' +
          fe +
          ' de ' +
          vivas.length +
          ' metas hoje. Cada prova vale XP e mantém sua sequência viva.</p></div><div class="tiles">' +
          tl('🔥', j.eu.sequencia, 'dias seguidos') +
          tl('⭐', j.eu.xp_nivel, 'XP no nível') +
          tl('📸', j.eu.provas, 'provas enviadas') +
          tl('🏆', j.eu.trofeus, 'troféus') +
          '</div></div>' +
          cut +
          '<div class="fl">' +
          fl +
          '</div><div class="grade">' +
          (L.map(function (m) {
            return cartao(m);
          }).join('') || '<p class="meta">Nenhuma meta aqui.</p>') +
          '</div>'
        );
      });
    },

    meta: function () {
      return api('GET', '/api/metas/' + S.sel).then(function (j) {
        var m = j.meta;
        return (
          '<button class="bs" data-ir="painel">← Voltar</button><h2 class="mt_14">' +
          esc(m.nome) +
          '</h2><p class="sub">Acompanhe o grupo e converse com todo mundo.</p><div class="det"><div class="coluna_18">' +
          cartao(m, 1) +
          '<div class="card"><h3>Membros</h3>' +
          j.membros
            .map(function (x) {
              var lado;
              if (x.estado == 'fantasma') lado = '<span class="dot">👻 fantasma</span>';
              else if (x.estado == 'concluida') lado = '<span class="dot cor_verde">🎯 concluiu</span>';
              else if (x.feito_hoje) lado = '<span class="dot cor_verde">feito hoje</span>';
              else if (x.usuario != NOME)
                lado = '<button class="bs dot" data-cut="' + esc(x.usuario) + '">Cutucar 👈</button>';
              else lado = '<span class="dot">pendente</span>';
              return (
                '<div class="mem"><div class="av">' +
                inicial(x.usuario) +
                '</div><span class="lk" data-pf="' +
                esc(x.usuario) +
                '">' +
                esc(x.usuario) +
                '</span>' +
                lado +
                '</div>'
              );
            })
            .join('') +
          '</div></div>' +
          '<div class="card"><h3>Chat do grupo</h3>' +
          (m.modo_prova
            ? '<p class="meta">💬 Conversa não vale check. Só foto, vídeo ou áudio conclui o dia.</p>'
            : '') +
          '<div class="chat" id="ch">' +
          j.chat
            .map(function (x) {
              return (
                '<div class="msg' +
                (x.usuario == NOME ? ' eu2' : '') +
                '"><small class="lk" data-pf="' +
                esc(x.usuario) +
                '">' +
                esc(x.usuario) +
                '</small>' +
                (x.tipo_prova ? prova(x.tipo_prova, x.texto) : esc(x.texto)) +
                '</div>'
              );
            })
            .join('') +
          '</div>' +
          (m.estado == 'fantasma'
            ? '<p class="meta">👻 Fantasmas não falam no chat.</p>'
            : '<div class="env"><input type="text" id="tx" maxlength="500" placeholder="Cobre o pessoal..."><button class="bt" data-env="' +
              m.id +
              '">Enviar</button></div>') +
          '</div></div>'
        );
      });
    },

    criar: function () {
      return Promise.resolve(
        '<h2>Nova meta</h2><p class="sub">Escolha o prazo e convide quem vai cumprir junto.</p><div class="form"><div><label for="nm">Nome da meta</label><input type="text" id="nm" maxlength="60" placeholder="Ex.: caminhar 30 minutos"></div>' +
          '<div><label>Duração</label><div class="sel">' +
          [7, 14, 21, 30, 60, 90]
            .map(function (d) {
              return (
                '<button class="chip' +
                (d == S.dias ? ' on' : '') +
                '" data-dias="' +
                d +
                '">' +
                d +
                ' dias</button>'
              );
            })
            .join('') +
          '</div></div>' +
          '<div><label for="co">Quem vai junto (nomes de usuário, separe por vírgula)</label><input type="text" id="co" placeholder="maria, joao.silva"></div>' +
          '<div class="modo"><p><b>Modo prova 🎙️</b>Para concluir cada dia, é obrigatório enviar foto, vídeo ou áudio. Sem prova, sem check.</p><button class="sw' +
          (S.audio ? ' on' : '') +
          '" id="sw" aria-label="Ativar modo prova"></button></div>' +
          '<div class="alerta">Regras: duração e modo prova não mudam depois de criar. Máximo de 8 pessoas por meta e 5 metas ativas por conta.</div><button class="bt" data-criar="1">Criar meta</button></div>'
      );
    },

    trofeus: function () {
      return api('GET', '/api/trofeus').then(function (j) {
        var g = j.trofeus.filter(function (t) {
          return t.conquistado;
        }).length;
        var R = ['', 'comum', 'raro', 'épico', 'lendário'];
        return (
          '<h2>Troféus</h2><p class="sub">' +
          g +
          ' de ' +
          j.trofeus.length +
          ' conquistados.</p><div class="barra barra_geral"><div data-largura="' +
          Math.round((g / j.trofeus.length) * 100) +
          '"></div></div><div class="grade">' +
          j.trofeus
            .map(function (t) {
              return (
                '<div class="card troféu' +
                (t.conquistado ? '' : ' bloq') +
                '"><div class="em">' +
                esc(EMOJI_TROFEU[t.chave] || '🏆') +
                '</div><h3>' +
                esc(t.nome) +
                '</h3><p class="meta">' +
                esc(t.descricao) +
                '</p><span class="raro r' +
                t.raridade +
                '">' +
                R[t.raridade] +
                '</span></div>'
              );
            })
            .join('') +
          '</div>'
        );
      });
    },

    ranking: function () {
      return api('GET', '/api/ranking').then(function (j) {
        var r = j.top;
        var pos = j.eu.posicao;
        var pd = [1, 0, 2]
          .filter(function (i) {
            return r[i];
          })
          .map(function (i) {
            return (
              '<div class="card' +
              (i == 0 ? ' p1' : '') +
              (r[i].usuario == NOME ? ' me' : '') +
              '"><div class="emoji_pod">' +
              ['🥇', '🥈', '🥉'][i] +
              '</div><h3 class="lk" data-pf="' +
              esc(r[i].usuario) +
              '">' +
              esc(r[i].usuario) +
              '</h3><p class="meta">' +
              r[i].xp_total +
              ' XP</p></div>'
            );
          })
          .join('');
        var falta =
          pos > 3 && r[2]
            ? 'faltam ' + (r[2].xp_total - j.eu.xp_total + 1) + ' XP para entrar no top 3'
            : 'continue assim';
        return (
          '<h2>Ranking global</h2><p class="sub">Os 3 líderes do Thirtyly.</p><div class="pod">' +
          pd +
          '</div><div class="card larg_680"><h3>' +
          (pos <= 3 ? 'Você está no pódio! 🎉' : 'Sua posição: ' + pos + 'º') +
          '</h3><p class="meta">' +
          j.eu.xp_total +
          ' XP · ' +
          falta +
          '</p></div>'
        );
      });
    },

    perfil: function () {
      var alvo = S.pf == 'Você' ? NOME : S.pf;
      return api('GET', '/api/perfil/' + encodeURIComponent(alvo)).then(function (j) {
        var eu = j.eu;
        var tl = function (a, b) {
          return '<div class="card centro"><h2>' + esc(a) + '</h2><p class="meta">' + b + '</p></div>';
        };
        return (
          '<div class="card pf"><div class="avg">' +
          inicial(j.usuario) +
          '</div><div class="pf_info"><h2>' +
          esc(j.usuario) +
          (eu ? ' (você)' : '') +
          '</h2><p class="meta">Nível ' +
          j.nivel +
          ' · ' +
          titulo(j.nivel) +
          '</p><p class="bio">' +
          esc(j.bio || (eu ? 'Escreva uma bio para contar seus objetivos.' : 'Sem bio por enquanto.')) +
          '</p>' +
          (eu
            ? '<button class="bs" data-bio="1">Editar bio</button>'
            : j.pode_cutucar
            ? '<button class="bs" data-cut="' + esc(j.usuario) + '">Cutucar 👈</button>'
            : '') +
          '</div></div>' +
          '<div class="grade espaco_18">' +
          tl(j.xp_total, 'XP total') +
          tl('🔥 ' + j.sequencia, 'dias seguidos') +
          tl(j.provas, 'provas enviadas') +
          tl(j.metas.length, eu ? 'metas' : 'metas juntos') +
          '</div>' +
          '<h3 class="mb_10">Troféus</h3><div class="tr mb_22">' +
          (j.trofeus
            .map(function (t) {
              return '<span title="' + esc(t.nome) + '">' + esc(EMOJI_TROFEU[t.chave] || '🏆') + '</span>';
            })
            .join('') || '<p class="meta">Nenhum troféu ainda.</p>') +
          '</div>' +
          '<h3 class="mb_10">Últimas provas</h3><div class="pvs mb_22">' +
          (j.provas_recentes
            .map(function (p) {
              return '<div class="card">' + prova(p.tipo_prova, 'Dia ' + p.numero + ' · ' + p.nome) + '</div>';
            })
            .join('') || '<p class="meta">Nenhuma prova para mostrar.</p>') +
          '</div>' +
          '<h3 class="mb_10">Metas' +
          (eu ? '' : ' em comum') +
          '</h3>' +
          (j.metas
            .map(function (m) {
              return (
                '<div class="mem"><span class="ico">' +
                (IC[m.categoria] || '🎯') +
                '</span><span class="lk" data-abrir="' +
                m.id +
                '">' +
                esc(m.nome) +
                '</span></div>'
              );
            })
            .join('') || '<p class="meta">Nenhuma meta em comum.</p>')
        );
      });
    },

    descobrir: function () {
      return api('GET', '/api/descobrir').then(function (j) {
        return (
          '<h2>Descobrir metas</h2><p class="sub">Metas oficiais prontas para começar sozinho ou em grupo.</p><div class="grade">' +
          j.modelos
            .map(function (t) {
              return (
                '<div class="card"><div class="ct"><span class="ico">' +
                esc(IC[t.categoria] || '🎯') +
                '</span><div><span class="tag">' +
                esc(t.categoria) +
                ' · ' +
                t.dias +
                ' dias</span><h3>' +
                esc(t.nome) +
                '</h3></div></div><p class="meta">' +
                esc(t.descricao) +
                '</p><div class="rodape"><span class="meta">👥 ' +
                t.participantes +
                ' participando' +
                (t.modo_prova ? ' · 🎙️ prova' : '') +
                '</span><button class="bs" data-tpl="' +
                esc(t.chave) +
                '">Começar</button></div></div>'
              );
            })
            .join('') +
          '</div>'
        );
      });
    },

    missoes: function () {
      return api('GET', '/api/missoes').then(function (j) {
        return (
          '<h2>Missões do dia</h2><p class="sub">Renovam à meia-noite e dão XP extra.</p>' +
          (j.carta ? '<div class="carta">🃏 ' + esc(j.carta) + '</div>' : '') +
          '<div class="form">' +
          j.missoes
            .map(function (m) {
              var ok = m.progresso >= m.quantidade;
              return (
                '<div class="card mis"><span class="ico">' +
                esc(EMOJI_MISSAO[m.chave] || '⭐') +
                '</span><div><h3>' +
                esc(m.titulo) +
                '</h3><p class="meta">' +
                m.progresso +
                '/' +
                m.quantidade +
                ' · +' +
                m.xp +
                ' XP</p></div>' +
                (m.resgatada
                  ? '<span class="ok">Resgatada</span>'
                  : '<button class="bt" data-res="' + esc(m.chave) + '"' + (ok ? '' : ' disabled') + '>Resgatar</button>') +
                '</div>'
              );
            })
            .join('') +
          '<button class="bs" data-carta="1">🃏 Tirar carta-desafio</button></div>'
        );
      });
    },

    calendario: function () {
      return api('GET', '/api/calendario').then(function (j) {
        S.cal = j;
        var MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
        var SEM = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
        var meses = [];
        var porMes = {};
        j.dias.forEach(function (x) {
          var chave = x.data.slice(0, 7);
          if (!porMes[chave]) {
            porMes[chave] = { ano: +x.data.slice(0, 4), mes: +x.data.slice(5, 7), dias: [] };
            meses.push(porMes[chave]);
          }
          porMes[chave].dias.push(x);
        });
        var blocos = meses
          .filter(function (m) {
            return m.dias.some(function (x) { return x.data >= j.criado; });
          })
          .map(function (m) {
            var vazios = new Date(m.ano, m.mes - 1, 1).getDay();
            var cel = '';
            for (var i = 0; i < vazios; i++) cel += '<span class="cal_vazio"></span>';
            m.dias.forEach(function (x) {
              var cls = 'cal_dia ' + estadoDia(x, j);
              if (x.data === j.hoje) cls += ' cal_hoje';
              cel +=
                '<button class="' + cls + '" data-dia="' + esc(x.data) + '" title="' + esc(textoDia(x, j)) + '">' +
                '<b>' + +x.data.slice(8, 10) + '</b>' +
                '<em>' + (x.perfeito ? '★' : x.qtd > 0 ? '✓' : '') + '</em></button>';
            });
            return (
              '<div class="card cal_mes"><h3>' + MESES[m.mes - 1] + ' ' + m.ano + '</h3>' +
              '<div class="cal_sem">' + SEM.map(function (s) { return '<span>' + s + '</span>'; }).join('') + '</div>' +
              '<div class="cal_grade">' + cel + '</div></div>'
            );
          })
          .join('');
        var leg = function (cls, t) {
          return '<span class="cal_leg"><i class="cal_dia ' + cls + '"></i>' + t + '</span>';
        };
        var tl = function (n, t) {
          return '<div class="card centro"><h2>' + esc(n) + '</h2><p class="meta">' + t + '</p></div>';
        };
        return (
          '<h2>Calendário</h2><p class="sub">Cada quadrado é um dia. Toque em um dia para ver o que aconteceu nele.</p>' +
          '<div class="grade larg_640">' +
          tl(j.sequencia, 'sequência atual') + tl(j.melhor_sequencia, 'melhor sequência') +
          tl(j.pct_cumpridos + '%', 'dias cumpridos') + tl(j.dias_perfeitos, 'dias perfeitos') +
          '</div>' +
          '<div class="card cal_legenda">' +
          leg('cal_perfeito', '★ Dia perfeito: marcou todas as metas') +
          leg('cal_parcial', '✓ Marcou, mas faltou alguma meta') +
          leg('cal_falhou', 'Tinha meta e não marcou') +
          leg('cal_livre', 'Sem metas neste dia') +
          leg('cal_antes', 'Antes de você entrar / futuro') +
          '</div>' +
          '<div class="card cal_detalhe" id="cal_det">' + detalheDia(j.dias[j.dias.length - 1], j) + '</div>' +
          '<div class="cal_meses">' + blocos + '</div>'
        );
      });
    },

    cemiterio: function () {
      var frases = [
        'Foi bom enquanto durou.',
        'Perdeu para o travesseiro.',
        'Resistiu até o guaraná.',
        'Descanse em paz.',
      ];
      return api('GET', '/api/cemiterio').then(function (j) {
        return (
          '<h2>Cemitério de metas</h2><p class="sub">Aqui descansam as metas que não sobreviveram. Fantasmas não voltam.</p><div class="grade">' +
          (j.metas
            .map(function (x, i) {
              return (
                '<div class="card tum"><div class="em">🪦</div><h3>' +
                esc(x.nome) +
                '</h3><p class="meta">Viveu ' +
                x.dias_cumpridos +
                ' dias</p><p class="meta"><i>' +
                frases[i % frases.length] +
                '</i></p></div>'
              );
            })
            .join('') || '<p class="meta">Nenhuma meta aqui. Continue assim! 🙌</p>') +
          '</div>'
        );
      });
    },

    regras: function () {
      var R = [
        ['✅', '1 check por dia', 'Vale só o dia de hoje e reinicia à meia-noite. Não dá para marcar dias passados.'],
        [
          '🎙️',
          'Modo prova',
          'Foto, vídeo ou áudio de até 25 MB é obrigatório. Sem arquivo, sem check. Não pode ser desligado depois.',
        ],
        [
          '🪦',
          'Lápide',
          'Se esquecer de marcar, você tem até o fim do dia seguinte e 2 salvamentos por meta. Salvar exige prova.',
        ],
        [
          '👻',
          'Fantasma',
          'Sem salvamento ou passado o prazo, você vira fantasma: perde 50 XP e a meta acaba para você.',
        ],
        ['🔒', 'Meta fixa', 'Duração de 7 a 90 dias e modo prova não mudam depois de criar.'],
        ['👥', 'Limites', 'Até 8 pessoas por meta e 5 metas ativas por conta.'],
        ['⭐', 'XP', '+50 por dia, +30 por salvamento, +100 ao concluir a meta.'],
        ['👈', 'Cutucar', 'Uma cutucada por pessoa por dia, só para quem participa de uma meta com você.'],
      ];
      return Promise.resolve(
        '<h2>Regras do jogo</h2><p class="sub">Tudo o que vale na Thirtyly.</p><div class="form larg_640">' +
          R.map(function (x) {
            return (
              '<div class="card rg"><span class="ico">' +
              x[0] +
              '</span><div><h3>' +
              x[1] +
              '</h3><p>' +
              x[2] +
              '</p></div></div>'
            );
          }).join('') +
          '</div>'
      );
    },
  };

  function aplicarMedidas() {
    document.querySelectorAll('[data-largura]').forEach(function (e) {
      e.style.width = e.getAttribute('data-largura') + '%';
    });
    document.querySelectorAll('[data-altura]').forEach(function (e) {
      e.style.height = e.getAttribute('data-altura') + 'px';
    });
  }

  function ir(v) {
    S.view = v;
    var meu = ++pedidoAtual;
    document.querySelectorAll('#nav button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.v == (v == 'meta' ? 'painel' : v));
    });
    return V[v]()
      .then(function (html) {
        if (meu !== pedidoAtual) return; // o usuário já foi para outra tela
        $('#v').innerHTML = html;
        aplicarMedidas();
        var c = $('#ch');
        if (c) c.scrollTop = c.scrollHeight;
        if (v != 'painel') atualizarTopo().catch(function () {});
      })
      .catch(function (e) {
        if (meu === pedidoAtual) falha(e);
      });
  }

  function modal(titulo, cb) {
    var escolha = null;
    var nm = { foto: '📷 Foto', video: '🎥 Vídeo', audio: '🎙️ Áudio' };
    $('#mo').innerHTML =
      '<h3>' +
      esc(titulo) +
      '</h3><p class="meta">Prove que cumpriu: foto, vídeo ou áudio. Mensagem de texto não vale.</p><div class="demo"><button class="bs" data-t="foto">📷 Foto de exemplo</button><button class="bs" data-t="video">🎥 Vídeo de exemplo</button><button class="bs" data-t="audio">🎙️ Áudio de exemplo</button></div><p class="meta">ou escolha um arquivo (até 25 MB). Por enquanto guardamos o tipo e o nome do arquivo, não o conteúdo:</p><input type="file" id="ar" accept="image/*,video/*,audio/*"><p class="ok" id="sl"></p><div class="env"><button class="bt" id="ok" disabled>Enviar prova</button><button class="bs" id="x">Cancelar</button></div>';
    $('#fm').classList.add('on');
    var set = function (p) {
      escolha = p;
      $('#sl').textContent = nm[p.tipo] + ' pronto para enviar';
      $('#ok').disabled = false;
    };
    document.querySelectorAll('#mo [data-t]').forEach(function (b) {
      b.onclick = function () {
        set({ tipo: b.dataset.t, nome: null, bytes: null });
      };
    });
    $('#ar').onchange = function () {
      var a = this.files[0];
      if (a && a.size > 26214400) {
        aviso('O arquivo passa de 25 MB.');
        this.value = '';
        return;
      }
      if (a)
        set({
          tipo: a.type.indexOf('video') == 0 ? 'video' : a.type.indexOf('audio') == 0 ? 'audio' : 'foto',
          nome: a.name,
          bytes: a.size,
        });
    };
    $('#x').onclick = function () {
      $('#fm').classList.remove('on');
    };
    $('#ok').onclick = function () {
      $('#fm').classList.remove('on');
      cb(escolha);
    };
  }

  // Manda o check do dia (ou o salvamento) para o servidor.
  function concluir(m) {
    var precisaProva = m.modo_prova || m.estado == 'lapide';
    var enviar = function (p) {
      var corpo = p ? { tipo_prova: p.tipo, arquivo_nome: p.nome, arquivo_bytes: p.bytes } : {};
      return api('POST', '/api/metas/' + m.id + '/check', corpo)
        .then(function (j) {
          var msg = j.concluiu
            ? '🎯 Meta concluída! +' + j.xp + ' XP'
            : (j.salvou ? 'Meta salva! ' : '') + '+' + j.xp + ' XP';
          if (j.subiu_nivel) msg += ' · 🎉 Nível ' + j.subiu_nivel + '!';
          if (j.trofeus && j.trofeus.length) msg += ' · 🏆 ' + j.trofeus.join(', ');
          aviso(msg);
          return ir(S.view);
        })
        .catch(falha);
    };
    if (precisaProva) {
      modal(m.estado == 'lapide' ? 'Prove para salvar a meta' : 'Prova de hoje', function (p) {
        enviar(p);
      });
      return null;
    }
    return enviar(null);
  }

  function mensagemDeGanho(j, base) {
    var msg = base;
    if (j.subiu_nivel) msg += ' · 🎉 Nível ' + j.subiu_nivel + '!';
    if (j.trofeus && j.trofeus.length) msg += ' · 🏆 ' + j.trofeus.join(', ');
    return msg;
  }

  // ---- calendário: estado de cada dia ----
  function estadoDia(x, j) {
    if (x.data > j.hoje || x.data < j.criado) return 'cal_antes';
    if (x.perfeito) return 'cal_perfeito';
    if (x.qtd > 0) return 'cal_parcial';
    if (x.ativas > 0) return x.data === j.hoje ? 'cal_livre' : 'cal_falhou';
    return 'cal_livre';
  }
  function dataBR(d) {
    return d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4);
  }
  function plural(n, um, varios) {
    return n + ' ' + (n === 1 ? um : varios);
  }
  function textoDia(x, j) {
    var e = estadoDia(x, j);
    var d = dataBR(x.data) + ': ';
    if (e === 'cal_antes') return d + (x.data > j.hoje ? 'ainda não chegou' : 'antes de você entrar no Thirtyly');
    if (e === 'cal_perfeito') return d + 'dia perfeito! Você marcou ' + x.qtd + ' de ' + plural(x.ativas, 'meta', 'metas');
    if (e === 'cal_parcial') return d + 'você marcou ' + x.qtd + ' de ' + plural(Math.max(x.ativas, x.qtd), 'meta', 'metas');
    if (e === 'cal_falhou') return d + 'você tinha ' + plural(x.ativas, 'meta', 'metas') + ' e não marcou nenhuma';
    if (x.ativas > 0) return d + 'hoje você tem ' + plural(x.ativas, 'meta', 'metas') + ' para marcar';
    return d + 'você não tinha metas ativas';
  }
  function detalheDia(x, j) {
    var e = estadoDia(x, j);
    return '<span class="cal_leg"><i class="cal_dia ' + e + '"></i></span><div><b>' + esc(textoDia(x, j)) + '</b></div>';
  }

  function acao(t, d) {
    if (d.dia) {
      var x = (S.cal ? S.cal.dias : []).filter(function (y) { return y.data === d.dia; })[0];
      var box = $('#cal_det');
      if (x && box) box.innerHTML = detalheDia(x, S.cal);
      return null;
    }
    if (d.v) {
      if (d.v == 'perfil') S.pf = 'Você';
      return ir(d.v);
    } else if (d.sair) {
      return fetch('/api/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).then(function () {
        location.href = 'index.html';
      });
    } else if (d.pf) {
      S.pf = d.pf;
      return ir('perfil');
    } else if (d.bio) {
      var nova = prompt('Escreva sua bio (até 140 caracteres):', '');
      if (nova === null) return null;
      return api('POST', '/api/perfil/bio', { bio: nova }).then(function () {
        return ir('perfil');
      });
    } else if (d.ir) {
      return ir(d.ir);
    } else if (d.fazer) {
      return concluir(S.metas[d.fazer]);
    } else if (d.salvar) {
      return concluir(S.metas[d.salvar]);
    } else if (d.abrir) {
      S.sel = d.abrir;
      return ir('meta');
    } else if (d.dias) {
      S.dias = +d.dias;
      var nm = $('#nm').value;
      var co = $('#co').value;
      return ir('criar').then(function () {
        $('#nm').value = nm;
        $('#co').value = co;
      });
    } else if (d.f) {
      S.f = d.f;
      return ir('painel');
    } else if (d.tpl !== undefined) {
      return api('POST', '/api/metas', { modelo: d.tpl }).then(function () {
        aviso('Meta adicionada às suas metas!');
        return ir('painel');
      });
    } else if (d.cut) {
      return api('POST', '/api/cutucar', { usuario: d.cut }).then(function (j) {
        aviso(mensagemDeGanho(j, '👈 Você cutucou ' + j.usuario + '!'));
        return atualizarTopo();
      });
    } else if (d.res) {
      return api('POST', '/api/missoes/' + d.res + '/resgatar', {}).then(function (j) {
        aviso(mensagemDeGanho(j, '+' + j.xp + ' XP'));
        return ir('missoes');
      });
    } else if (d.carta) {
      return api('POST', '/api/missoes/carta', {}).then(function () {
        return ir('missoes');
      });
    } else if (t.id == 'sw') {
      S.audio = !S.audio;
      t.classList.toggle('on', S.audio);
    } else if (d.criar) {
      var n = $('#nm').value.trim();
      if (n.length < 3) {
        aviso('O nome precisa ter pelo menos 3 letras.');
        return null;
      }
      var convidados = $('#co')
        .value.split(',')
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
      return api('POST', '/api/metas', {
        nome: n,
        dias: S.dias,
        modo_prova: S.audio,
        convidados: convidados,
      }).then(function () {
        S.audio = false;
        aviso('Meta criada!');
        return ir('painel');
      });
    } else if (d.env) {
      var i = $('#tx');
      var v = i.value.trim();
      if (!v) return null;
      return api('POST', '/api/metas/' + d.env + '/mensagens', { texto: v }).then(function () {
        return ir('meta');
      });
    }
    return null;
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('button,[data-abrir],[data-pf]');
    if (!t) return;
    var d = t.dataset;
    Promise.resolve()
      .then(function () {
        return acao(t, d);
      })
      .catch(falha);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target && e.target.id === 'tx') {
      var b = document.querySelector('[data-env]');
      if (b) b.click();
    }
  });

  api('GET', '/api/eu')
    .then(function (u) {
      NOME = u.usuario;
      $('#nome_usuario').textContent = NOME;
      $('#inicial_usuario').textContent = NOME.charAt(0).toUpperCase();
      return ir('painel');
    })
    .catch(function () {
      location.href = 'index.html';
    });
})();
