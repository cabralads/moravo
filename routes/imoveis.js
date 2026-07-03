// =========================================================================
// /api/imoveis — CRUD de imóveis
// =========================================================================
const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { verify: verifyJwt } = require('../lib/jwt');
const { criarNotificacao } = require('../lib/notifications');

const TIPOS_IMOVEL = ['casa', 'apartamento', 'terreno', 'comercial', 'chacara', 'sitio'];
const STATUS_VALIDOS = ['ativo', 'vendido', 'pausado'];

// ---- GET /api/imoveis
// Query params:
//   dono_id=X        -> só os imóveis do dono X
//   disponivel=1     -> exclui 'vendido' (pra feed de corretores)
//   tipo=casa        -> filtra por tipo
//   cidade=Joinville -> filtra por cidade (ILIKE)
//   limit=50         -> máx 200
router.get('/', async (req, res) => {
  try {
    const donoId   = parseInt(req.query.dono_id, 10);
    const disponivel = req.query.disponivel === '1' || req.query.disponivel === 'true';
    const tipo     = (req.query.tipo   || '').toLowerCase();
    const cidade   = (req.query.cidade || '').trim();
    const limit    = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    // Opcionalmente extrai o usuário logado para ocultar seus próprios imóveis na busca pública
    let loggedUserId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const decoded = verifyJwt(token);
        if (decoded && decoded.id) {
          loggedUserId = decoded.id;
        }
      } catch (e) {
        // Ignora erros de token na busca pública
      }
    }

    const conditions = [];
    const params = [];
    let i = 1;

    if (Number.isFinite(donoId)) {
      conditions.push(`im.dono_id = $${i++}`);
      params.push(donoId);
    } else if (loggedUserId) {
      conditions.push(`im.dono_id <> $${i++}`);
      params.push(loggedUserId);
    }
    if (disponivel) {
      conditions.push(`im.status <> 'vendido'`);
    }
    if (TIPOS_IMOVEL.indexOf(tipo) !== -1) {
      conditions.push(`im.tipo = $${i++}`);
      params.push(tipo);
    }
    if (cidade) {
      conditions.push(`im.cidade ILIKE $${i++}`);
      params.push(`%${cidade}%`);
    }

    params.push(limit);
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const sql = `
      SELECT im.*,
             u.nome AS dono_nome, u.whatsapp AS dono_whatsapp, u.email AS dono_email,
             EXISTS (
               SELECT 1 FROM moravo.interesses i
               WHERE i.imovel_id = im.id AND i.status = 'aceito'
             ) AS tem_corretor_aceito
      FROM moravo.imoveis im
      JOIN moravo.usuarios u ON u.id = im.dono_id
      ${where}
      ORDER BY im.created_at DESC
      LIMIT $${i}
    `;
    const r = await query(sql, params);
    return res.json({ ok: true, total: r.rowCount, imoveis: r.rows });
  } catch (err) {
    console.error('[imoveis GET] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- GET /api/imoveis/:id
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'ID inválido.' });
    const sql = `
      SELECT im.*,
             u.nome AS dono_nome, u.whatsapp AS dono_whatsapp, u.email AS dono_email,
             EXISTS (
               SELECT 1 FROM moravo.interesses i
               WHERE i.imovel_id = im.id AND i.status = 'aceito'
             ) AS tem_corretor_aceito
      FROM moravo.imoveis im
      JOIN moravo.usuarios u ON u.id = im.dono_id
      WHERE im.id = $1
    `;
    const r = await query(sql, [id]);
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: 'Imóvel não encontrado.' });
    return res.json({ ok: true, imovel: r.rows[0] });
  } catch (err) {
    console.error('[imoveis GET :id] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- POST /api/imoveis/:id/clique-interesse — registra interesse do comprador comum
router.post('/:id/clique-interesse', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'ID de imóvel inválido.' });

    // Tenta inserir o interesse do comprador (evitando duplicados através da constraint única)
    try {
      // Confere se já registrou esse interesse para evitar duplicações/erros em bancos locais
      const dupCheck = await query(
        'SELECT id FROM moravo.interesses_compradores WHERE imovel_id = $1 AND comprador_id = $2',
        [id, req.user.id]
      );

      if (dupCheck.rowCount === 0) {
        await query(
          `INSERT INTO moravo.interesses_compradores (imovel_id, comprador_id)
           VALUES ($1, $2)`,
          [id, req.user.id]
        );

        // Incrementa a contagem de interesses dos compradores
        await query(
          `UPDATE moravo.imoveis 
           SET interesses_compradores = COALESCE(interesses_compradores, 0) + 1 
           WHERE id = $1`,
          [id]
        );
      }
    } catch (dbErr) {
      // Trata erro de UNIQUE constraint
      if (dbErr.code === '23505' || dbErr.message.includes('duplicado') || dbErr.message.includes('unique')) {
        return res.status(409).json({ ok: false, error: 'Você já demonstrou interesse neste imóvel.' });
      }
      throw dbErr;
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[imoveis clique-interesse] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- POST /api/imoveis — só proprietário ou corretor (cria pra si mesmo)
router.post('/', requireAuth, requireRole('proprietario', 'corretor'), async (req, res) => {
  try {
    const b = req.body || {};
    const errors = [];

    const titulo = (b.titulo || '').trim();
    if (titulo.length < 3 || titulo.length > 200) {
      errors.push({ field: 'titulo', message: 'Título deve ter entre 3 e 200 caracteres.' });
    }

    const tipo = (b.tipo || '').toLowerCase();
    if (TIPOS_IMOVEL.indexOf(tipo) === -1) {
      errors.push({ field: 'tipo', message: 'Tipo inválido. Aceitos: ' + TIPOS_IMOVEL.join(', ') });
    }

    const preco = Number(b.preco);
    if (!Number.isFinite(preco) || preco < 0) {
      errors.push({ field: 'preco', message: 'Preço inválido.' });
    }

    // Endereço (tudo obrigatório, exceto complemento)
    const uf = (b.uf || '').toUpperCase().trim();
    if (!/^[A-Z]{2}$/.test(uf)) {
      errors.push({ field: 'uf', message: 'Estado (UF) obrigatório (ex.: SP).' });
    }
    const cep = (b.cep || '').trim();
    if (!/^\d{5}-?\d{3}$/.test(cep)) {
      errors.push({ field: 'cep', message: 'CEP inválido (formato 00000-000).' });
    }
    const rua = (b.rua || '').trim();
    if (rua.length < 3) errors.push({ field: 'rua', message: 'Rua obrigatória.' });
    const numero = (b.numero || '').trim();
    if (!numero) errors.push({ field: 'numero', message: 'Número obrigatório.' });
    const complemento = (b.complemento || '').trim() || null;
    const bairro = (b.bairro || '').trim();
    if (bairro.length < 2) errors.push({ field: 'bairro', message: 'Bairro obrigatório.' });
    const cidade = (b.cidade || '').trim();
    if (cidade.length < 2) errors.push({ field: 'cidade', message: 'Cidade obrigatória.' });

    if (errors.length) return res.status(400).json({ ok: false, errors });

    const result = await query(
      `INSERT INTO moravo.imoveis
        (dono_id, titulo, tipo, preco, uf, cep, rua, numero, complemento, bairro, cidade,
         area_m2, quartos, banheiros, vagas, descricao, fotos, status, lat, lng)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING id, created_at`,
      [
        req.user.id, titulo, tipo, preco, uf, cep, rua, numero, complemento, bairro, cidade,
        b.area_m2  ? Number(b.area_m2)  : null,
        b.quartos  ? parseInt(b.quartos, 10)  : null,
        b.banheiros? parseInt(b.banheiros,10) : null,
        b.vagas    ? parseInt(b.vagas,   10)  : null,
        (b.descricao || '').trim() || null,
        JSON.stringify(Array.isArray(b.fotos) ? b.fotos : []),
        'ativo',
        b.lat ? Number(b.lat) : null,
        b.lng ? Number(b.lng) : null
      ]
    );

    return res.status(201).json({ ok: true, id: result.rows[0].id, created_at: result.rows[0].created_at });
  } catch (err) {
    if (err.code === '23514') {
      return res.status(400).json({ ok: false, errors: [{ field: 'tipo', message: 'Dados não passam validação.' }] });
    }
    if (err.code === '23505') {
      return res.status(409).json({
        ok: false,
        errors: [{ field: 'endereco', message: 'Já existe um imóvel cadastrado neste endereço. Adicione um complemento pra diferenciar.' }],
      });
    }
    console.error('[imoveis POST] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- PUT /api/imoveis/:id — só o dono
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'ID inválido.' });

    // Verifica se o imóvel é do usuário logado
    const check = await query('SELECT dono_id FROM moravo.imoveis WHERE id = $1', [id]);
    if (check.rowCount === 0) return res.status(404).json({ ok: false, error: 'Imóvel não encontrado.' });
    if (check.rows[0].dono_id !== req.user.id) {
      return res.status(403).json({ ok: false, error: 'Você só pode editar seus próprios imóveis.' });
    }

    const b = req.body || {};
    const updates = {};
    ['titulo', 'bairro', 'descricao', 'rua', 'complemento'].forEach(k => {
      if (b[k] != null) updates[k] = String(b[k]).trim() || null;
    });
    if (b.uf != null) {
      const u = String(b.uf).toUpperCase().trim();
      if (!/^[A-Z]{2}$/.test(u)) {
        return res.status(400).json({ ok: false, errors: [{ field: 'uf', message: 'UF inválida.' }] });
      }
      updates.uf = u;
    }
    if (b.cep != null) {
      const cep = String(b.cep).trim();
      if (!/^\d{5}-?\d{3}$/.test(cep)) {
        return res.status(400).json({ ok: false, errors: [{ field: 'cep', message: 'CEP inválido (formato 00000-000).' }] });
      }
      updates.cep = cep;
    }
    if (b.numero != null) {
      const num = String(b.numero).trim();
      if (!num) return res.status(400).json({ ok: false, errors: [{ field: 'numero', message: 'Número obrigatório.' }] });
      updates.numero = num;
    }
    if (b.tipo != null) {
      if (TIPOS_IMOVEL.indexOf(String(b.tipo).toLowerCase()) === -1) {
        return res.status(400).json({ ok: false, error: 'Tipo inválido.' });
      }
      updates.tipo = String(b.tipo).toLowerCase();
    }
    if (b.preco != null) {
      const p = Number(b.preco);
      if (!Number.isFinite(p) || p < 0) return res.status(400).json({ ok: false, error: 'Preço inválido.' });
      updates.preco = p;
    }
    if (b.cidade != null) {
      const c = String(b.cidade).trim();
      if (c.length < 2) return res.status(400).json({ ok: false, errors: [{ field: 'cidade', message: 'Cidade obrigatória.' }] });
      updates.cidade = c;
    }
    if (b.status != null) {
      if (STATUS_VALIDOS.indexOf(b.status) === -1) {
        return res.status(400).json({ ok: false, error: 'Status inválido.' });
      }
      updates.status = b.status;
    }
    ['area_m2', 'quartos', 'banheiros', 'vagas', 'lat', 'lng'].forEach(k => {
      if (b[k] != null) updates[k] = Number(b[k]) || null;
    });
    if (Array.isArray(b.fotos)) updates.fotos = JSON.stringify(b.fotos);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok: false, error: 'Nenhum campo pra atualizar.' });
    }

    // Monta SET dinamicamente
    const setClause = Object.keys(updates).map((k, idx) => `${k} = $${idx + 1}`).join(', ');
    const params = [...Object.values(updates), id];
    const sql = `UPDATE moravo.imoveis SET ${setClause} WHERE id = $${params.length} RETURNING *`;
    const r = await query(sql, params);

    return res.json({ ok: true, imovel: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        ok: false,
        errors: [{ field: 'endereco', message: 'Já existe outro imóvel neste endereço.' }],
      });
    }
    console.error('[imoveis PUT] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- DELETE /api/imoveis/:id — só o dono
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'ID inválido.' });

    const check = await query('SELECT dono_id FROM moravo.imoveis WHERE id = $1', [id]);
    if (check.rowCount === 0) return res.status(404).json({ ok: false, error: 'Imóvel não encontrado.' });
    if (check.rows[0].dono_id !== req.user.id) {
      return res.status(403).json({ ok: false, error: 'Você só pode deletar seus próprios imóveis.' });
    }

    await query('DELETE FROM moravo.imoveis WHERE id = $1', [id]);
    return res.json({ ok: true, deleted: id });
  } catch (err) {
    console.error('[imoveis DELETE] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- PATCH /api/imoveis/:id/status — atualiza status (dono ou corretor aceito)
router.patch('/:id/status', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'ID inválido.' });

    const novoStatus = (req.body && req.body.status || '').toLowerCase();
    if (['ativo', 'vendido', 'pausado'].indexOf(novoStatus) === -1) {
      return res.status(400).json({ ok: false, error: 'Status inválido.' });
    }

    // Verifica se o imóvel existe
    const imovelCheck = await query(
      'SELECT id, dono_id, titulo FROM moravo.imoveis WHERE id = $1',
      [id]
    );
    if (imovelCheck.rowCount === 0) return res.status(404).json({ ok: false, error: 'Imóvel não encontrado.' });

    const imovel = imovelCheck.rows[0];
    let papel = null; // 'dono' ou 'corretor_aceito'

    if (imovel.dono_id === req.user.id) {
      papel = 'dono';
    } else {
      // Verifica se é um corretor aceito
      const corretorCheck = await query(
        `SELECT id FROM moravo.interesses
         WHERE imovel_id = $1 AND corretor_id = $2 AND status = 'aceito'`,
        [id, req.user.id]
      );
      if (corretorCheck.rowCount > 0) {
        papel = 'corretor_aceito';
      }
    }

    if (!papel) {
      return res.status(403).json({ ok: false, error: 'Você não tem permissão para alterar o status deste imóvel.' });
    }

    await query('UPDATE moravo.imoveis SET status = $1 WHERE id = $2', [novoStatus, id]);

    // ---- Efeito colateral: quando o imóvel é marcado como vendido
    if (novoStatus === 'vendido') {
      // Pega o nome do remetente (pra mensagem)
      const remetenteRow = await query(
        'SELECT nome FROM moravo.usuarios WHERE id = $1',
        [req.user.id]
      );
      const remetenteNome = (remetenteRow.rows[0] && remetenteRow.rows[0].nome) || '';

      // Pega o corretor aceito (se houver)
      const aceitoRow = await query(
        `SELECT i.id AS interesse_id, i.corretor_id
         FROM moravo.interesses i
         WHERE i.imovel_id = $1 AND i.status = 'aceito' LIMIT 1`,
        [id]
      );

      if (papel === 'dono') {
        // Dono marcou: notifica o corretor aceito (se houver)
        if (aceitoRow.rowCount > 0) {
          const aceito = aceitoRow.rows[0];
          await criarNotificacao({
            usuario_id: aceito.corretor_id,
            tipo: 'imovel_vendido',
            imovel_id: id,
            interesse_id: aceito.interesse_id,
            remetente_id: req.user.id,
            payload: {
              imovel_titulo: imovel.titulo,
              remetente_nome: remetenteNome,
              remetente_papel: 'dono',
            },
          });
        }
      } else if (papel === 'corretor_aceito') {
        // Corretor marcou: notifica o dono
        await criarNotificacao({
          usuario_id: imovel.dono_id,
          tipo: 'imovel_vendido',
          imovel_id: id,
          interesse_id: aceitoRow.rows[0] ? aceitoRow.rows[0].interesse_id : null,
          remetente_id: req.user.id,
          payload: {
            imovel_titulo: imovel.titulo,
            remetente_nome: remetenteNome,
            remetente_papel: 'corretor',
          },
        });
      }

      // Recusa automática de todos os outros corretores pendentes
      const pendentes = await query(
        `UPDATE moravo.interesses
           SET status = 'recusado'
         WHERE imovel_id = $1 AND status = 'pendente'
         RETURNING id, corretor_id`,
        [id]
      );
      for (const p of pendentes.rows) {
        await criarNotificacao({
          usuario_id: p.corretor_id,
          tipo: 'corretor_recusado_auto',
          imovel_id: id,
          interesse_id: p.id,
          remetente_id: req.user.id,
          payload: {
            imovel_titulo: imovel.titulo,
            motivo: 'imovel_vendido',
          },
        });
      }
    }

    return res.json({ ok: true, status: novoStatus });
  } catch (err) {
    console.error('[imoveis PATCH status] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

module.exports = router;
module.exports.TIPOS_IMOVEL = TIPOS_IMOVEL;
