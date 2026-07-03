// =========================================================================
// Middlewares de autenticação
// - requireAuth: valida JWT e popula req.user
// - requireRole(...roles): garante que o usuário tem um dos perfis
// =========================================================================
const { verify: verifyJwt } = require('../lib/jwt');

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ ok: false, error: 'Token ausente. Faça login primeiro.' });
  }

  try {
    const decoded = verifyJwt(token);
    req.user = decoded; // { id, email, perfil, iat, exp }
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Token inválido ou expirado.' });
  }
}

function requireRole(...roles) {
  return function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'Não autenticado.' });
    }
    if (roles.indexOf(req.user.perfil) === -1) {
      return res.status(403).json({
        ok: false,
        error: `Acesso restrito a: ${roles.join(', ')}. Seu perfil: ${req.user.perfil}.`,
      });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
