import os
import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo, MenuButtonWebApp
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes, MessageHandler, filters

# ── CONFIG ──
BOT_TOKEN   = "8689166931:AAFweXM9nYW9YoY6-W0INnNURCCXpJ7bMjU"
MINIAPP_URL = "https://melodic-baklava-cd5a09.netlify.app/"
ADMIN_IDS   = [7524388895]  # ← ton Telegram ID (tu peux en ajouter d'autres)
ADMIN_URL   = "inquisitive-lokum-bfa632.netlify.app"
logging.basicConfig(level=logging.INFO)

# ── /start ──
async def start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    name = user.first_name or "ami"

    keyboard = InlineKeyboardMarkup([[
        InlineKeyboardButton(
            "🌿 Ouvrir la boutique",
            web_app=WebAppInfo(url=MINIAPP_URL)
        )
    ]])

    await update.message.reply_text(
        f"Salam {name} 👋\n\n"
        f"Bienvenue chez *GoldenTrichomes* 🌿\n\n"
        f"✨ Drysift · Frozen · Static · Ice O'Lator\n"
        f"🏔️ Beldia · Accessoires\n\n"
        f"Qualité marocaine, livraison Partout au Maroc MA\n\n"
        f"👇 Clique pour commander :",
        parse_mode="Markdown",
        reply_markup=keyboard
    )

# ── /menu ──
async def menu(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    keyboard = InlineKeyboardMarkup([[
        InlineKeyboardButton(
            "🛒 Voir le catalogue",
            web_app=WebAppInfo(url=MINIAPP_URL)
        )
    ]])
    await update.message.reply_text(
        "🌿 *GoldenTrichomes — Catalogue*\n\nOuvre la boutique pour voir tous nos produits et passer commande :",
        parse_mode="Markdown",
        reply_markup=keyboard
    )

# ── /admin ──
async def admin(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if user.id not in ADMIN_IDS:
        await update.message.reply_text("⛔ Accès refusé.")
        return

    keyboard = InlineKeyboardMarkup([[
        InlineKeyboardButton(
            "⚙️ Panel Admin",
            web_app=WebAppInfo(url=ADMIN_URL)
        )
    ]])
    await update.message.reply_text(
        f"👑 *Panel Admin GoldenTrichomes*\n\nBienvenue {user.first_name} !",
        parse_mode="Markdown",
        reply_markup=keyboard
    )

# ── /help ──
async def help_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "🌿 *GoldenTrichomes — Aide*\n\n"
        "/start — Ouvrir la boutique\n"
        "/menu — Voir le catalogue\n"
        "/help — Aide\n\n"
        "Pour toute question contacte-nous directement.",
        parse_mode="Markdown"
    )

# ── Message texte → redirige vers la Mini App ──
async def handle_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    keyboard = InlineKeyboardMarkup([[
        InlineKeyboardButton("🌿 Ouvrir la boutique", web_app=WebAppInfo(url=MINIAPP_URL))
    ]])
    await update.message.reply_text(
        "👇 Utilise le bouton pour accéder à la boutique :",
        reply_markup=keyboard
    )

# ── MAIN ──
if __name__ == "__main__":
    app = ApplicationBuilder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("menu",  menu))
    app.add_handler(CommandHandler("admin", admin))
    app.add_handler(CommandHandler("help",  help_cmd))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    print("✅ Bot GoldenTrichomes démarré...")
    app.run_polling()
