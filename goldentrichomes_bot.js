require('dotenv').config();
const express     = require('express');
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const admin       = require('firebase-admin');
const axios       = require('axios');

/* ══════════════════════════════════════════
   CONFIG
   ══════════════════════════════════════════ */
const CONFIG = {
  BOT_TOKEN:    process.env.BOT_TOKEN   || '8689166931:AAFweXM9nYW9YoY6-W0INnNURCCXpJ7bMjU',
  ADMIN_CHAT:   process.env.ADMIN_CHAT  || '-5108947245',   /* ton Chat ID perso */
  GROUP_CHAT:   process.env.GROUP_CHAT  || '-5108947245',  /* ton groupe commandes */
  WEBHOOK_URL:  process.env.WEBHOOK_URL || 'https://goldentrichomes-bot-production.up.railway.app',
  MINI_APP_URL: 'https://melodic-baklava-cd5a09.netlify.app/',
  PORT:         process.env.PORT        || 3000,

  WALLETS: {
    BTC:        'bc1qep4m47qeluj9jvdhp4ft4qcmk9r4w34u6xxuyd',
    ETH:        '0x0918234e6e8202AF158fde6328B8643846EfDeb0',
    USDT_TRC20: 'TWP5niQbrsNdhY2s3S1wFvi9MfBjEscHqY',
    USDT_ERC20: '0x0918234e6e8202AF158fde6328B8643846EfDeb0',
    SOL:        '45hP6dSNnNxP3at3seQ1pjwPoLXujneTvCoutbecFnpw',
  },
};

/* ══════════════════════════════════════════
   FIREBASE ADMIN
   ══════════════════════════════════════════ */
let db;
try {
  /* Essai via fichier local */
  const sa = require('./serviceAccount.json');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  db = admin.firestore();
  console.log('✅ Firebase connecté (serviceAccount.json)');
} catch(e) {
  /* Essai via variable d'environnement Railway */
  try {
    const sa = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '{}');
    if (sa.project_id) {
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      db = admin.firestore();
      console.log('✅ Firebase connecté (env variable)');
    } else {
      console.warn('⚠️  Firebase non connecté — ajoute serviceAccount.json ou GOOGLE_APPLICATION_CREDENTIALS_JSON');
    }
  } catch(e2) {
    console.warn('⚠️  Firebase non connecté:', e2.message);
  }
}

/* ══════════════════════════════════════════
   BOT + EXPRESS
   ══════════════════════════════════════════ */
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: false });
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'GoldenTrichomes Bot Online 🌿' }));

app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

/* ══════════════════════════════════════════
   STATUTS — FLOW COMPLET
   ══════════════════════════════════════════ */
const STATUTS = {
  new:         { label: '🆕 Nouvelle',       emoji: '🆕', next: 'confirmed'   },
  confirmed:   { label: '✅ Confirmée',       emoji: '✅', next: 'preparing'   },
  preparing:   { label: '👨‍🍳 En préparation', emoji: '👨‍🍳', next: 'ready'      },
  ready:       { label: '📦 Prête',           emoji: '📦', next: 'delivered'   },
  delivered:   { label: '🚴 Livrée',          emoji: '🚴', next: 'paid'        },
  paid:        { label: '💰 Payée',           emoji: '💰', next: null          },
  cancelled:   { label: '❌ Annulée',         emoji: '❌', next: null          },
};

/* Boutons selon le statut actuel */
function buildButtons(orderId, status) {
  const rows = [];

  /* Bouton principal — avancer au statut suivant */
  const current = STATUTS[status] || STATUTS.new;
  if (current.next) {
    const next = STATUTS[current.next];
    rows.push([{
      text: `${next.emoji} Marquer "${next.label.replace(/^.\s/, '')}"`,
      callback_data: `status:${orderId}:${current.next}`,
    }]);
  }

  /* Bouton payé si pas encore payé */
  if (status !== 'paid' && status !== 'cancelled') {
    rows.push([
      { text: '💰 Marquer Payée', callback_data: `status:${orderId}:paid` },
      { text: '❌ Annuler',       callback_data: `status:${orderId}:cancelled` },
    ]);
  }

  /* Bouton détails */
  rows.push([{ text: '🔍 Voir les détails', callback_data: `details:${orderId}` }]);

  return { inline_keyboard: rows };
}

/* Texte de la carte commande */
function buildOrderText(order, orderId) {
  const status  = order.status || 'new';
  const statut  = STATUTS[status] || STATUTS.new;
  const items   = (order.items || [])
    .map(i => `  • ${i.name} ${i.weight || ''}g × ${i.qty} = ${((i.priceMAD || i.price || 0) * i.qty).toFixed(0)} MAD`)
    .join('\n');
  const date    = order.createdAt?.toDate
    ? order.createdAt.toDate().toLocaleString('fr-MA', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })
    : new Date().toLocaleString('fr-MA');

  return (
    `${statut.emoji} *Commande GoldenTrichomes*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📋 Code : \`${order.code || orderId.slice(0,8).toUpperCase()}\`\n` +
    `📅 Date : ${date}\n` +
    `👤 Client : ${order.customerName || order.name || '—'}\n` +
    `📞 Tél : ${order.customerPhone || order.phone || '—'}\n` +
    `📍 Ville : ${order.shop || order.city || '—'}\n` +
    `🕐 Créneau : ${order.slot || '—'}\n` +
    `💳 Paiement : ${payLabel(order.payment)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${items || '  (aucun article)'}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 *Total : ${(order.total || 0).toFixed(0)} MAD*\n` +
    `📊 Statut : *${statut.label}*`
  );
}

function payLabel(p) {
  const map = { cash:'💵 Cash', card:'💳 Carte', crypto:'₿ Crypto', btc:'₿ Bitcoin', eth:'Ξ Ethereum', sol:'◎ Solana', usdt:'$ USDT' };
  return map[p] || p || '—';
}

/* ══════════════════════════════════════════
   ENVOYER UNE COMMANDE AU GROUPE
   ══════════════════════════════════════════ */
async function sendOrderToGroup(orderId, order) {
  const text    = buildOrderText(order, orderId);
  const buttons = buildButtons(orderId, order.status || 'new');
  try {
    const msg = await bot.sendMessage(CONFIG.GROUP_CHAT, text, {
      parse_mode:   'Markdown',
      reply_markup: buttons,
    });
    /* Sauvegarde le message_id pour pouvoir l'éditer plus tard */
    if (db) {
      await db.collection('orders').doc(orderId).update({
        groupMsgId:   msg.message_id,
        groupChatId:  CONFIG.GROUP_CHAT,
      }).catch(() => {});
    }
    return msg;
  } catch(e) {
    console.error('sendOrderToGroup error:', e.message);
  }
}

/* ══════════════════════════════════════════
   CALLBACK BOUTONS INLINE
   ══════════════════════════════════════════ */
bot.on('callback_query', async (query) => {
  const [action, orderId, newStatus] = query.data.split(':');
  const employeeName = query.from.first_name || query.from.username || 'Employé';

  /* ── Changement de statut ── */
  if (action === 'status') {
    if (!orderId || !newStatus) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Données manquantes' });
    }
    if (!STATUTS[newStatus]) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Statut inconnu' });
    }
    try {
      let order = {};
      if (db) {
        const ref  = db.collection('orders').doc(orderId);
        const snap = await ref.get();
        if (!snap.exists) return bot.answerCallbackQuery(query.id, { text: '❌ Commande introuvable' });
        order = snap.data();
        await ref.update({
          status:    newStatus,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          [`statusHistory.${newStatus}`]: admin.firestore.FieldValue.serverTimestamp(),
          lastUpdatedBy: employeeName,
        });
        order.status = newStatus;
      }

      const statut  = STATUTS[newStatus];
      const newText = buildOrderText({ ...order, status: newStatus }, orderId);
      const newBtns = buildButtons(orderId, newStatus);

      /* Édite le message dans le groupe */
      await bot.editMessageText(newText, {
        chat_id:    query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: newBtns,
      }).catch(() => {});

      /* Notifie l'employé qui a cliqué */
      await bot.answerCallbackQuery(query.id, {
        text: `${statut.emoji} Statut mis à jour → ${statut.label} par ${employeeName}`,
        show_alert: false,
      });

      /* Notifie le client si on a son chatId */
      if (order.clientChatId && db) {
        const msgs = {
          confirmed: `✅ Ta commande *${order.code}* a été confirmée !`,
          preparing: `👨‍🍳 Ta commande *${order.code}* est en préparation !`,
          ready:     `📦 Ta commande *${order.code}* est prête ! Viens la récupérer.`,
          delivered: `🚴 Ta commande *${order.code}* est en route !`,
          paid:      `💰 Paiement reçu pour *${order.code}*. Merci !`,
          cancelled: `❌ Ta commande *${order.code}* a été annulée.`,
        };
        const clientMsg = msgs[newStatus];
        if (clientMsg) {
          await bot.sendMessage(order.clientChatId, clientMsg, { parse_mode: 'Markdown' }).catch(() => {});
        }
      }
    } catch(e) {
      console.error('status callback error:', e);
      await bot.answerCallbackQuery(query.id, { text: '❌ Erreur: ' + e.message });
    }
  }

  /* ── Voir les détails ── */
  if (action === 'details') {
    try {
      let details = `🔍 *Détails commande ${orderId.slice(0,8).toUpperCase()}*\n\n`;
      if (db) {
        const snap = await db.collection('orders').doc(orderId).get();
        if (snap.exists) {
          const o = snap.data();
          details += `👤 ${o.customerName || o.name || '—'}\n`;
          details += `📞 ${o.customerPhone || o.phone || '—'}\n`;
          details += `📍 ${o.shop || o.city || '—'}\n`;
          details += `🕐 ${o.slot || '—'}\n`;
          details += `💳 ${payLabel(o.payment)}\n`;
          details += `📊 Historique statuts :\n`;
          const hist = o.statusHistory || {};
          Object.entries(hist).forEach(([s, t]) => {
            const ts = t?.toDate ? t.toDate().toLocaleString('fr-MA') : '—';
            details += `  • ${STATUTS[s]?.label || s} : ${ts}\n`;
          });
          if (o.lastUpdatedBy) details += `\n✏️ Dernière action par : ${o.lastUpdatedBy}`;
        }
      } else {
        details += 'Firebase non connecté.';
      }
      await bot.answerCallbackQuery(query.id, { text: details.slice(0, 200), show_alert: true });
    } catch(e) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Erreur détails' });
    }
  }
});

/* ══════════════════════════════════════════
   COMMANDES BOT
   ══════════════════════════════════════════ */
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const name   = msg.from?.first_name || 'là';
  await bot.sendMessage(chatId,
    `🌿👑 *Bienvenue sur GoldenTrichomes* 👑🌿\n\✨ Drysift · Frozen · Static · Ice O'Lator
🏔️ Beldia · Accessoires ·Morocco 🇲🇦\n\nClique ci-dessous pour commander `,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{
          text: '🛒 Ouvrir la boutique',
          web_app: { url: CONFIG.MINI_APP_URL },
        }]],
      },
    }
  );
});

bot.onText(/\/orders/, async (msg) => {
  if (String(msg.chat.id) !== CONFIG.ADMIN_CHAT) return;
  if (!db) return bot.sendMessage(msg.chat.id, '❌ Firebase non connecté');
  const snap = await db.collection('orders')
    .where('status', 'in', ['new', 'confirmed', 'preparing', 'ready'])
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();
  if (snap.empty) return bot.sendMessage(msg.chat.id, '✅ Aucune commande active');
  for (const d of snap.docs) {
    await sendOrderToGroup(d.id, d.data());
  }
});

bot.onText(/\/stats/, async (msg) => {
  if (String(msg.chat.id) !== CONFIG.ADMIN_CHAT) return;
  if (!db) return bot.sendMessage(msg.chat.id, '❌ Firebase non connecté');
  const [pending, done, all] = await Promise.all([
    db.collection('orders').where('status', 'in', ['new','confirmed','preparing','ready']).get(),
    db.collection('orders').where('status', '==', 'delivered').get(),
    db.collection('orders').get(),
  ]);
  const revenue = done.docs.reduce((s, d) => s + (d.data().total || 0), 0);
  bot.sendMessage(msg.chat.id,
    `📊 *Stats GoldenTrichomes*\n\n` +
    `🔄 En cours : ${pending.size}\n` +
    `✅ Livrées : ${done.size}\n` +
    `📦 Total : ${all.size}\n` +
    `💰 Revenus : ${revenue.toFixed(0)} MAD`,
    { parse_mode: 'Markdown' }
  );
});

/* ══════════════════════════════════════════
   API ENDPOINTS — Mini App → Bot
   ══════════════════════════════════════════ */
app.post('/order', async (req, res) => {
  try {
    const order = req.body;
    if (!order || (!order.items?.length && !order.customerName)) {
      return res.status(400).json({ error: 'Commande invalide' });
    }
    order.code      = 'GT-' + Math.floor(1000 + Math.random() * 9000);
    order.status    = 'new';
    order.createdAt = db ? admin.firestore.FieldValue.serverTimestamp() : new Date().toISOString();

    let orderId = 'local_' + Date.now();
    if (db) {
      const ref = await db.collection('orders').add(order);
      orderId   = ref.id;
    }

    /* Envoie au groupe */
    await sendOrderToGroup(orderId, order);

    res.json({ success: true, orderId, code: order.code });
  } catch(e) {
    console.error('POST /order error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/rates', async (req, res) => {
  try {
    const { data } = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=mad',
      { timeout: 5000 }
    );
    res.json({
      BTC:        data.bitcoin?.mad  || 0,
      ETH:        data.ethereum?.mad || 0,
      SOL:        data.solana?.mad   || 0,
      USDT_TRC20: 9.9,
      USDT_ERC20: 9.9,
    });
  } catch(e) {
    res.json({ BTC: 0, ETH: 0, SOL: 0, USDT_TRC20: 9.9, USDT_ERC20: 9.9 });
  }
});

/* ══════════════════════════════════════════
   FIRESTORE LISTENER — nouvelles commandes
   ══════════════════════════════════════════ */
function watchNewOrders() {
  if (!db) return;
  let firstRun = true;
  db.collection('orders')
    .where('status', '==', 'new')
    .onSnapshot(snap => {
      if (firstRun) { firstRun = false; return; }
      snap.docChanges().forEach(async change => {
        if (change.type === 'added') {
          const order = change.doc.data();
          /* Évite les doublons — envoie seulement si pas déjà de groupMsgId */
          if (!order.groupMsgId) {
            await sendOrderToGroup(change.doc.id, order).catch(console.error);
          }
        }
      });
    });
  console.log('👁️  Écoute des nouvelles commandes active');
}

/* ══════════════════════════════════════════
   DÉMARRAGE
   ══════════════════════════════════════════ */
app.listen(CONFIG.PORT, async () => {
  console.log(`🚀 GoldenTrichomes Bot — port ${CONFIG.PORT}`);
  try {
    await bot.setWebHook(`${CONFIG.WEBHOOK_URL}/webhook`);
    console.log(`🔗 Webhook: ${CONFIG.WEBHOOK_URL}/webhook`);
  } catch(e) {
    console.error('Webhook error:', e.message);
  }
  watchNewOrders();
});

module.exports = { app, bot, sendOrderToGroup };
