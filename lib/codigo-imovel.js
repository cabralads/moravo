// =========================================================================
// Código público e URL amigável do imóvel
// =========================================================================
// O id do banco é sequencial: entrega quantos imóveis existem, e um link com
// id vira uma lista inteira quando alguém resolve contar de 1 até acabar. O
// código é aleatório, então serve de identificação pública sem esse vazamento,
// e ainda cabe no nome do grupo do WhatsApp (por exemplo "Casa mc7GvdX").
//
// O id continua existindo e continua sendo a chave: o código é só a fachada.
// =========================================================================

// Sem 0/O/o, 1/l/I: são os pares que as pessoas erram ao ler em voz alta ou
// ao digitar um código que veio pelo WhatsApp.
const ALFABETO = '23456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const TAMANHO = 7;

const crypto = require('crypto');

function gerarCodigo(tamanho = TAMANHO) {
  const bytes = crypto.randomBytes(tamanho);
  let saida = '';
  for (let i = 0; i < tamanho; i++) saida += ALFABETO[bytes[i] % ALFABETO.length];
  return saida;
}

// Um código válido tem só letras e números do alfabeto acima. Serve para
// separar "é um código" de "é um id numérico" na rota.
function pareceCodigo(v) {
  return typeof v === 'string' && new RegExp('^[' + ALFABETO + ']{' + TAMANHO + '}$').test(v);
}

function slugify(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // tira acento
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Preço em partes legíveis: 580000 -> "580-000"
function precoSlug(preco) {
  const n = Math.round(Number(preco) || 0);
  if (!n) return '';
  return slugify(n.toLocaleString('pt-BR'));
}

// tipo + preço + cidade, que é o que a pessoa procura no Google
function slugImovel(im) {
  return [slugify(im && im.tipo), precoSlug(im && im.preco), slugify(im && im.cidade)]
    .filter(Boolean).join('-') || 'imovel';
}

// A URL leva o slug no caminho e o código na query. O slug é enfeite: pode
// mudar quando o preço mudar sem invalidar nenhum link já enviado, porque
// quem identifica o imóvel é sempre o código.
function urlImovel(im) {
  if (!im || !im.codigo) return im && im.id ? '/detalhes?id=' + im.id : '/';
  return '/imovel/' + slugImovel(im) + '/?id=' + im.codigo;
}

// Nome do grupo no WhatsApp: "Casa mc7GvdX"
function nomeGrupo(im) {
  const tipo = String((im && im.tipo) || 'Imóvel');
  const titulo = tipo.charAt(0).toUpperCase() + tipo.slice(1);
  return im && im.codigo ? titulo + ' ' + im.codigo : titulo;
}

// Grupo do comprador: leva o primeiro nome do corretor, senão o comprador vê
// dois grupos com o mesmo título e não sabe qual é qual. Só o primeiro nome
// porque o WhatsApp corta o assunto do grupo em poucas letras na lista.
function nomeGrupoComprador(im, corretorNome) {
  const base = nomeGrupo(im);
  const primeiro = String(corretorNome || '').trim().split(/\s+/)[0];
  return primeiro ? base + ' · ' + primeiro : base;
}

module.exports = { gerarCodigo, pareceCodigo, slugify, slugImovel, urlImovel,
                   nomeGrupo, nomeGrupoComprador, ALFABETO, TAMANHO };
