// netlify/functions/webhook.js
// Recebe eventos do Stripe e ativa planos automaticamente
// Configure no Stripe Dashboard → Webhooks → Add endpoint:
//   URL: https://SEU-SITE.netlify.app/.netlify/functions/webhook
//   Eventos: checkout.session.completed, invoice.paid,
//            invoice.payment_failed, customer.subscription.updated,
//            customer.subscription.deleted

const stripe        = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const signature = event.headers['stripe-signature'];
  if (!signature) {
    return { statusCode: 400, body: 'Missing stripe-signature' };
  }

  // VALIDAR ASSINATURA STRIPE (segurança obrigatória)
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[WEBHOOK] Assinatura inválida:', err.message);
    return { statusCode: 400, body: `Signature error: ${err.message}` };
  }

  console.log('[WEBHOOK] evento:', stripeEvent.type);

  try {
    switch (stripeEvent.type) {

      // ── Checkout concluído → ativar plano ──────────────────────
      case 'checkout.session.completed': {
        const session   = stripeEvent.data.object;
        const empresaId = session.metadata?.empresa_id;
        const plano     = session.metadata?.plano || 'medio';
        if (!empresaId) break;

        let expira = new Date(Date.now() + 30 * 86400000).toISOString();
        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          expira = new Date(sub.current_period_end * 1000).toISOString();
        }

        await sb.from('assinaturas').upsert({
          empresa_id:             empresaId,
          plano,
          status:                 'ativa',
          valor:                  (session.amount_total || 0) / 100,
          data_inicio:            new Date().toISOString(),
          data_expiracao:         expira,
          stripe_customer_id:     session.customer,
          stripe_subscription_id: session.subscription,
        }, { onConflict: 'empresa_id' });

        await sb.from('empresas').update({ plano }).eq('id', empresaId);

        await sb.from('pagamentos').insert({
          empresa_id:        empresaId,
          valor:             (session.amount_total || 0) / 100,
          status:            'pago',
          metodo:            'stripe',
          plano,
          descricao:         `Assinatura ${plano} — Stripe`,
          stripe_payment_id: session.payment_intent,
          data_pagamento:    new Date().toISOString(),
        });

        await logSeg(empresaId, 'plano_ativado', { plano, session_id: session.id });
        console.log('[WEBHOOK] ✅ plano ativado:', empresaId, plano);
        break;
      }

      // ── Fatura paga → renovar ───────────────────────────────────
      case 'invoice.paid': {
        const invoice = stripeEvent.data.object;
        const subId   = invoice.subscription;
        if (!subId) break;

        const sub    = await stripe.subscriptions.retrieve(subId);
        const expira = new Date(sub.current_period_end * 1000).toISOString();

        const { data: ass } = await sb
          .from('assinaturas')
          .select('empresa_id, plano')
          .eq('stripe_subscription_id', subId)
          .maybeSingle();

        if (!ass) break;

        await sb.from('assinaturas').update({
          status: 'ativa', data_expiracao: expira,
        }).eq('stripe_subscription_id', subId);

        await sb.from('pagamentos').insert({
          empresa_id:        ass.empresa_id,
          valor:             (invoice.amount_paid || 0) / 100,
          status:            'pago',
          metodo:            'stripe',
          plano:             ass.plano,
          descricao:         `Renovação ${ass.plano}`,
          stripe_invoice_id: invoice.id,
          data_pagamento:    new Date().toISOString(),
        });

        console.log('[WEBHOOK] ✅ renovação:', ass.empresa_id);
        break;
      }

      // ── Falha no pagamento → bloquear ───────────────────────────
      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        const subId   = invoice.subscription;
        if (!subId) break;

        const { data: ass } = await sb
          .from('assinaturas').select('empresa_id')
          .eq('stripe_subscription_id', subId).maybeSingle();

        if (!ass) break;

        await sb.from('assinaturas')
          .update({ status: 'vencida' })
          .eq('stripe_subscription_id', subId);

        await logSeg(ass.empresa_id, 'pagamento_falhou', { invoice: invoice.id });
        console.log('[WEBHOOK] ⚠️ falha:', ass.empresa_id);
        break;
      }

      // ── Upgrade / Downgrade ─────────────────────────────────────
      case 'customer.subscription.updated': {
        const sub    = stripeEvent.data.object;
        const plano  = sub.metadata?.plano || 'medio';
        const expira = new Date(sub.current_period_end * 1000).toISOString();
        const status = ['active','trialing'].includes(sub.status) ? 'ativa' : 'vencida';

        await sb.from('assinaturas').update({
          plano, status, data_expiracao: expira,
          cancel_at_period_end: sub.cancel_at_period_end,
        }).eq('stripe_subscription_id', sub.id);

        const { data: ass } = await sb
          .from('assinaturas').select('empresa_id')
          .eq('stripe_subscription_id', sub.id).maybeSingle();

        if (ass) await sb.from('empresas').update({ plano }).eq('id', ass.empresa_id);
        console.log('[WEBHOOK] ✅ atualizado:', sub.id, plano, status);
        break;
      }

      // ── Cancelamento ────────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;

        const { data: ass } = await sb
          .from('assinaturas').select('empresa_id')
          .eq('stripe_subscription_id', sub.id).maybeSingle();

        await sb.from('assinaturas').update({
          status: 'cancelada', data_expiracao: new Date().toISOString(),
        }).eq('stripe_subscription_id', sub.id);

        if (ass) {
          await sb.from('empresas').update({ plano: 'free' }).eq('id', ass.empresa_id);
          await logSeg(ass.empresa_id, 'cancelamento', { sub_id: sub.id });
        }
        console.log('[WEBHOOK] 🔴 cancelado:', sub.id);
        break;
      }
    }
  } catch (err) {
    console.error('[WEBHOOK] erro:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ received: true }),
  };
};

async function logSeg(empresaId, acao, detalhes) {
  try {
    await sb.from('logs_seguranca').insert({
      empresa_id: empresaId,
      acao,
      detalhes:   JSON.stringify(detalhes),
      created_at: new Date().toISOString(),
    });
  } catch { }
}
