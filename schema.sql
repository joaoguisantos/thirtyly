-- =====================================================================
-- Thirtyly: banco de dados
-- =====================================================================


-- ---------------------------------------------------------------------
-- Contas e login
-- ---------------------------------------------------------------------

-- A senha nunca é guardada: só o hash (scrypt com sal).
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  usuario VARCHAR(20) NOT NULL UNIQUE,
  email VARCHAR(254) NOT NULL UNIQUE,
  senha_hash VARCHAR(255) NOT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Só o hash do token fica aqui (o token de verdade fica no cookie).
CREATE TABLE IF NOT EXISTS sessoes (
  token_hash VARCHAR(64) NOT NULL PRIMARY KEY,
  usuario_id INTEGER NOT NULL,
  expira_em BIGINT NOT NULL,
  FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
);

-- Tentativas que falharam (bloqueio contra adivinhar senha ou código).
CREATE TABLE IF NOT EXISTS tentativas_login (
  chave VARCHAR(300) NOT NULL,
  em BIGINT NOT NULL
);

-- Código de 6 dígitos do "esqueci minha senha". Guardamos só o hash (com sal).
-- Um código por usuário; vale 15 minutos e tem no máximo 5 tentativas.
CREATE TABLE IF NOT EXISTS recuperacoes_senha (
  usuario_id INTEGER NOT NULL PRIMARY KEY,
  sal VARCHAR(32) NOT NULL,
  codigo_hash VARCHAR(64) NOT NULL,
  criado_em BIGINT NOT NULL,
  expira_em BIGINT NOT NULL,
  tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas BETWEEN 0 AND 10),
  FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- Perfil e XP (o nível é calculado do XP: nível = 1 + XP / 1000)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS perfis (
  usuario_id INTEGER NOT NULL PRIMARY KEY,
  bio VARCHAR(140) NOT NULL DEFAULT '',
  xp_total INTEGER NOT NULL DEFAULT 0 CHECK (xp_total >= 0),
  FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- Metas
-- ---------------------------------------------------------------------

-- Duração e modo prova não mudam depois de criar.
-- "modelo" é a chave da meta oficial (dados.js), ou vazio se a meta é própria.
CREATE TABLE IF NOT EXISTS metas (
  id INTEGER PRIMARY KEY,
  criador_id INTEGER NOT NULL,
  modelo VARCHAR(30) NULL,
  categoria VARCHAR(20) NOT NULL DEFAULT 'Nova',
  nome VARCHAR(60) NOT NULL,
  dias INTEGER NOT NULL CHECK (dias BETWEEN 7 AND 90),
  modo_prova TINYINT NOT NULL DEFAULT 0 CHECK (modo_prova IN (0, 1)),
  criada_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (criador_id) REFERENCES usuarios (id) ON DELETE CASCADE
);

-- Quem participa de cada meta e a situação DE CADA PESSOA nela:
--   ativa = em dia | lapide = esqueceu, tem 1 dia para salvar
--   fantasma = perdeu o prazo | concluida = chegou ao último dia
CREATE TABLE IF NOT EXISTS membros_meta (
  meta_id INTEGER NOT NULL,
  usuario_id INTEGER NOT NULL,
  estado VARCHAR(10) NOT NULL DEFAULT 'ativa'
    CHECK (estado IN ('ativa', 'lapide', 'fantasma', 'concluida')),
  dias_cumpridos INTEGER NOT NULL DEFAULT 0 CHECK (dias_cumpridos >= 0),
  salvamentos INTEGER NOT NULL DEFAULT 2 CHECK (salvamentos BETWEEN 0 AND 2),
  entrou_em VARCHAR(10) NOT NULL,
  fantasma_em VARCHAR(10) NULL,
  concluida_em VARCHAR(10) NULL,
  PRIMARY KEY (meta_id, usuario_id),
  FOREIGN KEY (meta_id) REFERENCES metas (id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- Check diário (a "prova"), chat e cutucadas
-- ---------------------------------------------------------------------

-- Um check por pessoa, por meta, por dia (a chave primária garante).
-- Guardamos o tipo da prova e o nome/tamanho do arquivo (até 25 MB).
CREATE TABLE IF NOT EXISTS checks (
  meta_id INTEGER NOT NULL,
  usuario_id INTEGER NOT NULL,
  dia VARCHAR(10) NOT NULL,
  numero INTEGER NOT NULL CHECK (numero >= 1),
  hora INTEGER NOT NULL CHECK (hora BETWEEN 0 AND 23),
  tipo_prova VARCHAR(5) NULL CHECK (tipo_prova IN ('foto', 'video', 'audio')),
  arquivo_nome VARCHAR(120) NULL,
  arquivo_bytes INTEGER NULL CHECK (arquivo_bytes BETWEEN 0 AND 26214400),
  salvamento TINYINT NOT NULL DEFAULT 0 CHECK (salvamento IN (0, 1)),
  PRIMARY KEY (meta_id, usuario_id, dia),
  FOREIGN KEY (meta_id, usuario_id) REFERENCES membros_meta (meta_id, usuario_id) ON DELETE CASCADE
);

-- Chat da meta. Só quem participa lê e escreve. Quando o check tem prova,
-- uma mensagem com o tipo da prova aparece no chat.
CREATE TABLE IF NOT EXISTS mensagens (
  id INTEGER PRIMARY KEY,
  meta_id INTEGER NOT NULL,
  usuario_id INTEGER NOT NULL,
  texto VARCHAR(500) NOT NULL,
  tipo_prova VARCHAR(5) NULL CHECK (tipo_prova IN ('foto', 'video', 'audio')),
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (meta_id, usuario_id) REFERENCES membros_meta (meta_id, usuario_id) ON DELETE CASCADE
);

-- Uma cutucada por pessoa, por destinatário, por dia.
CREATE TABLE IF NOT EXISTS cutucadas (
  de_id INTEGER NOT NULL,
  para_id INTEGER NOT NULL,
  dia VARCHAR(10) NOT NULL,
  PRIMARY KEY (de_id, para_id, dia),
  FOREIGN KEY (de_id) REFERENCES usuarios (id) ON DELETE CASCADE,
  FOREIGN KEY (para_id) REFERENCES usuarios (id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- Troféus, missões e carta do dia (a lista fixa está no dados.js)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trofeus_usuario (
  usuario_id INTEGER NOT NULL,
  trofeu VARCHAR(30) NOT NULL,
  conquistado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (usuario_id, trofeu),
  FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
);

-- Progresso diário (renova à meia-noite).
CREATE TABLE IF NOT EXISTS missoes_usuario (
  usuario_id INTEGER NOT NULL,
  missao VARCHAR(20) NOT NULL,
  dia VARCHAR(10) NOT NULL,
  progresso INTEGER NOT NULL DEFAULT 0 CHECK (progresso >= 0),
  resgatada TINYINT NOT NULL DEFAULT 0 CHECK (resgatada IN (0, 1)),
  PRIMARY KEY (usuario_id, missao, dia),
  FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
);

-- "carta" é a posição da carta sorteada na lista do dados.js.
CREATE TABLE IF NOT EXISTS carta_do_dia (
  usuario_id INTEGER NOT NULL,
  dia VARCHAR(10) NOT NULL,
  carta INTEGER NOT NULL,
  PRIMARY KEY (usuario_id, dia),
  FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
);
