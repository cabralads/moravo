// =========================================================================
// /api/auth — registro, login, dados do usuário logado
// =========================================================================
const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();

const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sign: signJwt } = require('../lib/jwt');

const PERFIS = ['proprietario', 'corretor'];
const SALT_ROUNDS = 10;

function normalizeWhatsapp(v) { return (v || '').replace(/\D/g, ''); }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CRECI_RE = /^[0-9]+-?[A-Z]?$/;

// Gera token JWT com TTL configurável (default 7 dias)
function signToken(user) {
  return signJwt({ id: user.id, email: user.email, perfil: user.perfil, nome: user.nome });
}

// ---- POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const body = req.body || {};
    const nome = (body.nome || '').trim();
    const email = (body.email || '').trim().toLowerCase();
    const whatsapp = normalizeWhatsapp(body.whatsapp);
    const cidade = (body.cidade || '').trim();
    const perfil = (body.perfil || '').trim().toLowerCase();
    const senha = body.senha || '';
    const tipo_imovel = (body.tipo_imovel || '').trim() || null;
    const preco_estimado = body.preco_estimado ? Number(String(body.preco_estimado).replace(/\D/g, '')) : null;
    const creci = (body.creci || '').trim().toUpperCase() || null;
    const regiao_atuacao = (body.regiao_atuacao || '').trim() || null;

    const errors = [];
    if (nome.length < 2) errors.push({ field: 'nome', message: 'Nome muito curto.' });
    if (!EMAIL_RE.test(email)) errors.push({ field: 'email', message: 'E-mail inválido.' });
    if (whatsapp.length < 10 || whatsapp.length > 13) errors.push({ field: 'whatsapp', message: 'WhatsApp inválido.' });
    if (cidade.length < 2) errors.push({ field: 'cidade', message: 'Cidade inválida.' });
    if (PERFIS.indexOf(perfil) === -1) errors.push({ field: 'perfil', message: 'Perfil inválido.' });
    if (senha.length < 6) errors.push({ field: 'senha', message: 'Senha deve ter no mínimo 6 caracteres.' });

    if (perfil === 'proprietario' && tipo_imovel && !['casa', 'apartamento', 'terreno', 'comercial', 'chacara', 'sitio'].includes(tipo_imovel)) {
      errors.push({ field: 'tipo_imovel', message: 'Tipo de imóvel inválido.' });
    }
    if (perfil === 'corretor' && !CRECI_RE.test(creci || '')) {
      errors.push({ field: 'creci', message: 'CRECI inválido (use o formato 12345-F).' });
    }
    if (perfil === 'corretor' && (!regiao_atuacao || regiao_atuacao.length < 2)) {
      errors.push({ field: 'regiao_atuacao', message: 'Informe a região de atuação.' });
    }

    if (errors.length) return res.status(400).json({ ok: false, errors });

    // Hash da senha
    const senha_hash = await bcrypt.hash(senha, SALT_ROUNDS);

    const result = await query(
      `INSERT INTO moravo.usuarios
        (nome, email, senha_hash, whatsapp, cidade, perfil,
         tipo_imovel, preco_estimado, creci, regiao_atuacao,
         ip_cadastro, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, created_at`,
      [nome, email, senha_hash, whatsapp, cidade, perfil,
        tipo_imovel, preco_estimado, creci, regiao_atuacao,
        req.ip || null,
        (req.get('user-agent') || '').slice(0, 255) || null]
    );

    const newUser = { id: result.rows[0].id, email, perfil, nome, whatsapp, cidade };
    const token = signToken(newUser);

    return res.status(201).json({
      ok: true,
      token,
      user: { ...newUser, created_at: result.rows[0].created_at },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ ok: false, errors: [{ field: 'email', message: 'Este e-mail já está cadastrado.' }] });
    }
    if (err.code === '23514') {
      return res.status(400).json({ ok: false, errors: [{ field: 'perfil', message: 'Dados não correspondem ao perfil.' }] });
    }
    console.error('[auth/register] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const body = req.body || {};
    const email = (body.email || '').trim().toLowerCase();
    const senha = body.senha || '';

    if (!EMAIL_RE.test(email) || !senha) {
      return res.status(400).json({ ok: false, error: 'E-mail e senha são obrigatórios.' });
    }

    const r = await query(
      `SELECT id, nome, email, whatsapp, cidade, perfil, foto_perfil, senha_hash FROM moravo.usuarios WHERE email = $1`,
      [email]
    );
    if (r.rowCount === 0) {
      return res.status(401).json({ ok: false, error: 'E-mail ou senha incorretos.' });
    }

    const user = r.rows[0];
    if (!user.senha_hash) {
      return res.status(401).json({ ok: false, error: 'Conta sem senha definida. Use o fluxo de cadastro.' });
    }

    const ok = await bcrypt.compare(senha, user.senha_hash);
    if (!ok) {
      return res.status(401).json({ ok: false, error: 'E-mail ou senha incorretos.' });
    }

    const token = signToken(user);
    return res.json({
      ok: true,
      token,
      user: { id: user.id, nome: user.nome, email: user.email, whatsapp: user.whatsapp, cidade: user.cidade, perfil: user.perfil, foto_perfil: user.foto_perfil },
    });
  } catch (err) {
    console.error('[auth/login] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- GET /api/auth/me — dados do usuário logado
router.get('/me', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, nome, email, whatsapp, cidade, perfil,
              tipo_imovel, preco_estimado, creci, regiao_atuacao, foto_perfil, created_at
       FROM moravo.usuarios WHERE id = $1`,
      [req.user.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: 'Usuário não encontrado.' });
    return res.json({ ok: true, user: r.rows[0] });
  } catch (err) {
    console.error('[auth/me] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

module.exports = router;
