// =========================================================================
// /api/admin — login auditado + fila de aprovação de imóveis + logs
// =========================================================================
const express = require('express');
const bcrypt  = require('bcrypt');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sign: signJwt } = require('../lib/jwt');
const { criarNotificacao } = require('../lib/notifications');

const router = express.Router();

// ---- POST /api/admin/login — login auditado (só perfil='admin')
router.post('/login', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const senha = req.body.senha || '';

    const ip = req.ip || null;
    const ua = (req.get('user-agent') || '').slice(0, 255) || null;

    const r = await query(
      `SELECT id, nome, email, senha_hash
       FROM moravo.usuarios
       WHERE email = $1 AND perfil = 'admin'`,
      [email]
    );

    if (r.rowCount === 0) {
      // Registra tentativa falha (sem FK válida)
      await query(
        `INSERT INTO moravo.admin_login_logs (usuario_id, email, sucesso, ip, user_agent)
         VALUES (NULL, $1, false, $2, $3)`,
        [email, ip, ua]
      );
      return res.status(401).json({ ok: false, error: 'Credenciais inválidas ou sem permissão de admin.' });
    }

    const user = r.rows[0];
    const senhaOk = await bcrypt.compare(senha, user.senha_hash);

    await query(
      `INSERT INTO moravo.admin_login_logs (usuario_id, email, sucesso, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, email, senhaOk, ip, ua]
    );

    if (!senhaOk) {
      return res.status(401).json({ ok: false, error: 'Credenciais inválidas.' });
    }

    const token = signJwt({ id: user.id, email: user.email, perfil: 'admin', nome: user.nome });
    return res.json({
      ok: true,
      token,
      user: { id: user.id, nome: user.nome, email: user.email, perfil: 'admin' }
    });
  } catch (err) {
    console.error('[admin/login] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- A partir daqui, todas as rotas exigem JWT de admin
router.use(requireAuth, requireRole('admin'));

// ---- GET /api/admin/imoveis?status=pendente|aprovado|reprovado&com_documento=1
router.get('/imoveis', async (req, res) => {
  try {
    const status = (req.query.status || 'pendente').toLowerCase();
    if (['pendente', 'aprovado', 'reprovado'].indexOf(status) === -1) {
      return res.status(400).json({ ok: false, error: 'status inválido.' });
    }
    const comDocumento = req.query.com_documento === '1' || req.query.com_documento === 'true';
    const where = 'im.status_aprovacao = $1' + (comDocumento ? " AND im.escritura_arquivo_url IS NOT NULL AND im.escritura_arquivo_url <> ''" : '');
    const r = await query(
      `SELECT im.id, im.titulo, im.tipo, im.preco, im.cidade, im.uf, im.bairro,
              im.status_aprovacao, im.aprovado_em, im.reprovado_em, im.reprovado_motivo,
              im.escritura_arquivo_url, im.matricula, im.condominio, im.valor_condominio,
              im.created_at, im.fotos,
              u.nome AS dono_nome, u.email AS dono_email, u.whatsapp AS dono_whatsapp
       FROM moravo.imoveis im
       JOIN moravo.usuarios u ON u.id = im.dono_id
       WHERE ${where}
       ORDER BY im.created_at DESC
       LIMIT 200`,
      [status]
    );
    return res.json({ ok: true, total: r.rowCount, imoveis: r.rows });
  } catch (err) {
    console.error('[admin/imoveis GET] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- GET /api/admin/imoveis/contadores — totais por status (badge da sidebar)
router.get('/imoveis/contadores', async (req, res) => {
  try {
    const r = await query(
      `SELECT status_aprovacao, COUNT(*)::int AS total
       FROM moravo.imoveis
       GROUP BY status_aprovacao`
    );
    const map = { pendente: 0, aprovado: 0, reprovado: 0 };
    r.rows.forEach(function (row) { map[row.status_aprovacao] = row.total; });
    return res.json({ ok: true, contadores: map });
  } catch (err) {
    console.error('[admin/imoveis/contadores] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- POST /api/admin/imoveis/:id/aprovar
router.post('/imoveis/:id/aprovar', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'ID inválido.' });
    const r = await query(
      `UPDATE moravo.imoveis
         SET status_aprovacao = 'aprovado',
             aprovado_por = $1,
             aprovado_em = NOW(),
             reprovado_motivo = NULL,
             reprovado_em = NULL
       WHERE id = $2 RETURNING id`,
      [req.user.id, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: 'Imóvel não encontrado.' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[admin/aprovar] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- POST /api/admin/imoveis/:id/reprovar  { motivo: "..." }
router.post('/imoveis/:id/reprovar', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'ID inválido.' });
    const motivo = (req.body && req.body.motivo || '').trim();
    if (motivo.length < 10) {
      return res.status(400).json({ ok: false, error: 'Informe o motivo (mínimo 10 caracteres).' });
    }

    // Busca o imóvel antes de atualizar pra ter o dono_id e titulo na notificação
    const imovelAntes = await query(
      `SELECT id, dono_id, titulo FROM moravo.imoveis WHERE id = $1`,
      [id]
    );
    if (imovelAntes.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Imóvel não encontrado.' });
    }
    const imovel = imovelAntes.rows[0];

    const r = await query(
      `UPDATE moravo.imoveis
         SET status_aprovacao = 'reprovado',
             reprovado_motivo = $1,
             reprovado_em = NOW(),
             aprovado_por = NULL,
             aprovado_em = NULL
       WHERE id = $2 RETURNING id`,
      [motivo, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: 'Imóvel não encontrado.' });

    // Notifica o dono pra reenviar a documentação
    try {
      await criarNotificacao({
        usuario_id: imovel.dono_id,
        tipo: 'documento_reprovado',
        imovel_id: imovel.id,
        remetente_id: req.user.id,
        payload: {
          imovel_titulo: imovel.titulo,
          motivo: motivo,
        },
      });
    } catch (notifErr) {
      // Não bloqueia o fluxo se a notificação falhar
      console.error('[admin/reprovar] erro ao criar notificação:', notifErr.message);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[admin/reprovar] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- GET /api/admin/logs — últimos 100 acessos (sucesso ou falha)
router.get('/logs', async (req, res) => {
  try {
    const r = await query(
      `SELECT l.id, l.email, l.sucesso, l.ip, l.user_agent, l.created_at,
              u.nome AS admin_nome
       FROM moravo.admin_login_logs l
       LEFT JOIN moravo.usuarios u ON u.id = l.usuario_id
       ORDER BY l.created_at DESC
       LIMIT 100`
    );
    return res.json({ ok: true, logs: r.rows });
  } catch (err) {
    console.error('[admin/logs GET] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

module.exports = router;
