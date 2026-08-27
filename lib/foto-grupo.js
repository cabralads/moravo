// =========================================================================
// Foto que os grupos de WhatsApp recebem ao nascer
// =========================================================================
// Fica no banco, não em uploads/: o container é recriado a cada deploy e
// arquivo gravado em disco vai junto. Como é uma imagem só e pequena, o custo
// de guardar em base64 na linha de configuração é menor que o de perdê-la.
//
// Sem nada no banco, vale a imagem do repositório: o grupo nunca nasce sem
// foto por falta de configuração.
// =========================================================================
const fs = require('fs');
const path = require('path');
const { query } = require('../db');

const PADRAO = path.join(__dirname, '..', 'public', 'img', 'moravo-grupo.jpg');
const TIPOS_OK = ['image/jpeg', 'image/png', 'image/webp'];
const TAMANHO_MAX = 2 * 1024 * 1024; // 2MB

async function obterFotoGrupo() {
  try {
    const r = await query(
      `SELECT foto_grupo, foto_grupo_mime, foto_grupo_em
         FROM moravo.config_whatsapp WHERE id = 1`
    );
    const linha = r.rows[0];
    if (linha && linha.foto_grupo) {
      return {
        base64: linha.foto_grupo,
        mimetype: linha.foto_grupo_mime || 'image/jpeg',
        origem: 'painel',
        em: linha.foto_grupo_em || null,
      };
    }
  } catch (err) {
    console.warn('[foto-grupo] não foi possível ler do banco:', err.message);
  }

  if (!fs.existsSync(PADRAO)) return null;
  return {
    base64: fs.readFileSync(PADRAO).toString('base64'),
    mimetype: 'image/jpeg',
    origem: 'padrão do repositório',
    em: null,
  };
}

async function salvarFotoGrupo({ buffer, mimetype }) {
  if (!buffer || !buffer.length) throw new Error('Nenhuma imagem recebida.');
  if (TIPOS_OK.indexOf(mimetype) === -1) {
    throw new Error('Formato não aceito. Use JPG, PNG ou WEBP.');
  }
  if (buffer.length > TAMANHO_MAX) {
    throw new Error('Imagem maior que 2MB. Reduza antes de enviar.');
  }
  await query(
    `UPDATE moravo.config_whatsapp
        SET foto_grupo = $1, foto_grupo_mime = $2, foto_grupo_em = NOW()
      WHERE id = 1`,
    [buffer.toString('base64'), mimetype]
  );
  return { bytes: buffer.length, mimetype };
}

// Volta para a imagem do repositório
async function limparFotoGrupo() {
  await query(
    `UPDATE moravo.config_whatsapp
        SET foto_grupo = NULL, foto_grupo_mime = NULL, foto_grupo_em = NULL
      WHERE id = 1`
  );
}

module.exports = { obterFotoGrupo, salvarFotoGrupo, limparFotoGrupo, TIPOS_OK, TAMANHO_MAX, PADRAO };
