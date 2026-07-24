import os, json, time, logging
import urllib.request, urllib.parse

# ── CONFIG ──
BOT_TOKEN   = "8689166931:AAFweXM9nYW9YoY6-W0INnNURCCXpJ7bMjU"
MINIAPP_URL = "https://goldentrichomes.netlify.app"        # ← ton URL Mini App
ADMIN_URL   = "https://inquisitive-lokum-bfa632.netlify.app"
GROUP_ID    = "-5383453640"

# IDs admin autorisés — ajoute autant que tu veux
ADMIN_IDS   = [7524388895, 7670750855]

API = f"https://api.telegram.org/bot{BOT_TOKEN}"
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger(__name__)

# ──────────────────────────────────────
# UTILS API
# ──────────────────────────────────────
def api_call(method, data=None, params=None):
    if params:
        url = f"{API}/{method}?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url)
    else:
        url = f"{API}/{method}"
        body = json.dumps(data or {}).encode()
        req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        log.error(f"API {method} error: {e}")
        return {}

def send_msg(chat_id, text, keyboard=None, parse_mode="Markdown"):
    data = {"chat_id": chat_id, "text": text, "parse_mode": parse_mode}
    if keyboard:
        data["reply_markup"] = json.dumps(keyboard)
    return api_call("sendMessage", data)

def edit_msg(chat_id, message_id, text, keyboard=None):
    data = {"chat_id": chat_id, "message_id": message_id,
            "text": text, "parse_mode": "Markdown"}
    if keyboard:
        data["reply_markup"] = json.dumps(keyboard)
    return api_call("editMessageText", data)

def answer_callback(callback_id, text=""):
    api_call("answerCallbackQuery", {"callback_query_id": callback_id, "text": text})

# ──────────────────────────────────────
# KEYBOARDS
# ──────────────────────────────────────
def kb_webapp(label, url):
    return {"inline_keyboard": [[{"text": label, "web_app": {"url": url}}]]}

def kb_order_actions(order_code):
    return {"inline_keyboard": [
        [
            {"text": "✅ Confirmer",  "callback_data": f"confirm:{order_code}"},
            {"text": "🚀 En livraison","callback_data": f"delivering:{order_code}"},
        ],
        [
            {"text": "✔️ Livré",     "callback_data": f"done:{order_code}"},
            {"text": "❌ Annuler",   "callback_data": f"cancel:{order_code}"},
        ]
    ]}

def kb_order_status(status):
    """Clavier simple après action"""
    labels = {
        "confirmed":   "✅ Confirmé",
        "delivering":  "🚀 En livraison",
        "done":        "✔️ Livré",
        "cancelled":   "❌ Annulé",
    }
    return {"inline_keyboard": [[{"text": labels.get(status, status), "callback_data": "noop"}]]}

# ──────────────────────────────────────
# COMMANDES
# ──────────────────────────────────────
def handle_command(chat_id, uid, name, text):

    if text.startswith("/start"):
        send_msg(chat_id,
            f"Salam {name} 👋\n\n"
            f"Bienvenue chez *GoldenTrichomes* 🌿\n\n"
            f"✨ Drysift · Frozen · Static · Ice O'Lator\n"
            f"🏔️ Beldia · Weed · HerbVape\n\n"
            f"Qualité marocaine · Tout le Maroc 🇲🇦\n\n"
            f"👇 Clique pour commander :",
            kb_webapp("🌿 Ouvrir la boutique", MINIAPP_URL)
        )

    elif text.startswith("/menu"):
        send_msg(chat_id,
            "🌿 *GoldenTrichomes — Catalogue*\n\nOuvre la boutique :",
            kb_webapp("🛒 Voir le catalogue", MINIAPP_URL)
        )

    elif text.startswith("/admin"):
        if uid not in ADMIN_IDS:
            send_msg(chat_id, "⛔ Accès refusé.")
            return
        send_msg(chat_id,
            f"👑 *Panel Admin — GoldenTrichomes*\n\n"
            f"Bienvenue {name} !\n\n"
            f"Gère tes produits, commandes, boutiques et paramètres :",
            kb_webapp("⚙️ Ouvrir le Panel Admin", ADMIN_URL)
        )

    elif text.startswith("/commandes"):
        if uid not in ADMIN_IDS:
            send_msg(chat_id, "⛔ Accès refusé.")
            return
        send_msg(chat_id,
            "📦 *Commandes en cours*\n\nOuvre le panel pour gérer toutes les commandes :",
            kb_webapp("📦 Voir les commandes", ADMIN_URL)
        )

    elif text.startswith("/help"):
        extra = ""
        if uid in ADMIN_IDS:
            extra = "\n\n*Admin :*\n/admin — Panel admin\n/commandes — Commandes en cours"
        send_msg(chat_id,
            f"🌿 *GoldenTrichomes — Aide*\n\n"
            f"/start — Ouvrir la boutique\n"
            f"/menu — Voir le catalogue\n"
            f"/help — Aide"
            f"{extra}"
        )

    else:
        send_msg(chat_id,
            "👇 Clique pour accéder à la boutique :",
            kb_webapp("🌿 Ouvrir la boutique", MINIAPP_URL)
        )

# ──────────────────────────────────────
# CALLBACKS (boutons sur les commandes)
# ──────────────────────────────────────
STATUS_LABELS = {
    "confirm":    ("confirmed",  "✅ Confirmée"),
    "delivering": ("delivering", "🚀 En livraison"),
    "done":       ("done",       "✔️ Livrée"),
    "cancel":     ("cancelled",  "❌ Annulée"),
}

def handle_callback(callback):
    uid         = callback["from"]["id"]
    cb_id       = callback["id"]
    data        = callback.get("data", "")
    chat_id     = callback["message"]["chat"]["id"]
    message_id  = callback["message"]["message_id"]
    orig_text   = callback["message"].get("text", "")

    if data == "noop":
        answer_callback(cb_id)
        return

    if uid not in ADMIN_IDS:
        answer_callback(cb_id, "⛔ Accès refusé")
        return

    parts = data.split(":", 1)
    if len(parts) != 2:
        answer_callback(cb_id)
        return

    action, order_code = parts
    if action not in STATUS_LABELS:
        answer_callback(cb_id)
        return

    new_status, status_label = STATUS_LABELS[action]

    # Met à jour le message dans le groupe avec le nouveau statut
    new_text = orig_text + f"\n\n*Statut mis à jour :* {status_label}"
    edit_msg(chat_id, message_id, new_text, kb_order_status(new_status))
    answer_callback(cb_id, f"{status_label} !")

    # Notifie le groupe
    send_msg(GROUP_ID,
        f"🔄 *Commande {order_code}* — {status_label}\n"
        f"Mis à jour par @{callback['from'].get('username','admin')}"
    )

    log.info(f"Order {order_code} → {new_status}")

# ──────────────────────────────────────
# NOUVELLE COMMANDE — appelée depuis Mini App via Firebase
# Cette fonction envoie la notification dans le groupe avec les boutons
# ──────────────────────────────────────
def notify_new_order(order):
    """
    Appelée quand une nouvelle commande arrive.
    'order' est un dict avec les infos de la commande.
    """
    code         = order.get("code", "GT-????")
    name         = order.get("customerName", "—")
    phone        = order.get("customerPhone", "—")
    tg_user      = order.get("telegramUser", "")
    delivery     = order.get("delivery", "pickup")
    shop         = order.get("shop", "—")
    slot         = order.get("slot", "—")
    address      = order.get("address", "")
    payment      = order.get("payment", "cash")
    final_mad    = order.get("finalMAD", 0)
    items        = order.get("items", [])

    deliv_label  = "🛵 Livraison à domicile" if delivery == "delivery" else "🏪 Click & Collect"
    pay_label    = "₿ Crypto" if payment == "crypto" else "💵 Cash"

    items_text = "\n".join([
        f"  • {i.get('name','?')} — {i.get('weight','?')}g × {i.get('qty',1)} = *{i.get('priceMAD',0):,} MAD*"
        for i in items
    ])

    shop_line = f"\n🏪 *Boutique :* {shop}\n⏰ *Créneau :* {slot}" if delivery == "pickup" else ""
    addr_line = f"\n📍 *Adresse :* {address}" if address else ""
    tg_line   = f"\n✈️ *Telegram :* @{tg_user}" if tg_user else ""

    msg = (
        f"🔔 *NOUVELLE COMMANDE — {code}*\n\n"
        f"👤 *Client :* {name}\n"
        f"📞 *Tél :* {phone}"
        f"{tg_line}\n\n"
        f"*{deliv_label}*{shop_line}{addr_line}\n"
        f"💳 *Paiement :* {pay_label}\n\n"
        f"🛒 *Articles :*\n{items_text}\n\n"
        f"💰 *TOTAL : {final_mad:,} MAD*"
    )

    result = send_msg(GROUP_ID, msg, kb_order_actions(code))
    log.info(f"New order notified: {code} → {result.get('ok')}")
    return result

# ──────────────────────────────────────
# POLLING LOOP
# ──────────────────────────────────────
def get_updates(offset=None):
    params = {"timeout": 30, "allowed_updates": json.dumps(["message", "callback_query"])}
    if offset:
        params["offset"] = offset
    url = f"{API}/getUpdates?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=35) as r:
            return json.loads(r.read()).get("result", [])
    except Exception as e:
        log.error(f"getUpdates error: {e}")
        time.sleep(3)
        return []

def process_update(update):
    # Callback query (boutons commande)
    if "callback_query" in update:
        handle_callback(update["callback_query"])
        return

    # Message texte
    msg = update.get("message") or update.get("edited_message")
    if not msg:
        return

    chat_id = msg["chat"]["id"]
    user    = msg.get("from", {})
    name    = user.get("first_name", "ami")
    uid     = user.get("id", 0)
    text    = msg.get("text", "")

    if text:
        handle_command(chat_id, uid, name, text)

def main():
    log.info("✅ GoldenTrichomes Bot démarré — Python natif, zéro dépendance")
    log.info(f"🔑 Admins: {ADMIN_IDS}")
    log.info(f"📱 Mini App: {MINIAPP_URL}")
    log.info(f"⚙️  Panel Admin: {ADMIN_URL}")

    offset = None
    while True:
        updates = get_updates(offset)
        for u in updates:
            offset = u["update_id"] + 1
            try:
                process_update(u)
            except Exception as e:
                log.error(f"Process error: {e}")

if __name__ == "__main__":
    main()
