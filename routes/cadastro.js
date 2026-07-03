// =========================================================================
// POST /api/cadastro — recebe dados do formulário do site e grava no banco
// =========================================================================
const express = require('express');
const router = express.Router();
const { query } = require('../db');

// Perfis aceitos (espelha o CHECK constraint do schema)
const PERFIS = ['proprietario', 'corretor'];

// Campos obrigatórios por perfil
const REQUIRED_BY_PERFIL = {
  proprietario: ['nome', 'email', 'whatsapp', 'cidade'],
  corretor:     ['nome', 'email', 'whatsapp', 'cidade', 'creci', 'regiao_atuacao'],
};

// Normaliza o WhatsApp pra só dígitos (ex: (47) 99999-9999 -> 47999999999)
function normalizeWhatsapp(value) {
  if (!value) return '';
  return String(value).replace(/\D/g, '');
}

// Validação de e-mail simples (mesma regex que o front já usa)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Validação do CRECI: número, opcional hífen + letra (ex: 12345-F)
const CRECI_RE = /^[0-9]+-?[A-Z]?$/;

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};

    // ---- 1) Campos comuns
    const nome     = (body.nome     || '').trim();
    const email    = (body.email    || '').trim().toLowerCase();
    const whatsapp = normalizeWhatsapp(body.whatsapp);
    const cidade   = (body.cidade   || '').trim();
    const perfil   = (body.perfil   || '').trim().toLowerCase();

    // ---- 2) Campos específicos por perfil
    const tipo_imovel    = (body.tipo_imovel    || '').trim() || null;
    const preco_estimado = body.preco_estimado ? Number(String(body.preco_estimado).replace(/\D/g, '')) : null;
    const creci          = (body.creci          || '').trim().toUpperCase() || null;
    const regiao_atuacao = (body.regiao_atuacao || '').trim() || null;

    // ---- 3) Validações
    const errors = [];

    if (PERFIS.indexOf(perfil) === -1) {
      errors.push({ field: 'perfil', message: 'Perfil inválido.' });
    }
    if (nome.length < 2)               errors.push({ field: 'nome',     message: 'Nome muito curto.' });
    if (!EMAIL_RE.test(email))         errors.push({ field: 'email',    message: 'E-mail inválido.' });
    if (whatsapp.length < 10 || whatsapp.length > 13) {
      errors.push({ field: 'whatsapp', message: 'WhatsApp inválido.' });
    }
    if (cidade.length < 2)             errors.push({ field: 'cidade',   message: 'Cidade inválida.' });

    if (perfil === 'proprietario') {
      const tiposValidos = ['casa', 'apartamento', 'terreno', 'comercial', 'chacara', 'sitio'];
      if (tipo_imovel && tiposValidos.indexOf(tipo_imovel) === -1) {
        errors.push({ field: 'tipo_imovel', message: 'Tipo de imóvel inválido.' });
      }
      if (preco_estimado !== null && preco_estimado < 0) {
        errors.push({ field: 'preco_estimado', message: 'Preço não pode ser negativo.' });
      }
    }

    if (perfil === 'corretor') {
      if (!CRECI_RE.test(creci || '')) {
        errors.push({ field: 'creci', message: 'CRECI inválido (use o formato 12345-F).' });
      }
      if (!regiao_atuacao || regiao_atuacao.length < 2) {
        errors.push({ field: 'regiao_atuacao', message: 'Informe a região de atuação.' });
      }
    }

    if (errors.length) {
      return res.status(400).json({ ok: false, errors });
    }

    // ---- 4) INSERT
    // Os CHECK constraints do banco fazem a segunda camada de validação
    const sql = `
      INSERT INTO moravo.usuarios
        (nome, email, whatsapp, cidade, perfil,
         tipo_imovel, preco_estimado, creci, regiao_atuacao,
         ip_cadastro, user_agent)
      VALUES
        ($1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11)
      RETURNING id, created_at
    `;
    const params = [
      nome, email, whatsapp, cidade, perfil,
      tipo_imovel, preco_estimado, creci, regiao_atuacao,
      req.ip || null,
      (req.get('user-agent') || '').slice(0, 255) || null,
    ];

    const result = await query(sql, params);

    return res.status(201).json({
      ok: true,
      id: result.rows[0].id,
      created_at: result.rows[0].created_at,
    });
  } catch (err) {
    // 23505 = unique_violation (e-mail duplicado)
    if (err.code === '23505') {
      return res.status(409).json({
        ok: false,
        errors: [{ field: 'email', message: 'Este e-mail já está cadastrado.' }],
      });
    }
    // 23514 = check_violation (burlou alguma CHECK constraint)
    if (err.code === '23514') {
      return res.status(400).json({
        ok: false,
        errors: [{ field: 'perfil', message: 'Dados não correspondem ao perfil selecionado.' }],
      });
    }
    console.error('[cadastro] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

module.exports = router;
