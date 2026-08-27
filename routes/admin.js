// =========================================================================
// /api/admin — login auditado + fila de aprovação de imóveis + logs
// =========================================================================
const express = require('express');
const bcrypt  = require('bcrypt');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sign: signJwt } = require('../lib/jwt');
const { criarNotificacao } = require('../lib/notifications');
const wa = require('../lib/whatsapp');
const siteConfig = require('../lib/site-config');
const waha = require('../lib/waha');

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

// =========================================================================
// WhatsApp Cloud API — configuração e monitoramento (só admin)
// =========================================================================

// Mostra só os 4 últimos caracteres do token. O valor nunca volta inteiro.
function mascararToken(token) {
  if (!token) return '';
  return token.length <= 4 ? '••••' : '••••••••' + token.slice(-4);
}

// ---- GET /api/admin/whatsapp/config
router.get('/whatsapp/config', async (req, res) => {
  try {
    const c = await wa.getConfig({ semCache: true });
    return res.json({
      ok: true,
      config: {
        phone_number_id: c.phone_number_id,
        waba_id:         c.waba_id,
        api_version:     c.api_version,
        template_nome:   c.template_nome,
        template_idioma: c.template_idioma,
        ativo:           c.ativo,
        atualizado_em:   c.atualizado_em,
        token_definido:  !!c.token,
        token_mascarado: mascararToken(c.token),
      },
    });
  } catch (err) {
    console.error('[admin/whatsapp/config GET] erro:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- PUT /api/admin/whatsapp/config
// O token só é gravado quando vem preenchido. Campo vazio mantém o atual.
router.put('/whatsapp/config', async (req, res) => {
  try {
    const b = req.body || {};
    const phone   = (b.phone_number_id || '').trim();
    const waba    = (b.waba_id || '').trim();
    const versao  = (b.api_version || 'v23.0').trim();
    const tmpl    = (b.template_nome || 'link_grupo_convite').trim();
    const idioma  = (b.template_idioma || 'pt_BR').trim();
    const ativo   = !!b.ativo;
    const token   = (b.token || '').trim();

    if (!/^v\d+\.\d+$/.test(versao)) {
      return res.status(400).json({ ok: false, error: 'Versão da API inválida. Use o formato v23.0.' });
    }
    if (ativo && !phone) {
      return res.status(400).json({ ok: false, error: 'Informe o Phone Number ID antes de ativar o envio.' });
    }

    let tokenCifrado = null;
    if (token) {
      try {
        tokenCifrado = wa.cifrar(token);
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
    }

    await query(
      `UPDATE moravo.config_whatsapp
          SET phone_number_id = $1,
              waba_id         = $2,
              api_version     = $3,
              template_nome   = $4,
              template_idioma = $5,
              ativo           = $6,
              token_cifrado   = COALESCE($7, token_cifrado),
              atualizado_por  = $8,
              atualizado_em   = NOW()
        WHERE id = 1`,
      [phone || null, waba || null, versao, tmpl, idioma, ativo, tokenCifrado, req.user.id]
    );

    wa.limparCache();
    const check = await wa.prontoParaEnviar();
    return res.json({ ok: true, pronto: check.pronto, motivo: check.motivo || null });
  } catch (err) {
    console.error('[admin/whatsapp/config PUT] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- POST /api/admin/whatsapp/testar  { telefone, codigo }
// Dispara o template para um número, sem depender de negociação real.
router.post('/whatsapp/testar', async (req, res) => {
  try {
    const telefone = (req.body && req.body.telefone || '').trim();
    const codigo   = (req.body && req.body.codigo || 'TESTE123').trim();
    if (!telefone) return res.status(400).json({ ok: false, error: 'Informe o telefone de destino.' });

    const nome = (req.body && req.body.nome || '').trim() || 'Teste';
    const envio = await wa.enviarTemplateConvite({ telefone: telefone, codigoConvite: codigo, nome: nome });
    await wa.registrarEnvio({
      papel: 'teste', telefone: telefone, template: null,
      codigo_convite: codigo, status: 'enviado', wamid: envio.wamid,
    });
    return res.json({ ok: true, wamid: envio.wamid, destino: envio.destino });
  } catch (err) {
    await wa.registrarEnvio({
      papel: 'teste', telefone: (req.body && req.body.telefone) || '',
      status: 'falhou', erro: err.message,
    });
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// ---- GET /api/admin/whatsapp/waha — qual sessão o servidor está usando
router.get('/whatsapp/waha', async (req, res) => {
  try {
    return res.json({ ok: true, waha: await waha.diagnostico() });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// ---- GET /api/admin/whatsapp/templates — o que a Meta realmente tem cadastrado
router.get('/whatsapp/templates', async (req, res) => {
  try {
    const templates = await wa.listarTemplates();
    const config = await wa.getConfig();
    const combina = templates.filter(function (t) {
      return t.nome === config.template_nome && t.idioma === config.template_idioma;
    });
    return res.json({
      ok: true,
      templates: templates,
      procurando: { nome: config.template_nome, idioma: config.template_idioma },
      encontrado: combina[0] || null,
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// ---- GET /api/admin/whatsapp/envios?status=falhou|enviado|todos
router.get('/whatsapp/envios', async (req, res) => {
  try {
    const status = (req.query.status || 'todos').toLowerCase();
    const filtro = ['enviado', 'falhou'].indexOf(status) !== -1 ? 'WHERE e.status = $1' : '';
    const params = filtro ? [status] : [];
    const r = await query(
      `SELECT e.id, e.interesse_id, e.papel, e.telefone, e.template,
              e.codigo_convite, e.status, e.wamid, e.erro, e.tentativas, e.created_at,
              u.nome AS destinatario_nome,
              im.titulo AS imovel_titulo
         FROM moravo.whatsapp_envios e
         LEFT JOIN moravo.usuarios  u  ON u.id = e.destinatario_id
         LEFT JOIN moravo.interesses i ON i.id = e.interesse_id
         LEFT JOIN moravo.imoveis   im ON im.id = i.imovel_id
         ${filtro}
         ORDER BY e.created_at DESC
         LIMIT 200`,
      params
    );
    const cnt = await query(
      `SELECT count(*) FILTER (WHERE status = 'falhou')::int  AS falhou,
              count(*) FILTER (WHERE status = 'enviado')::int AS enviado
         FROM moravo.whatsapp_envios`
    );
    return res.json({ ok: true, envios: r.rows, contadores: cnt.rows[0] });
  } catch (err) {
    console.error('[admin/whatsapp/envios] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- POST /api/admin/whatsapp/envios/:id/reenviar
router.post('/whatsapp/envios/:id/reenviar', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'ID inválido.' });

    const r = await query(
      `SELECT e.*, i.grupo_whatsapp_link
         FROM moravo.whatsapp_envios e
         LEFT JOIN moravo.interesses i ON i.id = e.interesse_id
        WHERE e.id = $1`,
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: 'Envio não encontrado.' });
    const env = r.rows[0];

    // Prefere o código atual do grupo; cai para o que foi registrado na tentativa
    const codigo = wa.extrairCodigoConvite(env.grupo_whatsapp_link) || env.codigo_convite;
    if (!codigo) {
      return res.status(400).json({ ok: false, error: 'Não há código de convite disponível para este envio.' });
    }

    try {
      const envio = await wa.enviarTemplateConvite({ telefone: env.telefone, codigoConvite: codigo });
      await query(
        `UPDATE moravo.whatsapp_envios
            SET status = 'enviado', wamid = $1, erro = NULL,
                tentativas = tentativas + 1, created_at = NOW()
          WHERE id = $2`,
        [envio.wamid, id]
      );
      return res.json({ ok: true, wamid: envio.wamid });
    } catch (err) {
      await query(
        `UPDATE moravo.whatsapp_envios
            SET status = 'falhou', erro = $1, tentativas = tentativas + 1
          WHERE id = $2`,
        [String(err.message).slice(0, 500), id]
      );
      return res.status(400).json({ ok: false, error: err.message });
    }
  } catch (err) {
    console.error('[admin/whatsapp/reenviar] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// =========================================================================
// Configurações do site: scripts de terceiros (Tag Manager, pixels)
// =========================================================================

// ---- GET /api/admin/config/scripts
router.get('/config/scripts', async (req, res) => {
  try {
    const c = await siteConfig.getScripts({ semCache: true });
    return res.json({ ok: true, scripts: c });
  } catch (err) {
    console.error('[admin/config/scripts GET] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- PUT /api/admin/config/scripts  { head_html, body_html }
router.put('/config/scripts', async (req, res) => {
  try {
    const b = req.body || {};
    const head = typeof b.head_html === 'string' ? b.head_html.trim() : '';
    const body = typeof b.body_html === 'string' ? b.body_html.trim() : '';

    const LIMITE = 20000;
    if (head.length > LIMITE || body.length > LIMITE) {
      return res.status(400).json({ ok: false, error: `Cada campo aceita no máximo ${LIMITE} caracteres.` });
    }
    // Evita quebrar o HTML das páginas com uma tag mal fechada
    if (/<\/(head|body|html)\s*>/i.test(head) || /<\/(head|body|html)\s*>/i.test(body)) {
      return res.status(400).json({
        ok: false,
        error: 'Cole apenas o trecho do script. Não inclua as tags </head>, </body> ou </html>.',
      });
    }

    await query(
      `UPDATE moravo.config_site
          SET head_html = $1, body_html = $2, atualizado_por = $3, atualizado_em = NOW()
        WHERE id = 1`,
      [head || null, body || null, req.user.id]
    );
    siteConfig.limparCache();

    return res.json({ ok: true, ativo: !!(head || body) });
  } catch (err) {
    console.error('[admin/config/scripts PUT] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

module.exports = router;
