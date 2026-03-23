// netlify/functions/portal.js
// Abre o portal Stripe do cliente (gerenciar assinatura, trocar cartão, cancelar)

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

  const authHeader = event.headers['authorization'];
  if (!authHeader) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Não autorizado' }) };

  const sbUser = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user } } = await sbUser.auth.getUser();
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Não autenticado' }) };

  const body       = JSON.parse(event.body || '{}');
  const { empresa_id, return_url } = body;

  const { data: ass } = await sb
    .from('assinaturas').select('stripe_customer_id')
    .eq('empresa_id', empresa_id).maybeSingle();

  if (!ass?.stripe_customer_id) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Nenhuma assinatura Stripe encontrada' }) };
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   ass.stripe_customer_id,
      return_url: return_url || 'https://seusite.netlify.app',
    });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
