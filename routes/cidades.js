// =========================================================================
// /api/cidades — autocomplete de cidades (por UF) e bairros (por cidade)
// Base: IBGE (municípios do Brasil) + bairros populares das principais cidades
// =========================================================================
const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');

// Carrega a base uma vez no boot
const CIDADES_FILE = path.join(__dirname, '..', 'data', 'cidades.json');
let CIDADES = [];
try {
  CIDADES = JSON.parse(fs.readFileSync(CIDADES_FILE, 'utf8'));
  console.log(`[cidades] carregadas ${CIDADES.length} cidades`);
} catch (err) {
  console.error('[cidades] erro ao carregar base:', err.message);
}

// ---- GET /api/cidades/estados — lista de UFs
router.get('/estados', (_req, res) => {
  const ufs = [...new Set(CIDADES.map(c => c.uf))].sort();
  res.json({ ok: true, total: ufs.length, ufs });
});

// ---- GET /api/cidades?uf=SP&q=joi&limit=20
//   - Retorna cidades do estado (filtra pelo nome se vier "q")
//   - Cada cidade pode trazer uma lista de bairros populares
router.get('/', (req, res) => {
  const uf = (req.query.uf || '').toUpperCase().trim();
  const q  = (req.query.q  || '').toLowerCase().trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 1000);

  let list = CIDADES;
  if (uf) {
    list = list.filter(c => c.uf === uf);
  }
  if (q) {
    list = list.filter(c => c.nome.toLowerCase().indexOf(q) !== -1);
  }
  list = list.slice(0, limit).map(c => ({
    nome:    c.nome,
    uf:      c.uf,
    ibge:    c.ibge,
    // Só envia os bairros pra cidade que o usuário digitou EXATAMENTE
    // (evita payload enorme com bairros de cidades erradas)
    bairros: (q && c.nome.toLowerCase() === q) ? (c.bairros || []) : undefined,
  }));

  res.json({ ok: true, total: list.length, cidades: list });
});

// ---- GET /api/cidades/bairros?uf=SP&cidade=Joinville&q=Am%C3%A9rica
//   - Retorna só os bairros de uma cidade (com filtro por query)
router.get('/bairros', (req, res) => {
  const uf     = (req.query.uf      || '').toUpperCase().trim();
  const cidade = (req.query.cidade  || '').toLowerCase().trim();
  const q      = (req.query.q       || '').toLowerCase().trim();
  const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  if (!uf || !cidade) {
    return res.status(400).json({ ok: false, error: 'Passe uf e cidade.' });
  }

  const city = CIDADES.find(c => c.uf === uf && c.nome.toLowerCase() === cidade);
  if (!city) return res.json({ ok: true, total: 0, bairros: [] });

  let bairros = city.bairros || [];
  if (q) bairros = bairros.filter(b => b.toLowerCase().indexOf(q) !== -1);
  bairros = bairros.slice(0, limit);

  res.json({ ok: true, total: bairros.length, bairros });
});

module.exports = router;
