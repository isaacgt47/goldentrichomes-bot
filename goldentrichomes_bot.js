require('dotenv').config();
const express     = require('express');
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const admin       = require('firebase-admin');
const axios       = require('axios');
const https       = require('https');
const FormData    = require('form-data');

/* ══════════════════════════════════════════
   CONFIG
   ══════════════════════════════════════════ */
const CONFIG = {
  BOT_TOKEN:    process.env.BOT_TOKEN   || '8689166931:AAFweXM9nYW9YoY6-W0INnNURCCXpJ7bMjU',
  ADMIN_CHAT:   process.env.ADMIN_CHAT  || '7670750855',
  GROUP_CHAT:   process.env.GROUP_CHAT  || '-1003981429957',
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
   CLOUDINARY CONFIG
   Upload vidéo depuis Telegram → Cloudinary
   ══════════════════════════════════════════ */
const CLOUDINARY = {
  CLOUD:  process.env.CLOUDINARY_CLOUD  || 'prxyoco2',
  PRESET: process.env.CLOUDINARY_PRESET || 'gt_videos',
};

/* État temporaire des commandes vidéo en cours */
const pendingVideoUpload = {}; /* chatId → { produitId, boutique } */

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

  /* ── Choix boutique pour upload vidéo ── */
  if(action === 'vidvill'){
    const adminId    = parts[1];
    const boutiqueId = parts[2];
    const pending    = pendingVideoUpload[adminId];
    if(!pending || pending.step !== 'choose_boutique'){
      return bot.answerCallbackQuery(query.id, { text: '❌ Session expirée. Relance /video' });
    }
    const { resultats, nomProduit, statusMsgId } = pending;
    let choix, boutLabel;
    if(boutiqueId === 'ALL'){
      choix = resultats;
      boutLabel = 'toutes les boutiques (' + resultats.length + ')';
    } else {
      choix = resultats.filter(r => r.boutiqueId === boutiqueId);
      boutLabel = choix[0]?.boutiqueNom || boutiqueId;
    }
    if(!choix.length) return bot.answerCallbackQuery(query.id, { text: '❌ Introuvable' });

    pendingVideoUpload[adminId] = {
      allRefs:    choix.map(r => r.ref),
      produitNom: choix[0].data.name || choix[0].data.nom || nomProduit,
      boutique:   boutLabel,
    };
    await bot.answerCallbackQuery(query.id, { text: '✅ ' + boutLabel + ' sélectionnée' });
    await bot.editMessageText(
      '✅ *' + nomProduit + '*\n' +
      '📍 Boutique : *' + boutLabel + '*\n\n' +
      '📹 Envoie maintenant ta vidéo (MOV, MP4...)\n' +
      "L\'upload démarre automatiquement.",
      { chat_id: query.message.chat.id, message_id: statusMsgId, parse_mode: 'Markdown' }
    );
    return;
  }

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
  if (String(msg.chat.id) !== CONFIG.ADMIN_CHAT && String(msg.chat.id) !== '7524388895') return;
  if (!db) return bot.sendMessage(msg.chat.id, '❌ Firebase non connecté');
  const snap = await db.collection('orders')
    .where('status', 'in', ['new','confirmed','preparing','ready'])
    .orderBy('createdAt','desc').limit(10).get();
  if (snap.empty) return bot.sendMessage(msg.chat.id, '✅ Aucune commande active');
  for (const d of snap.docs) await sendOrderToGroup(d.id, d.data());
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = String(msg.chat.id);
  if(chatId !== CONFIG.ADMIN_CHAT && chatId !== '7524388895') return;
  if(!db) return bot.sendMessage(msg.chat.id, '❌ Firebase non connecté');

  const loadMsg = await bot.sendMessage(msg.chat.id, '⏳ Chargement des stats...');

  try{
    /* Toutes les données en parallèle */
    const [
      allOrders, activeOrders, doneOrders, cancelledOrders,
      allClients, allBoutiques
    ] = await Promise.all([
      db.collection('orders').get(),
      db.collection('orders').where('status','in',['new','confirmed','preparing','ready']).get(),
      db.collection('orders').where('status','in',['delivered','paid']).get(),
      db.collection('orders').where('status','==','cancelled').get(),
      db.collection('clients').get(),
      db.collection('boutiques').get(),
    ]);

    /* Revenus */
    const revenue = doneOrders.docs.reduce((s,d) => s+(d.data().totalMAD||d.data().total||0), 0);
    const revenueTotal = allOrders.docs
      .filter(d => !['cancelled'].includes(d.data().status))
      .reduce((s,d) => s+(d.data().totalMAD||d.data().total||0), 0);

    /* Commandes aujourd'hui */
    const today = new Date(); today.setHours(0,0,0,0);
    const ordersToday = allOrders.docs.filter(d => {
      const t = d.data().createdAt?.toDate ? d.data().createdAt.toDate() : null;
      return t && t >= today;
    }).length;

    /* Commandes cette semaine */
    const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate()-7);
    const ordersWeek = allOrders.docs.filter(d => {
      const t = d.data().createdAt?.toDate ? d.data().createdAt.toDate() : null;
      return t && t >= weekAgo;
    }).length;

    /* Clients actifs (ont commandé) */
    const clientsWithOrders = new Set(
      allOrders.docs.map(d => d.data().clientChatId || d.data().telegramId).filter(Boolean)
    ).size;

    /* Top produits */
    const prodCount = {};
    allOrders.docs.forEach(d => {
      (d.data().items||[]).forEach(item => {
        const n = item.name || item.nom || '?';
        prodCount[n] = (prodCount[n]||0) + (item.qty||1);
      });
    });
    const topProds = Object.entries(prodCount)
      .sort((a,b) => b[1]-a[1])
      .slice(0,5)
      .map(([ n, q ], i) => `  ${['🥇','🥈','🥉','4️⃣','5️⃣'][i]} ${n} — ${q}x`)
      .join('\n');

    /* Boutiques actives */
    const boutiquesActives = allBoutiques.docs
      .filter(d => d.data().actif !== false)
      .map(d => d.data().nom || d.id)
      .join(', ');

    /* Panier moyen */
    const panierMoyen = allOrders.size > 0
      ? Math.round(revenueTotal / allOrders.size)
      : 0;

    const text =
      '📊 *GoldenTrichomes — Dashboard*\n' +
      '━━━━━━━━━━━━━━━━━━━━\n\n' +
      '👥 *Utilisateurs*\n' +
      `  📱 Total inscrits : *${allClients.size}*\n` +
      `  🛒 Ont commandé : *${clientsWithOrders}*\n\n` +
      '📦 *Commandes*\n' +
      `  📅 Aujourd\'hui : *${ordersToday}*\n` +
      `  📆 Cette semaine : *${ordersWeek}*\n` +
      `  🔄 En cours : *${activeOrders.size}*\n` +
      `  ✅ Livrées : *${doneOrders.size}*\n` +
      `  ❌ Annulées : *${cancelledOrders.size}*\n` +
      `  📦 Total : *${allOrders.size}*\n\n` +
      '💰 *Revenus*\n' +
      `  💵 Revenus livrées : *${revenue.toLocaleString('fr-MA')} MAD*\n` +
      `  🧾 Panier moyen : *${panierMoyen.toLocaleString('fr-MA')} MAD*\n\n` +
      '🏆 *Top 5 Produits*\n' +
      (topProds || '  Aucune donnée') + '\n\n' +
      '🏪 *Boutiques actives*\n' +
      `  ${boutiquesActives || 'Aucune'}\n\n` +
      '━━━━━━━━━━━━━━━━━━━━\n' +
      '📹 `/video [nom]` — Uploader vidéo\n' +
      '📢 `/broadcast [msg]` — Envoyer à tous\n' +
      '📦 `/stock` — Voir le stock\n' +
      '📋 `/orders` — Commandes actives';

    await bot.editMessageText(text, {
      chat_id:    msg.chat.id,
      message_id: loadMsg.message_id,
      parse_mode: 'Markdown',
    });

  }catch(e){
    console.error('stats error:', e);
    await bot.editMessageText('❌ Erreur stats : ' + e.message, {
      chat_id: msg.chat.id, message_id: loadMsg.message_id
    });
  }
});

/* ══════════════════════════════════════════
   UPLOAD VIDÉO — Cloudinary
   ══════════════════════════════════════════ */

/* Télécharge un fichier Telegram puis l\'upload sur Cloudinary */
async function uploadVideoFromTelegram(fileId, filename){
  /* 1. Récupère l\'URL de téléchargement Telegram */
  const fileInfo = await bot.getFile(fileId);
  const fileUrl  = `https://api.telegram.org/file/bot${CONFIG.BOT_TOKEN}/${fileInfo.file_path}`;

  /* 2. Télécharge le fichier */
  const response = await axios.get(fileUrl, { responseType: 'stream', timeout: 120000 });
  const stream   = response.data;

  /* 3. Upload sur Cloudinary via multipart */
  const form = new FormData();
  form.append('file',           stream, { filename: filename || 'video.mp4' });
  form.append('upload_preset',  CLOUDINARY.PRESET);
  form.append('resource_type',  'video');
  form.append('folder',         'goldentrichomes');

  const uploadRes = await axios.post(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY.CLOUD}/video/upload`,
    form,
    { headers: form.getHeaders(), timeout: 300000 }
  );

  return uploadRes.data.secure_url; /* URL directe MP4 permanente */
}

/* Cherche un produit dans TOUTES les boutiques actives — retourne liste dédupliquée */
async function findProduitDansBoutiques(search){
  if(!db) return [];
  search = search.toLowerCase().trim();
  const results = [];
  const seenNoms = new Set(); /* déduplique par nom de boutique */

  const boutSnap = await db.collection('boutiques').get();
  for(const boutDoc of boutSnap.docs){
    const b = boutDoc.data();
    if(b.actif === false) continue;

    /* Déduplique les boutiques avec le même nom (ex: plusieurs docs "Rabat") */
    const nomBout = (b.nom || boutDoc.id).toLowerCase();
    if(seenNoms.has(nomBout)) continue;

    const prodsSnap = await boutDoc.ref.collection('produits').get();
    let found = false;
    for(const prodDoc of prodsSnap.docs){
      const p = prodDoc.data();
      const name = (p.name || p.nom || '').toLowerCase();
      if(name.includes(search) || search.includes(name.split(' ')[0].toLowerCase())){
        results.push({
          ref:         prodDoc.ref,
          data:        p,
          id:          prodDoc.id,
          boutiqueId:  boutDoc.id,
          boutiqueNom: b.nom || boutDoc.id,
        });
        found = true;
        break; /* 1 produit par boutique suffit */
      }
    }
    if(found) seenNoms.add(nomBout);
  }
  return results;
}

/* ══════════════════════════════════════════
   COMMANDE /video — Admin seulement
   Propose un choix de boutique avec boutons
   ══════════════════════════════════════════ */
bot.onText(/\/video(?:\s+(.+))?/, async (msg) => {
  const chatId = String(msg.chat.id);
  if(chatId !== CONFIG.ADMIN_CHAT && chatId !== '7524388895'){
    return bot.sendMessage(msg.chat.id, "❌ Commande réservée à l\'admin.");
  }
  if(!db) return bot.sendMessage(msg.chat.id, "❌ Firebase non connecté.");

  const nomProduit = (msg.text.match(/\/video\s+(.+)/)?.[1] || '').trim();
  if(!nomProduit){
    return bot.sendMessage(msg.chat.id,
      "📹 *Commande vidéo produit*\n\n" +
      "Usage : `/video nom_du_produit`\n\n" +
      "Exemples :\n" +
      "`/video Forbidden Fruit 120u`\n" +
      "`/video Rainbow Belt`\n" +
      "Le bot te proposera de choisir la boutique.",
      { parse_mode: "Markdown" }
    );
  }

  const statusMsg = await bot.sendMessage(msg.chat.id,
    "🔍 Recherche *" + nomProduit + "* dans les boutiques actives...",
    { parse_mode: "Markdown" }
  );

  const resultats = await findProduitDansBoutiques(nomProduit);

  if(!resultats.length){
    return bot.editMessageText(
      "❌ Produit *" + nomProduit + "* introuvable.\n\nVérifie le nom dans le panel admin.",
      { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: "Markdown" }
    );
  }

  /* 1 seul résultat → pas de choix */
  if(resultats.length === 1){
    const p = resultats[0];
    pendingVideoUpload[chatId] = {
      allRefs:    [p.ref],
      produitNom: p.data.name || p.data.nom || nomProduit,
      boutique:   p.boutiqueNom,
    };
    return bot.editMessageText(
      "✅ *" + (p.data.name||p.data.nom) + "*\n" +
      "📍 Boutique : *" + p.boutiqueNom + "*\n\n" +
      "📹 Envoie maintenant ta vidéo (MOV, MP4...)\n" +
      "L\'upload démarre automatiquement.",
      { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: "Markdown" }
    );
  }

  /* Plusieurs boutiques → boutons */
  pendingVideoUpload[chatId] = {
    step:        "choose_boutique",
    resultats:   resultats,
    nomProduit:  nomProduit,
    statusMsgId: statusMsg.message_id,
  };

  const btns = resultats.map(r => ([{
    text: "🏪 " + r.boutiqueNom,
    callback_data: "vidvill:" + chatId + ":" + r.boutiqueId,
  }]));
  btns.push([{ text: "🌍 Toutes les boutiques", callback_data: "vidvill:" + chatId + ":ALL" }]);

  await bot.editMessageText(
    "✅ *" + nomProduit + "* trouvé dans *" + resultats.length + " boutiques*\n\n" +
    "📍 Choisis la boutique à mettre à jour :",
    {
      chat_id:      msg.chat.id,
      message_id:   statusMsg.message_id,
      parse_mode:   "Markdown",
      reply_markup: { inline_keyboard: btns },
    }
  );
});

/* ══════════════════════════════════════════
   RÉCEPTION VIDÉO — Après /video
   ══════════════════════════════════════════ */
bot.on('video', async (msg) => {
  const chatId = String(msg.chat.id);
  if(chatId !== CONFIG.ADMIN_CHAT && chatId !== '7524388895') return;
  await handleVideoUpload(msg, msg.video.file_id, msg.video.file_name || 'video.mp4');
});

bot.on('document', async (msg) => {
  const chatId = String(msg.chat.id);
  if(chatId !== CONFIG.ADMIN_CHAT && chatId !== '7524388895') return;
  /* Accepte les documents vidéo (MOV, MP4 envoyés comme fichier) */
  const mime = msg.document?.mime_type || '';
  if(!mime.startsWith('video/')) return;
  await handleVideoUpload(msg, msg.document.file_id, msg.document.file_name || 'video.mp4');
});

async function handleVideoUpload(msg, fileId, filename){
  const chatId  = String(msg.chat.id);
  const pending = pendingVideoUpload[chatId];

  if(!pending){
    return bot.sendMessage(msg.chat.id,
      '⚠️ Envoie d\'abord `/video nom_du_produit` pour associer la vidéo.',
      { parse_mode: 'Markdown' }
    );
  }

  const uploadMsg = await bot.sendMessage(msg.chat.id,
    '⏳ Upload en cours...\n0% — Téléchargement depuis Telegram'
  );

  try{
    /* Progression */
    await bot.editMessageText(
      '⏳ Upload en cours...\n30% — Téléchargement vidéo',
      { chat_id: msg.chat.id, message_id: uploadMsg.message_id }
    );

    const videoUrl = await uploadVideoFromTelegram(fileId, filename);

    await bot.editMessageText(
      '⏳ Upload en cours...\n85% — Sauvegarde Firestore',
      { chat_id: msg.chat.id, message_id: uploadMsg.message_id }
    );

    /* Sauvegarde sur TOUS les refs sélectionnés */
    const refs = pending.allRefs || (pending.produitRef ? [pending.produitRef] : []);
    if(refs.length){
      await Promise.all(refs.map(ref => ref.update({
        videoURL:  videoUrl,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })));
    }

    delete pendingVideoUpload[chatId];

    await bot.editMessageText(
      "✅ *Vidéo uploadée !*\n\n" +
      "📦 Produit : *" + pending.produitNom + "*\n" +
      "📍 " + (pending.boutique || '') + "\n" +
      "🏪 Mis à jour dans " + refs.length + " boutique(s)\n\n" +
      "La vidéo s\'affiche maintenant dans la mini app.",
      { chat_id: msg.chat.id, message_id: uploadMsg.message_id, parse_mode: 'Markdown' }
    );

  }catch(err){
    console.error('handleVideoUpload error:', err.message);
    delete pendingVideoUpload[chatId];
    await bot.editMessageText(
      `❌ *Upload échoué*\n\n${err.message}\n\nRéessaie avec /video ${pending.produitNom}`,
      { chat_id: msg.chat.id, message_id: uploadMsg.message_id, parse_mode: 'Markdown' }
    );
  }
}

/* ══════════════════════════════════════════
   COMMANDE /videos — Liste les produits avec vidéo
   ══════════════════════════════════════════ */
bot.onText(/\/videos/, async (msg) => {
  if(String(msg.chat.id) !== CONFIG.ADMIN_CHAT) return;
  if(!db) return bot.sendMessage(msg.chat.id, '❌ Firebase non connecté');

  const boutSnap = await db.collection('boutiques').get();
  let text = '🎬 *Produits avec vidéo :*\n\n';
  let count = 0;

  for(const boutDoc of boutSnap.docs){
    const prodsSnap = await boutDoc.ref.collection('produits')
      .where('videoURL', '!=', null).get();
    prodsSnap.docs.forEach(d => {
      const p = d.data();
      if(p.videoURL){
        text += `✅ ${p.name || p.nom} (${boutDoc.id})\n`;
        count++;
      }
    });
  }

  if(!count) text += 'Aucun produit avec vidéo pour l\'instant.';
  text += `\n\n📊 Total : ${count} produit(s) avec vidéo`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

/* ══════════════════════════════════════════
   /broadcast — Envoie un message à tous les clients
   Usage: /broadcast Votre message ici
   Supporte les images: envoie une photo avec caption /broadcast texte
   ══════════════════════════════════════════ */
bot.onText(/\/broadcast(?:\s+(.+))?/s, async (msg) => {
  const chatId = String(msg.chat.id);
  if(chatId !== CONFIG.ADMIN_CHAT && chatId !== '7524388895') return;
  if(!db) return bot.sendMessage(msg.chat.id, '❌ Firebase non connecté');

  const text = (msg.text.match(/\/broadcast\s+([\s\S]+)/)?.[1] || '').trim();

  if(!text){
    return bot.sendMessage(msg.chat.id,
      '📢 *Broadcast*\n\n' +
      'Usage :\n' +
      '`/broadcast Votre message ici`\n\n' +
      'Envoie ce message à *tous tes clients* qui ont utilisé le bot.\n\n' +
      '⚠️ Utilise avec modération.',
      { parse_mode: 'Markdown' }
    );
  }

  /* Charge tous les clients */
  const snap = await db.collection('clients').get();
  if(snap.empty) return bot.sendMessage(msg.chat.id, '⚠️ Aucun client enregistré.');

  const total    = snap.size;
  const statusMsg = await bot.sendMessage(msg.chat.id,
    `📢 Envoi en cours à *${total}* clients...\n0/${total}`,
    { parse_mode: 'Markdown' }
  );

  let sent = 0, failed = 0;

  /* Bouton pour ouvrir la mini app */
  const keyboard = {
    inline_keyboard: [[{
      text: '🛒 Ouvrir la boutique',
      web_app: { url: CONFIG.MINI_APP_URL },
    }]],
  };

  for(const doc of snap.docs){
    const client = doc.data();
    const tgId   = client.telegramId || client.chatId;
    if(!tgId) { failed++; continue; }

    try{
      await bot.sendMessage(tgId,
        '🌿 *GoldenTrichomes*\n\n' + text,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
      sent++;
    }catch(e){
      /* Client a bloqué le bot ou compte supprimé */
      failed++;
      /* Supprime le client si compte introuvable */
      if(e.response?.body?.error_code === 403){
        await doc.ref.delete().catch(() => {});
      }
    }

    /* Update progression toutes les 10 */
    if((sent + failed) % 10 === 0){
      await bot.editMessageText(
        `📢 Envoi en cours...\n${sent+failed}/${total} — ✅ ${sent} envoyés, ❌ ${failed} échoués`,
        { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});
    }

    /* Délai anti-spam Telegram (30 msg/sec max) */
    await new Promise(r => setTimeout(r, 50));
  }

  /* Résumé final */
  await bot.editMessageText(
    `✅ *Broadcast terminé !*\n\n` +
    `📤 Message envoyé : "${text.slice(0,80)}${text.length>80?'...':''}"\n\n` +
    `👥 Total clients : ${total}\n` +
    `✅ Envoyés : *${sent}*\n` +
    `❌ Échoués : ${failed} (bloqués ou supprimés)`,
    { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
  ).catch(() => {});
});

/* ══════════════════════════════════════════
   /clients — Liste et stats des clients
   ══════════════════════════════════════════ */
bot.onText(/\/clients/, async (msg) => {
  const chatId = String(msg.chat.id);
  if(chatId !== CONFIG.ADMIN_CHAT && chatId !== '7524388895') return;
  if(!db) return bot.sendMessage(msg.chat.id, '❌ Firebase non connecté');

  const snap = await db.collection('clients').get();
  if(snap.empty) return bot.sendMessage(msg.chat.id, 'Aucun client enregistré.');

  /* Clients récents (7 derniers jours) */
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate()-7);
  let recent = 0;
  snap.docs.forEach(d => {
    const t = d.data().lastSeen?.toDate ? d.data().lastSeen.toDate() : null;
    if(t && t >= weekAgo) recent++;
  });

  /* Liste des 10 derniers */
  const derniers = snap.docs
    .filter(d => d.data().lastSeen)
    .sort((a,b) => {
      const ta = a.data().lastSeen?.toDate ? a.data().lastSeen.toDate() : new Date(0);
      const tb = b.data().lastSeen?.toDate ? b.data().lastSeen.toDate() : new Date(0);
      return tb - ta;
    })
    .slice(0,10)
    .map(d => {
      const c = d.data();
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Inconnu';
      const user = c.telegramUsername ? '@' + c.telegramUsername : c.telegramId || '—';
      return `  • ${name} (${user})`;
    })
    .join('\n');

  bot.sendMessage(msg.chat.id,
    `👥 *Clients GoldenTrichomes*\n\n` +
    `📊 Total : *${snap.size}*\n` +
    `📅 Actifs 7j : *${recent}*\n\n` +
    `🕐 *10 derniers connectés :*\n${derniers}\n\n` +
    `💡 Utilise /broadcast pour leur envoyer un message`,
    { parse_mode: 'Markdown' }
  );
});

/* Stock check command */
bot.onText(/\/stock/, async (msg) => {
  if (String(msg.chat.id) !== CONFIG.ADMIN_CHAT && String(msg.chat.id) !== '7524388895') return;
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
    if (!order) {
      return res.status(400).json({ error: 'Commande invalide' });
    }
    /* Normalise les champs manquants */
    order.customerName  = order.customerName || order.name || 'Client';
    order.customerPhone = order.customerPhone || order.phone || '—';
    if (!order.items || !order.items.length) {
      return res.status(400).json({ error: 'Panier vide' });
    }

    /* ── Vérification stock en grammes ── */
    const villeId = order.villeId || order.shop || null;
    if (db && order.items?.length) {
      for (const item of order.items) {
        if (!item.name) continue;
        try {
          let snap = null;
          /* 1. Cherche dans /boutiques/{villeId}/produits par nom */
          if (villeId) {
            const bSnap = await db.collection('boutiques').doc(villeId)
              .collection('produits').where('nom', '==', item.name).limit(1).get();
            if (!bSnap.empty) snap = bSnap;
          }
          /* 2. Cherche dans /boutiques/{villeId}/produits par name */
          if ((!snap || snap.empty) && villeId) {
            const bSnap2 = await db.collection('boutiques').doc(villeId)
              .collection('produits').where('name', '==', item.name).limit(1).get();
            if (!bSnap2.empty) snap = bSnap2;
          }
          /* 3. Fallback: /products global */
          if (!snap || snap.empty) {
            const gSnap = await db.collection('products')
              .where('name', '==', item.name).limit(1).get();
            if (!gSnap.empty) snap = gSnap;
          }
          /* Vérifie le stock seulement si produit trouvé */
          if (snap && !snap.empty) {
            const prod    = snap.docs[0].data();
            const demande = (item.weight || item.w || 0) * (item.qty || 1);
            if (prod.stockGrams != null && prod.stockGrams < demande) {
              return res.status(400).json({
                error: `Stock insuffisant pour ${item.name}. Disponible : ${prod.stockGrams}g`,
                stockError: true,
                product: item.name,
                available: prod.stockGrams,
              });
            }
          }
          /* Si produit non trouvé → on laisse passer (pas de blocage) */
        } catch(se) {
          console.error('Stock check error:', se.message);
          /* En cas d'erreur → on laisse passer */
        }
      }
    }

    /* ── Génère le code ── */
    order.code      = order.code || ('GT-' + Math.floor(1000 + Math.random() * 9000));
    order.status    = 'new';
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
          const applyDecrement = async (snap) => {
            if (snap && !snap.empty) {
              const prod = snap.docs[0].data();
              if (prod.stockGrams != null) {
                const newStock = Math.max(0, prod.stockGrams - demande);
                await snap.docs[0].ref.update({
                  stockGrams: newStock,
                  stock: newStock === 0 ? 'out' : newStock < 10 ? 'low' : 'available',
                });
              }
            }
          };
          /* Cherche dans boutique spécifique */
          if (villeId) {
            const bSnap = await db.collection('boutiques').doc(villeId)
              .collection('produits').where('nom', '==', item.name).limit(1).get();
            await applyDecrement(bSnap);
            if (bSnap.empty) {
              const bSnap2 = await db.collection('boutiques').doc(villeId)
                .collection('produits').where('name', '==', item.name).limit(1).get();
              await applyDecrement(bSnap2);
            }
          }
          /* Aussi dans /products global */
          const gSnap = await db.collection('products')
            .where('name', '==', item.name).limit(1).get();
          await applyDecrement(gSnap);
        } catch(se) { console.error('Stock decrement error:', se.message); }
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
