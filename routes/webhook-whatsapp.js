// =========================================================================
// Webhook de status da WhatsApp Cloud API
// =========================================================================
// Sem isto, `status = 'enviado'` só quer dizer "a Meta aceitou a chamada".
// Se a mensagem chegou ou não era invisível para a gente, e toda dúvida do
// tipo "o sistema diz que mandou, a pessoa diz que não recebeu" terminava em
// palpite. A Meta avisa aqui cada mudança: sent, delivered, read, failed.
//
// A rota é pública porque quem chama é a Meta, não um usuário logado. O que
// garante a procedência:
//   - GET  : handshake com o verify token gravado em config_whatsapp
//   - POST : assinatura HMAC do corpo cru com o App Secret, quando definido
//   - e o update só encosta em linha cujo wamid já existe (nunca cria nada)
// =========================================================================
const express = require('express');
const crypto = require('crypto');
const wa = require('../lib/whatsapp');

const router = express.Router();

// ---- Confere a X-Hub-Signature-256 do corpo cru
// Sem App Secret configurado a checagem é pulada, e o painel avisa disso.
function assinaturaConfere(req, appSecret) {
  if (!appSecret) return { ok: true, checada: false };

  const cabecalho = req.get('x-hub-signature-256') || '';
  const esperado = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody || Buffer.alloc(0))
    .digest('hex');

  // timingSafeEqual exige o mesmo tamanho, senão ele mesmo estoura
  const a = Buffer.from(cabecalho);
  const b = Buffer.from(esperado);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok: ok, checada: true };
}

// ---- GET / : handshake de verificação da Meta
router.get('/', async (req, res) => {
  try {
    const config = await wa.getConfig();
    const modo    = req.query['hub.mode'];
    const token   = req.query['hub.verify_token'];
    const desafio = req.query['hub.challenge'];

    if (modo === 'subscribe' && token && config.webhook_token && token === config.webhook_token) {
      console.log('[webhook] verificação aceita pela Meta');
      return res.status(200).send(String(desafio || ''));
    }
    console.warn('[webhook] verificação recusada: token não confere');
    return res.sendStatus(403);
  } catch (err) {
    console.error('[webhook] erro no handshake:', err.message);
    return res.sendStatus(500);
  }
});

// ---- POST / : eventos de status
router.post('/', async (req, res) => {
  let config = null;
  try {
    config = await wa.getConfig();
  } catch (err) {
    console.error('[webhook] não foi possível ler a configuração:', err.message);
    return res.sendStatus(200); // 200 mesmo assim: erro nosso não é motivo para a Meta reenviar em loop
  }

  const assinatura = assinaturaConfere(req, config.app_secret);
  if (!assinatura.ok) {
    console.warn('[webhook] assinatura inválida, evento descartado');
    return res.sendStatus(401);
  }

  // A Meta espera 200 rápido. Falha no processamento vira log, não retry.
  res.sendStatus(200);

  try {
    const entradas = (req.body && req.body.entry) || [];
    for (const entrada of entradas) {
      for (const mudanca of (entrada.changes || [])) {
        const statuses = (mudanca.value && mudanca.value.statuses) || [];
        for (const st of statuses) {
          const erro = (st.errors && st.errors[0]) || null;
          const detalhe = erro
            ? [erro.title, (erro.error_data && erro.error_data.details) || erro.message, erro.code && ('código ' + erro.code)]
                .filter(Boolean).join(' | ')
            : null;

          const r = await wa.registrarStatusEntrega({
            wamid: st.id,
            entrega: st.status,
            erro: detalhe,
            quando: st.timestamp ? new Date(Number(st.timestamp) * 1000) : null,
          });

          if (r.atualizado) {
            console.log(`[webhook] ${st.status}${detalhe ? ' (' + detalhe + ')' : ''} — wamid ${st.id}`);
          }
        }
      }
    }
  } catch (err) {
    console.error('[webhook] erro ao processar evento:', err.message);
  }
});

module.exports = router;
