require('dotenv').config();
const Database = require('better-sqlite3');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
} = require('discord.js');

/* =========================
   CLIENT
========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

/* =========================
   DB (SQLite)
========================= */
const db = new Database('./discipline.sqlite');

db.exec(`
CREATE TABLE IF NOT EXISTS punishments (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  warn_start   INTEGER,
  oral_start   INTEGER,
  strict_start INTEGER,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS settings (
  guild_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (guild_id, key)
);
`);

const SQL = {
  getRow: db.prepare(`SELECT * FROM punishments WHERE guild_id=? AND user_id=?`),
  upsertRow: db.prepare(`
    INSERT INTO punishments (guild_id,user_id,warn_start,oral_start,strict_start)
    VALUES (?,?,?,?,?)
    ON CONFLICT(guild_id,user_id) DO UPDATE SET
      warn_start=excluded.warn_start,
      oral_start=excluded.oral_start,
      strict_start=excluded.strict_start
  `),
  setStart: db.prepare(`
    INSERT INTO punishments (guild_id,user_id,warn_start,oral_start,strict_start)
    VALUES (?,?,?,?,?)
    ON CONFLICT(guild_id,user_id) DO UPDATE SET
      warn_start=COALESCE(?, warn_start),
      oral_start=COALESCE(?, oral_start),
      strict_start=COALESCE(?, strict_start)
  `),
  clearStart: db.prepare(`
    UPDATE punishments
    SET warn_start = CASE WHEN ?=1 THEN NULL ELSE warn_start END,
        oral_start = CASE WHEN ?=1 THEN NULL ELSE oral_start END,
        strict_start = CASE WHEN ?=1 THEN NULL ELSE strict_start END
    WHERE guild_id=? AND user_id=?
  `),
  listUsers: db.prepare(`SELECT user_id FROM punishments WHERE guild_id=?`),

  getSetting: db.prepare(`SELECT value FROM settings WHERE guild_id=? AND key=?`),
  setSetting: db.prepare(`
    INSERT INTO settings (guild_id,key,value)
    VALUES (?,?,?)
    ON CONFLICT(guild_id,key) DO UPDATE SET value=excluded.value
  `),
};

/* =========================
   ENV / IDs
========================= */
function envId(key) { return (process.env[key] || '').trim(); }

const GUILD_ID = envId('GUILD_ID');
const PUNISH_CHANNEL_ID = envId('PUNISH_CHANNEL_ID');
const INFO_CHANNEL_ID = envId('INFO_CHANNEL_ID');
const BRAND_NAME = envId('BOT_BRAND_NAME') || null;
const EVIDENCE_CHANNEL_ID = envId('EVIDENCE_CHANNEL_ID');
const EVIDENCE_FORM_URL = (process.env.EVIDENCE_FORM_URL || '').trim();

// Roles
const ROLES = {
  warn:   { r1: envId('ROLE_WARN_1'),   r2: envId('ROLE_WARN_2') },
  oral:   { r1: envId('ROLE_ORAL_1'),   r2: envId('ROLE_ORAL_2') },
  strict: { r1: envId('ROLE_STRICT_1'), r2: envId('ROLE_STRICT_2') },
  reattest: envId('ROLE_REATTEST'),
};

const COLOR = { dogan: 0xE74C3C, undogan: 0x2ECC71 };

/* =========================
   TIME RULES (ms)
   (ВАЖЛИВО: бот НЕ знімає/НЕ видає сам — тільки пише "пройшло ХХ год")
========================= */
const MS = {
  WARN_EXPIRE: 48 * 60 * 60 * 1000,  // 48h -> потрібно зняти попередження
  ORAL_DUE:    72 * 60 * 60 * 1000,  // 72h -> потрібно видати повторно усну
  STRICT_DUE:  48 * 60 * 60 * 1000,  // 48h -> потрібно видати повторно сувору
};

/* =========================
   UTILS
========================= */
function hasDisciplineAccess(member) {
  const allowed = (process.env.DISCIPLINE_ROLES || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

  // якщо список порожній — забороняємо всім (щоб випадково не відкрити доступ)
  if (!allowed.length) return false;

  return member.roles.cache.some(role => allowed.includes(role.id));
}
function pad(n) { return String(n).padStart(2, '0'); }
function formatTime(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function getBotIconUrl() {
  try { return client.user.displayAvatarURL({ extension: 'png', size: 256 }); }
  catch { return client.user.displayAvatarURL({ format: 'png', size: 256 }); }
}
async function silentAck(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
    await interaction.deleteReply().catch(() => {});
  } catch {}
}
function nowMs() { return Date.now(); }
function isPassed(startMs, durationMs) {
  if (!startMs) return false;
  return (Date.now() - startMs) >= durationMs;
}

/* =========================
   ROLE STATE
========================= */
function countFromRoles(member, group) {
  const r1 = ROLES[group].r1;
  const r2 = ROLES[group].r2;
  if (r2 && member.roles.cache.has(r2)) return 2;
  if (r1 && member.roles.cache.has(r1)) return 1;
  return 0;
}
function hasReattest(member) {
  return !!ROLES.reattest && member.roles.cache.has(ROLES.reattest);
}
async function setCount(member, group, count) {
  const r1 = ROLES[group].r1;
  const r2 = ROLES[group].r2;
  if (r1) await member.roles.remove(r1).catch(() => {});
  if (r2) await member.roles.remove(r2).catch(() => {});
  if (count === 1 && r1) await member.roles.add(r1);
  if (count === 2 && r2) await member.roles.add(r2);
}
async function setReattest(member, on) {
  if (!ROLES.reattest) return;
  if (on) await member.roles.add(ROLES.reattest);
  else await member.roles.remove(ROLES.reattest).catch(() => {});
}

/* =========================
   DB SYNC (start times)
========================= */
function ensureDbRow(guildId, userId) {
  const row = SQL.getRow.get(guildId, userId);
  if (row) return row;
  SQL.upsertRow.run(guildId, userId, null, null, null);
  return SQL.getRow.get(guildId, userId);
}

/**
 * Логіка:
 * - якщо ролі з'явилися (0 -> >0) і start пустий -> ставимо start=now
 * - якщо ролі зникли (>0 -> 0) -> чистимо start
 * - якщо ролі залишилися >0 -> start НЕ чіпаємо
 */
function syncStartsWithCurrentCounts(guildId, userId, counts) {
  const row = ensureDbRow(guildId, userId);
  const t = nowMs();

  const warnStart = (counts.w > 0 && !row.warn_start) ? t : null;
  const oralStart = (counts.o > 0 && !row.oral_start) ? t : null;
  const strictStart = (counts.s > 0 && !row.strict_start) ? t : null;

  SQL.setStart.run(
    guildId, userId,
    row.warn_start, row.oral_start, row.strict_start,
    warnStart, oralStart, strictStart
  );

  SQL.clearStart.run(
    counts.w === 0 ? 1 : 0,
    counts.o === 0 ? 1 : 0,
    counts.s === 0 ? 1 : 0,
    guildId, userId
  );
}

/* =========================
   ACCUMULATION (roles)
   Повертаємо ОДИН красивий рядок typeLine зі стрілкою
========================= */
function fmt(type, count) {
  if (type === 'reattest') return 'Переатестація';
  const name =
    type === 'warning' ? 'Попередження' :
    type === 'oral' ? 'Усна догана' :
    'Сувора догана';
  return `${name} (${count}/2)`;
}

async function applyIncrement(member, type) {
  let w = countFromRoles(member, 'warn');
  let o = countFromRoles(member, 'oral');
  let s = countFromRoles(member, 'strict');
  let r = hasReattest(member);

  let typeLine = '';

  const convertWarnToOral = () => { w = 0; o += 1; };
  const convertOralToStrict = () => { o = 0; s += 1; };
  const convertStrictToReattest = () => { s = 0; r = true; };

  if (type === 'reattest') {
    typeLine = 'Переатестація';
    r = true;
    await setReattest(member, true);
    return { typeLine };
  }

  if (type === 'warning') {
    const issued = Math.min(2, w + 1);
    w = w + 1;
    typeLine = fmt('warning', issued);

    if (w >= 2) {
      convertWarnToOral();
      typeLine = `Попередження (2/2) → ${fmt('oral', Math.min(2, o))}`;
      if (o >= 2) {
        convertOralToStrict();
        typeLine = `Попередження (2/2) → Усна догана (2/2) → ${fmt('strict', Math.min(2, s))}`;
      }
      if (s >= 2) {
        convertStrictToReattest();
        typeLine = `Попередження (2/2) → Усна догана (2/2) → Сувора догана (2/2) → Переатестація`;
      }
    }

    w = Math.max(0, Math.min(2, w));
    o = Math.max(0, Math.min(2, o));
    s = Math.max(0, Math.min(2, s));

    await setCount(member, 'warn', w);
    await setCount(member, 'oral', o);
    await setCount(member, 'strict', s);
    await setReattest(member, r);

    return { typeLine };
  }

  if (type === 'oral') {
    const issued = Math.min(2, o + 1);
    o = o + 1;
    typeLine = fmt('oral', issued);

    if (o >= 2) {
      convertOralToStrict();
      typeLine = `Усна догана (2/2) → ${fmt('strict', Math.min(2, s))}`;
      if (s >= 2) {
        convertStrictToReattest();
        typeLine = `Усна догана (2/2) → Сувора догана (2/2) → Переатестація`;
      }
    }

    o = Math.max(0, Math.min(2, o));
    s = Math.max(0, Math.min(2, s));

    await setCount(member, 'oral', o);
    await setCount(member, 'strict', s);
    await setReattest(member, r);

    return { typeLine };
  }

  if (type === 'strict') {
    const issued = Math.min(2, s + 1);
    s = s + 1;
    typeLine = fmt('strict', issued);

    if (s >= 2) {
      convertStrictToReattest();
      typeLine = `Сувора догана (2/2) → Переатестація`;
    }

    s = Math.max(0, Math.min(2, s));
    await setCount(member, 'strict', s);
    await setReattest(member, r);
    return { typeLine };
  }

  return { typeLine: 'Невідомий тип' };
}

async function applyDecrement(member, token) {
  let w = countFromRoles(member, 'warn');
  let o = countFromRoles(member, 'oral');
  let s = countFromRoles(member, 'strict');
  let r = hasReattest(member);

  let typeLine = '';

  switch (token) {
    case 'w2': typeLine = 'Попередження (2/2) → Попередження (1/2)'; w = 1; break;
    case 'w1': typeLine = 'Попередження (1/2) → Знято'; w = 0; break;

    case 'o2': typeLine = 'Усна догана (2/2) → Усна догана (1/2)'; o = 1; break;
    case 'o1': typeLine = 'Усна догана (1/2) → Знято'; o = 0; break;

    case 's2': typeLine = 'Сувора догана (2/2) → Сувора догана (1/2)'; s = 1; break;
    case 's1': typeLine = 'Сувора догана (1/2) → Знято'; s = 0; break;

    case 'r':  typeLine = 'Переатестація → Знято'; r = false; break;

    default: typeLine = 'Невідомий тип зняття'; break;
  }

  await setCount(member, 'warn', w);
  await setCount(member, 'oral', o);
  await setCount(member, 'strict', s);
  await setReattest(member, r);

  return { typeLine };
}

/* =========================
   EMBED (Punish channel)
========================= */
function buildEmbed({ title, kind, issuerId, targetId, reason, typeLine }) {
  const botIconUrl = getBotIconUrl();
  const botName = BRAND_NAME || client.user?.username || 'Discipline Bot';

  const emb = new EmbedBuilder()
    .setTitle(title)
    .setColor(COLOR[kind] ?? 0x95A5A6)
    .setThumbnail(botIconUrl);

  if (botName && botIconUrl) emb.setAuthor({ name: botName, iconURL: botIconUrl });

  emb.addFields(
    { name: 'Хто:', value: `<@${issuerId}>`, inline: false },
    { name: 'Кому:', value: `<@${targetId}>`, inline: false },
    { name: 'Тип догани:', value: typeLine, inline: false },
    { name: 'Причина:', value: reason, inline: false },
    { name: 'Час:', value: formatTime(), inline: false },
  );

  return emb;
}
async function postEvidenceCase({ guild, issuerId, targetId, reason, typeLine, punishMsgUrl }) {
  if (!EVIDENCE_CHANNEL_ID) return;

  const evidenceChannel = await client.channels.fetch(EVIDENCE_CHANNEL_ID).catch(() => null);
  if (!evidenceChannel) return;

  // ✅ без дублювання, навіть якщо issuerId === targetId
  const mentionUsers = [...new Set([issuerId, targetId].filter(Boolean))];

  // Службове повідомлення в каналі підтверджень
  const headerLines = [
    `**Потрібне підтвердження догани**`,
    `Кому: <@${targetId}>`,
    `Хто видав: <@${issuerId}>`,
    `Причина: **${reason}**`,
    `Стягнення: **${typeLine}**`,
    punishMsgUrl ? `Посилання на догану: ${punishMsgUrl}` : null,
    EVIDENCE_FORM_URL ? `Форма/звіт: ${EVIDENCE_FORM_URL}` : null,
  ].filter(Boolean);

  // ⚠️ якщо Discord іноді капризує — можна прибрати allowedMentions повністю,
  // але зараз робимо правильно й безпечно
  const msg = await evidenceChannel.send({
    content: headerLines.join('\n'),
    allowedMentions: { users: mentionUsers },
  }).catch(() => null);

  if (!msg) return;

  // Створюємо thread під це повідомлення
  const safeTypeLine = String(typeLine || '').replace(/\n/g, ' ').trim();
  const threadName = `Докази • ${targetId} • ${safeTypeLine}`.slice(0, 95);

  const thread = await msg.startThread({
    name: threadName,
    autoArchiveDuration: 1440,
    reason: 'Докази видачі догани',
  }).catch(() => null);

  if (!thread) return;

  // Перше повідомлення в гілці — пінгуємо того, хто видав догану (спойлером)
  await thread.send({
    content:
      `||<@${issuerId}>||, додайте, будь ласка, **докази** видачі догани сюди (скріни/відео/логи).` +
      (punishMsgUrl ? `\n🔗 Догана: ${punishMsgUrl}` : ''),
    allowedMentions: { users: [issuerId] },
  }).catch(() => {});
}
/* =========================
   INFO MESSAGE (single editable)
========================= */
async function getOrCreateInfoMessage(guild) {
  const infoChannel = INFO_CHANNEL_ID
    ? await client.channels.fetch(INFO_CHANNEL_ID).catch(() => null)
    : null;

  if (!infoChannel) return null;

  const stored = SQL.getSetting.get(guild.id, 'info_message_id')?.value || null;
  if (stored) {
    const msg = await infoChannel.messages.fetch(stored).catch(() => null);
    if (msg) return msg;
  }

  const msg = await infoChannel.send({ content: '⏳ Завантажую InfoDogan...' });
  SQL.setSetting.run(guild.id, 'info_message_id', String(msg.id));
  return msg;
}

/**
 * InfoDogan: показуємо тільки наявні стягнення.
 * Якщо пройшло 48/72/48 — додаємо коротку примітку "Пройшло ХХ год..."
 * До того моменту — НІЧОГО не пишемо (без countdown).
 */
async function renderInfoMessage(guild) {
  const infoMsg = await getOrCreateInfoMessage(guild);
  if (!infoMsg) return;

  const rows = SQL.listUsers.all(guild.id);
  const blocks = [];

  for (const row of rows) {
    const member = await guild.members.fetch(row.user_id).catch(() => null);
    if (!member) continue;

    const w = countFromRoles(member, 'warn');
    const o = countFromRoles(member, 'oral');
    const s = countFromRoles(member, 'strict');
    const r = hasReattest(member);

    if (w === 0 && o === 0 && s === 0 && !r) continue;

    syncStartsWithCurrentCounts(guild.id, member.id, { w, o, s });
    const fresh = SQL.getRow.get(guild.id, member.id) || {};

    const items = [];

    if (w > 0) {
      let line = `Попередження (${w}/2)`;
      if (isPassed(fresh.warn_start, MS.WARN_EXPIRE)) {
        line += ` — ⚠️ **Пройшло 48 год, потрібно зняти**`;
      }
      items.push(line);
    }

    if (o > 0) {
      let line = `Усна догана (${o}/2)`;
      if (isPassed(fresh.oral_start, MS.ORAL_DUE)) {
        line += ` — ⚠️ **Пройшло 72 год, потрібно видати повторно**`;
      }
      items.push(line);
    }

    if (s > 0) {
      let line = `Сувора догана (${s}/2)`;
      if (isPassed(fresh.strict_start, MS.STRICT_DUE)) {
        line += ` — ⚠️ **Пройшло 48 год, потрібно видати повторно**`;
      }
      items.push(line);
    }

    if (r) items.push(`🛑 **Переатестація**`);

    blocks.push(
      `> **<@${member.id}>**\n` +
      items.map(x => `> • ${x}`).join('\n')
    );
  }

  const header =
    `**InfoDogan — логування доган!**\n` +
    `Оновлення: **${formatTime()}**\n\n`;

  const body = blocks.length ? blocks.join('\n\n') : '✅ Немає активних доган.';
  await infoMsg.edit({ content: (header + body).slice(0, 1900) }).catch(() => {});
}

/* =========================
   READY + INFO SCHEDULER
========================= */
client.once('ready', async () => {
  console.log(`✅ Бот запущений як ${client.user.tag}`);

  // Оновлення InfoDogan раз на 10 хв (без флуду)
  setInterval(async () => {
    try {
      if (!GUILD_ID) return;
      const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
      if (!guild) return;
      await renderInfoMessage(guild);
    } catch (e) {
      console.error('InfoDogan update error:', e?.message || e);
    }
  }, 10 * 60_000);

  // Одразу оновити після старту
  if (GUILD_ID) {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (guild) await renderInfoMessage(guild);
  }
});

/* =========================
   INTERACTIONS
========================= */
client.on('interactionCreate', async (interaction) => {

  /* ---------- AUTOCOMPLETE: undogan type (only existing) ---------- */
  if (interaction.isAutocomplete()) {
    if (interaction.commandName !== 'undogan') return;

    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'type') return;

    const userOpt = interaction.options.get('user');
    const userId = userOpt?.value;
    if (!userId || !interaction.guild) return interaction.respond([]);

    const m = await interaction.guild.members.fetch({ user: userId, force: true }).catch(() => null);
    if (!m) return interaction.respond([]);

    const items = [];
    const w = countFromRoles(m, 'warn');
    const o = countFromRoles(m, 'oral');
    const s = countFromRoles(m, 'strict');
    const r = hasReattest(m);

    if (w === 2) items.push({ name: 'Попередження (2/2)', value: 'w2' });
    if (w === 1) items.push({ name: 'Попередження (1/2)', value: 'w1' });

    if (o === 2) items.push({ name: 'Усна догана (2/2)', value: 'o2' });
    if (o === 1) items.push({ name: 'Усна догана (1/2)', value: 'o1' });

    if (s === 2) items.push({ name: 'Сувора догана (2/2)', value: 's2' });
    if (s === 1) items.push({ name: 'Сувора догана (1/2)', value: 's1' });

    if (r) items.push({ name: 'Переатестація', value: 'r' });

    if (!items.length) return interaction.respond([{ name: 'Немає активних доган', value: 'none' }]);

    const q = String(focused.value || '').toLowerCase();
    return interaction.respond(items.filter(x => x.name.toLowerCase().includes(q)).slice(0, 25));
  }

  /* ---------- COMMANDS ---------- */
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;
  if (cmd !== 'dogan' && cmd !== 'undogan') return;

const mem = interaction.member;

const isAdmin = mem.permissions.has(PermissionsBitField.Flags.Administrator);
if (!isAdmin && !hasDisciplineAccess(mem)) {
  return interaction.reply({
    content: '❌ У вас немає повноважень на використання дисциплінарної системи FIB.',
    ephemeral: true
  });
}
  if (!interaction.guild) {
    return interaction.reply({ content: '❌ Команда доступна лише на сервері.', ephemeral: true });
  }

console.log('ENV PUNISH_CHANNEL_ID raw =', process.env.PUNISH_CHANNEL_ID);
console.log('PUNISH_CHANNEL_ID =', PUNISH_CHANNEL_ID);

const punishChannel = PUNISH_CHANNEL_ID
  ? await interaction.guild.channels.fetch(PUNISH_CHANNEL_ID).catch(() => null)
  : null;

console.log('punishChannel found =', !!punishChannel);

if (!punishChannel) {
  return interaction.reply({
    content: `❌ Не знайдено канал для покарань. ID: ${PUNISH_CHANNEL_ID || 'empty'}`,
    ephemeral: true
  });
}

  const targetUser = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason', true);

  const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  if (!targetMember) {
    return interaction.reply({ content: '❌ Не можу знайти цього учасника на сервері.', ephemeral: true });
  }

  const issuerId = interaction.user.id;

  if (cmd === 'dogan') {
    const type = interaction.options.getString('type', true); // warning/oral/strict/reattest

    let res;
    try {
      res = await applyIncrement(targetMember, type);
    } catch (e) {
      return interaction.reply({
        content: '❌ Не вдалося змінити ролі. Перевір: Manage Roles у бота + роль бота ВИЩЕ за всі ролі доган.',
        ephemeral: true,
      });
    }

    // sync timers after role change
    const w = countFromRoles(targetMember, 'warn');
    const o = countFromRoles(targetMember, 'oral');
    const s = countFromRoles(targetMember, 'strict');
    syncStartsWithCurrentCounts(interaction.guild.id, targetMember.id, { w, o, s });

const punishMsg = await punishChannel.send({
  content: `||<@${targetUser.id}>||`,
  embeds: [buildEmbed({
    title: 'Догана',
    kind: 'dogan',
    issuerId,
    targetId: targetUser.id,
    reason,
    typeLine: res.typeLine,
  })],
  allowedMentions: { users: [targetUser.id] },
});

// створюємо кейс у підтвердженнях + thread
await postEvidenceCase({
  guild: interaction.guild,
  issuerId,
  targetId: targetUser.id,
  reason,
  typeLine: res.typeLine,
  punishMsgUrl: punishMsg.url, // jump link на повідомлення
});
    await renderInfoMessage(interaction.guild);
    return silentAck(interaction);
  }

  if (cmd === 'undogan') {
    const token = interaction.options.getString('type', true);
    if (token === 'none') {
      return interaction.reply({ content: 'ℹ️ У користувача немає активних доган.', ephemeral: true });
    }

    let res;
    try {
      res = await applyDecrement(targetMember, token);
    } catch (e) {
      return interaction.reply({
        content: '❌ Не вдалося змінити ролі. Перевір: Manage Roles у бота + роль бота ВИЩЕ за всі ролі доган.',
        ephemeral: true,
      });
    }

    // sync timers after role change
    const w = countFromRoles(targetMember, 'warn');
    const o = countFromRoles(targetMember, 'oral');
    const s = countFromRoles(targetMember, 'strict');
    syncStartsWithCurrentCounts(interaction.guild.id, targetMember.id, { w, o, s });

    await punishChannel.send({
      content: `||<@${targetUser.id}>||`,
      embeds: [buildEmbed({
        title: 'Зняття догани',
        kind: 'undogan',
        issuerId,
        targetId: targetUser.id,
        reason,
        typeLine: res.typeLine,
      })],
      allowedMentions: { users: [targetUser.id] },
    });

    await renderInfoMessage(interaction.guild);
    return silentAck(interaction);
  }
});

/* =========================
   START
========================= */
client.login(process.env.DISCORD_TOKEN);
process.on('unhandledRejection', (err) => console.error('UnhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('UncaughtException:', err));
