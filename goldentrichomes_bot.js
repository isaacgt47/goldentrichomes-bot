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
  ADMIN_CHAT:   process.env.ADMIN_CHAT  || '5383453640',
  GROUP_CHAT:   process.env.GROUP_CHAT  || '-5108947245',
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

/* Anti-doublon — garde en mémoire les orderId déjà envoyés */
const sentOrders = new Set();

/* ══════════════════════════════════════════
   FIREBASE ADMIN
   ══════════════════════════════════════════ */
let db;
try {
  const sa = require('./serviceAccount.json');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  db = admin.firestore();
  console.log('✅ Firebase connecté (serviceAccount.json)');
} catch(e) {
  try {
    const sa = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '{}');
    if (sa.project_id) {
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      db = admin.firestore();
      console.log('✅ Firebase connecté (env variable)');
    } else {
      console.warn('⚠️  Firebase non connecté');
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
/* CORS — permet les appels depuis Netlify */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => res.json({ status: 'GoldenTrichomes Bot Online 🌿' }));
app.post('/webhook', (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });

/* ══════════════════════════════════════════
   STATUTS
   ══════════════════════════════════════════ */
const STATUTS = {
  new:       { label: '🆕 Nouvelle',        emoji: '🆕', next: 'confirmed'  },
  confirmed: { label: '✅ Confirmée',        emoji: '✅', next: 'preparing'  },
  preparing: { label: '👨‍🍳 En préparation', emoji: '👨‍🍳', next: 'ready'     },
  ready:     { label: '📦 Prête',            emoji: '📦', next: 'delivered'  },
  delivered: { label: '🚴 Livrée',           emoji: '🚴', next: 'paid'       },
  paid:      { label: '💰 Payée',            emoji: '💰', next: null         },
  cancelled: { label: '❌ Annulée',          emoji: '❌', next: null         },
};

function buildButtons(orderId, status) {
  const rows = [];
  const current = STATUTS[status] || STATUTS.new;
  if (current.next) {
    const next = STATUTS[current.next];
    rows.push([{ text: `${next.emoji} ${next.label.replace(/^.\s/,'')}`, callback_data: `status:${orderId}:${current.next}` }]);
  }
  if (status !== 'paid' && status !== 'cancelled') {
    rows.push([
      { text: '💰 Marquer Payée',  callback_data: `status:${orderId}:paid`      },
      { text: '❌ Annuler',        callback_data: `status:${orderId}:cancelled`  },
    ]);
  }
  rows.push([{ text: '🔍 Voir les détails', callback_data: `details:${orderId}` }]);
  return { inline_keyboard: rows };
}

/* Échappe les caractères spéciaux Markdown Telegram */
function escapeMd(s){ return String(s||'').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&'); }

function buildOrderText(order, orderId) {
  const status = order.status || 'new';
  const statut = STATUTS[status] || STATUTS.new;
  const items  = (order.items || [])
    .map(i => `  • ${escapeMd(i.name)} ${i.weight||i.w||''}g × ${i.qty} = ${((i.priceMAD||i.price||0)*i.qty).toLocaleString('fr-MA')} MAD`)
    .join('\n');
  const date = order.createdAt?.toDate
    ? order.createdAt.toDate().toLocaleString('fr-MA', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})
    : new Date().toLocaleString('fr-MA');

  const name  = (order.customerName || order.name || '—').replace(/[<>&]/g,'');
  const phone = (order.customerPhone || order.phone || '—').replace(/[<>&]/g,'');
  const ville = (order.shopName || order.shop || '—').replace(/[<>&]/g,'');
  const slot  = (order.slot || '—').replace(/[<>&]/g,'');
  const addr  = (order.address || '').replace(/[<>&]/g,'');
  const tgU   = (order.telegramUser || '').replace(/[<>&]/g,'');
  const code  = (order.code || orderId.slice(0,8).toUpperCase()).replace(/[<>&]/g,'');

  return (
    `${statut.emoji} <b>Commande GoldenTrichomes</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📋 Code : <code>${code}</code>\n` +
    `📅 Date : ${date}\n` +
    `👤 Client : ${name}\n` +
    `📞 Tél : ${phone}\n` +
    (tgU ? `✈️ Telegram : @${tgU}\n` : '') +
    `📍 Ville : ${ville}\n` +
    `🕐 Créneau : ${slot}\n` +
    `💳 Paiement : ${payLabel(order.payment)}\n` +
    `🚚 Livraison : ${order.delivery === 'delivery' ? '🛵 À domicile' : '🏪 Click & Collect'}\n` +
    (addr ? `📍 Adresse : ${addr}\n` : '') +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${items || '  (aucun article)'}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 <b>Total : ${(order.totalMAD || order.total || 0).toLocaleString('fr-MA')} MAD</b>\n` +
    `📊 Statut : <b>${statut.label}</b>`
  );
}

function payLabel(p) {
  return { cash:'💵 Cash', card:'💳 Carte', crypto:'₿ Crypto', btc:'₿ Bitcoin', eth:'Ξ Ethereum', sol:'◎ Solana', usdt:'$ USDT' }[p] || p || '—';
}

/* ══════════════════════════════════════════
   ENVOYER UNE COMMANDE AU GROUPE
   ══════════════════════════════════════════ */
async function sendOrderToGroup(orderId, order) {
  /* Anti-doublon — ignore si déjà envoyé */
  if (sentOrders.has(orderId)) {
    console.log(`⏭️  Doublon ignoré: ${orderId}`);
    return;
  }
  sentOrders.add(orderId);
  /* Nettoie après 1h pour éviter les fuites mémoire */
  setTimeout(() => sentOrders.delete(orderId), 3600000);

  const text    = buildOrderText(order, orderId);
  const buttons = buildButtons(orderId, order.status || 'new');
  try {
    const msg = await bot.sendMessage(CONFIG.GROUP_CHAT, text, {
      parse_mode:   'HTML',
      reply_markup: buttons,
    });
    /* Sauvegarde le message_id pour éviter les doublons */
    if (db) {
      await db.collection('orders').doc(orderId).update({
        groupMsgId:  msg.message_id,
        groupChatId: CONFIG.GROUP_CHAT,
        sentToGroup: true,
      }).catch(() => {});
    }
    return msg;
  } catch(e) {
    console.error('sendOrderToGroup error:', e.message);
  }
}

/* ══════════════════════════════════════════
   CALLBACK BOUTONS
   ══════════════════════════════════════════ */
bot.on('callback_query', async (query) => {
  const parts   = query.data.split(':');
  const action  = parts[0];
  const orderId = parts[1];
  const newStatus = parts[2];
  const employeeName = query.from.first_name || query.from.username || 'Employé';

  if (action === 'status') {
    if (!STATUTS[newStatus]) return bot.answerCallbackQuery(query.id, { text: '❌ Statut inconnu' });
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
      }
      order.status = newStatus;
      const statut  = STATUTS[newStatus];
      const newText = buildOrderText(order, orderId);
      const newBtns = buildButtons(orderId, newStatus);

      /* Met à jour le message dans le groupe */
      await bot.editMessageText(newText, {
        chat_id:      query.message.chat.id,
        message_id:   query.message.message_id,
        parse_mode:   'HTML',
        reply_markup: newBtns,
      }).catch(() => {});

      await bot.answerCallbackQuery(query.id, {
        text: `${statut.emoji} ${statut.label} — par ${employeeName}`,
        show_alert: false,
      });

      /* Notif client */
      if (order.clientChatId) {
        const msgs = {
          confirmed: `✅ Ta commande *${order.code}* a été confirmée !`,
          preparing: `👨‍🍳 Ta commande *${order.code}* est en préparation !`,
          ready:     `📦 Ta commande *${order.code}* est prête ! Viens la récupérer.`,
          delivered: `🚴 Ta commande *${order.code}* est en route !`,
          paid:      `💰 Paiement reçu pour *${order.code}*. Merci !`,
          cancelled: `❌ Ta commande *${order.code}* a été annulée.`,
        };
        const clientMsg = msgs[newStatus];
        if (clientMsg) await bot.sendMessage(order.clientChatId, clientMsg, { parse_mode: 'HTML' }).catch(() => {});
      }
    } catch(e) {
      console.error('status callback error:', e);
      await bot.answerCallbackQuery(query.id, { text: '❌ Erreur: ' + e.message });
    }
  }

  if (action === 'details') {
    try {
      let details = `🔍 *Détails commande*\n\n`;
      if (db) {
        const snap = await db.collection('orders').doc(orderId).get();
        if (snap.exists) {
          const o = snap.data();
          details += `👤 ${o.customerName||'—'} · 📞 ${o.customerPhone||'—'}\n`;
          details += `📍 ${o.shopName||o.shop||'—'} · 🕐 ${o.slot||'—'}\n`;
          details += `💳 ${payLabel(o.payment)}\n`;
          if (o.lastUpdatedBy) details += `✏️ Dernière action : ${o.lastUpdatedBy}\n`;
          const hist = o.statusHistory || {};
          if (Object.keys(hist).length) {
            details += `\n📊 Historique :\n`;
            Object.entries(hist).forEach(([s, t]) => {
              const ts = t?.toDate ? t.toDate().toLocaleString('fr-MA') : '—';
              details += `  • ${STATUTS[s]?.label||s} : ${ts}\n`;
            });
          }
        }
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
  const name   = msg.from?.first_name || '';
  /* Vérifie si l'utilisateur a un username */
  if (!msg.from?.username) {
    return bot.sendMessage(chatId,
      `🌿 *Bienvenue chez GoldenTrichomes* 🌿\n\n` +
      `Salam ${name} 👋\n\n` +
      `⚠️ *Pour commander, tu dois avoir un @username Telegram.*\n\n` +
      `Voici comment en créer un :\n` +
      `1. Va dans *Paramètres Telegram*\n` +
      `2. Clique sur ton profil\n` +
      `3. Clique sur *Nom d'utilisateur*\n` +
      `4. Choisis un @username\n` +
      `5. Reviens ici et tape /start\n\n` +
      `C'est gratuit et prend 30 secondes ! 🙏`,
      { parse_mode: 'HTML' }
    );
  }
  /* Enregistre le client dans Firebase */
  if (db && msg.from?.id) {
    await db.collection('clients').doc(String(msg.from.id)).set({
      telegramId:       String(msg.from.id),
      telegramUsername: msg.from.username,
      firstName:        msg.from.first_name || '',
      lastName:         msg.from.last_name  || '',
      lastSeen:         admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
  }
  await bot.sendMessage(chatId,
    `🌿 *Bienvenue chez GoldenTrichomes* 🌿\n\nSalam ${name} 👋\n\nQualité marocaine, livraison partout au Maroc 🇲🇦\n\n👇 Clique pour commander :`,
    {
      parse_mode: 'HTML',
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
    .where('status', 'in', ['new','confirmed','preparing','ready'])
    .orderBy('createdAt','desc').limit(10).get();
  if (snap.empty) return bot.sendMessage(msg.chat.id, '✅ Aucune commande active');
  for (const d of snap.docs) await sendOrderToGroup(d.id, d.data());
});

bot.onText(/\/stats/, async (msg) => {
  if (String(msg.chat.id) !== CONFIG.ADMIN_CHAT) return;
  if (!db) return bot.sendMessage(msg.chat.id, '❌ Firebase non connecté');
  const [actives, done, all] = await Promise.all([
    db.collection('orders').where('status','in',['new','confirmed','preparing','ready']).get(),
    db.collection('orders').where('status','==','delivered').get(),
    db.collection('orders').get(),
  ]);
  const revenue = done.docs.reduce((s,d) => s+(d.data().totalMAD||d.data().total||0), 0);
  bot.sendMessage(msg.chat.id,
    `📊 *Stats GoldenTrichomes*\n\n` +
    `🔄 En cours : ${actives.size}\n✅ Livrées : ${done.size}\n📦 Total : ${all.size}\n💰 Revenus : ${revenue.toLocaleString('fr-MA')} MAD`,
    { parse_mode: 'HTML' }
  );
});

/* Stock check command */
bot.onText(/\/stock/, async (msg) => {
  if (String(msg.chat.id) !== CONFIG.ADMIN_CHAT) return;
  if (!db) return bot.sendMessage(msg.chat.id, '❌ Firebase non connecté');
  const snap = await db.collection('products').orderBy('cat').get();
  if (snap.empty) return bot.sendMessage(msg.chat.id, 'Aucun produit');
  let text = `📦 *Stock GoldenTrichomes*\n━━━━━━━━━━━━━━━━\n`;
  snap.docs.forEach(d => {
    const p = d.data();
    const stockG = p.stockGrams != null ? p.stockGrams : '∞';
    const icon   = p.stockGrams === 0 ? '❌' : p.stockGrams < 10 ? '⚠️' : '✅';
    text += `${icon} ${p.name} — *${stockG}g*\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

/* ══════════════════════════════════════════
   API — POST /order
   Reçoit la commande depuis la Mini App
   ══════════════════════════════════════════ */
app.post('/order', async (req, res) => {
  try {
    const order = req.body;
    if (!order || !order.customerName) {
      return res.status(400).json({ error: 'Commande invalide' });
    }

    const villeId = order.villeId || order.shop || null;

    /* ── Vérification stock ── */
    if (db && order.items && order.items.length) {
      for (const item of order.items) {
        if (!item.name) continue;
        let snap = null;
        try {
          if (villeId) {
            const bSnap = await db.collection('boutiques').doc(villeId)
              .collection('produits').where('nom', '==', item.name).limit(1).get();
            if (!bSnap.empty) snap = bSnap;
          }
          if (!snap || snap.empty) {
            snap = await db.collection('products')
              .where('name', '==', item.name).limit(1).get();
          }
          if (snap && !snap.empty) {
            const prod    = snap.docs[0].data();
            const demande = (item.weight || item.w || 0) * (item.qty || 1);
            if (prod.stockGrams != null && prod.stockGrams < demande) {
              return res.status(400).json({
                error: `Stock insuffisant pour ${item.name}. Disponible : ${prod.stockGrams}g`,
                stockError: true, product: item.name, available: prod.stockGrams,
              });
            }
          }
        } catch (se) { console.error('Stock check error:', se.message); }
      }
    }

    /* ── Génère le code ── */
    order.code        = order.code || ('GT-' + Math.floor(1000 + Math.random() * 9000));
    order.status      = 'new';
    order.sentToGroup = false;

    /* ── Sauvegarde Firebase ── */
    let orderId = 'local_' + Date.now();
    if (db) {
      order.createdAt = admin.firestore.FieldValue.serverTimestamp();
      const ref = await db.collection('orders').add(order);
      orderId   = ref.id;

      /* ── Décrémente le stock dans boutiques ET global ── */
      for (const item of (order.items || [])) {
        if (!item.name) continue;
        try {
          const demande = (item.weight || item.w || 0) * (item.qty || 1);
          const applyUpdate = async (snap) => {
            if (!snap.empty) {
              const prod = snap.docs[0].data();
              if (prod.stockGrams != null) {
                const nStock = Math.max(0, prod.stockGrams - demande);
                await snap.docs[0].ref.update({
                  stockGrams: nStock,
                  stock: nStock === 0 ? 'out' : nStock < 10 ? 'low' : 'available',
                });
              }
            }
          };
          if (villeId) {
            const bSnap = await db.collection('boutiques').doc(villeId)
              .collection('produits').where('nom', '==', item.name).limit(1).get();
            await applyUpdate(bSnap);
          }
          const gSnap = await db.collection('products')
            .where('name', '==', item.name).limit(1).get();
          await applyUpdate(gSnap);
        } catch (se) { console.error('Stock decrement error:', se.message); }
      }
    }

    /* ── Envoie au groupe avec boutons ── */
    await sendOrderToGroup(orderId, { ...order, status: 'new' });

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
    res.json({ BTC: data.bitcoin?.mad||0, ETH: data.ethereum?.mad||0, SOL: data.solana?.mad||0, USDT_TRC20: 9.9, USDT_ERC20: 9.9 });
  } catch(e) {
    res.json({ BTC:0, ETH:0, SOL:0, USDT_TRC20:9.9, USDT_ERC20:9.9 });
  }
});

/* ══════════════════════════════════════════
   DÉMARRAGE — PAS de watchNewOrders
   pour éviter les doublons
   ══════════════════════════════════════════ */
app.listen(CONFIG.PORT, async () => {
  console.log(`🚀 GoldenTrichomes Bot — port ${CONFIG.PORT}`);
  try {
    await bot.setWebHook(`${CONFIG.WEBHOOK_URL}/webhook`);
    console.log(`🔗 Webhook: ${CONFIG.WEBHOOK_URL}/webhook`);
  } catch(e) {
    console.error('Webhook error:', e.message);
  }
  /* PAS de watchNewOrders — évite les doublons */
  console.log('✅ Bot prêt — envoi via /order uniquement');
});

module.exports = { app, bot, sendOrderToGroup };
