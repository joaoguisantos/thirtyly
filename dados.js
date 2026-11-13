'use strict';
/* Dados fixos do jogo: troféus, missões, cartas-desafio e metas oficiais.
 *
 * Isso não muda de pessoa para pessoa, então fica aqui no JavaScript e não no
 * banco. O banco (schema.sql) guarda só o que cada usuário faz: contas,
 * metas, provas, chat, XP e o que ele conquistou.
 *
 * Este arquivo NÃO é servido ao navegador.
 */

// raridade: 1 comum, 2 raro, 3 épico, 4 lendário
const TROFEUS = [
  { chave: 'primeiro_passo', nome: 'Primeiro passo', descricao: 'Conclua seu primeiro dia', raridade: 1 },
  { chave: 'semana_de_fogo', nome: 'Semana de fogo', descricao: '7 dias seguidos', raridade: 1 },
  { chave: 'prova_real', nome: 'Prova real', descricao: 'Envie 10 provas', raridade: 1 },
  { chave: 'voz_da_meta', nome: 'Voz da meta', descricao: 'Envie 5 provas em áudio', raridade: 2 },
  { chave: 'voltei_dos_mortos', nome: 'Voltei dos mortos', descricao: 'Salve uma meta na lápide', raridade: 2 },
  { chave: 'meta_cumprida', nome: 'Meta cumprida', descricao: 'Termine uma meta', raridade: 2 },
  { chave: 'time_unido', nome: 'Time unido', descricao: 'Meta com 5 pessoas', raridade: 2 },
  { chave: 'mes_perfeito', nome: 'Mês perfeito', descricao: '30 dias sem falhar', raridade: 3 },
  { chave: 'rei_das_cobrancas', nome: 'Rei das cobranças', descricao: 'Cutuque 20 pessoas', raridade: 2 },
  { chave: 'madrugador', nome: 'Madrugador', descricao: 'Prova antes das 7h, 7 vezes', raridade: 3 },
  { chave: 'meta_de_ferro', nome: 'Meta de ferro', descricao: 'Cumpra uma meta de 90 dias', raridade: 4 },
  { chave: 'top_10', nome: 'Top 10', descricao: 'Entre no top 10 global', raridade: 3 },
  { chave: 'corrente', nome: 'Corrente', descricao: 'Conclua 3 metas', raridade: 3 },
  { chave: 'mestre_das_provas', nome: 'Mestre das provas', descricao: 'Envie 100 provas', raridade: 4 },
  { chave: 'nivel_20', nome: 'Nível 20', descricao: 'Chegue ao nível 20', raridade: 4 },
  { chave: 'sobrevivente', nome: 'Sobrevivente', descricao: 'Termine uma meta sem nunca ter virado fantasma', raridade: 4 },
];

// Missões do dia (renovam à meia-noite).
const MISSOES = [
  { chave: 'provas', titulo: 'Envie 2 provas hoje', quantidade: 2, xp: 40 },
  { chave: 'cutucar', titulo: 'Cutuque um membro atrasado', quantidade: 1, xp: 15 },
  { chave: 'mensagem', titulo: 'Mande uma mensagem no chat', quantidade: 1, xp: 10 },
];

const CARTAS = [
  'Envie a prova de hoje antes das 10h.',
  'Mande um áudio de incentivo no chat.',
  'Convide alguém novo para uma meta.',
  'Cutuque quem está há 2 dias sem marcar.',
];

// Metas oficiais da aba "Descobrir".
const METAS_OFICIAIS = [
  { chave: 'hidratacao_total', nome: 'Hidratação total', dias: 30, modo_prova: false, descricao: 'Beba 2,5L de água todos os dias', categoria: 'Saúde' },
  { chave: 'corrida_5k', nome: 'Corrida 5K', dias: 60, modo_prova: true, descricao: 'Corra ou caminhe 30 min por dia', categoria: 'Fitness' },
  { chave: 'leitura_diaria', nome: 'Leitura diária', dias: 30, modo_prova: false, descricao: 'Leia 15 páginas por dia', categoria: 'Estudo' },
  { chave: 'meditar_10_min', nome: 'Meditar 10 min', dias: 21, modo_prova: true, descricao: 'Grave um áudio contando como foi', categoria: 'Mente' },
  { chave: 'acordar_cedo', nome: 'Acordar cedo', dias: 30, modo_prova: true, descricao: 'Foto do nascer do sol antes das 7h', categoria: 'Rotina' },
  { chave: 'jantar_em_familia', nome: 'Jantar em família', dias: 90, modo_prova: true, descricao: 'Foto da mesa, sem celular', categoria: 'Família' },
  { chave: 'economia_diaria', nome: 'Economia diária', dias: 60, modo_prova: false, descricao: 'Guarde R$ 5 por dia', categoria: 'Finanças' },
  { chave: 'ingles_falado', nome: 'Inglês falado', dias: 30, modo_prova: true, descricao: 'Grave 1 min falando em inglês', categoria: 'Estudo' },
];

module.exports = { TROFEUS, MISSOES, CARTAS, METAS_OFICIAIS };
