// =========================================================================
// Cifra dos segredos guardados no banco (AES-256-GCM)
// =========================================================================
// Usado pelo token da Meta e pela chave do Waha. A chave de cifra vem de
// CONFIG_SECRET, com JWT_SECRET como reserva, para não exigir uma variável
// nova em quem já tinha o sistema rodando.
// =========================================================================
const crypto = require('crypto');

function chave() {
  const base = process.env.CONFIG_SECRET || process.env.JWT_SECRET;
  if (!base || !base.trim()) {
    throw new Error('CONFIG_SECRET (ou JWT_SECRET) precisa estar definido para guardar segredos.');
  }
  return crypto.scryptSync(base, 'moravo-config-whatsapp', 32);
}

function cifrar(texto) {
  if (!texto) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const dados = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), dados.toString('base64')].join(':');
}

function decifrar(guardado) {
  if (!guardado) return '';
  const partes = String(guardado).split(':');
  if (partes.length !== 3) return '';
  try {
    const [iv, tag, dados] = partes.map((p) => Buffer.from(p, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', chave(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(dados), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('[cripto] falha ao decifrar:', err.message);
    return '';
  }
}

module.exports = { cifrar, decifrar };
