(function () {
  'use strict';

  var textosAbas = {
    entrar: {
      titulo: 'Bem-vinda de volta',
      subtitulo: 'Entre pra ver o progresso das suas metas',
      botao: 'Entrar →',
      dicaSenha: '••••••••',
      autocompletar: 'current-password'
    },
    criar: {
      titulo: 'Crie sua conta',
      subtitulo: 'Comece sua primeira meta em menos de 1 minuto',
      botao: 'Criar conta →',
      dicaSenha: 'Mínimo 8, com letras e números',
      autocompletar: 'new-password'
    }
  };

  var duracaoAviso = 2200;
  var paginaPainel = 'painel.html';
  var atrasoRedirecionamento = 500;
  var msgSemServidor = 'Não consegui falar com o servidor. Rode "node servidor.js" e abra http://127.0.0.1:8000';

  var regraUsuario = /^[A-Za-z0-9_.]{3,20}$/;
  var regraEmail = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
  var regraCodigo = /^[0-9]{6}$/;

  var abas = document.querySelectorAll('.aba');
  var campoNome = document.getElementById('campo_nome');
  var campoConfirmar = document.getElementById('campo_confirmar');
  var campoCodigo = document.getElementById('campo_codigo');
  var campoSenhaCaixa = document.getElementById('campo_senha');
  var campoUsuario = document.getElementById('nome_login');
  var campoEmail = document.getElementById('email_login');
  var campoSenha = document.getElementById('senha_login');
  var campoConfirmarSenha = document.getElementById('confirmar_login');
  var campoCodigoTexto = document.getElementById('codigo_login');
  var rotuloSenha = document.getElementById('rotulo_senha');
  var rotuloConfirmar = document.getElementById('rotulo_confirmar');
  var botaoEsqueci = document.getElementById('botao_esqueci');
  var botaoReenviar = document.getElementById('botao_reenviar');
  var tituloFormulario = document.getElementById('titulo_formulario');
  var subtituloFormulario = document.getElementById('subtitulo_formulario');
  var botaoPrincipal = document.getElementById('botao_principal');
  var formularioLogin = document.getElementById('formulario_login');
  var elementoErro = document.getElementById('erro_form');
  var elementoAviso = document.getElementById('aviso');
  var temporizadorAviso = null;
  var abaAtual = 'entrar';
  // 0 = login/cadastro normal, 1 = pedir código por e-mail, 2 = digitar código + nova senha
  var etapaRecuperar = 0;
  var enviando = false;

  function mostrarAviso(mensagem, duracao) {
    elementoAviso.textContent = mensagem;
    elementoAviso.classList.add('mostrar');
    clearTimeout(temporizadorAviso);
    temporizadorAviso = setTimeout(function () {
      elementoAviso.classList.remove('mostrar');
    }, duracao || duracaoAviso);
  }

  function mostrarErro(mensagem) {
    elementoErro.textContent = mensagem;
  }

  function trocarAba(nomeAba) {
    var criandoConta = nomeAba === 'criar';
    var textos = textosAbas[nomeAba];

    abaAtual = nomeAba;
    etapaRecuperar = 0;

    abas.forEach(function (aba) {
      aba.classList.toggle('ativa', aba.getAttribute('data-aba') === nomeAba);
    });

    campoNome.classList.toggle('visivel', criandoConta);
    campoConfirmar.classList.toggle('visivel', criandoConta);
    campoCodigo.classList.remove('visivel');
    campoSenhaCaixa.classList.remove('escondido');
    botaoReenviar.classList.remove('visivel');
    campoEmail.readOnly = false;
    rotuloSenha.textContent = 'Senha';
    rotuloConfirmar.textContent = 'Confirmar senha';
    botaoEsqueci.textContent = 'Esqueci minha senha';
    botaoEsqueci.classList.toggle('oculto', criandoConta);
    tituloFormulario.textContent = textos.titulo;
    subtituloFormulario.textContent = textos.subtitulo;
    botaoPrincipal.textContent = textos.botao;
    campoSenha.placeholder = textos.dicaSenha;
    campoSenha.setAttribute('autocomplete', textos.autocompletar);
    mostrarErro('');
  }

  // Passo 1 da recuperação: só o campo de e-mail.
  function abrirRecuperacao() {
    etapaRecuperar = 1;
    abas.forEach(function (aba) {
      aba.classList.remove('ativa');
    });
    campoNome.classList.remove('visivel');
    campoConfirmar.classList.remove('visivel');
    campoCodigo.classList.remove('visivel');
    campoSenhaCaixa.classList.add('escondido');
    botaoReenviar.classList.remove('visivel');
    campoEmail.readOnly = false;
    botaoEsqueci.textContent = '← Voltar ao login';
    botaoEsqueci.classList.remove('oculto');
    tituloFormulario.textContent = 'Esqueceu a senha?';
    subtituloFormulario.textContent = 'Digite o e-mail da sua conta e enviaremos um código para você criar uma nova senha';
    botaoPrincipal.textContent = 'Enviar código →';
    mostrarErro('');
    campoEmail.focus();
  }

  // Passo 2: código recebido + nova senha.
  function abrirNovaSenha(email) {
    etapaRecuperar = 2;
    campoEmail.value = email;
    campoEmail.readOnly = true;
    campoCodigoTexto.value = '';
    campoSenha.value = '';
    campoConfirmarSenha.value = '';
    campoCodigo.classList.add('visivel');
    campoSenhaCaixa.classList.remove('escondido');
    campoConfirmar.classList.add('visivel');
    botaoReenviar.classList.add('visivel');
    rotuloSenha.textContent = 'Nova senha';
    rotuloConfirmar.textContent = 'Confirmar nova senha';
    campoSenha.placeholder = 'Mínimo 8, com letras e números';
    campoSenha.setAttribute('autocomplete', 'new-password');
    tituloFormulario.textContent = 'Digite o código';
    subtituloFormulario.textContent = 'Se o e-mail ' + email + ' tiver uma conta, enviamos um código de 6 dígitos. Ele vale 15 minutos.';
    botaoPrincipal.textContent = 'Redefinir senha →';
    mostrarErro('');
    campoCodigoTexto.focus();
  }

  function alternarSenha(botao) {
    var campo = document.getElementById(botao.getAttribute('data-alvo'));
    var mostrando = campo.type === 'password';

    campo.type = mostrando ? 'text' : 'password';
    botao.textContent = mostrando ? '🙈' : '👁️';
    botao.setAttribute('aria-label', mostrando ? 'Ocultar senha' : 'Mostrar senha');
  }

  function validarSenhaNova(senha, confirmar) {
    if (senha.length < 8) {
      return 'A senha precisa ter pelo menos 8 caracteres.';
    }
    if (!/[A-Za-z]/.test(senha) || !/[0-9]/.test(senha)) {
      return 'A senha precisa ter letras e números.';
    }
    if (senha !== confirmar) {
      return 'As senhas não conferem.';
    }
    return '';
  }

  function validar(dados, criandoConta) {
    if (criandoConta && !regraUsuario.test(dados.usuario)) {
      return 'Usuário: de 3 a 20 caracteres (letras, números, _ ou .).';
    }
    if (!regraEmail.test(dados.email)) {
      return 'Digite um e-mail válido.';
    }
    if (!dados.senha) {
      return 'Digite sua senha.';
    }
    if (!criandoConta) {
      return '';
    }
    return validarSenhaNova(dados.senha, dados.confirmar);
  }

  function pedir(url, dados) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados)
    }).then(function (resposta) {
      return resposta.json().then(function (corpo) {
        return { status: resposta.status, corpo: corpo };
      });
    });
  }

  function liberar() {
    enviando = false;
    botaoPrincipal.disabled = false;
  }

  function erroDoServidor(resultado) {
    return (resultado.corpo && resultado.corpo.erro) || 'Algo deu errado. Tente de novo.';
  }

  // Pede o código por e-mail (passo 1, e também o "enviar outro código").
  function pedirCodigo() {
    var email = campoEmail.value.trim();

    if (enviando) {
      return;
    }
    if (!regraEmail.test(email)) {
      mostrarErro('Digite um e-mail válido.');
      return;
    }
    mostrarErro('');
    enviando = true;
    botaoPrincipal.disabled = true;

    pedir('/api/esqueci', { email: email })
      .then(function (resultado) {
        if (resultado.corpo && resultado.corpo.ok) {
          abrirNovaSenha(email);
          mostrarAviso('Pedido enviado! Confira seu e-mail.', 3500);
        } else {
          mostrarErro(erroDoServidor(resultado));
        }
        liberar();
      })
      .catch(function () {
        mostrarErro(msgSemServidor);
        liberar();
      });
  }

  // Passo 2: manda e-mail + código + nova senha.
  function redefinirSenha() {
    var dados = {
      email: campoEmail.value.trim(),
      codigo: campoCodigoTexto.value.trim(),
      senha: campoSenha.value,
      confirmar: campoConfirmarSenha.value
    };
    var erro = '';

    if (enviando) {
      return;
    }
    if (!regraCodigo.test(dados.codigo)) {
      erro = 'Digite o código de 6 dígitos que chegou no seu e-mail.';
    } else {
      erro = validarSenhaNova(dados.senha, dados.confirmar);
    }
    if (erro) {
      mostrarErro(erro);
      return;
    }
    mostrarErro('');
    enviando = true;
    botaoPrincipal.disabled = true;

    pedir('/api/redefinir', dados)
      .then(function (resultado) {
        if (resultado.corpo && resultado.corpo.ok) {
          var email = dados.email;
          trocarAba('entrar');
          campoEmail.value = email;
          campoSenha.value = '';
          campoConfirmarSenha.value = '';
          campoCodigoTexto.value = '';
          mostrarAviso('Senha redefinida! Entre com a nova senha.', 4000);
          campoSenha.focus();
        } else {
          mostrarErro(erroDoServidor(resultado));
        }
        liberar();
      })
      .catch(function () {
        mostrarErro(msgSemServidor);
        liberar();
      });
  }

  function enviar() {
    var criandoConta = abaAtual === 'criar';
    var dados = {
      usuario: campoUsuario.value.trim(),
      email: campoEmail.value.trim(),
      senha: campoSenha.value,
      confirmar: campoConfirmarSenha.value
    };
    var erro;

    if (etapaRecuperar === 1) {
      pedirCodigo();
      return;
    }
    if (etapaRecuperar === 2) {
      redefinirSenha();
      return;
    }

    erro = validar(dados, criandoConta);
    if (enviando) {
      return;
    }
    if (erro) {
      mostrarErro(erro);
      return;
    }

    mostrarErro('');
    enviando = true;
    botaoPrincipal.disabled = true;

    pedir(criandoConta ? '/api/cadastro' : '/api/login', dados)
      .then(function (resultado) {
        if (resultado.corpo && resultado.corpo.ok) {
          mostrarAviso(criandoConta ? 'Conta criada! Entrando...' : 'Entrando...');
          setTimeout(function () {
            window.location.href = paginaPainel;
          }, atrasoRedirecionamento);
          return;
        }
        mostrarErro(erroDoServidor(resultado));
        liberar();
      })
      .catch(function () {
        mostrarErro(msgSemServidor);
        liberar();
      });
  }

  abas.forEach(function (aba) {
    aba.addEventListener('click', function () {
      trocarAba(aba.getAttribute('data-aba'));
    });
  });

  botaoEsqueci.addEventListener('click', function () {
    if (etapaRecuperar > 0) {
      trocarAba('entrar');
    } else {
      abrirRecuperacao();
    }
  });

  botaoReenviar.addEventListener('click', function () {
    pedirCodigo();
  });

  document.querySelectorAll('.botao_ver').forEach(function (botao) {
    botao.addEventListener('click', function () {
      alternarSenha(botao);
    });
  });

  document.querySelectorAll('[data-aviso]').forEach(function (elemento) {
    elemento.addEventListener('click', function () {
      mostrarAviso(elemento.getAttribute('data-aviso'));
    });
  });

  formularioLogin.addEventListener('submit', function (evento) {
    evento.preventDefault();
    enviar();
  });
})();
