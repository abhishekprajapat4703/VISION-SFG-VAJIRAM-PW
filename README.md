# 🚀 VISION + SFG + VAJIRAM + PW Bot

Unified Telegram bot for UPSC PDF conversion. Converts PDF test papers and solution booklets into perfectly formatted `.txt` files.

## ✨ Features

| Converter | Questions | Input PDFs |
|-----------|-----------|------------|
| ⚡ ForumIAS SFG | 50 Q | 1 Solutions PDF |
| ⚙️ Vajiram & Ravi | 100 Q | Test PDF + Solution PDF |
| 🔮 VisionIAS | 100 Q | Test PDF + Solution PDF |
| 🔥 PW Only IAS | 100 Q | Test PDF + Solution PDF |
| 🔧 TXT File Fixer | — | Any .txt file |

**Output format:**
```
Q1.Question text here
1. Statement one
2. Statement two
Which of the above are correct?
😂
Option A ✅
Option B
Option C
Option D
Ex: Explanation text here...

Q2.Next question...
```

---

## 🛠️ Setup

### 1. Create Bot Token
1. Open Telegram, message **@BotFather**
2. Send `/newbot` → follow prompts
3. Copy your **Bot Token**

### 2. Clone & Install
```bash
git clone https://github.com/YOUR_USERNAME/VISION-SFG-VAJIRAM-PW.git
cd "VISION + SFG + VAJIRAM + PW"
npm install
```

### 3. Configure Environment
```bash
cp .env.example .env
# Edit .env and set BOT_TOKEN=your_token_here
```

---

## 🚀 Deploy on Vercel

### Step 1: Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/VISION-SFG-VAJIRAM-PW.git
git push -u origin main
```

### Step 2: Deploy on Vercel
1. Go to [vercel.com](https://vercel.com) → **New Project**
2. Import your GitHub repo
3. Add Environment Variable: `BOT_TOKEN` = your token
4. Click **Deploy**
5. Copy your Vercel URL (e.g. `https://your-app.vercel.app`)

### Step 3: Set Webhook
```bash
node scripts/setWebhook.js https://your-app.vercel.app
```

---

## 💻 Local Testing (Polling Mode)

For local testing without Vercel (no ngrok needed):
```bash
# Create .env with your BOT_TOKEN first
node start.js
```

This uses Telegram long-polling instead of webhooks.

---

## 📁 Project Structure

```
VISION + SFG + VAJIRAM + PW/
├── api/
│   └── webhook.js          # Vercel serverless function entry
├── lib/
│   ├── bot.js              # Main bot logic + session management
│   ├── fixer.js            # TXT File Fixer
│   └── parsers/
│       ├── sfg.js          # ForumIAS SFG 50Q parser
│       ├── vajiram.js      # Vajiram & Ravi 100Q parser
│       ├── vision.js       # VisionIAS 100Q parser
│       └── pw.js           # PW Only IAS parser
├── scripts/
│   ├── setWebhook.js       # Set Telegram webhook
│   └── deleteWebhook.js    # Delete webhook (for polling)
├── start.js                # Polling mode entry point
├── .env.example            # Environment template
├── vercel.json             # Vercel config (60s timeout)
└── package.json
```

---

## 🤖 Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Show main menu |
| `/sfg` | ForumIAS SFG mode |
| `/vajiram` | Vajiram & Ravi mode |
| `/vision` | VisionIAS mode |
| `/pw` | PW Only IAS mode |
| `/fixer` | TXT File Fixer mode |
| `/cancel` | Cancel current operation |
| `/help` | Show help |

---

## ⚠️ Notes

- PDFs must be **text-based** (not scanned images)
- Maximum file size: **20MB** (Telegram limit)
- Processing takes **20–50 seconds** for large PDFs
- Vercel Hobby plan has **10-second timeout** — use Pro plan (60s) or polling mode for large files

---

## 📄 License

MIT
