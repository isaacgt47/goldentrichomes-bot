/**
 * GoldenTrichomes — Bot Telegram Backend
 * Node.js + Express + Firebase Admin
 * 
 * SETUP :
 * 1. npm init -y
 * 2. npm install express node-telegram-bot-api firebase-admin axios dotenv qrcode
 * 3. Remplace les valeurs ci-dessous
 * 4. node bot.js
 */

require('dotenv').config();
const express        = require('express');
const TelegramBot    = require('node-telegram-bot-api');
const admin          = require('firebase-admin');
const axios          = require('axios');
const QRCode         = require('qrcode');

/* ══════════════════════════════════════════════
   CONFIG — REMPLACE CES VALEURS
   ══════════════════════════════════════════════ */
const CONFIG = {
  BOT_TOKEN:   process.env.BOT_TOKEN   || '8689166931:AAFweXM9nYW9YoY6-W0INnNURCCXpJ7bMjU',
  ADMIN_CHAT:  process.env.ADMIN_CHAT  || '5383453640',
  WEBHOOK_URL: process.env.WEBHOOK_URL || 'https://TON_SERVEUR.com/webhook',
  PORT:        process.env.PORT        || 3000,

  /* Adresses wallet */
  WALLETS: {
    BTC:       'bc1qep4m47qeluj9jvdhp4ft4qcmk9r4w34u6xxuyd',
    ETH:       '0x0918234e6e8202AF158fde6328B8643846EfDeb0',
    USDT_TRC20:'TWP5niQbrsNdhY2s3S1wFvi9MfBjEscHqY',
    USDT_ERC20:'0x0918234e6e8202AF158fde6328B8643846EfDeb0',
    SOL:       '45hP6dSNnNxP3at3seQ1pjwPoLXujneTvCoutbecFnpw',
  },

  /* Taux de conversion MAD → Crypto (mis à jour via API) */
  RATES: { BTC: 0, ETH: 0, USDT: 1, SOL: 0 },

  /* Firebase service account JSON path */
  FIREBASE_SA: process.env.FIREBASE_SA || './serviceAccount.json',
  FIREBASE_PROJECT: 'goldentrichomes-90627',
};

/* ══════════════════════════════════════════════
   FIREBASE ADMIN INIT
   ══════════════════════════════════════════════ */
let db;
try {
  const serviceAccount = require(CONFIG.FIREBASE_SA);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId:  CONFIG.FIREBASE_PROJECT,
  });
  db = admin.firestore();
  console.log('✅ Firebase connecté');
} catch(e) {
  console.warn('⚠️  Firebase non connecté:', e.message);
}

/* ══════════════════════════════════════════════
   BOT TELEGRAM
   ══════════════════════════════════════════════ */
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: false });
const app = express();
app.use(express.json());

/* ── Webhook Telegram ── */
app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

/* ══════════════════════════════════════════════
   COMMANDES BOT
   ══════════════════════════════════════════════ */

/* /start → ouvre la Mini App */
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId,
    `🌿 *Bienvenue sur GoldenTrichomes* 🌿\n\nQualité marocaine certifiée · Amsterdam\n\nClique ci-dessous pour commander :`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{
          text: '🛒 Ouvrir la boutique',
          web_app: { url: 'https://melodic-baklava-cd5a09.netlify.app/' }
        }]]
      }
    }
  );
});

/* /orders → admin : voir les commandes en attente */
bot.onText(/\/orders/, async (msg) => {
  if(String(msg.chat.id) !== CONFIG.ADMIN_CHAT) return;
  if(!db){ return bot.sendMessage(msg.chat.id, '❌ Firebase non connecté'); }
  const snap = await db.collection('orders')
    .where('status','==','pending')
    .orderBy('createdAt','desc')
    .limit(10)
    .get();
  if(snap.empty){ return bot.sendMessage(msg.chat.id, '✅ Aucune commande en attente'); }
  for(const d of snap.docs){
    await sendOrderCard(msg.chat.id, d.id, d.data());
  }
});

/* /stats → admin : stats rapides */
bot.onText(/\/stats/, async (msg) => {
  if(String(msg.chat.id) !== CONFIG.ADMIN_CHAT) return;
  if(!db){ return bot.sendMessage(msg.chat.id, '❌ Firebase non connecté'); }
  const [pending, done, all] = await Promise.all([
    db.collection('orders').where('status','==','pending').get(),
    db.collection('orders').where('status','==','done').get(),
    db.collection('orders').get(),
  ]);
  const revenue = done.docs.reduce((s,d) => s + (d.data().total||0), 0);
  bot.sendMessage(msg.chat.id,
    `📊 *Stats GoldenTrichomes*\n\n` +
    `⏳ En attente : ${pending.size}\n` +
    `✅ Livrées : ${done.size}\n` +
    `📦 Total commandes : ${all.size}\n` +
    `💰 Revenus : ${revenue.toFixed(0)} MAD`,
    { parse_mode: 'Markdown' }
  );
});

/* ══════════════════════════════════════════════
   CALLBACK BOUTONS INLINE (Confirmé/Livré/Payé)
   ══════════════════════════════════════════════ */
bot.on('callback_query', async (query) => {
  const [action, orderId] = query.data.split(':');
  if(!orderId) return bot.answerCallbackQuery(query.id, { text: '❌ ID manquant' });

  const STATUS_MAP = {
    'confirm':  { status: 'confirmed', label: '✅ Confirmé',    emoji: '✅' },
    'ready':    { status: 'ready',     label: '📦 Prêt',        emoji: '📦' },
    'done':     { status: 'done',      label: '✔️ Récupéré',    emoji: '✔️' },
    'paid':     { status: 'paid',      label: '💰 Payé',        emoji: '💰' },
    'cancel':   { status: 'cancelled', label: '❌ Annulé',      emoji: '❌' },
    'crypto_ok':{ status: 'paid',      label: '₿ Crypto reçue', emoji: '₿'  },
  };

  const mapping = STATUS_MAP[action];
  if(!mapping) return bot.answerCallbackQuery(query.id, { text: '❌ Action inconnue' });

  try {
    if(!db) throw new Error('Firebase non connecté');
    const ref  = db.collection('orders').doc(orderId);
    const snap = await ref.get();
    if(!snap.exists) return bot.answerCallbackQuery(query.id, { text: '❌ Commande introuvable' });

    const order = snap.data();
    await ref.update({
      status:    mapping.status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      [`statusHistory.${mapping.status}`]: admin.firestore.FieldValue.serverTimestamp(),
    });

    /* Notif client si on a son chatId */
    if(order.clientChatId){
      const clientMsg = {
        confirmed: `✅ Ta commande *${order.code}* a été confirmée ! Prépare-toi à venir la récupérer.`,
        ready:     `📦 Ta commande *${order.code}* est *prête* ! Viens la récupérer à ${order.shop}.`,
        done:      `✔️ Commande *${order.code}* récupérée. Merci et profite bien ! 🌿`,
        paid:      `💰 Paiement reçu pour *${order.code}*. Commande en cours de traitement.`,
        cancelled: `❌ Ta commande *${order.code}* a été annulée. Contacte-nous pour plus d'infos.`,
      };
      const msg = clientMsg[mapping.status];
      if(msg) await bot.sendMessage(order.clientChatId, msg, { parse_mode: 'Markdown' }).catch(()=>{});
    }

    /* Mise à jour du message admin */
    await bot.editMessageText(
      buildOrderText(order, mapping.label),
      {
        chat_id:    query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: buildOrderButtons(orderId, mapping.status),
      }
    ).catch(()=>{});

    await bot.answerCallbackQuery(query.id, {
      text: `${mapping.emoji} Commande ${mapping.label}`,
      show_alert: false,
    });
  } catch(e) {
    console.error('callback_query error:', e);
    await bot.answerCallbackQuery(query.id, { text: '❌ Erreur: ' + e.message });
  }
});

/* ══════════════════════════════════════════════
   API ENDPOINTS — appelés par la Mini App
   ══════════════════════════════════════════════ */

/* POST /order → nouvelle commande depuis la Mini App */
app.post('/order', async (req, res) => {
  try {
    const order = req.body;
    if(!order.items?.length) return res.status(400).json({ error: 'Commande vide' });

    /* Génère un code unique */
    order.code      = 'GT-' + Math.floor(1000 + Math.random() * 9000);
    order.status    = 'pending';
    order.createdAt = admin.firestore.FieldValue.serverTimestamp();

    /* Sauvegarde dans Firestore */
    let orderId = 'local_' + Date.now();
    if(db){
      const ref = await db.collection('orders').add(order);
      orderId = ref.id;
    }

    /* Notif Telegram admin */
    await sendOrderCard(CONFIG.ADMIN_CHAT, orderId, order);

    /* Si paiement crypto → envoie les infos de paiement */
    if(order.payment === 'crypto'){
      const cryptoInfo = await buildCryptoPayment(order.total, order.cryptoCurrency || 'USDT_TRC20', orderId);
      return res.json({ success: true, orderId, code: order.code, cryptoInfo });
    }

    res.json({ success: true, orderId, code: order.code });
  } catch(e) {
    console.error('POST /order error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* GET /rates → taux de conversion MAD → Crypto */
app.get('/rates', async (req, res) => {
  try {
    const rates = await fetchRates();
    res.json(rates);
  } catch(e) {
    res.json(CONFIG.RATES);
  }
});

/* POST /crypto/check → vérifie si un paiement crypto a été reçu */
app.post('/crypto/check', async (req, res) => {
  const { orderId, currency, amount, txHash } = req.body;
  try {
    const verified = await verifyCryptoPayment(currency, amount, txHash);
    if(verified && db){
      await db.collection('orders').doc(orderId).update({
        status: 'paid',
        txHash,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      /* Notif admin */
      await bot.sendMessage(CONFIG.ADMIN_CHAT,
        `₿ *Paiement crypto reçu !*\n\nCommande : \`${orderId}\`\nCrypto : ${currency}\nTx : \`${txHash}\``,
        { parse_mode: 'Markdown' }
      );
    }
    res.json({ verified });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════ */

/* Envoie une card de commande à l'admin avec les boutons d'action */
async function sendOrderCard(chatId, orderId, order) {
  const text    = buildOrderText(order, '⏳ En attente');
  const buttons = buildOrderButtons(orderId, order.status || 'pending');
  await bot.sendMessage(chatId, text, {
    parse_mode:   'Markdown',
    reply_markup: buttons,
  });
}

function buildOrderText(order, statusLabel) {
  const items = (order.items || [])
    .map(i => `  • ${i.name} ${i.weight||''}g × ${i.qty} = ${((i.priceMAD||i.price||0)*i.qty).toFixed(0)} MAD`)
    .join('\n');

  return (
    `🌿 *Nouvelle commande GoldenTrichomes*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📋 Code : \`${order.code || orderId}\`\n` +
    `👤 Client : ${order.customerName || '—'}\n` +
    `📞 Tél : ${order.customerPhone || '—'}\n` +
    `📍 Ville : ${order.shop || '—'}\n` +
    `🕐 Créneau : ${order.slot || '—'}\n` +
    `💳 Paiement : ${payLabel(order.payment)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${items}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 *Total : ${(order.total||0).toFixed(0)} MAD*\n` +
    `📊 Statut : ${statusLabel}`
  );
}

function buildOrderButtons(orderId, currentStatus) {
  /* Boutons selon le statut actuel */
  const btnSets = {
    pending: [[
      { text: '✅ Confirmer',    callback_data: `confirm:${orderId}` },
      { text: '❌ Annuler',      callback_data: `cancel:${orderId}`  },
    ],[
      { text: '💰 Marquer Payé', callback_data: `paid:${orderId}`    },
    ]],
    confirmed: [[
      { text: '📦 Prêt à retirer', callback_data: `ready:${orderId}` },
      { text: '❌ Annuler',        callback_data: `cancel:${orderId}` },
    ],[
      { text: '💰 Marquer Payé',   callback_data: `paid:${orderId}`  },
    ]],
    ready: [[
      { text: '✔️ Récupéré / Livré', callback_data: `done:${orderId}` },
    ]],
    paid: [[
      { text: '✅ Confirmer',        callback_data: `confirm:${orderId}` },
      { text: '✔️ Récupéré / Livré', callback_data: `done:${orderId}`   },
    ]],
    done:      [],
    cancelled: [],
  };
  return { inline_keyboard: btnSets[currentStatus] || btnSets.pending };
}

function payLabel(p) {
  return { cash:'💵 Cash', card:'💳 Carte', crypto:'₿ Crypto', btc:'₿ Bitcoin', eth:'Ξ Ethereum', sol:'◎ Solana', usdt:'$ USDT' }[p] || p || '—';
}

/* ── TAUX CRYPTO ── */
async function fetchRates() {
  const { data } = await axios.get(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=mad',
    { timeout: 5000 }
  );
  CONFIG.RATES.BTC = data.bitcoin?.mad  || 0;
  CONFIG.RATES.ETH = data.ethereum?.mad || 0;
  CONFIG.RATES.SOL = data.solana?.mad   || 0;
  CONFIG.RATES.USDT = 9.9; /* 1 USDT ≈ 9.9 MAD */
  return CONFIG.RATES;
}

/* ── CRYPTO PAYMENT INFO ── */
async function buildCryptoPayment(totalMAD, currency, orderId) {
  const rates = await fetchRates().catch(() => CONFIG.RATES);
  const RATE_MAP = {
    BTC: rates.BTC, ETH: rates.ETH, SOL: rates.SOL,
    USDT_TRC20: rates.USDT, USDT_ERC20: rates.USDT,
  };
  const rate       = RATE_MAP[currency] || rates.USDT;
  const cryptoAmt  = rate > 0 ? (totalMAD / rate).toFixed(6) : '—';
  const address    = CONFIG.WALLETS[currency] || CONFIG.WALLETS.USDT_TRC20;
  const qrData     = address;
  const qrUrl      = await QRCode.toDataURL(qrData, { width: 200, margin: 1 }).catch(() => null);
  return { currency, address, amount: cryptoAmt, totalMAD, qrUrl, orderId };
}

/* ── VÉRIFICATION PAIEMENT ── */
async function verifyCryptoPayment(currency, amount, txHash) {
  /* Vérification basique — à renforcer avec BlockCypher ou Trongrid */
  if(!txHash || txHash.length < 20) return false;
  try {
    if(currency === 'USDT_TRC20' || currency === 'TRX'){
      const { data } = await axios.get(
        `https://api.trongrid.io/v1/transactions/${txHash}`,
        { timeout: 8000 }
      );
      return data?.data?.[0]?.ret?.[0]?.contractRet === 'SUCCESS';
    }
    if(currency === 'BTC'){
      const { data } = await axios.get(
        `https://blockstream.info/api/tx/${txHash}`,
        { timeout: 8000 }
      );
      return !!data?.status?.confirmed;
    }
    if(currency === 'ETH' || currency === 'USDT_ERC20'){
      const { data } = await axios.get(
        `https://api.etherscan.io/api?module=transaction&action=gettxreceiptstatus&txhash=${txHash}&apikey=YourEtherscanKey`,
        { timeout: 8000 }
      );
      return data?.result?.status === '1';
    }
  } catch(e) { console.error('verifyCryptoPayment:', e.message); }
  return false;
}

/* ══════════════════════════════════════════════
   FIRESTORE LISTENER → nouvelles commandes
   (Notif automatique dès qu'une commande arrive)
   ══════════════════════════════════════════════ */
function watchNewOrders() {
  if(!db) return;
  let firstRun = true;
  db.collection('orders')
    .where('status','==','pending')
    .onSnapshot(snap => {
      if(firstRun){ firstRun = false; return; }
      snap.docChanges().forEach(async change => {
        if(change.type === 'added'){
          const order = change.doc.data();
          await sendOrderCard(CONFIG.ADMIN_CHAT, change.doc.id, order).catch(console.error);
        }
      });
    });
  console.log('👁️  Écoute des nouvelles commandes active');
}

/* ══════════════════════════════════════════════
   DÉMARRAGE
   ══════════════════════════════════════════════ */
app.listen(CONFIG.PORT, async () => {
  console.log(`🚀 GoldenTrichomes Bot démarré sur port ${CONFIG.PORT}`);
  /* Enregistre le webhook */
  await bot.setWebHook(`${CONFIG.WEBHOOK_URL}/webhook`).catch(console.error);
  console.log(`🔗 Webhook: ${CONFIG.WEBHOOK_URL}/webhook`);
  /* Lance les taux crypto */
  await fetchRates().catch(() => {});
  setInterval(fetchRates, 5 * 60 * 1000); /* refresh toutes les 5 min */
  /* Écoute Firestore */
  watchNewOrders();
});

module.exports = { app, bot, sendOrderCard };
