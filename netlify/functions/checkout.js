// netlify/functions/checkout.js
// Cria sessão de Checkout no Stripe

const stripe           = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Content-Type':                 'application/json',
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  // Validar JWT do usuário
  const authHeader = event.headers['authorization'];
  if (!authHeader) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Não autorizado' }) };

  const sbUser = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error } = await sbUser.auth.getUser();
  if (error || !user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Não autenticado' }) };

  const body = JSON.parse(event.body || '{}');
  const { plano, price_id, empresa_id, email, trial_days, success_url, cancel_url } = body;

  if (!price_id || !empresa_id) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'price_id e empresa_id obrigatórios' }) };
  }

  try {
    // Buscar ou criar customer no Stripe
    let customerId;
    const { data: ass } = await sb
      .from('assinaturas').select('stripe_customer_id')
      .eq('empresa_id', empresa_id).maybeSingle();

    if (ass?.stripe_customer_id) {
      customerId = ass.stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email,
        metadata: { empresa_id, user_id: user.id },
      });
      customerId = customer.id;
    }

    // Criar sessão de Checkout
    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      payment_method_types: ['card'],
      line_items:           [{ price: price_id, quantity: 1 }],
      mode:                 'subscription',
      success_url,
      cancel_url,
      metadata:             { empresa_id, plano: plano || 'medio', user_id: user.id },
      subscription_data: {
        metadata:   { empresa_id, plano: plano || 'medio' },
        ...(trial_days > 0 ? { trial_period_days: trial_days } : {}),
      },
      allow_promotion_codes: true,
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    console.error('[CHECKOUT]', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
