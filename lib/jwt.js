// =========================================================================
// JWT — configuração centralizada
// Lê JWT_SECRET do ambiente. Se faltar em produção, aborta o startup.
// =========================================================================

const jwt = require('jsonwebtoken');

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.trim() === '') {
    // Em produção, não sobe sem secret. Em dev, usa um placeholder visível
    // (vai aparecer no log, fácil de notar).
    if ((process.env.NODE_ENV || 'development') === 'production') {
      throw new Error('JWT_SECRET não definido. Defina no .env antes de subir em produção.');
    }
    return 'moravo-dev-secret-troque';
  }
  return secret;
}

function getExpiresIn() {
  const hours = parseInt(process.env.JWT_EXPIRES_IN, 10);
  return (Number.isFinite(hours) && hours > 0 ? hours : 168) + 'h';
}

function sign(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: getExpiresIn() });
}

function verify(token) {
  return jwt.verify(token, getSecret());
}

module.exports = { sign, verify };
