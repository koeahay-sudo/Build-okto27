require('dotenv').config();
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { CallbackQuery } = require('telegram/events/CallbackQuery');
const { Button } = require('telegram/tl/custom/button');
const { CustomFile } = require('telegram/client/uploads');
const fs   = require('fs-extra');
const path = require('path');
const https = require('https');
const http  = require('http');

const CONFIG      = require('./config');
const db          = require('./database');
const github      = require('./github');
const githubStore = require('./github-store');
const queue       = require('./queue');
const buildModule = require('./build-module');
const aivision    = require('./aivision');
const web2apkMod  = require('./web2apk-module');
const deployMod   = require('./deploy-vercel-module');
const fluttermod  = require('./fluttermod');

// ── Session ──
const SESSION_FILE = './session.txt';
const sessionString = fs.existsSync(SESSION_FILE)
  ? fs.readFileSync(SESSION_FILE, 'utf8').trim() : '';

const client = new TelegramClient(
  new StringSession(sessionString),
  CONFIG.API_ID,
  CONFIG.API_HASH,
  { connectionRetries: 10, autoReconnect: true }
);

// ── Foto Monitor ──
const MON_PHOTO_URL = 'https://files.catbox.moe/chilsv.png';

// ── State ──
const userStates = new Map();
const renameBaseStates = new Map();
const checkBaseStates  = new Map();
const rombaWarnaStates = new Map();
const modStates = new Map(); // for ganti domain/warna/icon/nama

// ── Helpers ──
function escapeMd(text) {
  if (!text) return '';
  return String(text).replace(/([`*_\[])/g, '\\$1');
}

function toSansBold(str) {
  return str.replace(/[A-Za-z0-9]/g, ch => {
    const c = ch.codePointAt(0);
    if (c >= 65 && c <= 90) return String.fromCodePoint(0x1d5d4 + (c - 65));
    if (c >= 97 && c <= 122) return String.fromCodePoint(0x1d5ee + (c - 97));
    if (c >= 48 && c <= 57) return String.fromCodePoint(0x1d7ec + (c - 48));
    return ch;
  });
}

function toBoldCaps(text) {
  if (!text) return text;
  const UPPER_BASE = 0x1d5d4;
  const DIGIT_BASE = 0x1d7ec;
  let out = '';
  for (const ch of text.toUpperCase()) {
    const c = ch.codePointAt(0);
    if (c >= 65 && c <= 90) out += String.fromCodePoint(UPPER_BASE + (c - 65));
    else if (c >= 48 && c <= 57) out += String.fromCodePoint(DIGIT_BASE + (c - 48));
    else out += ch;
  }
  return out;
}

// ══════════════════════════════════════════════════════
// 🎨 BUTTON BUILDER — PRIMARY | SUCCESS | DANGER
// ══════════════════════════════════════════════════════
//
// style: 'primary' → 🔵  | 'success' → 🟢  | 'danger' → 🔴
// url buttons → pakai Button.url()
// callback buttons → pakai Button.inline()
//
const STYLE_PREFIX = {
  primary: '',
  success: '',
  danger:  '',
  default: '',
};

function buildButtons(rows) {
  return rows.map(row =>
    row.map(btn => {
      const label = btn.text;
      if (btn.url) return Button.url(label, btn.url);
      const cbData = btn.callback_data ?? btn.data;
      return Button.inline(label, Buffer.from(cbData));
    })
  );
}



// ── Send / Edit ──
function buildQuotedMessage(blocks) {
  let message = '';
  const entities = [];
  blocks.forEach((b, i) => {
    if (i > 0) message += '\n\n';
    const start = message.length;
    message += b.text;
    if (b.pre)   entities.push(new Api.MessageEntityPre({ offset: start, length: b.text.length, language: '' }));
    else if (b.quote) entities.push(new Api.MessageEntityBlockquote({ offset: start, length: b.text.length, collapsed: false }));
  });
  return { message, entities };
}

async function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, res => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout')));
  });
}

async function resolveMediaFile(pathOrUrl) {
  if (!pathOrUrl) return null;
  try {
    if (/^https?:\/\//i.test(pathOrUrl)) {
      const buf = await fetchBuffer(pathOrUrl);
      const ext = path.extname(new URL(pathOrUrl).pathname) || '.jpg';
      return new CustomFile(`media${ext}`, buf.length, '', buf);
    }
    if (fs.existsSync(pathOrUrl)) return pathOrUrl;
  } catch (e) { console.error('resolveMediaFile:', e.message); }
  return null;
}

async function send(chatId, text, buttonDefs = null, deleteMsgId = null, entities = null) {
  if (deleteMsgId) {
    try { await client.deleteMessages(chatId, [deleteMsgId], { revoke: true }); } catch (_) {}
  }
  const buttons = buttonDefs ? buildButtons(buttonDefs) : undefined;
  return client.sendMessage(chatId, {
    message: text,
    ...(entities ? { formattingEntities: entities } : { parseMode: 'md' }),
    ...(buttons ? { buttons } : {}),
  });
}

async function edit(chatId, msgId, text, buttonDefs = null, entities = null) {
  if (!msgId) return null;
  try {
    const buttons = buttonDefs ? buildButtons(buttonDefs) : undefined;
    await client.editMessage(chatId, {
      message: msgId, text,
      ...(entities ? { formattingEntities: entities } : { parseMode: 'md' }),
      ...(buttons ? { buttons } : {}),
    });
    return msgId;
  } catch (_) { return null; }
}

async function sendChannelCard(target, blocks, { file = null, buttons = null } = {}) {
  const { message, entities } = buildQuotedMessage(blocks);
  const kb = buttons ? buildButtons(buttons) : undefined;
  if (file) return client.sendFile(target, { file, caption: message, formattingEntities: entities, buttons: kb });
  return client.sendMessage(target, { message, formattingEntities: entities, buttons: kb });
}

async function editChannelCard(target, messageId, blocks, { buttons = null } = {}) {
  const { message, entities } = buildQuotedMessage(blocks);
  const kb = buttons ? buildButtons(buttons) : undefined;
  return client.editMessage(target, { message: messageId, text: message, formattingEntities: entities, buttons: kb });
}

function tmpPath(name) { return path.join(CONFIG.TMP_DIR, name); }
function genTag(userId) { return `build-${userId}-${Date.now()}`; }
function formatDuration(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}j`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}d`);
  return parts.join(' ');
}

async function getUserDisplay(userId) {
  try {
    const entity = await client.getEntity(userId);
    const name = [entity?.firstName, entity?.lastName].filter(Boolean).join(' ');
    if (name) return name;
    if (entity?.username) return `@${entity.username}`;
  } catch (_) {}
  return `User_${userId}`;
}

async function isJoinedChannel(userId) {
  const channels = [CONFIG.CHANNEL_USERNAME, CONFIG.CHANNEL_USERNAME2].filter(Boolean);
  for (const ch of channels) {
    try {
      const channel = await client.getEntity(ch);
      const res = await client.invoke(new Api.channels.GetParticipant({ channel, participant: userId }));
      if (!res?.participant) return false;
      const type = res.participant.className;
      if (type === 'ChannelParticipantLeft' || type === 'ChannelParticipantBanned') return false;
    } catch (err) {
      if (err.message?.includes('USER_NOT_PARTICIPANT') ||
        err.message?.includes('PARTICIPANT_ID_INVALID')) return false;
    }
  }
  return true;
}

// ── Init semua module ──
const deps = {
  client, CONFIG, db,
  getUserJob:    queue.getUserJob,
  setUserJob:    queue.setUserJob,
  removeUserJob: queue.removeUserJob,
  isUserBuilding: queue.isUserBuilding,
  queue,
  send, edit, escapeMd, buildButtons,
  formatDuration, elapsedSec: t => Math.floor((Date.now() - t) / 1000),
  tmpPath, genTag,
  githubStore, ...github,
  sleep: github.sleep,
  resolveMediaFile, toSansBold,
  sendChannelCard, editChannelCard, buildQuotedMessage,
  getUserDisplay,
  buildModule,
};

buildModule.init(deps);
web2apkMod.init(deps);
deployMod.init(deps);

// ══════════════════════════════════════════════════════
// 🏠 MAIN MENU
// ══════════════════════════════════════════════════════
async function handleStart(event, deleteMsgId = null) {
  const chatId  = event.chatId;
  const sender  = await event.message.getSender();
  const userId  = Number(sender?.id);
  const username = sender?.username ? `@${sender.username}` : '-';
  const name    = sender?.firstName || 'User';

  // Maintenance
  if (db.getMaintenance() && !db.isOwner(userId)) {
    const reason = db.getMaintenanceReason() || '-';
    const sinceRaw = db.getMaintenanceSince();
    const since = sinceRaw
      ? new Date(sinceRaw).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
      : '-';
    return send(chatId,
      `🔧 **BOT SEDANG MAINTENANCE**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚙️ BOT SEDANG DALAM PEMBARUAN ATAU PENINGKATAN SYSTEM🔥\n\n` +
      `📝 Alasan   : ${reason}\n` +
      `🕐 Sejak    : ${since}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ KAMI SEDANG MELALUKAN PENINGKATAN SYSTEM/PEMBARUAN SYSTEM‼️`,
      [[{ text: "❌ Tutup", callback_data: "noop", style: "danger" }]]
    );
  }

  // Gate join channel
  const joined = await isJoinedChannel(userId);
  if (!joined) {
    const btns = [];
    if (CONFIG.CHANNEL_USERNAME)
      btns.push({ text: `📢 Join ${CONFIG.CHANNEL_USERNAME}`, url: `https://t.me/${CONFIG.CHANNEL_USERNAME.replace('@', '')}` });
    if (CONFIG.CHANNEL_USERNAME2)
      btns.push({ text: `📢 Join ${CONFIG.CHANNEL_USERNAME2}`, url: `https://t.me/${CONFIG.CHANNEL_USERNAME2.replace('@', '')}` });
    const joinBtnRows = [
      ...(btns.length ? [btns] : []),
      [{ text: "✅ Sudah Join", callback_data: "check_join" }],
    ];
    try {
      if (deleteMsgId) { try { await client.deleteMessages(chatId, [deleteMsgId], { revoke: true }); } catch (_) {} }
      const joinPhoto = await resolveMediaFile(MON_PHOTO_URL);
      const joinCaption =
        `🔒 <b>Akses Terbatas!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Kamu harus <b>join channel</b> kami terlebih dahulu.\n\n` +
        `📢 Setelah join, klik tombol <b>✅ Sudah Join</b> di bawah.`;
      if (joinPhoto) {
        return await client.sendFile(chatId, {
          file: joinPhoto, caption: joinCaption, parseMode: 'html',
          buttons: buildButtons(joinBtnRows),
        });
      }
    } catch (_) {}
    return send(chatId,
      `🔒 **Akses Terbatas!**\n━━━━━━━━━━━━━━━━━━━━━━\n\nKamu harus **join channel** kami terlebih dahulu.\n\n📢 Setelah join, klik tombol **✅ Sudah Join** di bawah.`,
      joinBtnRows, deleteMsgId
    );
  }

  // Register
  const isNew  = db.upsertUser({ userId, name, username });
  if (isNew) {
    const dt    = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const count = db.getUserCount();
    const joinCaption =
      `🔔 <b>USER BARU TERDAFTAR</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 Nama     : ${name}\n` +
      `🆔 ID       : <code>${userId}</code>\n` +
      `📛 Username : ${username}\n` +
      `⏰ Waktu    : ${dt} WIB\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 Total    : <b>${count}</b> user terdaftar`;
    try {
      await sendMonitorPhoto(CONFIG.CHANNEL_USERNAME, joinCaption);
    } catch (e) { console.error('New user log error:', e.message); }
    // Auto backup ke GitHub saat user baru join
    github.backupToGithub(CONFIG.dataFile, null).catch(() => {});
  }

  const role   = db.getRole(userId);
  const credit = db.getCredit(userId);
  const isPriv = db.isPrivileged(userId);

  const { message: caption, entities: captionEntities } = buildQuotedMessage([
    { text: `👋 Halo ${name}☇\n✨ Selamat Datang Di Bot Web2Apps! 👋😎`, quote: true },
    {
      text:
        `🤖 Bot Build APK Flutter\n` +
        `Kirim project Flutter dalam bentuk .zip, atau ubah website menjadi APK.\n\n` +
        `✅ Format  : .zip\n` +
        `✅ Wajib   : pubspec.yaml / gradlew\n` +
        `✅ Maks    : 1990 MB`,
      quote: true,
    },
    {
      text:
        `💎 Credit  : ${isPriv ? '∞' : credit}\n` +
        `🏷️ Role    : ${role.toUpperCase()}\n` +
        `🔖 Version : v${CONFIG.BOT_VERSION}`,
      quote: true,
    },
  ]);

  // ── MAIN BUTTONS ──
  const buttonDefs = [
    [
      { text: "🔨 Build APK", callback_data: "build" },
      { text: "🌐 Web→APK", callback_data: "menu_web2apk" },
    ],
    [
      { text: "👾 Copy Base", callback_data: "design_to_code" },
      { text: "🚀 Deploy Vercel", callback_data: "menu_deploy_vercel" },
    ],
  ];

  if (db.isOwner(userId)) {
    buttonDefs.push([{ text: "👑 Owner Panel", callback_data: "owner_panel" }]);
  } else if (db.isAdmin(userId)) {
    buttonDefs.push([{ text: "🛡 Admin Panel", callback_data: "admin_panel" }]);
  } else if (db.isReseller(userId)) {
    buttonDefs.push([{ text: "🤝 Reseller Panel", callback_data: "reseller_panel" }]);
  }

  const linkRow = [{ text: "📢 Info", url: CONFIG.INFO_CHANNEL_LINK }];
  if (db.isOwner(userId)) linkRow.push({ text: "👤 Owner", url: CONFIG.OWNER_LINK });
  buttonDefs.push(linkRow);

  buttonDefs.push([
    { text: "🔨 Rename", callback_data: "rename_base" },
    { text: "🔍 Check Base", callback_data: "check_base" },
  ]);
  buttonDefs.push([
    { text: "🎨 Rombak Warna", callback_data: "rombak_warna" },
    { text: "⚠️ Lapor Bug", callback_data: "user_start_lapor" },
  ]);
  buttonDefs.push([
    { text: "🔧 Ganti Domain", callback_data: "mod_domain_start" },
    { text: "🎨 Ganti Warna", callback_data: "mod_color_start" },
  ]);
  buttonDefs.push([
    { text: "🖼️ Ganti Icon", callback_data: "mod_icon_start" },
    { text: "✏️ Ganti Nama", callback_data: "mod_name_start" },
  ]);

  if (db.isOwner(userId)) {
    buttonDefs.push([
      { text: "🔧 Maintenance", callback_data: "maintenance_menu" },
      { text: "📣 Broadcast", callback_data: "broadcast_menu" },
    ]);
  }

  try {
    if (deleteMsgId) {
      try { await client.deleteMessages(chatId, [deleteMsgId], { revoke: true }); } catch (_) {}
    }
    const photo = await resolveMediaFile(CONFIG.WELCOME_PHOTO);
    if (photo) {
      await client.sendFile(chatId, {
        file: photo, caption, formattingEntities: captionEntities,
        buttons: buildButtons(buttonDefs),
      });
    } else {
      await client.sendMessage(chatId, {
        message: caption, formattingEntities: captionEntities,
        buttons: buildButtons(buttonDefs),
      });
    }
  } catch (err) {
    console.error('handleStart error:', err.message);
  }
}

// ══════════════════════════════════════════════════════
// 📩 CALLBACK HANDLER
// ══════════════════════════════════════════════════════
async function handleCallback(event) {
  const data   = event.data.toString();
  const chatId = event.chatId;
  const userId = Number(event.senderId);
  const msgId  = event.messageId;

  await event.answer();

  // Maintenance guard
  if (db.getMaintenance() && !db.isOwner(userId) && data !== 'check_join') {
    const reason = db.getMaintenanceReason() || '-';
    const sinceRaw = db.getMaintenanceSince();
    const since = sinceRaw
      ? new Date(sinceRaw).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
      : '-';
    return send(chatId,
      `🔧 **BOT SEDANG MAINTENANCE**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚙️ BOT SEDANG DALAM PEMBARUAN ATAU PENINGKATAN SYSTEM🔥\n\n` +
      `📝 Alasan   : ${reason}\n` +
      `🕐 Sejak    : ${since}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ SILAHKAN KAMU SABARAN SEDIKIT YA!! KAMI SEDANG MELALUKAN PENINGKATAN SYSTEM/PEMBARUAN SYSTEM‼️`
    );
  }

  // ── Check Join ──
  if (data === 'check_join') {
    const joined = await isJoinedChannel(userId);
    if (!joined) return event.answer({ message: '❌ Kamu belum join semua channel!', alert: true });
    return handleStart({
      chatId,
      message: {
        getSender: async () => {
          try {
            const e = await client.getEntity(userId);
            return { id: userId, firstName: e?.firstName || 'User', username: e?.username || null };
          } catch { return { id: userId, firstName: 'User' }; }
        },
      },
    }, msgId);
  }

  // ── Noop ──
  if (data === 'noop') return;

  // ── Start / Back ──
  if (data === 'start') {
    return handleStart({
      chatId,
      message: {
        getSender: async () => {
          try {
            const e = await client.getEntity(userId);
            return { id: userId, firstName: e?.firstName || 'User', username: e?.username || null };
          } catch { return { id: userId, firstName: 'User' }; }
        },
      },
    }, msgId);
  }

  // ── Build ──
  if (data === 'build')         return buildModule.handleBuild(chatId, userId, null, msgId);
  if (data === 'build_debug')   return buildModule.handleBuild(chatId, userId, 'debug', msgId);
  if (data === 'build_release') return buildModule.handleBuild(chatId, userId, 'release', msgId);

  // ── Pilih Server Build ──
  if (data.startsWith('bsrv_build_')) {
    const serverId = data.replace('bsrv_build_', '');
    const job      = queue.getUserJob(userId);
    if (!job || job.status !== 'waiting_server_build') {
      return event.answer({ message: '⚠️ Sesi kadaluarsa.', alert: true });
    }
    const server = githubStore.getById(serverId);
    if (!server) return event.answer({ message: '❌ Server tidak ditemukan.', alert: true });
    queue.setUserJob(userId, {
      ...job, status: 'waiting_zip',
      creds: { token: server.token, repo: server.repo },
      serverName: server.name, updatedAt: Date.now(),
    });
    return send(chatId,
      `📦 **Build dari ZIP**\n━━━━━━━━━━━━━━━━━━\n` +
      `🖥️ **Server:** ${escapeMd(server.name)}\n\n` +
      `Silakan kirim file **.zip** project Flutter/Android Anda.`,
      [[{ text: "❌ Batalkan", callback_data: "cancel", style: "danger" }]], msgId
    );
  }

  // ── Cancel ──
  if (data === 'cancel') {
    queue.removeUserJob(userId);
    modCleanup(userId);
    renameBaseStates.delete(userId);
    checkBaseStates.delete(userId);
    rombaWarnaStates.delete(userId);
    return send(chatId,
      `✅ **Dibatalkan.**`,
      [[{ text: "🏠 Menu Utama", callback_data: "start", style: "danger" }]], msgId
    );
  }

  // ── AI Vision: Copy Base ──
  if (data === 'design_to_code') {
    await send(
      chatId,
      `👾 **Copy Base**\n━━━━━━━━━━━━━━━━━━\n\nPilih jenis media yang ingin diubah menjadi kode Flutter:`,
      [
        [{ text: "📸 Dari FOTO", callback_data: "design_to_code_photo", style: "danger" }],
        [{ text: "🎬 Dari VIDEO", callback_data: "design_to_code_video", style: "danger" }],
        [{ text: "❌ Batalkan", callback_data: "start", style: "danger" }]
      ],
      msgId
    );
    return;
  }

  if (data === 'design_to_code_photo') {
    if (!db.isPrivileged(userId)) {
      await send(
        chatId,
        `⛔ **ANDA TIDAK DAPAT MENDAPATKAN AKSES UNTUK FITUR INI**\nHubungi Owner untuk mendapatkan akses!!!`,
        [[{ text: "🔙 Kembali ke Menu", callback_data: "start", style: "danger" }]],
        msgId
      );
      return;
    }
    userStates.set(userId, { step: 'WAITING_DESIGN_PHOTO', chatId, updatedAt: Date.now(), type: 'photo' });
    await send(
      chatId,
      `📸 **Kirim FOTO Desain UI**\n━━━━━━━━━━━━━━━━━━\n\nKirimkan **foto desain UI** (tampilan aplikasi) yang ingin diubah menjadi kode Flutter.\n\n🤖 AI akan menghasilkan widget Flutter yang mirip dengan gambar.`,
      [[{ text: "❌ Batalkan", callback_data: "start", style: "danger" }]],
      msgId
    );
    return;
  }

  if (data === 'design_to_code_video') {
    if (!db.isPrivileged(userId)) {
      await send(
        chatId,
        `⛔ **ANDA TIDAK DAPAT MENDAPATKAN AKSES UNTUK FITUR INI**\nHubungi Owner untuk mendapatkan akses!!!`,
        [[{ text: "🔙 Kembali ke Menu", callback_data: "start", style: "danger" }]],
        msgId
      );
      return;
    }
    userStates.set(userId, { step: 'WAITING_DESIGN_PHOTO', chatId, updatedAt: Date.now(), type: 'video' });
    await send(
      chatId,
      `🎬 **Kirim VIDEO Desain UI**\n━━━━━━━━━━━━━━━━━━\n\nKirimkan **video desain UI** (rekaman tampilan aplikasi) yang ingin diubah menjadi kode Flutter.\n\n🤖 AI akan menganalisis video dan menghasilkan widget Flutter.\n⚠️ Video akan diambil frame pertamanya untuk dianalisis.`,
      [[{ text: "❌ Batalkan", callback_data: "start", style: "danger" }]],
      msgId
    );
    return;
  }

  // ── Web to APK ──
  if (data === 'menu_web2apk' || data === 'w2a_cancel' || data === 'w2a_start_build') {
    return web2apkMod.handleWeb2ApkCallback(event);
  }

  // ── Deploy Vercel ──
  if (data === 'menu_deploy_vercel' || data === 'deploy_cancel') {
    return deployMod.handleDeployCallback(event);
  }

  // ── Maintenance ──
  if (data === 'maintenance_menu') {
    if (!db.isOwner(userId)) return;
    const isActive = db.getMaintenance();
    return send(chatId,
      `🔧 **Mode Maintenance**\nStatus: ${isActive ? '🔴 AKTIF' : '🟢 NONAKTIF'}`,
      [
        [isActive
          ? { text: "🟢 Maintenance OFF", callback_data: "maint_off", style: "danger" }
          : { text: "🔴 Maintenance ON", callback_data: "maint_on", style: "danger" }],
        [{ text: "🔙 Kembali", callback_data: "start", style: "danger" }],
      ], msgId
    );
  }

  if (data === 'maint_on') {
    if (!db.isOwner(userId)) return;
    db.setMaintenance(true, 'Pemeliharaan sistem oleh owner', new Date().toISOString());
    const since = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    return send(chatId,
      `🔧 **MAINTENANCE DIAKTIFKAN**\n━━━━━━━━━━━━━━━━━\n\n📝 Alasan : Pemeliharaan sistem oleh owner\n🕐 Sejak  : ${since}\n\nUser non-owner akan ditolak sementara.`,
      [[{ text: "🔙 Kembali", callback_data: "start", style: "danger" }]], msgId
    );
  }

  if (data === 'maint_off') {
    if (!db.isOwner(userId)) return;
    db.setMaintenance(false);
    return send(chatId,
      `🟢 **MAINTENANCE NONAKTIF**\n━━━━━━━━━━━━━━━━━\nSemua user bisa menggunakan bot kembali.`,
      [[{ text: "🔙 Kembali", callback_data: "start", style: "danger" }]], msgId
    );
  }

  // ── Owner Panel ──
  if (data === 'owner_panel') {
    if (!db.isOwner(userId)) return;
    return send(chatId,
      `👑 **Owner Panel**\n━━━━━━━━━━━━━━━━━━\n\n` +
      `• \`/addadmin {id}\` — Tambah admin\n` +
      `• \`/addreseller {id}\` — Tambah reseller\n` +
      `• \`/addcredit {id} {jumlah}\` — Tambah credit\n` +
      `• \`/broadcast {pesan}\` — Broadcast semua user`,
      [[{ text: "🔙 Kembali", callback_data: "start", style: "danger" }]], msgId
    );
  }

  if (data === 'admin_panel') {
    if (!db.isAdmin(userId)) return;
    return send(chatId,
      `🛡 **Admin Panel**\n━━━━━━━━━━━━━━━━━━\n\n` +
      `• \`/addreseller {id}\` — Tambah reseller`,
      [[{ text: "🔙 Kembali", callback_data: "start", style: "danger" }]], msgId
    );
  }

  if (data === 'reseller_panel') {
    if (!db.isReseller(userId)) return;
    return send(chatId,
      `🤝 **Reseller Panel**\n━━━━━━━━━━━━━━━━━━\n\n` +
      `• \`/addcredit {id} {jumlah}\` — Tambah credit user`,
      [[{ text: "🔙 Kembali", callback_data: "start", style: "danger" }]], msgId
    );
  }

  // ── Broadcast ──
  if (data === 'broadcast_menu') {
    if (!db.isOwner(userId)) return;
    return send(chatId,
      `📣 Gunakan:\n\`/broadcast {pesan}\``,
      [[{ text: "🔙 Kembali", callback_data: "start", style: "danger" }]], msgId
    );
  }

  // ── Laporan Bug ──
  if (data === 'user_start_lapor') {
    if (!db.blockedReportUsers) db.blockedReportUsers = new Set();
    if (db.blockedReportUsers.has(userId)) {
      return event.answer({ message: '❌ Akses Ditolak! Kamu telah diblokir dari fitur laporan.', alert: true });
    }
    userStates.set(userId, { step: 'WAITING_FOR_REASON' });
    await client.editMessage(chatId, {
      message: msgId,
      text: `📝 **MENU LAPORAN**\n\nSilakan ketik **Alasan & Detail Laporan** kamu dengan jelas.\n\n⚠️ __Laporan asal-asalan/palsu akan mengakibatkan akun kamu diblokir.__`,
      parseMode: 'md',
      buttons: buildButtons([[{ text: "❌ Batalkan Laporan", callback_data: "user_cancel_lapor", style: "danger" }]])
    });
    return;
  }

  if (data === 'user_cancel_lapor') {
    userStates.delete(userId);
    await client.editMessage(chatId, {
      message: msgId,
      text: `❌ **Laporan Dibatalkan**\n\nProses pengisian laporan telah dihentikan secara aman.`,
      parseMode: 'md',
      buttons: []
    });
    return event.answer({ message: 'Laporan dibatalkan' });
  }

  // Admin action dari laporan
  const isAdminAction = data.startsWith('adm_fix_') || data.startsWith('adm_blk_') || data.startsWith('adm_unblk_');
  if (isAdminAction) {
    if (!db.isAdmin(userId) && !db.isOwner(userId)) {
      return event.answer({ message: '❌ Tidak ada akses admin!', alert: true });
    }
    let originalMsgText = 'Laporan User';
    try {
      const fullMsg = await client.getMessages(chatId, { ids: [msgId] });
      originalMsgText = fullMsg[0]?.message || fullMsg[0]?.caption || 'Laporan User';
    } catch (_) {}

    if (data.startsWith('adm_fix_')) {
      const targetUserId = Number(data.replace('adm_fix_', ''));
      try {
        await client.sendMessage(targetUserId, {
          message: `🎉 **LAPORAN SELESAI DIPROSES**\n\nKendala yang kamu laporkan **telah berhasil diperbaiki** oleh tim admin.\n\nTerima kasih atas kontribusimu!`,
          parseMode: 'md'
        });
        await event.answer({ message: '✅ User sudah diberitahu!', alert: false });
      } catch (_) {
        await event.answer({ message: '⚠️ Gagal kirim DM', alert: true });
      }
      await client.editMessage(chatId, {
        message: msgId,
        text: originalMsgText + `\n\n🟢 **STATUS:** Selesai diperbaiki & user telah diberitahu.`,
        parseMode: 'md',
        buttons: buildButtons([[{ text: "🔒 Blokir User", callback_data: `adm_blk_${targetUserId}`, style: "danger" }]])
      });
      return;
    }

    if (data.startsWith('adm_blk_')) {
      const targetUserId = Number(data.replace('adm_blk_', ''));
      if (!db.blockedReportUsers) db.blockedReportUsers = new Set();
      db.blockedReportUsers.add(targetUserId);
      await event.answer({ message: `🔒 ID ${targetUserId} Diblokir`, alert: false });
      await client.editMessage(chatId, {
        message: msgId,
        text: originalMsgText + `\n\n🔴 **STATUS:** User telah diblokir.`,
        parseMode: 'md',
        buttons: buildButtons([[{ text: "🔓 Unblokir User", callback_data: `adm_unblk_${targetUserId}`, style: "danger" }]])
      });
      try { await client.sendMessage(targetUserId, { message: `⚠️ **AKSES DIBLOKIR**\n\nFitur laporan kamu dinonaktifkan karena terindikasi laporan palsu/spam.`, parseMode: 'md' }); } catch (_) {}
      return;
    }

    if (data.startsWith('adm_unblk_')) {
      const targetUserId = Number(data.replace('adm_unblk_', ''));
      if (!db.blockedReportUsers) db.blockedReportUsers = new Set();
      db.blockedReportUsers.delete(targetUserId);
      await event.answer({ message: `🔓 Blokir ID ${targetUserId} Dibuka`, alert: false });
      await client.editMessage(chatId, {
        message: msgId,
        text: originalMsgText + `\n\n⚪ **STATUS:** Akses laporan dikembalikan normal.`,
        parseMode: 'md',
        buttons: buildButtons([
          [{ text: "✅ Masalah Selesai", callback_data: `adm_fix_${targetUserId}`, style: "danger" }],
          [
            { text: "🔒 Blokir", callback_data: `adm_blk_${targetUserId}`, style: "danger" },
            { text: "🔓 Unblokir", callback_data: `adm_unblk_${targetUserId}`, style: "danger" }
          ]
        ])
      });
      try { await client.sendMessage(targetUserId, { message: `✅ **AKSES DIKEMBALIKAN**\n\nFitur laporan kamu telah diaktifkan kembali.`, parseMode: 'md' }); } catch (_) {}
      return;
    }
  }

  // ── Rename Base ──
  if (data === 'rename_base') return await handleRenameBase(chatId, userId, msgId);

  if (data === 'rename_skip_domain') {
    const rbs = renameBaseStates.get(userId);
    if (!rbs) return;
    return await showRenameBaseAssets(chatId, userId, msgId);
  }

  if (data.startsWith('rename_pick_dom_')) {
    const idx = parseInt(data.replace('rename_pick_dom_', ''), 10);
    const rbs = renameBaseStates.get(userId);
    if (!rbs || !rbs.allDomains || rbs.allDomains[idx] === undefined) {
      return event.answer({ message: '⚠️ Sesi kadaluarsa, ulangi dari awal.', alert: true });
    }
    rbs.step = 'waiting_new_domain';
    rbs.selectedDomain = rbs.allDomains[idx];
    renameBaseStates.set(userId, rbs);
    return await send(chatId,
      `🌐 **Ganti Domain**\n━━━━━━━━━━━━━━━━━━━━━━\n\nDomain yang dipilih:\n\`${escapeMd(rbs.selectedDomain)}\`\n\nKirim **URL baru** untuk menggantikannya.\n\n📌 Contoh:\n\`http://domainbaru.com:1945\``,
      [[{ text: "❌ Lewati (Tidak Jadi)", callback_data: "rename_skip_domain", style: "danger" }]], msgId
    );
  }

  if (data === 'rename_skip_logo') {
    const rbs = renameBaseStates.get(userId);
    if (!rbs) return;
    return await showRenameApkName(chatId, userId, msgId);
  }

  if (data === 'rename_skip_apkname') {
    const rbs = renameBaseStates.get(userId);
    if (!rbs) return;
    return await finishRenameBase(chatId, userId);
  }

  // ── Check Base ──
  if (data === 'check_base') return await handleCheckBase(chatId, userId, msgId);

  if (data === 'detail_error') {
    const cs = checkBaseStates.get(userId);
    if (!cs || !cs.errors) return;
    return await showDetailErrors(chatId, userId, msgId, cs.errors);
  }

  if (data === 'fix_base') {
    const cs = checkBaseStates.get(userId);
    if (!cs || !cs.extractDir) return;
    return await handleFixBase(chatId, userId, msgId, cs);
  }

  // ── Rombak Warna ──
  if (data === 'rombak_warna') return await handleRombaWarna(chatId, userId, msgId);

  // ── Flutter Mod: Domain / Warna / Icon / Nama ──
  if (data === 'mod_domain_start') return await handleModDomainStart(chatId, userId, msgId);
  if (data === 'mod_color_start')  return await handleModColorStart(chatId, userId, msgId);
  if (data === 'mod_icon_start')   return await handleModIconStart(chatId, userId, msgId);
  if (data === 'mod_name_start')   return await handleModNameStart(chatId, userId, msgId);
  if (data.startsWith('mod_pickurl_')) {
    const idx = parseInt(data.replace('mod_pickurl_', ''), 10);
    return await handleModPickUrl(chatId, userId, msgId, idx);
  }
  if (data.startsWith('mod_preset_')) {
    const key = data.replace('mod_preset_', '');
    return await handleModPresetColor(chatId, userId, msgId, key);
  }
  if (data === 'mod_custom_color') return await handleModCustomColor(chatId, userId, msgId);
}

// ══════════════════════════════════════════════════════
// 📨 MESSAGE HANDLER
// ══════════════════════════════════════════════════════
async function handleMessage(event) {
  const msg    = event.message;
  const text   = msg?.text?.trim();
  const chatId = event.chatId;
  const userId = Number(msg.senderId);

  if (!text && !msg.media) return;

  if (text === '/start') return handleStart(event);

  if (db.getMaintenance() && !db.isOwner(userId) && text?.startsWith('/')) {
    const reason = db.getMaintenanceReason() || '-';
    const sinceRaw = db.getMaintenanceSince();
    const since = sinceRaw
      ? new Date(sinceRaw).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
      : '-';
    return send(chatId,
      `🔧 **BOT SEDANG MAINTENANCE**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚙️ BOT SEDANG DALAM PEMBARUAN ATAU PENINGKATAN SYSTEM🔥\n\n` +
      `📝 Alasan   : ${reason}\n` +
      `🕐 Sejak    : ${since}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ SILAHKAN KAMU SABARAN SEDIKIT YA!! KAMI SEDANG MELALUKAN PENINGKATAN SYSTEM/PEMBARUAN SYSTEM‼️`
    );
  }

  // /addadmin
  if (text?.startsWith('/addadmin') && db.isOwner(userId)) {
    const id = parseInt(text.split(' ')[1]);
    if (!id) return send(chatId, `⚠️ Gunakan: \`/addadmin {id}\``);
    db.addAdmin(id);
    await send(chatId, `✅ ID \`${id}\` dijadikan Admin.`);
    // Auto backup ke GitHub
    github.backupToGithub(CONFIG.dataFile, null).catch(() => {});
    return;
  }

  // /addreseller
  if (text?.startsWith('/addreseller') && (db.isOwner(userId) || db.isAdmin(userId))) {
    const id = parseInt(text.split(' ')[1]);
    if (!id) return send(chatId, `⚠️ Gunakan: \`/addreseller {id}\``);
    db.addReseller(id);
    await send(chatId, `✅ ID \`${id}\` dijadikan Reseller.`);
    // Auto backup ke GitHub
    github.backupToGithub(CONFIG.dataFile, null).catch(() => {});
    return;
  }

  // /addcredit
  if (text?.startsWith('/addcredit') && (db.isOwner(userId) || db.isAdmin(userId) || db.isReseller(userId))) {
    const parts    = text.split(' ');
    const targetId = parseInt(parts[1]);
    const amount   = parseInt(parts[2]);
    if (!targetId || isNaN(amount)) return send(chatId, `⚠️ Gunakan: \`/addcredit {id} {jumlah}\``);
    const newBal = db.addCredit(targetId, amount);
    if (newBal === null) return send(chatId, `❌ User tidak ditemukan.`);
    await send(chatId, `✅ Berhasil menambah **${amount}** credit ke \`${targetId}\`.\nSisa: \`${newBal}\``);
    try {
      await client.sendMessage(targetId, {
        message: `🎁 **Credit kamu bertambah!**\n+${amount} credit\nSisa: \`${newBal}\``,
        parseMode: 'md',
      });
    } catch (_) {}
    return;
  }

  // /maintenance {alasan} — aktifkan maintenance dengan alasan custom
  if (text?.startsWith('/maintenance') && db.isOwner(userId)) {
    const alasan = text.replace('/maintenance', '').trim();
    if (!alasan) {
      return send(chatId,
        `⚠️ **Gunakan:** \`/maintenance {alasan}\`\n\nContoh:\n\`/maintenance Pembaruan sistem versi 2.0\``
      );
    }
    const now = new Date();
    db.setMaintenance(true, alasan, now.toISOString());
    const since = now.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    return send(chatId,
      `🔧 **MAINTENANCE DIAKTIFKAN**\n━━━━━━━━━━━━━━━━━\n\n📝 Alasan : ${alasan}\n🕐 Sejak  : ${since}\n\nUser non-owner akan melihat pesan maintenance.`
    );
  }

  // /unmaintenance — nonaktifkan maintenance
  if (text?.startsWith('/unmaintenance') && db.isOwner(userId)) {
    db.setMaintenance(false);
    return send(chatId,
      `🟢 **MAINTENANCE DINONAKTIFKAN**\n━━━━━━━━━━━━━━━━━\nSemua user bisa menggunakan bot kembali.`
    );
  }

  // /broadcast
  if (text?.startsWith('/broadcast') && db.isOwner(userId)) {
    const msg_text = text.replace('/broadcast', '').trim();
    if (!msg_text) return send(chatId, `⚠️ Gunakan: \`/broadcast {pesan}\``);
    const users = db.getAllUsers();
    let success = 0, failed = 0;
    await send(chatId, `🚀 Broadcast dimulai ke ${users.length} user...`);
    for (const user of users) {
      try {
        await client.sendMessage(user.userId, {
          message: `📣 **BROADCAST**\n━━━━━━━━━━━━━━━━━\n${msg_text}`,
          parseMode: 'md',
        });
        success++;
      } catch { failed++; }
      await github.sleep(80);
    }
    return send(chatId, `✅ Broadcast selesai!\nBerhasil: ${success} | Gagal: ${failed}`);
  }

  // ── AI Vision: designState dicek SEBELUM web2apk agar instruksi user tidak terswallow ──
  const designState = userStates.get(userId);

  // ── Web to APK: intercept text (skip jika sedang di alur aivision) ──
  if (text && !text.startsWith('/') && !designState) {
    const w2aHandled = await web2apkMod.handleWeb2ApkText(event);
    if (w2aHandled) return;

    const deployHandled = await deployMod.handleDeployText(event);
    if (deployHandled) return;
  }

  // ── AI Vision: Copy Base (WAITING_DESIGN_PHOTO) — step 1: terima foto/video ──

  if (designState?.step === 'WAITING_DESIGN_PHOTO') {
    const media = msg.media;
    if (!media) {
      await send(chatId, `⚠️ **Kirim foto atau video desain UI, bukan teks.**`);
      return;
    }

    const isPhoto = media instanceof Api.MessageMediaPhoto;
    const isVideo =
      media instanceof Api.MessageMediaDocument &&
      media.document?.mimeType?.startsWith('video/');

    const userType = designState.type || 'photo';

    if (userType === 'photo' && !isPhoto) {
      await send(chatId,
        `⚠️ **Kamu memilih FOTO, tapi mengirim ${isVideo ? 'VIDEO' : 'file lain'}!**\n\nSilakan kirim **FOTO** desain UI.\nAtau klik ulang menu dan pilih **VIDEO** jika ingin kirim video.`
      );
      return;
    }

    if (userType === 'video' && !isVideo) {
      await send(chatId,
        `⚠️ **Kamu memilih VIDEO, tapi mengirim ${isPhoto ? 'FOTO' : 'file lain'}!**\n\nSilakan kirim **VIDEO** desain UI.\nAtau klik ulang menu dan pilih **FOTO** jika ingin kirim foto.`
      );
      return;
    }

    if (!isPhoto && !isVideo) {
      await send(chatId, `⚠️ **Format tidak didukung!**\n\nKirim **foto** atau **video** desain UI.`);
      return;
    }

    const statusMsg = await send(chatId, `⏳ **Menyimpan ${isPhoto ? 'foto' : 'video'}...**`);

    try {
      let imagePath;

      if (isPhoto) {
        imagePath = path.join(CONFIG.TMP_DIR, `design_${userId}_${Date.now()}.jpg`);
        await client.downloadMedia(msg, { outputFile: imagePath });
      } else {
        const videoPath = path.join(CONFIG.TMP_DIR, `design_video_${userId}_${Date.now()}.mp4`);
        await client.downloadMedia(msg, { outputFile: videoPath });
        const framePath = path.join(CONFIG.TMP_DIR, `design_frame_${userId}_${Date.now()}.jpg`);
        try {
          const { execSync } = require('child_process');
          execSync(`ffmpeg -i "${videoPath}" -vframes 1 -q:v 2 "${framePath}" -y`, {
            stdio: 'pipe', timeout: 30000
          });
          if (fs.existsSync(framePath)) {
            imagePath = framePath;
            fs.unlinkSync(videoPath);
          } else {
            throw new Error('Gagal ekstrak frame');
          }
        } catch {
          await edit(chatId, statusMsg.id,
            `⚠️ **Server tidak support video!**\n\nKirim **foto/screenshot** saja atau install ffmpeg di server.`
          );
          if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
          return;
        }
      }

      // Simpan state ke step berikutnya: tunggu file .dart
      userStates.set(userId, {
        step: 'WAITING_DESIGN_DART',
        chatId,
        type: userType,
        imagePath,
        updatedAt: Date.now(),
      });

      await edit(chatId, statusMsg.id,
        `✅ **${isPhoto ? 'Foto' : 'Video'} diterima!**\n━━━━━━━━━━━━━━━━━━\n\n📄 Sekarang **kirimkan file \`.dart\`** kamu yang ingin dimodifikasi.\n\n⚠️ Hanya menerima file dengan ekstensi **.dart**`
      );
    } catch (err) {
      try {
        await edit(chatId, statusMsg.id,
          `❌ **Gagal menyimpan media!**\n\n\`${escapeMd(err.message)}\``
        );
      } catch (_) {}
    }
    return;
  }

  // ── AI Vision: step 2 — terima file .dart ──
  if (designState?.step === 'WAITING_DESIGN_DART') {
    const media = msg.media;
    if (!media) {
      await send(chatId, `⚠️ **Kirim file \`.dart\`, bukan teks.**\n\nAtau klik /start untuk batal.`);
      return;
    }

    const isDoc = media instanceof Api.MessageMediaDocument;
    if (!isDoc) {
      await send(chatId, `⚠️ **Hanya menerima file dokumen .dart!**`);
      return;
    }

    const doc = media.document;
    const attrs = doc.attributes || [];
    const origFileName = attrs.find(a => a.fileName)?.fileName || `widget_${Date.now()}.dart`;

    if (!origFileName.toLowerCase().endsWith('.dart')) {
      await send(chatId,
        `❌ **File harus berekstensi \`.dart\`!**\n\nKamu mengirim: \`${escapeMd(origFileName)}\`\n\nSilakan kirim file dengan ekstensi **.dart**`
      );
      return;
    }

    const dartPath = path.join(CONFIG.TMP_DIR, `dart_${userId}_${Date.now()}.dart`);
    await client.downloadMedia(msg, { outputFile: dartPath });
    const dartCode = fs.readFileSync(dartPath, 'utf8');
    fs.unlinkSync(dartPath);

    // Lanjut ke step instruksi
    userStates.set(userId, {
      ...designState,
      step: 'WAITING_DESIGN_INSTRUCTION',
      dartCode,
      origFileName,
      updatedAt: Date.now(),
    });

    await send(chatId,
      `✅ **File \`${escapeMd(origFileName)}\` diterima!**\n━━━━━━━━━━━━━━━━━━\n\n📝 Sekarang **kirimkan instruksi** kamu untuk memodifikasi tampilan dart ini.\n\nContoh instruksi:\n• _"Ubah warna background menjadi biru gelap"\n"Tambah animasi di button"\n"Ubah font ukuran 18 dan tebalkan"_`
    );
    return;
  }

  // ── AI Vision: step 3 — terima instruksi & proses AI ──
  if (designState?.step === 'WAITING_DESIGN_INSTRUCTION') {
    if (!text || text.startsWith('/')) {
      await send(chatId, `⚠️ **Kirim instruksi dalam bentuk teks!**\n\nContoh: _"Ubah warna tombol jadi merah"_`);
      return;
    }

    const userInstruction = text;
    const { imagePath, dartCode, origFileName, type } = designState;
    userStates.delete(userId);

    const statusMsg = await send(chatId,
      `⏳ **AI sedang memproses instruksi...**\n\n📸 Referensi: ${type === 'video' ? 'Video' : 'Foto'}\n📄 File: \`${escapeMd(origFileName)}\`\n📝 Instruksi: _${escapeMd(userInstruction)}_\n\nMohon tunggu hingga 90 detik.`
    );

    try {
      const imageBuffer = fs.readFileSync(imagePath);

      const resultCode = await aivision.generateFlutterFromInstructionAndImage(
        imageBuffer,
        dartCode,
        userInstruction,
        CONFIG.GEMINI_API_KEY,
        CONFIG.GEMINI_MODEL
      );

      // Nama file output
      const baseName = origFileName.replace(/\.dart$/i, '');
      const outFileName = `${baseName}_modified.dart`;
      const outPath = path.join(CONFIG.TMP_DIR, `out_${userId}_${Date.now()}.dart`);
      fs.writeFileSync(outPath, resultCode, 'utf8');

      const from = await client.getEntity(userId);
      const displayName = [from?.firstName, from?.lastName].filter(Boolean).join(' ') || 'User';
      const displayUsername = from?.username ? `@${from.username}` : '-';
      const dt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      const mediaLabel = type === 'video' ? 'Video' : 'Gambar';

      // Edit status
      try {
        await edit(chatId, statusMsg.id,
          `✅ **COPY TAMPILAN SUCCESS!**\n━━━━━━━━━━━━━━━━━━━━\n` +
          `📝 Instruksi: _${escapeMd(userInstruction)}_\n` +
          `📦 Size hasil: ${(resultCode.length / 1024).toFixed(1)} KB`
        );
      } catch (_) {}

      // Send file dart hasil
      await client.sendFile(chatId, {
        file: outPath,
        caption:
          `✅ **COPY TAMPILAN SUCCESS!**\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `👤 Developer : ${displayName}\n` +
          `🌐 Username  : ${displayUsername}\n` +
          `🆔 ID        : ${userId}\n` +
          `🎨 File asli : \`${origFileName}\`\n` +
          `📄 File hasil: \`${outFileName}\`\n` +
          `📝 Instruksi : ${userInstruction}\n` +
          `🖼 ${mediaLabel}    : 1\n` +
          `🟢 Status    : SUKSES\n` +
          `⏰ Waktu     : ${dt}`,
        fileName: outFileName,
        parseMode: 'md',
        forceDocument: true,
      });

      // Cleanup
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      if (imagePath && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);

      // Log ke channel monitor dengan foto
      try {
        const logCaption =
          `✅ <b>COPY TAMPILAN SUCCESS!</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `👤 Developer : ${displayName}\n` +
          `🌐 Username  : ${displayUsername}\n` +
          `🆔 ID        : <code>${userId}</code>\n` +
          `🎨 File asli : <code>${origFileName}</code>\n` +
          `📄 File hasil: <code>${outFileName}</code>\n` +
          `📝 Instruksi : ${userInstruction}\n` +
          `🖼 ${mediaLabel}    : 1\n` +
          `🟢 Status    : SUKSES\n` +
          `⏰ Waktu     : ${dt}`;
        await sendMonitorPhoto(CONFIG.CHANNEL_USERNAME, logCaption);
      } catch (e) { console.error('Copy tampilan log channel error:', e.message); }

    } catch (err) {
      if (imagePath && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      try {
        await edit(chatId, statusMsg.id,
          `❌ **Gagal memproses!**\n\n\`${escapeMd(err.message)}\`\n\n_Pastikan GEMINI_API_KEY sudah di-set dan coba lagi._`
        );
      } catch (_) {}
    }

    return;
  }

  // ── Deploy Vercel: file ──
  if (msg.media) {
    const deployHandled = await deployMod.handleDeployFile(event);
    if (deployHandled) return;
  }

  // ── Laporan Bug: intercept text & photo ──
  const lapState = userStates.get(userId);
  if (lapState && (lapState.step === 'WAITING_FOR_REASON' || lapState.step === 'WAITING_FOR_SCREENSHOT')) {
    const handled = await handleUserReportMessages(event);
    if (handled) return;
  }

  // ── Rename Base: state routing ──
  const renameState = renameBaseStates.get(userId);
  if (renameState) {
    if (renameState.step === 'waiting_base_zip' && msg.media?.document) {
      const handled = await handleRenameBaseZip(event);
      if (handled) return;
    }
    if (renameState.step === 'waiting_new_domain' && text && !text.startsWith('/')) {
      const handled = await handleRenameNewDomain(event);
      if (handled) return;
    }
    if (renameState.step === 'waiting_logo_replace' && msg.media?.document) {
      const handled = await handleRenameBaseLogoFile(event);
      if (handled) return;
    }
    if (renameState.step === 'waiting_apk_name' && text && !text.startsWith('/')) {
      const handled = await handleRenameBaseApkName(event);
      if (handled) return;
    }
  }

  // ── Check Base: state routing ──
  const checkState = checkBaseStates.get(userId);
  if (checkState) {
    if (checkState.step === 'waiting_base_zip' && msg.media?.document) {
      const handled = await handleCheckBaseZip(event);
      if (handled) return;
    }
  }

  // ── Rombak Warna: state routing ──
  const rombaState = rombaWarnaStates.get(userId);
  if (rombaState) {
    if (rombaState.step === 'waiting_base_zip' && msg.media?.document) {
      const handled = await handleRombaWarnaZip(event);
      if (handled) return;
    }
    if (rombaState.step === 'waiting_color_selection' && text && !text.startsWith('/')) {
      const handled = await handleRombaWarnaColorInput(event);
      if (handled) return;
    }
  }

  // ── Flutter Mod state routing (real process) ──
  const modState = modStates.get(userId);
  if (modState) {
    if (modState.step === 'waiting_zip_domain' && msg.media?.document) {
      if (await processModZip(event, 'domain')) return;
    }
    if (modState.step === 'waiting_zip_color' && msg.media?.document) {
      if (await processModZip(event, 'color')) return;
    }
    if (modState.step === 'waiting_zip_icon' && msg.media?.document) {
      if (await processModZip(event, 'icon')) return;
    }
    if (modState.step === 'waiting_zip_name' && msg.media?.document) {
      if (await processModZip(event, 'name')) return;
    }
    if (modState.step === 'waiting_new_url' && text && !text.startsWith('/')) {
      if (await processModNewUrl(event)) return;
    }
    if (modState.step === 'waiting_custom_hex' && text && !text.startsWith('/')) {
      if (await processModCustomHex(event)) return;
    }
    if (modState.step === 'waiting_icon_image' && msg.media) {
      if (await processModIconImage(event)) return;
    }
    if (modState.step === 'waiting_new_name' && text && !text.startsWith('/')) {
      if (await processModNewName(event)) return;
    }
  }

  // ── Build: ZIP file ──
  if (msg.media) {
    const handled = await buildModule.handleZipFile(event);
    if (handled) return;
  }
}

// ══════════════════════════════════════════════════════
// 🚀 MAIN
// ══════════════════════════════════════════════════════


// ============================================
// 🔍 HELPER: findDartFiles
// ============================================

function findDartFiles(dir) {
  let dartFiles = [];
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        if (![".dart_tool", "build", ".git", "node_modules"].includes(item.name)) {
          dartFiles = dartFiles.concat(findDartFiles(path.join(dir, item.name)));
        }
      } else if (item.isFile() && item.name.endsWith(".dart")) {
        dartFiles.push(path.join(dir, item.name));
      }
    }
  } catch (e) {
    console.error(`Error scanning dir ${dir}:`, e.message);
  }
  return dartFiles;
}

// ============================================
// 📝 LAPORAN BUG - USER REPORT SYSTEM
// ============================================

async function handleUserReportMessages(event) {
  const sender = await event.message.getSender();
  const userId = Number(sender?.id);
  const chatId = event.chatId;
  const messageText = event.message.text;

  const currentState = userStates.get(userId);
  if (!currentState) return false; 

  if (currentState.step === 'WAITING_FOR_REASON') {
    if (!messageText || messageText.length < 10) {
      await client.sendMessage(chatId, { 
        message: "⚠️ **Mohon berikan alasan yang lebih detail (minimal 10 karakter agar admin paham penjelasannya).**",
        buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]]),
        parseMode: "md"
      });
      return true;
    }
    
    userStates.set(userId, { step: 'WAITING_FOR_SCREENSHOT', reason: messageText });
    await client.sendMessage(chatId, {
      message: `📸 **BUKTI SCREENSHOT**\n\n` +
               `Sekarang, silakan kirimkan **1 Foto/Screenshot** bukti pendukung kendala tersebut untuk mempermudah perbaikan.`,
      parseMode: "md",
      buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]])
    });
    return true;
  }

  if (currentState.step === 'WAITING_FOR_SCREENSHOT') {
    if (!event.message.media || !(event.message.media instanceof Api.MessageMediaPhoto)) {
      await client.sendMessage(chatId, { 
        message: "⚠️ **Format salah! Silakan kirimkan bukti file berupa Gambar/Foto.**",
        buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]]),
        parseMode: "md"
      });
      return true;
    }

    const username = sender?.username ? `@${sender.username}` : "Tidak ada username";
    const name = sender?.firstName || "User";
    
    const { message: adminReportLog, entities: adminReportEntities } = buildQuotedMessage([
      { text: `🚨 ${toSansBold("LAPORAN MASUK")}`, quote: true },
      {
        text:
          `Pengirim: ${name}\n` +
          `User ID : ${userId}\n` +
          `Username: ${username}`,
        pre: true,
      },
      { text: `📝 Detail Alasan:\n"${currentState.reason}"`, quote: true },
      { text: `📌 Tindakan Admin:`, quote: false },
    ]);

    try {
      const reportIconPath = tmpPath(`report_${userId}_${Date.now()}.jpg`);
      await client.downloadMedia(event.message, { outputFile: reportIconPath });

      const reportBtns = buildButtons([
        [{ text: "✅ Selesai", callback_data: `adm_fix_${userId}` }],
        [
          { text: "🔒 Blokir", callback_data: `adm_blk_${userId}` },
          { text: "🔓 Unblokir", callback_data: `adm_unblk_${userId}` }
        ]
      ]);
      // Foto monitor sebagai header laporan
      const monPhotoR = await resolveMediaFile(MON_PHOTO_URL);
      if (monPhotoR) {
        await client.sendFile(CONFIG.CHANNEL_USERNAME, {
          file: monPhotoR,
          caption: `🚨 <b>LAPORAN MASUK</b>\n━━━━━━━━━━━━━━\n👤 ${name} (<code>${userId}</code>)\n📛 ${username}\n📝 ${currentState.reason}`,
          parseMode: 'html',
        });
      }
      // Screenshot user
      await client.sendFile(CONFIG.CHANNEL_USERNAME, {
        file: reportIconPath,
        caption: `📸 Screenshot laporan dari ${name} (<code>${userId}</code>)`,
        parseMode: 'html',
        buttons: reportBtns,
      });

      if (fs.existsSync(reportIconPath)) fs.unlinkSync(reportIconPath);

      // Konfirmasi ke user dengan foto
      const confPhotoR = await resolveMediaFile(MON_PHOTO_URL);
      if (confPhotoR) {
        await client.sendFile(chatId, {
          file: confPhotoR,
          caption: `✅ <b>Laporan Sukses Dikirim</b>\n\nTerima kasih, laporan lengkap dan bukti screenshot kamu sudah berhasil masuk ke sistem penanganan admin. Kami akan segera mengeceknya.`,
          parseMode: 'html',
        });
      } else {
        await client.sendMessage(chatId, {
          message: `✅ **Laporan Sukses Dikirim**\n\nTerima kasih, laporan lengkap dan bukti screenshot kamu sudah berhasil masuk ke sistem penanganan admin. Kami akan segera mengeceknya.`,
          parseMode: 'md',
        });
      }

    } catch (e) {
      console.error("Gagal mengirim laporan:", e.message);
      await client.sendMessage(chatId, { message: "❌ Terjadi gangguan internal sistem, gagal mengirim laporan." });
    }

    userStates.delete(userId);
    return true;
  }
  return false;
}

// =============================================
// ========== FITUR RENAME BASE ================
// =============================================

function rbFindFiles(dir, ext) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory() && !["node_modules", ".git", "build", ".dart_tool", ".idea"].includes(entry.name)) {
        results.push(...rbFindFiles(fp, ext));
      } else if (entry.isFile() && fp.endsWith(ext)) {
        results.push(fp);
      }
    }
  } catch {}
  return results;
}

function rbExtractDomains(dartFiles) {
  const domainSet = new Set();
  const urlRegex = /https?:\/\/[^\s'"`,;)\]\\]+/g;
  for (const file of dartFiles) {
    try {
      const content = fs.readFileSync(file, "utf-8");
      const matches = content.match(urlRegex);
      if (matches) {
        for (let m of matches) {
          m = m.replace(/[;,\)'"\]\\]+$/, "");
          try {
            const u = new URL(m);
            domainSet.add(u.origin);
          } catch {}
        }
      }
    } catch {}
  }
  return [...domainSet];
}

function rbFindAssetsDir(extractDir) {
  function search(dir, depth = 0) {
    if (depth > 6) return null;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name === "assets") return path.join(dir, entry.name);
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !["node_modules", ".git", "build", ".dart_tool"].includes(entry.name)) {
          const found = search(path.join(dir, entry.name), depth + 1);
          if (found) return found;
        }
      }
    } catch {}
    return null;
  }
  return search(extractDir);
}

function rbFindAssetImages(assetsDir) {
  const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"];
  const results = [];
  function scan(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fp = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fp);
        } else if (entry.isFile() && imageExts.includes(path.extname(entry.name).toLowerCase())) {
          results.push({ name: entry.name, fullPath: fp });
        }
      }
    } catch {}
  }
  scan(assetsDir);
  return results;
}

function rbFindManifest(extractDir) {
  const common = path.join(extractDir, "android", "app", "src", "main", "AndroidManifest.xml");
  if (fs.existsSync(common)) return common;
  function search(dir, depth = 0) {
    if (depth > 8) return null;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name === "AndroidManifest.xml") return path.join(dir, entry.name);
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const found = search(path.join(dir, entry.name), depth + 1);
          if (found) return found;
        }
      }
    } catch {}
    return null;
  }
  return search(extractDir);
}

function rbReadAppNameInfo(manifestPath) {
  try {
    const content = fs.readFileSync(manifestPath, "utf-8");
    const match = content.match(/android:label="([^"]+)"/);
    if (!match) return null;
    const label = match[1];
    if (label.startsWith("@string/")) {
      const key = label.replace("@string/", "");
      const stringsPath = path.resolve(path.dirname(manifestPath), "..", "res", "values", "strings.xml");
      if (fs.existsSync(stringsPath)) {
        const sc = fs.readFileSync(stringsPath, "utf-8");
        const sm = sc.match(new RegExp(`<string name="${key}">([^<]+)</string>`));
        if (sm) return { displayValue: sm[1], type: "strings", stringsPath, key, manifestPath };
      }
      return { displayValue: label, type: "reference", manifestPath };
    }
    return { displayValue: label, type: "direct", manifestPath };
  } catch {}
  return null;
}

function rbApplyNewAppName(info, newName) {
  try {
    if (info.type === "direct") {
      let c = fs.readFileSync(info.manifestPath, "utf-8");
      c = c.replace(/android:label="[^"]+"/, `android:label="${newName}"`);
      fs.writeFileSync(info.manifestPath, c, "utf-8");
      return true;
    }
    if (info.type === "strings") {
      let c = fs.readFileSync(info.stringsPath, "utf-8");
      c = c.replace(
        new RegExp(`<string name="${info.key}">[^<]+</string>`),
        `<string name="${info.key}">${newName}</string>`
      );
      fs.writeFileSync(info.stringsPath, c, "utf-8");
      return true;
    }
  } catch {}
  return false;
}

function rbReplaceDomain(extractDir, oldOrigin, newOrigin) {
  const dartFiles = rbFindFiles(extractDir, ".dart");
  let count = 0;
  for (const file of dartFiles) {
    try {
      let c = fs.readFileSync(file, "utf-8");
      if (c.includes(oldOrigin)) {
        c = c.split(oldOrigin).join(newOrigin);
        fs.writeFileSync(file, c, "utf-8");
        count++;
      }
    } catch {}
  }
  return count;
}

function rbRezip(sourceDir, outputZipPath) {
  const zip = new AdmZip();
  function addDir(dir, zipBase) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        addDir(fp, zipBase ? `${zipBase}/${entry.name}` : entry.name);
      } else {
        zip.addLocalFile(fp, zipBase || "");
      }
    }
  }
  addDir(sourceDir, "");
  zip.writeZip(outputZipPath);
}

function rbCleanup(userId) {
  const state = renameBaseStates.get(userId);
  if (state?.extractDir && fs.existsSync(state.extractDir)) {
    try { fs.rmSync(state.extractDir, { recursive: true, force: true }); } catch {}
  }
  renameBaseStates.delete(userId);
}

async function handleRenameBase(chatId, userId, deleteMsgId = null) {
  rbCleanup(userId);
  renameBaseStates.set(userId, { step: "waiting_base_zip" });
  await send(
    chatId,
    `🔨 **Rename Base**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Fitur ini bisa mengubah:\n` +
    `  🌐 Domain/URL\n` +
    `  🖼️ Logo/Gambar di assets\n` +
    `  📱 Nama APK\n\n` +
    `📦 **Kirim file ZIP base Flutter kamu sekarang!**\n\n` +
    `__Format: .zip | Maks ukuran: 2 GB__`,
    [[{ text: "❌ Batalkan", data: "start" }]],
    deleteMsgId
  );
}

async function handleRenameBaseZip(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const msg = event.message;
  const state = renameBaseStates.get(userId);
  if (!state || state.step !== "waiting_base_zip") return false;

  const media = msg.media;
  if (!media || !media.document) {
    await send(chatId, `⚠️ Kirim file **ZIP**-nya ya, bukan teks atau foto!`);
    return true;
  }
  const doc = media.document;
  const fileName = doc.attributes?.find((a) => a.fileName)?.fileName || "base.zip";
  if (!fileName.endsWith(".zip")) {
    await send(chatId, `❌ File harus berformat **.zip**!\n\nKirim ulang file ZIP base kamu.`);
    return true;
  }

  const statusMsg = await send(chatId, `📥 **Mengunduh base ZIP...**\n\nMohon tunggu sebentar.`);
  try {
    if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
    const ts = Date.now();
    const zipPath = tmpPath(`rb_${userId}_${ts}.zip`);
    await client.downloadMedia(msg, { outputFile: zipPath });

    await edit(chatId, statusMsg.id, `🔍 **Menganalisis isi base...**`);

    const extractDir = tmpPath(`rb_ext_${userId}_${ts}`);
    fs.mkdirSync(extractDir, { recursive: true });
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);
    fs.unlinkSync(zipPath);

    const dartFiles = rbFindFiles(extractDir, ".dart");
    const allDomains = rbExtractDomains(dartFiles);
    const assetsDir = rbFindAssetsDir(extractDir);
    const assetImages = assetsDir ? rbFindAssetImages(assetsDir) : [];
    const manifestPath = rbFindManifest(extractDir);
    const appNameInfo = manifestPath ? rbReadAppNameInfo(manifestPath) : null;

    renameBaseStates.set(userId, {
      step: "waiting_domain_choice",
      extractDir,
      allDomains,
      assetsDir,
      assetImages,
      manifestPath,
      appNameInfo,
      originalFileName: fileName,
    });

    if (allDomains.length === 0) {
      await edit(chatId, statusMsg.id,
        `✅ **Base berhasil dianalisis!**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📁 **File Dart ditemukan:** ${dartFiles.length}\n` +
        `🌐 Tidak ada URL/domain yang ditemukan.\n\n` +
        `⏭️ Lanjut ke tahap ganti logo...`
      );
      await sleep(800);
      return await showRenameBaseAssets(chatId, userId, statusMsg.id);
    }

    const limitedDomains = allDomains.slice(0, 20);
    const domainBtns = limitedDomains.map((d, i) => {
      const lbl = d.length > 40 ? d.substring(0, 37) + "..." : d;
      return [{ text: `${i + 1}. ${lbl}`, callback_data: `rename_pick_dom_${i}`, style: "danger" }];
    });
    domainBtns.push([{ text: "⏭️ Lewati (Tidak Ganti Domain)", data: "rename_skip_domain" }]);

    await edit(chatId, statusMsg.id,
      `✅ **Base berhasil dianalisis!**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📁 **File Dart:** ${dartFiles.length} | 🖼️ **Aset:** ${assetImages.length}\n\n` +
      `🌐 **Ditemukan ${allDomains.length} domain di file Dart:**\n\n` +
      limitedDomains.map((d, i) => `${i + 1}\\. \`${escapeMd(d)}\``).join("\n") +
      `\n\n👆 Pilih domain yang ingin diganti, atau klik **Lewati**.`,
      domainBtns
    );
  } catch (err) {
    rbCleanup(userId);
    await edit(chatId, statusMsg.id, `❌ **Gagal memproses ZIP!**\n\n\`${escapeMd(err.message)}\``);
  }
  return true;
}

async function handleRenameNewDomain(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const text = event.message.text?.trim();
  const state = renameBaseStates.get(userId);
  if (!state || state.step !== "waiting_new_domain") return false;
  if (!text || text.startsWith("/")) return false;

  try { new URL(text); } catch {
    await send(chatId, `❌ **URL tidak valid!**\n\nContoh: \`http://domainbaru.com:1945\`\n\nKirim ulang URL yang benar.`);
    return true;
  }

  const oldOrigin = state.selectedDomain;
  const count = rbReplaceDomain(state.extractDir, oldOrigin, text);

  await send(chatId,
    `✅ **Domain berhasil diganti!**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🔴 Lama : \`${escapeMd(oldOrigin)}\`\n` +
    `🟢 Baru : \`${escapeMd(text)}\`\n` +
    `📄 Diubah di **${count} file** Dart.\n\n` +
    `⏭️ Lanjut ke tahap ganti logo...`
  );
  await sleep(800);
  await showRenameBaseAssets(chatId, userId);
  return true;
}

async function showRenameBaseAssets(chatId, userId, deleteMsgId = null) {
  const state = renameBaseStates.get(userId);
  if (!state) return;
  state.step = "waiting_logo_replace";
  renameBaseStates.set(userId, state);

  if (!state.assetsDir || state.assetImages.length === 0) {
    await send(chatId,
      `🖼️ **Ganti Logo/Gambar**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📭 Tidak ditemukan gambar di folder assets.\n\n` +
      `Lanjut ke tahap ganti nama APK.`,
      [[{ text: "⏭️ Lanjut ke Nama APK", data: "rename_skip_logo" }]],
      deleteMsgId
    );
    return;
  }

  await send(chatId,
    `🖼️ **Ganti Logo/Gambar**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Ditemukan **${state.assetImages.length} gambar** di folder assets.\n\n` +
    `📤 **Cara ganti logo:**\n` +
    `Kirim file gambar baru sebagai **File/Dokumen** (bukan foto) dengan nama yang **sama persis** seperti yang ingin diganti.\n\n` +
    `Contoh: Kalau mau ganti \`icon.png\`, kirim file gambar baru dengan nama file \`icon.png\`.\n\n` +
    `Klik **Selesai/Lewati** jika sudah atau tidak ingin ganti gambar.`,
    [[{ text: "❌ Lewati", data: "rename_skip_logo" }]],
    deleteMsgId
  );

  // Kirim semua gambar aset ke user
  for (const img of state.assetImages) {
    try {
      await client.sendFile(chatId, {
        file: img.fullPath,
        caption: `📁 \`${escapeMd(img.name)}\``,
        parseMode: "md",
        forceDocument: true,
      });
      await sleep(400);
    } catch (e) {
      await send(chatId, `⚠️ Gagal kirim: \`${escapeMd(img.name)}\``);
    }
  }

  await send(chatId,
    `📤 Kirim file pengganti sebagai **Dokumen** dengan nama yang sama persis.\nKlik **Selesai/Lewati** jika sudah.`,
    [[{ text: "❌ Lewati", data: "rename_skip_logo" }]]
  );
}

async function handleRenameBaseLogoFile(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const msg = event.message;
  const state = renameBaseStates.get(userId);
  if (!state || state.step !== "waiting_logo_replace") return false;

  const media = msg.media;
  if (!media || !media.document) return false;

  const doc = media.document;
  const fileName = doc.attributes?.find((a) => a.fileName)?.fileName;
  if (!fileName) return false;

  const matching = state.assetImages.find((img) => img.name.toLowerCase() === fileName.toLowerCase());
  if (!matching) return false;

  try {
    await client.downloadMedia(msg, { outputFile: matching.fullPath });
    await send(chatId,
      `✅ **\`${escapeMd(fileName)}\` berhasil diganti!**\n\nKirim gambar lain atau klik **Selesai/Lewati**.`,
      [[{ text: "❌ Lewati", data: "rename_skip_logo" }]]
    );
  } catch (e) {
    await send(chatId, `❌ Gagal mengganti \`${escapeMd(fileName)}\`: \`${escapeMd(e.message)}\``);
  }
  return true;
}

async function showRenameApkName(chatId, userId, deleteMsgId = null) {
  const state = renameBaseStates.get(userId);
  if (!state) return;
  state.step = "waiting_apk_name";
  renameBaseStates.set(userId, state);

  const appName = state.appNameInfo?.displayValue;

  if (!appName) {
    await send(chatId,
      `📱 **Ganti Nama APK**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚠️ Tidak bisa menemukan nama APK di file manifest.\n\n` +
      `Ketik nama APK baru atau klik **Lewati & Selesai**.`,
      [[{ text: "⏭️ Lewati & Selesai", data: "rename_skip_apkname" }]],
      deleteMsgId
    );
    return;
  }

  await send(chatId,
    `📱 **Ganti Nama APK**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📌 **Nama APK saat ini:**\n` +
    `\`${escapeMd(appName)}\`\n\n` +
    `Ketik **nama APK baru** yang kamu inginkan, atau klik **Lewati & Selesai**.`,
    [[{ text: "⏭️ Lewati & Selesai", data: "rename_skip_apkname" }]],
    deleteMsgId
  );
}

async function handleRenameBaseApkName(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const text = event.message.text?.trim();
  const state = renameBaseStates.get(userId);
  if (!state || state.step !== "waiting_apk_name") return false;
  if (!text || text.startsWith("/")) return false;

  if (state.appNameInfo) {
    rbApplyNewAppName(state.appNameInfo, text);
  }

  await send(chatId, `✅ **Nama APK diubah menjadi:** \`${escapeMd(text)}\`\n\n⏳ Mengemas ulang base...`);
  await finishRenameBase(chatId, userId);
  return true;
}

async function finishRenameBase(chatId, userId) {
  const state = renameBaseStates.get(userId);
  if (!state) return;

  const statusMsg = await send(chatId, `⏳ **Mengemas ulang base ZIP...**\n\nMohon tunggu sebentar.`);
  try {
    const outName = `renamed_${state.originalFileName || "base.zip"}`;
    const outPath = tmpPath(outName);
    rbRezip(state.extractDir, outPath);

    await edit(chatId, statusMsg.id, `📤 **Mengupload base yang sudah di-rename...**`);

    await client.sendFile(chatId, {
      file: outPath,
      caption:
        `✅ **Base Berhasil Di-Rename!**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📦 **File:** \`${escapeMd(outName)}\`\n\n` +
        `🎉 Base sudah siap digunakan untuk build APK!`,
      parseMode: "md",
    });

    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

    await edit(chatId, statusMsg.id,
      `✅ **Rename Base Selesai!**\n\nFile base yang sudah di-rename telah dikirim di atas. 👆`,
      [[{ text: "🏠 Menu Utama", data: "start" }]]
    );
  } catch (err) {
    await edit(chatId, statusMsg.id, `❌ **Gagal mengemas ulang!**\n\n\`${escapeMd(err.message)}\``);
  } finally {
    rbCleanup(userId);
  }
}

// =============================================
// ======== END FITUR RENAME BASE ==============
// =============================================

// ============================================
// 🔍 CHECK BASE HANDLERS
// ============================================

async function handleCheckBase(chatId, userId, msgId) {
  checkBaseStates.set(userId, { step: "waiting_base_zip" });
  await send(
    chatId,
    `🔍 **CHECK BASE - Analisis Error**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Fitur ini akan menganalisis base Flutter Anda dan menemukan semua error:\n\n` +
    `📊 Pemeriksaan:\n` +
    `  ✓ Syntax errors di Dart files\n` +
    `  ✓ Missing imports & dependencies\n` +
    `  ✓ Gradle configuration errors\n` +
    `  ✓ pubspec.yaml issues\n` +
    `  ✓ Android manifest errors\n` +
    `  ✓ Version conflicts\n` +
    `  ✓ Invalid file references\n\n` +
    `📦 **Kirim file ZIP base Flutter kamu sekarang!**\n\n` +
    `__Format: .zip | Maks ukuran: 2 GB__`,
    [[{ text: "❌ Batalkan", data: "start" }]],
    msgId
  );
}

async function handleCheckBaseZip(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const msg = event.message;
  const state = checkBaseStates.get(userId);

  if (!state || state.step !== "waiting_base_zip") return false;

  const media = msg.media;
  if (!media || !media.document) {
    await send(chatId, `⚠️ Kirim file **ZIP**-nya ya, bukan teks atau foto!`);
    return true;
  }

  const doc = media.document;
  const fileName = doc.attributes?.find((a) => a.fileName)?.fileName || "base.zip";
  if (!fileName.endsWith(".zip")) {
    await send(chatId, `❌ File harus berformat **.zip**!\n\nKirim ulang file ZIP base kamu.`);
    return true;
  }

  const statusMsg = await send(chatId, `📥 **Mengunduh base ZIP...**\n\nMohon tunggu sebentar.`);

  try {
    if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });

    const ts = Date.now();
    const zipPath = tmpPath(`check_base_${userId}_${ts}.zip`);
    await client.downloadMedia(msg, { outputFile: zipPath });

    await edit(chatId, statusMsg.id, `🔍 **Menganalisis error di base...**`);

    const extractDir = tmpPath(`check_ext_${userId}_${ts}`);
    fs.mkdirSync(extractDir, { recursive: true });

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);
    fs.unlinkSync(zipPath);

    const errors = detectAllErrors(extractDir);

    checkBaseStates.set(userId, {
      step: "results_shown",
      extractDir,
      originalFileName: fileName,
      errors,
      hasErrors: errors.length > 0,
    });

    if (errors.length === 0) {
      await edit(
        chatId,
        statusMsg.id,
        `✅ **BASE AMAN - TIDAK ADA ERROR!**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🟩 Analisis selesai, tidak ada error ditemukan.\n` +
        `✨ Base Anda ready untuk di-build!\n\n` +
        `💡 Tips: Pastikan selalu melakukan check sebelum build untuk hasil yang optimal.`,
        [[{ text: "🏠 Menu Utama", data: "start" }]]
      );
    } else {
      let errorReport = `❌ **BASE DITEMUKAN ERROR!**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📋 **Total Error: ${errors.length}**\n\n`;

      const errorsByType = {};
      errors.forEach(err => {
        if (!errorsByType[err.type]) errorsByType[err.type] = [];
        errorsByType[err.type].push(err);
      });

      for (const [type, typeErrors] of Object.entries(errorsByType)) {
        errorReport += `**${type} (${typeErrors.length})**\n`;
        typeErrors.slice(0, 3).forEach(err => {
          const shortMsg = err.message.substring(0, 80);
          errorReport += `  • ${shortMsg}...\n`;
        });
        if (typeErrors.length > 3) {
          errorReport += `  • +${typeErrors.length - 3} error lainnya\n`;
        }
        errorReport += `\n`;
      }

      errorReport += `\n✨ Klik tombol di bawah untuk memperbaiki error:`;

      await edit(chatId, statusMsg.id, errorReport, [
        [{ text: "🔧 Fix Base", data: "fix_base" }],
        [{ text: "📋 Detail Error", data: "detail_error" }],
        [{ text: "🏠 Menu Utama", data: "start" }],
      ]);
    }

    await sleep(500);
  } catch (err) {
    checkBaseCleanup(userId);
    await edit(
      chatId,
      statusMsg.id,
      `❌ **Gagal memproses ZIP!**\n\n\`${escapeMd(err.message)}\``
    );
  }

  return true;
}

function detectAllErrors(baseDir) {
  const errors = [];

  // Scan Dart files
  const dartFiles = findDartFiles(baseDir);
  dartFiles.forEach(dartFile => {
    const content = fs.readFileSync(dartFile, "utf-8");
    const dartErrors = detectDartErrors(content, dartFile);
    errors.push(...dartErrors);
  });

  // Scan pubspec.yaml
  const pubspecPath = path.join(baseDir, "pubspec.yaml");
  if (fs.existsSync(pubspecPath)) {
    const pubspecContent = fs.readFileSync(pubspecPath, "utf-8");
    const pubspecErrors = detectPubspecErrors(pubspecContent);
    errors.push(...pubspecErrors);
  }

  // Scan gradle files
  const gradleFiles = findGradleFiles(baseDir);
  gradleFiles.forEach(gradleFile => {
    const content = fs.readFileSync(gradleFile, "utf-8");
    const gradleErrors = detectGradleErrors(content, gradleFile);
    errors.push(...gradleErrors);
  });

  // Scan AndroidManifest.xml
  const manifestPath = path.join(baseDir, "android", "app", "src", "main", "AndroidManifest.xml");
  if (fs.existsSync(manifestPath)) {
    const manifestContent = fs.readFileSync(manifestPath, "utf-8");
    const manifestErrors = detectManifestErrors(manifestContent);
    errors.push(...manifestErrors);
  }

  return errors;
}

function detectDartErrors(content, filePath) {
  const errors = [];

  // Check for syntax errors
  const syntaxPatterns = [
    { regex: /^\s*import\s+['\"]([^'\"]+)['\"]\s*;?$/gm, name: "Import without semicolon" },
    { regex: /^\s*class\s+\w+\s*{?\s*$/gm, name: "Class definition incomplete" },
    { regex: /{{2,}}/g, name: "Double curly braces" },
    { regex: /}}\s*}/g, name: "Mismatched braces" },
  ];

  syntaxPatterns.forEach(pattern => {
    if (pattern.regex.test(content)) {
      errors.push({
        type: "Dart Syntax Error",
        message: `${pattern.name} di ${path.basename(filePath)}`,
        file: filePath,
        severity: "high",
      });
    }
  });

  // Check for missing imports
  const importedPackages = new Set();
  const usedPackages = new Set();

  content.split("\\n").forEach(line => {
    const importMatch = line.match(/import\s+['\"]([^'\"]+)['\"]/);
    if (importMatch) importedPackages.add(importMatch[1]);

    const packageUsage = line.match(/\\b(http|dio|provider|get|bloc|firebase_[a-z_]+|googleapis)/g);
    if (packageUsage) packageUsage.forEach(p => usedPackages.add(p));
  });

  usedPackages.forEach(pkg => {
    if (!importedPackages.has(pkg)) {
      errors.push({
        type: "Missing Import",
        message: `Package '${pkg}' digunakan tapi tidak di-import di ${path.basename(filePath)}`,
        file: filePath,
        severity: "high",
      });
    }
  });

  // Check for common mistakes
  if (content.includes("print(") && !content.includes("import 'package:flutter")) {
    errors.push({
      type: "Missing Flutter Import",
      message: `Gunakan Flutter logging, bukan print() di ${path.basename(filePath)}`,
      file: filePath,
      severity: "medium",
    });
  }

  if (content.match(/context\\.size/) && !content.includes("MediaQuery")) {
    errors.push({
      type: "Missing MediaQuery",
      message: `Gunakan MediaQuery sebelum akses context.size di ${path.basename(filePath)}`,
      file: filePath,
      severity: "high",
    });
  }

  return errors;
}

function detectPubspecErrors(content) {
  const errors = [];

  // Check YAML syntax
  const lines = content.split("\\n");
  let prevIndent = 0;

  lines.forEach((line, idx) => {
    const match = line.match(/^(\s*)/);
    const indent = match ? match[1].length : 0;

    if (indent % 2 !== 0 && line.trim()) {
      errors.push({
        type: "YAML Syntax Error",
        message: `Indentasi tidak valid di baris ${idx + 1} (pubspec.yaml)`,
        file: "pubspec.yaml",
        severity: "high",
      });
    }
  });

  // Check for missing required fields
  if (!content.includes("name:")) {
    errors.push({
      type: "Missing Field",
      message: `Field 'name:' required di pubspec.yaml`,
      file: "pubspec.yaml",
      severity: "high",
    });
  }

  if (!content.includes("version:")) {
    errors.push({
      type: "Missing Field",
      message: `Field 'version:' required di pubspec.yaml`,
      file: "pubspec.yaml",
      severity: "high",
    });
  }

  // Check for empty dependencies
  const depsMatch = content.match(/dependencies:\\s*\\n\\s*flutter:/);
  if (!depsMatch) {
    errors.push({
      type: "Dependencies Error",
      message: `Flutter dependency tidak ditemukan di pubspec.yaml`,
      file: "pubspec.yaml",
      severity: "high",
    });
  }

  return errors;
}

function detectGradleErrors(content, filePath) {
  const errors = [];
  const fileName = path.basename(filePath);

  // Check for version issues
  if (fileName.includes("build.gradle")) {
    if (!content.includes("compileSdkVersion") && !content.includes("compileSdk")) {
      errors.push({
        type: "Gradle Config Error",
        message: `compileSdk tidak ditemukan di ${fileName}`,
        file: filePath,
        severity: "high",
      });
    }

    if (!content.includes("targetSdkVersion") && !content.includes("targetSdk")) {
      errors.push({
        type: "Gradle Config Error",
        message: `targetSdk tidak ditemukan di ${fileName}`,
        file: filePath,
        severity: "high",
      });
    }

    // Check for invalid syntax
    if (content.match(/\\{\\s*\\{/)) {
      errors.push({
        type: "Gradle Syntax Error",
        message: `Double braces ditemukan di ${fileName}`,
        file: filePath,
        severity: "high",
      });
    }
  }

  return errors;
}

function detectManifestErrors(content) {
  const errors = [];

  if (!content.includes("<manifest")) {
    errors.push({
      type: "XML Error",
      message: `Tag manifest tidak ditemukan di AndroidManifest.xml`,
      file: "AndroidManifest.xml",
      severity: "high",
    });
  }

  if (!content.includes("package=")) {
    errors.push({
      type: "Manifest Error",
      message: `Package attribute tidak ditemukan di AndroidManifest.xml`,
      file: "AndroidManifest.xml",
      severity: "high",
    });
  }

  if (!content.includes("<application")) {
    errors.push({
      type: "Manifest Error",
      message: `Application tag tidak ditemukan di AndroidManifest.xml`,
      file: "AndroidManifest.xml",
      severity: "high",
    });
  }

  return errors;
}

function findGradleFiles(baseDir) {
  const gradleFiles = [];

  function searchDir(dir) {
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      items.forEach(item => {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory() && !item.name.startsWith(".")) {
          searchDir(fullPath);
        } else if (item.name.endsWith(".gradle")) {
          gradleFiles.push(fullPath);
        }
      });
    } catch (e) {}
  }

  searchDir(baseDir);
  return gradleFiles;
}

function checkBaseCleanup(userId) {
  try {
    const state = checkBaseStates.get(userId);
    if (state && state.extractDir && fs.existsSync(state.extractDir)) {
      fs.rmSync(state.extractDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error("Cleanup error:", e.message);
  }
  checkBaseStates.delete(userId);
}

async function showDetailErrors(chatId, userId, msgId, errors) {
  let detailMsg = `📋 **DETAIL ERROR LENGKAP**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  const errorsByType = {};
  errors.forEach(err => {
    if (!errorsByType[err.type]) errorsByType[err.type] = [];
    errorsByType[err.type].push(err);
  });

  for (const [type, typeErrors] of Object.entries(errorsByType)) {
    detailMsg += `**${type} (${typeErrors.length} error)**\n\n`;
    typeErrors.forEach((err, idx) => {
      const severity = err.severity === "high" ? "🔴" : "🟡";
      detailMsg += `${severity} #${idx + 1}\n`;
      detailMsg += `📄 File: ${path.basename(err.file)}\n`;
      detailMsg += `⚠️ Error: ${err.message}\n\n`;
    });
  }

  detailMsg += `\n✨ Gunakan **Fix Base** untuk memperbaiki error ini secara otomatis.`;

  await send(chatId, detailMsg, [
    [{ text: "🔧 Fix Base", data: "fix_base" }],
    [{ text: "🏠 Menu Utama", data: "start" }],
  ]);
}

async function handleFixBase(chatId, userId, msgId, state) {
  const statusMsg = await send(chatId, `⏳ **Memperbaiki error di base...**\n\nMohon tunggu sebentar.`);

  try {
    const extractDir = state.extractDir;
    const errors = state.errors;
    let fixedCount = 0;

    // Fix Dart files
    const dartFiles = findDartFiles(extractDir);
    dartFiles.forEach(dartFile => {
      let content = fs.readFileSync(dartFile, "utf-8");
      const originalContent = content;

      // Fix double braces
      content = content.replace(/{{2,}}/g, "{");
      content = content.replace(/}}\s*}/g, "}}");

      // Fix missing semicolons in imports
      content = content.replace(/^(\s*import\s+['\"][^'\"]+['\"])(\s*$)/gm, "\$1;");

      // Fix common syntax errors
      content = content.replace(/class\s+(\w+)\s*{\s*$/gm, "class \$1 {");

      if (content !== originalContent) {
        fs.writeFileSync(dartFile, content);
        fixedCount++;
      }
    });

    // Fix pubspec.yaml
    const pubspecPath = path.join(extractDir, "pubspec.yaml");
    if (fs.existsSync(pubspecPath)) {
      let pubspecContent = fs.readFileSync(pubspecPath, "utf-8");
      const originalPubspec = pubspecContent;

      // Fix indentation
      const lines = pubspecContent.split("\\n");
      const fixedLines = lines.map((line, idx) => {
        const match = line.match(/^(\s*)/);
        const indent = match ? match[1].length : 0;
        if (indent % 2 !== 0 && line.trim()) {
          return " " + line;
        }
        return line;
      });
      pubspecContent = fixedLines.join("\\n");

      if (pubspecContent !== originalPubspec) {
        fs.writeFileSync(pubspecPath, pubspecContent);
        fixedCount++;
      }
    }

    // Fix gradle files
    const gradleFiles = findGradleFiles(extractDir);
    gradleFiles.forEach(gradleFile => {
      let content = fs.readFileSync(gradleFile, "utf-8");
      const originalContent = content;

      // Fix double braces
      content = content.replace(/{{2,}}/g, "{");
      content = content.replace(/}}\s*}/g, "}}");

      // Ensure required gradle configs
      if (!content.includes("compileSdkVersion") && !content.includes("compileSdk")) {
        content = content.replace(
          /(android\s*{)/,
          "\$1\\n    compileSdk 31"
        );
      }

      if (content !== originalContent) {
        fs.writeFileSync(gradleFile, content);
        fixedCount++;
      }
    });

    // Create fixed ZIP
    const outName = `fixed_base_${state.originalFileName || "base.zip"}`;
    const outPath = tmpPath(outName);

    const zip = new AdmZip();
    function zipDir(dirPath, zipPath) {
      const items = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dirPath, item.name);
        if (item.isDirectory()) {
          zipDir(fullPath, path.join(zipPath, item.name));
        } else {
          zip.addFile(path.join(zipPath, item.name), fs.readFileSync(fullPath));
        }
      }
    }

    zipDir(extractDir, "");
    zip.writeZip(outPath);

    await edit(
      chatId,
      statusMsg.id,
      `✅ **Perbaikan Selesai!**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📁 File yang diperbaiki: ${fixedCount}\n` +
      `🔧 Tipe error yang diperbaiki:\n` +
      `  • Syntax errors\n` +
      `  • Missing semicolons\n` +
      `  • Indentation issues\n` +
      `  • Brace mismatches\n\n` +
      `📤 Mengupload base yang sudah diperbaiki...`
    );

    await client.sendFile(chatId, {
      file: outPath,
      caption:
        `✅ **Base Sudah Diperbaiki!**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `✨ Error telah diperbaiki otomatis\n` +
        `📁 File termodifikasi: ${fixedCount}\n\n` +
        `🔍 Rekomendasi:\n` +
        `  1. Cek error sekali lagi dengan CHECK BASE\n` +
        `  2. Jika masih ada error, benerin manual\n` +
        `  3. Test build sebelum upload ke production\n\n` +
        `🎉 Base sudah siap untuk di-build!`,
      parseMode: "md",
    });

    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

    await edit(
      chatId,
      statusMsg.id,
      `✅ **Fix Base Selesai!**\n\nBase yang sudah diperbaiki telah dikirim di atas. 👆`,
      [[{ text: "🏠 Menu Utama", data: "start" }]]
    );

    checkBaseCleanup(userId);
  } catch (err) {
    checkBaseCleanup(userId);
    console.error("Error in handleFixBase:", err);
    await edit(
      chatId,
      statusMsg.id,
      `❌ **Gagal memperbaiki base!**\n\n\`${escapeMd(err.message)}\``
    );
  }
}

// ============================================
// 🎨 ROMBAK WARNA BASE HANDLERS
// ============================================

async function handleRombaWarna(chatId, userId, msgId) {
  rombaWarnaStates.set(userId, { step: "waiting_base_zip" });
  await send(
    chatId,
    `🎨 **ROMBAK WARNA BASE**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Fitur ini akan mengubah SEMUA WARNA di project Flutter Anda:\n\n` +
    `📊 Fitur:\n` +
    `  ✨ Scan semua warna di Dart files\n` +
    `  🎨 Tampilkan list lengkap warna yang ada\n` +
    `  🔄 User input warna baru untuk setiap warna lama\n` +
    `  ✅ Replace otomatis & build tanpa error\n\n` +
    `📦 **Kirim file ZIP base Flutter kamu sekarang!**\n\n` +
    `__Format: .zip | Maks ukuran: 2 GB__`,
    [[{ text: "❌ Batalkan", data: "start" }]],
    msgId
  );
}

async function handleRombaWarnaZip(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const msg = event.message;
  const state = rombaWarnaStates.get(userId);

  if (!state || state.step !== "waiting_base_zip") return false;

  const media = msg.media;
  if (!media || !media.document) {
    await send(chatId, `⚠️ Kirim file **ZIP**-nya ya, bukan teks atau foto!`);
    return true;
  }

  const doc = media.document;
  const fileName = doc.attributes?.find((a) => a.fileName)?.fileName || "base.zip";
  if (!fileName.endsWith(".zip")) {
    await send(chatId, `❌ File harus berformat **.zip**!\n\nKirim ulang file ZIP base kamu.`);
    return true;
  }

  const statusMsg = await send(chatId, `📥 **Mengunduh base ZIP...**\n\nMohon tunggu sebentar.`);

  try {
    if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });

    const ts = Date.now();
    const zipPath = tmpPath(`rombak_warna_${userId}_${ts}.zip`);
    await client.downloadMedia(msg, { outputFile: zipPath });

    await edit(chatId, statusMsg.id, `🔍 **Menganalisis warna di base...**`);

    const extractDir = tmpPath(`rombak_warna_ext_${userId}_${ts}`);
    fs.mkdirSync(extractDir, { recursive: true });

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);
    fs.unlinkSync(zipPath);

    // Scan semua warna di Dart files
    const allColors = scanAllColorsInBase(extractDir);

    if (allColors.size === 0) {
      await edit(
        chatId,
        statusMsg.id,
        `⚠️ **Tidak ada warna ditemukan!**\n\nBase Anda tidak memiliki Color() atau color definitions yang bisa dirombak.`,
        [[{ text: "🏠 Menu Utama", data: "start" }]]
      );
      rombaWarnaCleanup(userId);
      return true;
    }

    rombaWarnaStates.set(userId, {
      step: "waiting_color_selection",
      extractDir,
      originalFileName: fileName,
      allColors: Array.from(allColors.entries()),
      currentColorIndex: 0,
      colorMappings: new Map(),
    });

    await showRombaWarnaColor(chatId, userId, statusMsg.id);

  } catch (err) {
    rombaWarnaCleanup(userId);
    await edit(
      chatId,
      statusMsg.id,
      `❌ **Gagal memproses ZIP!**\n\n\`${escapeMd(err.message)}\``
    );
  }

  return true;
}

function scanAllColorsInBase(baseDir) {
  const allColors = new Map();

  const dartFiles = findDartFiles(baseDir);
  dartFiles.forEach(dartFile => {
    try {
      const content = fs.readFileSync(dartFile, "utf-8");
      
      // Pattern 1: Color(0xFF...)
      const pattern1 = /Color\((0xFF[0-9A-Fa-f]{6,8})\)/g;
      let match;
      while ((match = pattern1.exec(content)) !== null) {
        const colorValue = match[1];
        if (!allColors.has(colorValue)) {
          allColors.set(colorValue, { 
            value: colorValue, 
            files: [], 
            count: 0,
            type: "Color()" 
          });
        }
        const colorData = allColors.get(colorValue);
        colorData.count++;
        if (!colorData.files.includes(path.basename(dartFile))) {
          colorData.files.push(path.basename(dartFile));
        }
      }

      // Pattern 2: Colors.xxx
      const pattern2 = /Colors\.([a-zA-Z0-9_]+)/g;
      while ((match = pattern2.exec(content)) !== null) {
        const colorName = match[1];
        const key = `Colors.${colorName}`;
        if (!allColors.has(key)) {
          allColors.set(key, { 
            value: key, 
            files: [], 
            count: 0,
            type: "Colors" 
          });
        }
        const colorData = allColors.get(key);
        colorData.count++;
        if (!colorData.files.includes(path.basename(dartFile))) {
          colorData.files.push(path.basename(dartFile));
        }
      }

      // Pattern 3: const/final color definitions
      const pattern3 = /(?:const|final)\s+\w+\s*=\s*Color\((0xFF[0-9A-Fa-f]{6,8})\)/g;
      while ((match = pattern3.exec(content)) !== null) {
        const colorValue = match[1];
        if (!allColors.has(colorValue)) {
          allColors.set(colorValue, { 
            value: colorValue, 
            files: [], 
            count: 0,
            type: "Const" 
          });
        }
        const colorData = allColors.get(colorValue);
        colorData.count++;
        if (!colorData.files.includes(path.basename(dartFile))) {
          colorData.files.push(path.basename(dartFile));
        }
      }
    } catch (e) {
      console.error(`Error scanning ${dartFile}:`, e.message);
    }
  });

  return allColors;
}

async function showRombaWarnaColor(chatId, userId, msgId) {
  const state = rombaWarnaStates.get(userId);
  if (!state) return;

  const idx = state.currentColorIndex;
  const allColors = state.allColors;

  if (idx >= allColors.length) {
    // Semua warna sudah diinput, apply perubahan
    return await applyRombaWarnaChanges(chatId, userId, msgId, state);
  }

  const [colorKey, colorData] = allColors[idx];
  const filenames = colorData.files.slice(0, 3).join(", ");
  const moreFiles = colorData.files.length > 3 ? ` +${colorData.files.length - 3} file lagi` : "";

  let message = `🎨 **GANTI WARNA - Nomor ${idx + 1} dari ${allColors.length}**\n`;
  message += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  message += `📌 **Warna Lama:** \`${colorKey}\`\n`;
  message += `📊 **Digunakan di:** ${colorData.count}x\n`;
  message += `📁 **Files:** ${filenames}${moreFiles}\n\n`;
  message += `💡 **Contoh warna baru:**\n`;
  message += `  • 0xFF000000 (Hitam)\n`;
  message += `  • 0xFFFFFFFF (Putih)\n`;
  message += `  • 0xFF0000FF (Biru)\n`;
  message += `  • 0xFFFF0000 (Merah)\n`;
  message += `  • 0xFF00AA00 (Hijau)\n\n`;
  message += `✍️ **Kirim warna baru (format: 0xFFxxxxxx) atau ketik "SKIP" untuk lewati:**`;

  await edit(chatId, msgId, message);
}

async function handleRombaWarnaColorInput(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const text = event.message.text?.trim() || "";
  const state = rombaWarnaStates.get(userId);

  if (!state || state.step !== "waiting_color_selection") return false;

  const idx = state.currentColorIndex;
  const [colorKey, colorData] = state.allColors[idx];

  if (text.toUpperCase() === "SKIP") {
    // Skip warna ini
    state.currentColorIndex++;
    const statusMsg = await send(chatId, `⏭️ **Warna dilewati!**`);
    await sleep(1000);
    await showRombaWarnaColor(chatId, userId, statusMsg.id);
    return true;
  }

  // Validasi format warna
  const colorRegex = /^0x[fF]{1}[0-9a-fA-F]{6}$/;
  if (!colorRegex.test(text)) {
    await send(
      chatId,
      `❌ **Format tidak valid!**\n\nGunakan format: 0xFFxxxxxx\nContoh: 0xFF0000FF (Biru)\n\nCoba lagi!`
    );
    return true;
  }

  // Simpan mapping
  state.colorMappings.set(colorKey, text.toUpperCase());

  // Lanjut ke warna berikutnya
  state.currentColorIndex++;
  const statusMsg = await send(chatId, `✅ **Warna disimpan:** \`${text.toUpperCase()}\``);
  await sleep(1000);
  await showRombaWarnaColor(chatId, userId, statusMsg.id);

  return true;
}

async function applyRombaWarnaChanges(chatId, userId, msgId, state) {
  const statusMsg = await send(chatId, `⏳ **Menerapkan perubahan warna...**\n\nMohon tunggu sebentar.`);

  try {
    const extractDir = state.extractDir;
    const colorMappings = state.colorMappings;

    let totalReplaced = 0;
    let filesModified = 0;

    // Apply perubahan ke semua Dart files
    const dartFiles = findDartFiles(extractDir);
    dartFiles.forEach(dartFile => {
      try {
        let content = fs.readFileSync(dartFile, "utf-8");
        let modified = false;

        for (const [oldColor, newColor] of colorMappings.entries()) {
          // Replace Color(oldColor)
          const pattern1 = new RegExp(`Color\\(${oldColor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, "g");
          if (pattern1.test(content)) {
            content = content.replace(pattern1, `Color(${newColor})`);
            modified = true;
            totalReplaced++;
          }

          // Replace direct hex values
          const pattern2 = new RegExp(`\\b${oldColor}\\b`, "g");
          if (pattern2.test(content)) {
            content = content.replace(pattern2, newColor);
            modified = true;
            totalReplaced++;
          }
        }

        if (modified) {
          fs.writeFileSync(dartFile, content, "utf-8");
          filesModified++;
        }
      } catch (e) {
        console.error(`Error modifying ${dartFile}:`, e.message);
      }
    });

    // Create ZIP dengan perubahan
    const outName = `rombak_warna_${state.originalFileName || "base.zip"}`;
    const outPath = tmpPath(outName);

    const zip = new AdmZip();
    function zipDir(dirPath, zipPath) {
      const items = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dirPath, item.name);
        if (item.isDirectory()) {
          zipDir(fullPath, path.join(zipPath, item.name));
        } else {
          zip.addFile(path.join(zipPath, item.name), fs.readFileSync(fullPath));
        }
      }
    }

    zipDir(extractDir, "");
    zip.writeZip(outPath);

    await edit(
      chatId,
      statusMsg.id,
      `✅ **Warna berhasil dirombak!**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🎨 **Statistik Perubahan:**\n` +
      `📁 File Dart: ${dartFiles.length}\n` +
      `✏️ File dimodif: ${filesModified}\n` +
      `🔄 Total perubahan warna: ${totalReplaced}\n\n` +
      `📤 Mengupload base...`
    );

    await client.sendFile(chatId, {
      file: outPath,
      caption:
        `✅ **Base Rombak Warna Selesai!**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🎨 **Hasil Perubahan:**\n` +
        `📁 File Dart: ${dartFiles.length}\n` +
        `✏️ File dimodif: ${filesModified}\n` +
        `🔄 Total perubahan: ${totalReplaced}\n\n` +
        `📝 **Warna yang diganti:**\n` +
        Array.from(state.colorMappings.entries())
          .map(([old, newVal]) => `  • ${old} → ${newVal}`)
          .join("\n") +
        `\n\n🔍 **Tips:**\n` +
        `  1. Cek dengan CHECK BASE untuk verifikasi\n` +
        `  2. Test build sebelum deploy\n` +
        `  3. Jika ada error, gunakan FIX BASE\n\n` +
        `🎉 Base siap untuk di-build!`,
      parseMode: "md",
    });

    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

    await edit(
      chatId,
      statusMsg.id,
      `✅ **Rombak Warna Selesai!**\n\nBase yang sudah dirombak telah dikirim di atas. 👆`,
      [[{ text: "🏠 Menu Utama", data: "start" }]]
    );

    rombaWarnaCleanup(userId);
  } catch (err) {
    rombaWarnaCleanup(userId);
    console.error("Error in applyRombaWarnaChanges:", err);
    await send(chatId, `❌ **Gagal menerapkan perubahan warna!**\n\n\`${escapeMd(err.message)}\``);
  }
}

function rombaWarnaCleanup(userId) {
  try {
    const state = rombaWarnaStates.get(userId);
    if (state && state.extractDir && fs.existsSync(state.extractDir)) {
      fs.rmSync(state.extractDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error("Cleanup error:", e.message);
  }
  rombaWarnaStates.delete(userId);
}

// ══════════════════════════════════════════════════════
// 🔧 FLUTTER MOD — GANTI DOMAIN / WARNA / ICON / NAMA
// Real process, real channel log, no fake / no simulation
// ══════════════════════════════════════════════════════

async function sendMonitorPhoto(target, caption, buttons = null) {
  try {
    const photo = await resolveMediaFile(MON_PHOTO_URL);
    const kb = buttons ? buildButtons(buttons) : undefined;
    if (photo) {
      return await client.sendFile(target, {
        file: photo,
        caption,
        parseMode: 'html',
        ...(kb ? { buttons: kb } : {}),
      });
    }
    return await client.sendMessage(target, {
      message: caption,
      parseMode: 'html',
      ...(kb ? { buttons: kb } : {}),
    });
  } catch (e) {
    console.error('[sendMonitorPhoto]', e.message);
  }
}

async function notifyModChannel(userId, actionLabel, extra = {}) {
  try {
    const logCh = CONFIG.LOG_CHANNEL_ID;
    if (!logCh) return;
    const name = (await client.getEntity(userId).catch(() => null))?.firstName || 'User';
    let extraText = '';
    for (const [k, v] of Object.entries(extra)) extraText += `\n• ${k}: ${v}`;
    const caption = `📡 <b>MOD LIVE</b>\n━━━━━━━━━━━━━━\n👤 ${name} (<code>${userId}</code>)\n🎯 ${actionLabel}${extraText}\n⏰ ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`;
    await sendMonitorPhoto(logCh, caption);
  } catch (e) {
    console.error('[notifyModChannel]', e.message);
  }
}

function modCleanup(userId) {
  try {
    const st = modStates.get(userId);
    if (st?.localZip && fs.existsSync(st.localZip)) fs.unlinkSync(st.localZip);
    if (st?.outZip && fs.existsSync(st.outZip)) fs.unlinkSync(st.outZip);
  } catch (_) {}
  modStates.delete(userId);
}

async function handleModDomainStart(chatId, userId, msgId) {
  modCleanup(userId);
  modStates.set(userId, { step: 'waiting_zip_domain' });
  await send(chatId, `🔧 **GANTI DOMAIN**\n\nKirim file .zip project Flutter yang ingin diganti domain-nya.\n\nBot akan scan semua URL di file .dart lalu kamu pilih mana yang diganti.`, [
    [{ text: '❌ Batalkan', callback_data: 'cancel', style: 'danger' }]
  ], msgId);
}

async function handleModColorStart(chatId, userId, msgId) {
  modCleanup(userId);
  modStates.set(userId, { step: 'waiting_zip_color' });
  await send(chatId, `🎨 **GANTI WARNA**\n\nKirim file .zip project Flutter.\nBot akan scan warna hex dominan di .dart / colors.xml / pubspec.`, [
    [{ text: '❌ Batalkan', callback_data: 'cancel', style: 'danger' }]
  ], msgId);
}

async function handleModIconStart(chatId, userId, msgId) {
  modCleanup(userId);
  modStates.set(userId, { step: 'waiting_zip_icon' });
  await send(chatId, `🖼️ **GANTI ICON**\n\nKirim file .zip project Flutter.\nBot scan slot icon Android (mipmap) + iOS (AppIcon).`, [
    [{ text: '❌ Batalkan', callback_data: 'cancel', style: 'danger' }]
  ], msgId);
}

async function handleModNameStart(chatId, userId, msgId) {
  modCleanup(userId);
  modStates.set(userId, { step: 'waiting_zip_name' });
  await send(chatId, `✏️ **GANTI NAMA APK**\n\nKirim file .zip project Flutter.\nBot akan ganti label di AndroidManifest, strings.xml, Info.plist, dll.`, [
    [{ text: '❌ Batalkan', callback_data: 'cancel', style: 'danger' }]
  ], msgId);
}

async function handleModPickUrl(chatId, userId, msgId, idx) {
  const state = modStates.get(userId);
  if (!state || state.step !== 'waiting_pick_url' || !state.urls || !state.urls[idx]) {
    return send(chatId, '⚠️ State tidak valid. Mulai ulang dari menu.');
  }
  state.oldUrl = state.urls[idx][0];
  state.step = 'waiting_new_url';
  await edit(chatId, msgId, `🔧 Domain lama dipilih:\n\`${state.oldUrl}\`\n\nKirim domain / URL baru (contoh: https://domain-baru.com):`);
}

async function handleModPresetColor(chatId, userId, msgId, key) {
  const state = modStates.get(userId);
  if (!state || !state.oldHex) return send(chatId, '⚠️ State tidak valid.');
  const newHex = fluttermod.COLOR_PRESETS[key];
  if (!newHex) return send(chatId, '⚠️ Preset tidak ditemukan.');
  return await doReplaceColor(chatId, userId, msgId, state.oldHex, newHex);
}

async function handleModCustomColor(chatId, userId, msgId) {
  const state = modStates.get(userId);
  if (!state) return;
  state.step = 'waiting_custom_hex';
  await edit(chatId, msgId, `✏️ Kirim hex warna baru (6 digit, tanpa #):\nContoh: \`FF5722\` atau \`2196F3\``);
}

async function doReplaceColor(chatId, userId, msgId, oldHex, newHex) {
  const state = modStates.get(userId);
  if (!state?.localZip) return;
  const status = await send(chatId, `⚙️ Mengganti warna \`${oldHex}\` → \`${newHex}\`...`, null, msgId);
  const dt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const userName = (await client.getEntity(userId).catch(() => null))?.firstName || 'User';
  try {
    const outZip = tmpPath(`mod_color_out_${userId}_${Date.now()}.zip`);
    const result = fluttermod.replaceColorInZip(state.localZip, outZip, oldHex, newHex);
    if (result.totalOccurrences === 0) {
      await edit(chatId, status.id, `⚠️ Tidak ada kemunculan warna \`${oldHex}\` yang diganti.`);
      const monCaption =
        `⚠️ <b>GANTI WARNA — TIDAK ADA PERUBAHAN</b>\n━━━━━━━━━━━━━━\n` +
        `👤 User : ${userName} (<code>${userId}</code>)\n` +
        `🎨 Old  : #${oldHex}\n🆕 New  : #${newHex}\n⏰ Waktu: ${dt} WIB`;
      sendMonitorPhoto(CONFIG.LOG_CHANNEL_ID, monCaption).catch(() => {});
      modCleanup(userId);
      return;
    }
    // Foto sukses ke user
    const photo = await resolveMediaFile(MON_PHOTO_URL);
    if (photo) {
      await client.sendFile(chatId, {
        file: photo,
        caption: `✅ <b>Warna Berhasil Diganti!</b>\n\n🎨 Old: <code>#${oldHex}</code>\n🆕 New: <code>#${newHex}</code>\n📁 File diubah: ${result.changedFiles.length}\n🔄 Total replace: ${result.totalOccurrences}`,
        parseMode: 'html',
      });
    }
    await client.sendFile(chatId, {
      file: outZip,
      caption: `📦 File ZIP hasil ganti warna`,
      forceDocument: true,
    });
    // Monitor dengan foto
    const monCaption =
      `✅ <b>GANTI WARNA BERHASIL</b>\n━━━━━━━━━━━━━━\n` +
      `👤 User  : ${userName} (<code>${userId}</code>)\n` +
      `🎨 Old   : #${oldHex}\n🆕 New   : #${newHex}\n` +
      `📁 File  : ${result.changedFiles.length}\n🔄 Replace: ${result.totalOccurrences}\n` +
      `⏰ Waktu : ${dt} WIB`;
    sendMonitorPhoto(CONFIG.LOG_CHANNEL_ID, monCaption).catch(() => {});
    try { fs.unlinkSync(outZip); } catch (_) {}
  } catch (err) {
    await edit(chatId, status.id, `❌ Gagal: ${err.message}`);
    const monCaption =
      `❌ <b>GANTI WARNA GAGAL</b>\n━━━━━━━━━━━━━━\n` +
      `👤 User  : ${userName} (<code>${userId}</code>)\n` +
      `🎨 Old   : #${oldHex}\n🆕 New   : #${newHex}\n` +
      `⚠️ Error : ${err.message}\n⏰ Waktu : ${dt} WIB`;
    sendMonitorPhoto(CONFIG.LOG_CHANNEL_ID, monCaption).catch(() => {});
  }
  modCleanup(userId);
}

// Process ZIP for mod features (called from message handler)
async function processModZip(event, type) {
  const msg = event.message;
  const chatId = event.chatId;
  const userId = Number(msg.senderId);
  const state = modStates.get(userId);
  if (!state) return false;

  if (!msg.media?.document) {
    await send(chatId, '⚠️ Kirim file .zip saja.');
    return true;
  }

  const dt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const userName = (await client.getEntity(userId).catch(() => null))?.firstName || 'User';
  const typeLabel = { domain: '🔧 Ganti Domain', color: '🎨 Ganti Warna', icon: '🖼️ Ganti Icon', name: '✏️ Ganti Nama' }[type] || type;
  // Notif mulai proses ke monitor
  sendMonitorPhoto(CONFIG.LOG_CHANNEL_ID,
    `⏳ <b>PROSES DIMULAI — ${typeLabel.toUpperCase()}</b>\n━━━━━━━━━━━━━━\n` +
    `👤 User  : ${userName} (<code>${userId}</code>)\n⏰ Waktu : ${dt} WIB`
  ).catch(() => {});

  const status = await send(chatId, `🔄 Mengunduh & memproses ZIP...`);
  try {
    const localZip = tmpPath(`mod_${type}_${userId}_${Date.now()}.zip`);
    await client.downloadMedia(msg, { outputFile: localZip });
    state.localZip = localZip;

    if (type === 'domain') {
      const urls = fluttermod.scanUrlsInZip(localZip);
      if (urls.length === 0) {
        await edit(chatId, status.id, '⚠️ Tidak ditemukan URL/http di file .dart.');
        modCleanup(userId);
        return true;
      }
      state.urls = urls;
      state.step = 'waiting_pick_url';
      const rows = urls.slice(0, 10).map((u, i) => [{ text: `${i + 1}. ${u[0].slice(0, 40)}`, callback_data: `mod_pickurl_${i}` }]);
      rows.push([{ text: '❌ Batalkan', callback_data: 'cancel', style: 'danger' }]);
      await edit(chatId, status.id, `🔧 Ditemukan ${urls.length} domain. Pilih yang mau diganti:`, rows);
      return true;
    }

    if (type === 'color') {
      const colors = fluttermod.scanDominantColors(localZip);
      if (colors.length === 0) {
        state.oldHex = '000000';
        state.step = 'waiting_pick_color';
        await edit(chatId, status.id, '⚠️ Tidak ada warna hex terdeteksi otomatis. Kamu tetap bisa pilih preset/custom.');
      } else {
        state.oldHex = colors[0][0];
        state.step = 'waiting_pick_color';
        await edit(chatId, status.id, `🎨 Warna dominan terdeteksi: \`${state.oldHex}\` (${colors[0][1]}x)\n\nPilih warna pengganti:`);
      }
      const keys = Object.keys(fluttermod.COLOR_PRESETS);
      const rows = [];
      for (let i = 0; i < keys.length; i += 3) {
        rows.push(keys.slice(i, i + 3).map(k => ({ text: k.toUpperCase(), callback_data: `mod_preset_${k}` })));
      }
      rows.push([{ text: '✏️ Custom Hex', callback_data: 'mod_custom_color' }]);
      rows.push([{ text: '❌ Batalkan', callback_data: 'cancel', style: 'danger' }]);
      await client.editMessage(chatId, { message: status.id, text: `🎨 Warna dominan: \`${state.oldHex}\`\n\nPilih warna pengganti:`, buttons: buildButtons(rows) });
      return true;
    }

    if (type === 'icon') {
      const targets = fluttermod.scanIconTargets(localZip);
      if (targets.length === 0) {
        await edit(chatId, status.id, '⚠️ Tidak ditemukan slot icon Android/iOS di project ini.');
        modCleanup(userId);
        return true;
      }
      state.step = 'waiting_icon_image';
      state.iconTargetsCount = targets.length;
      await edit(chatId, status.id, `✅ Ditemukan ${targets.length} slot icon.\n\n📤 Sekarang kirim gambar icon baru (PNG/JPG, disarankan persegi):`);
      return true;
    }

    if (type === 'name') {
      state.step = 'waiting_new_name';
      await edit(chatId, status.id, `✏️ ZIP diterima. Kirim nama aplikasi baru:`);
      return true;
    }
  } catch (err) {
    await edit(chatId, status.id, `❌ Error: ${err.message}`);
    const dt2 = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const userName2 = (await client.getEntity(userId).catch(() => null))?.firstName || 'User';
    sendMonitorPhoto(CONFIG.LOG_CHANNEL_ID,
      `❌ <b>ERROR PROSES ZIP</b>\n━━━━━━━━━━━━━━\n` +
      `👤 User  : ${userName2} (<code>${userId}</code>)\n` +
      `⚠️ Error : ${err.message}\n⏰ Waktu : ${dt2} WIB`
    ).catch(() => {});
    modCleanup(userId);
  }
  return true;
}

async function processModNewUrl(event) {
  const msg = event.message;
  const chatId = event.chatId;
  const userId = Number(msg.senderId);
  const text = msg?.text?.trim();
  const state = modStates.get(userId);
  if (!state || state.step !== 'waiting_new_url' || !text) return false;

  const newUrl = text.startsWith('http') ? text : `https://${text}`;
  const status = await send(chatId, `⚙️ Mengganti domain...`);
  const dt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const userName = (await client.getEntity(userId).catch(() => null))?.firstName || 'User';
  try {
    const outZip = tmpPath(`mod_domain_out_${userId}_${Date.now()}.zip`);
    const result = fluttermod.replaceDomainInZip(state.localZip, outZip, state.oldUrl, newUrl);
    if (result.totalOccurrences === 0) {
      await edit(chatId, status.id, '⚠️ Tidak ada kemunculan domain lama yang diganti.');
      // Foto gagal ke monitor
      const monCaption =
        `⚠️ <b>GANTI DOMAIN — TIDAK ADA PERUBAHAN</b>\n━━━━━━━━━━━━━━\n` +
        `👤 User : ${userName} (<code>${userId}</code>)\n` +
        `🔴 Old  : ${state.oldUrl}\n🟢 New  : ${newUrl}\n` +
        `⏰ Waktu: ${dt} WIB`;
      sendMonitorPhoto(CONFIG.LOG_CHANNEL_ID, monCaption).catch(() => {});
    } else {
      // Kirim file hasil dengan foto caption
      const photo = await resolveMediaFile(MON_PHOTO_URL);
      if (photo) {
        await client.sendFile(chatId, {
          file: photo,
          caption: `✅ <b>Domain Berhasil Diganti!</b>\n\n🔴 Old: <code>${state.oldUrl}</code>\n🟢 New: <code>${newUrl}</code>\n📁 File: ${result.changedFiles.length}\n🔄 Replace: ${result.totalOccurrences}`,
          parseMode: 'html',
        });
      }
      await client.sendFile(chatId, {
        file: outZip,
        caption: `📦 File ZIP hasil ganti domain`,
        forceDocument: true,
      });
      // Monitor channel dengan foto
      const monCaption =
        `✅ <b>GANTI DOMAIN BERHASIL</b>\n━━━━━━━━━━━━━━\n` +
        `👤 User  : ${userName} (<code>${userId}</code>)\n` +
        `🔴 Old   : ${state.oldUrl}\n🟢 New   : ${newUrl}\n` +
        `📁 File  : ${result.changedFiles.length}\n🔄 Replace: ${result.totalOccurrences}\n` +
        `⏰ Waktu : ${dt} WIB`;
      sendMonitorPhoto(CONFIG.LOG_CHANNEL_ID, monCaption).catch(() => {});
    }
    try { fs.unlinkSync(outZip); } catch (_) {}
  } catch (err) {
    await edit(chatId, status.id, `❌ Gagal: ${err.message}`);
    const monCaption =
      `❌ <b>GANTI DOMAIN GAGAL</b>\n━━━━━━━━━━━━━━\n` +
      `👤 User  : ${userName} (<code>${userId}</code>)\n` +
      `🔴 Old   : ${state.oldUrl}\n🟢 New   : ${newUrl}\n` +
      `⚠️ Error : ${err.message}\n⏰ Waktu : ${dt} WIB`;
    sendMonitorPhoto(CONFIG.LOG_CHANNEL_ID, monCaption).catch(() => {});
  }
  modCleanup(userId);
  return true;
}

async function processModCustomHex(event) {
  const msg = event.message;
  const chatId = event.chatId;
  const userId = Number(msg.senderId);
  const text = (msg?.text || '').trim().replace(/^#/, '');
  const state = modStates.get(userId);
  if (!state || state.step !== 'waiting_custom_hex') return false;
  if (!fluttermod.isValidHex(text)) {
    await send(chatId, '⚠️ Hex tidak valid. Kirim 6 digit hex (contoh: FF5722).');
    return true;
  }
  await doReplaceColor(chatId, userId, null, state.oldHex, text.toUpperCase());
  return true;
}

async function processModIconImage(event) {
  const msg = event.message;
  const chatId = event.chatId;
  const userId = Number(msg.senderId);
  const state = modStates.get(userId);
  if (!state || state.step !== 'waiting_icon_image' || !msg.media) return false;

  const status = await send(chatId, `⚙️ Mengganti icon...`);
  const dt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const userName = (await client.getEntity(userId).catch(() => null))?.firstName || 'User';
  try {
    const iconPath = tmpPath(`icon_src_${userId}_${Date.now()}.png`);
    await client.downloadMedia(msg, { outputFile: iconPath });
    const iconBuffer = await fs.readFile(iconPath);
    try { fs.unlinkSync(iconPath); } catch (_) {}

    const outZip = tmpPath(`mod_icon_out_${userId}_${Date.now()}.zip`);
    const result = await fluttermod.replaceIconInZip(state.localZip, outZip, iconBuffer);
    if (result.changedCount === 0) {
      await edit(chatId, status.id, '⚠️ Tidak ada icon yang berhasil diganti.');
      const monCaption =
        `⚠️ <b>GANTI ICON — TIDAK ADA PERUBAHAN</b>\n━━━━━━━━━━━━━━\n` +
        `👤 User : ${userName} (<code>${userId}</code>)\n⏰ Waktu: ${dt} WIB`;
      sendMonitorPhoto(CONFIG.LOG_CHANNEL_ID, monCaption).catch(() => {});
    } else {
      const resizeNote = result.resized ? '✅ Resize otomatis (sharp)' : '⚠️ sharp tidak ada — tanpa resize';
      // Foto sukses ke user
      const photo = await resolveMediaFile(MON_PHOTO_URL);
      if (photo) {
        await client.sendFile(chatId, {
          file: photo,
          caption: `✅ <b>Icon Berhasil Diganti!</b>\n\n🖼 File diganti: ${result.changedCount}\n${resizeNote}`,
          parseMode: 'html',
        });
      }
      await client.sendFile(chatId, {
        file: outZip,
        caption: `📦 File ZIP hasil ganti icon`,
        forceDocument: true,
      });
      // Monitor dengan foto
      const monCaption =
        `✅ <b>GANTI ICON BERHASIL</b>\n━━━━━━━━━━━━━━\n` +
        `👤 User   : ${userName} (<code>${userId}</code>)\n` +
        `🖼 Diganti : ${result.changedCount} file\n` +
        `⏰ Waktu  : ${dt} WIB`;
      sendMonitorPhoto(CONFIG.LOG_CHANNEL_ID, monCaption).catch(() => {});
    }
    try { fs.unlinkSync(outZip); } catch (_) {}
  } catch (err) {
    await edit(chatId, status.id, `❌ Gagal: ${err.message}`);
    const monCaption =
      `❌ <b>GANTI ICON GAGAL</b>\n━━━━━━━━━━━━━━\n` +
      `👤 User  : ${userName} (<code>${userId}</code>)\n` +
      `⚠️ Error : ${err.message}\n⏰ Waktu : ${dt} WIB`;
    sendMonitorPhoto(CONFIG.LOG_CHANNEL_ID, monCaption).catch(() => {});
  }
  modCleanup(userId);
  return true;
}

async function processModNewName(event) {
  const msg = event.message;
  const chatId = event.chatId;
  const userId = Number(msg.senderId);
  const text = msg?.text?.trim();
  const state = modStates.get(userId);
  if (!state || state.step !== 'waiting_new_name' || !text) return false;

  const status = await send(chatId, `⚙️ Mengganti nama app...`);
  const dt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const userName = (await client.getEntity(userId).catch(() => null))?.firstName || 'User';
  try {
    const outZip = tmpPath(`mod_name_out_${userId}_${Date.now()}.zip`);
    const result = fluttermod.replaceAppNameInZip(state.localZip, outZip, text);
    if (result.totalOccurrences === 0) {
      await edit(chatId, status.id, '⚠️ Tidak ditemukan tempat untuk mengganti nama app.');
      const monCaption =
        `⚠️ <b>GANTI NAMA — TIDAK ADA PERUBAHAN</b>\n━━━━━━━━━━━━━━\n` +
        `👤 User : ${userName} (<code>${userId}</code>)\n` +
        `✏️ Nama : ${text}\n⏰ Waktu: ${dt} WIB`;
      sendMonitorPhoto(CONFIG.LOG_CHANNEL_ID, monCaption).catch(() => {});
    } else {
      // Foto sukses ke user
      const photo = await resolveMediaFile(MON_PHOTO_URL);
      if (photo) {
        await client.sendFile(chatId, {
          file: photo,
          caption: `✅ <b>Nama App Berhasil Diganti!</b>\n\n✏️ Nama baru: <code>${text}</code>\n📁 File diubah: ${result.changedFiles.length}\n🔄 Total: ${result.totalOccurrences}`,
          parseMode: 'html',
        });
      }
      await client.sendFile(chatId, {
        file: outZip,
        caption: `📦 File ZIP hasil ganti nama`,
        forceDocument: true,
      });
      // Monitor dengan foto
      const monCaption =
        `✅ <b>GANTI NAMA BERHASIL</b>\n━━━━━━━━━━━━━━\n` +
        `👤 User  : ${userName} (<code>${userId}</code>)\n` +
        `✏️ Nama  : ${text}\n📁 File  : ${result.changedFiles.length}\n` +
        `🔄 Total : ${result.totalOccurrences}\n⏰ Waktu : ${dt} WIB`;
      sendMonitorPhoto(CONFIG.LOG_CHANNEL_ID, monCaption).catch(() => {});
    }
    try { fs.unlinkSync(outZip); } catch (_) {}
  } catch (err) {
    await edit(chatId, status.id, `❌ Gagal: ${err.message}`);
    const monCaption =
      `❌ <b>GANTI NAMA GAGAL</b>\n━━━━━━━━━━━━━━\n` +
      `👤 User  : ${userName} (<code>${userId}</code>)\n` +
      `✏️ Nama  : ${text}\n⚠️ Error : ${err.message}\n⏰ Waktu : ${dt} WIB`;
    sendMonitorPhoto(CONFIG.LOG_CHANNEL_ID, monCaption).catch(() => {});
  }
  modCleanup(userId);
  return true;
}

async function main() {
  await fs.ensureDir(CONFIG.TMP_DIR);
  await fs.ensureDir('./data');
  await db.load();

  await client.start({
    botAuthToken: CONFIG.BOT_TOKEN,
    onError: err => console.error('Client error:', err),
  });

  fs.writeFileSync(SESSION_FILE, client.session.save());
  console.log(`✅ ${CONFIG.BOT_NAME} v${CONFIG.BOT_VERSION} online!`);

  client.addEventHandler(async event => {
    try { await handleMessage(event); } catch (err) { console.error('Message handler error:', err); }
  }, new NewMessage({}));

  client.addEventHandler(async event => {
    try { await handleCallback(event); } catch (err) { console.error('Callback error:', err); }
  }, new CallbackQuery({}));

  await new Promise(() => {});
}

main().catch(console.error);
