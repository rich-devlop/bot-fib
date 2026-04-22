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
const db = new Database('./lespere_discipline.sqlite');

db.exec(`
CREATE TABLE IF NOT EXISTS punishments (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  oral_start INTEGER,
  strict_start INTEGER,
  reattest_start INTEGER,
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

  createRow: db.prepare(`
    INSERT OR IGNORE INTO punishments (guild_id, user_id, oral_start, strict_start, reattest_start)
    VALUES (?, ?, NULL, NULL, NULL)
  `),

  setOralStart: db.prepare(`
    UPDATE punishments
    SET oral_start=?
    WHERE guild_id=? AND user_id=?
  `),

  setStrictStart: db.prepare(`
    UPDATE punishments
    SET strict_start=?
    WHERE guild_id=? AND user_id=?
  `),

  setReattestStart: db.prepare(`
    UPDATE punishments
    SET reattest_start=?
    WHERE guild_id=? AND user_id=?
  `),

  clearOralStart: db.prepare(`
    UPDATE punishments
    SET oral_start=NULL
    WHERE guild_id=? AND user_id=?
  `),

  clearStrictStart: db.prepare(`
    UPDATE punishments
    SET strict_start=NULL
    WHERE guild_id=? AND user_id=?
  `),

  clearReattestStart: db.prepare(`
    UPDATE punishments
    SET reattest_start=NULL
    WHERE guild_id=? AND user_id=?
  `),

  listUsers: db.prepare(`SELECT user_id FROM punishments WHERE guild_id=?`),

  getSetting: db.prepare(`SELECT value FROM settings WHERE guild_id=? AND key=?`),

  setSetting: db.prepare(`
    INSERT INTO settings (guild_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id, key) DO UPDATE SET value=excluded.value
  `),
};

/* =========================
   ENV / IDs
========================= */
function envId(key) {
  return (process.env[key] || '').trim();
}

const GUILD_ID = envId('GUILD_ID');
const PUNISH_CHANNEL_ID = envId('PUNISH_CHANNEL_ID');
const INFO_CHANNEL_ID = envId('INFO_CHANNEL_ID');
const EVIDENCE_CHANNEL_ID = envId('EVIDENCE_CHANNEL_ID');
const EVIDENCE_FORM_URL = (process.env.EVIDENCE_FORM_URL || '').trim();
const BRAND_NAME = (process.env.BOT_BRAND_NAME || 'Lespere Discipline').trim();

const ROLES = {
  oral: {
    r1: envId('ROLE_ORAL_1'),
    r2: envId('ROLE_ORAL_2'),
  },
  strict: {
    r1: envId('ROLE_STRICT_1'),
    r2: envId('ROLE_STRICT_2'),
    r3: envId('ROLE_STRICT_3'),
  },
  reattest: envId('ROLE_REATTEST'),
};

const COLOR = {
  punish: 0xE74C3C,
  unpunish: 0x2ECC71,
  info: 0x3498DB,
};

const MS = {
  DOGAN_DUE: 24 * 60 * 60 * 1000,
};

/* =========================
   UTILS
========================= */
function nowMs() {
  return Date.now();
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTime(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getBotIconUrl() {
  try {
    return client.user.displayAvatarURL({ extension: 'png', size: 256 });
  } catch {
    return client.user.displayAvatarURL({ format: 'png', size: 256 });
  }
}

function hasDisciplineAccess(member) {
  const allowed = (process.env.DISCIPLINE_ROLES || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

  if (!allowed.length) return false;
  return member.roles.cache.some(role => allowed.includes(role.id));
}

function isPassed(startMs, durationMs) {
  if (!startMs) return false;
  return (Date.now() - startMs) >= durationMs;
}

async function silentAck(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
    await interaction.deleteReply().catch(() => {});
  } catch {}
}

function ensureDbRow(guildId, userId) {
  SQL.createRow.run(guildId, userId);
  return SQL.getRow.get(guildId, userId);
}

/* =========================
   ROLE HELPERS
========================= */
function getOralLevel(member) {
  if (ROLES.oral.r2 && member.roles.cache.has(ROLES.oral.r2)) return 2;
  if (ROLES.oral.r1 && member.roles.cache.has(ROLES.oral.r1)) return 1;
  return 0;
}

function getStrictLevel(member) {
  if (ROLES.strict.r3 && member.roles.cache.has(ROLES.strict.r3)) return 3;
  if (ROLES.strict.r2 && member.roles.cache.has(ROLES.strict.r2)) return 2;
  if (ROLES.strict.r1 && member.roles.cache.has(ROLES.strict.r1)) return 1;
  return 0;
}

function hasReattest(member) {
  return !!ROLES.reattest && member.roles.cache.has(ROLES.reattest);
}

async function setOralLevel(member, level) {
  if (ROLES.oral.r1) await member.roles.remove(ROLES.oral.r1).catch(() => {});
  if (ROLES.oral.r2) await member.roles.remove(ROLES.oral.r2).catch(() => {});

  if (level === 1 && ROLES.oral.r1) await member.roles.add(ROLES.oral.r1);
  if (level === 2 && ROLES.oral.r2) await member.roles.add(ROLES.oral.r2);
}

async function setStrictLevel(member, level) {
  if (ROLES.strict.r1) await member.roles.remove(ROLES.strict.r1).catch(() => {});
  if (ROLES.strict.r2) await member.roles.remove(ROLES.strict.r2).catch(() => {});
  if (ROLES.strict.r3) await member.roles.remove(ROLES.strict.r3).catch(() => {});

  if (level === 1 && ROLES.strict.r1) await member.roles.add(ROLES.strict.r1);
  if (level === 2 && ROLES.strict.r2) await member.roles.add(ROLES.strict.r2);
  if (level === 3 && ROLES.strict.r3) await member.roles.add(ROLES.strict.r3);
}

async function setReattest(member, on) {
  if (!ROLES.reattest) return;
  if (on) await member.roles.add(ROLES.reattest);
  else await member.roles.remove(ROLES.reattest).catch(() => {});
}

/* =========================
   DB START SYNC
========================= */
function syncStartsWithCurrentState(guildId, userId, state) {
  ensureDbRow(guildId, userId);
  const row = SQL.getRow.get(guildId, userId);
  const t = nowMs();

  if (state.oral > 0) {
    if (!row.oral_start) SQL.setOralStart.run(t, guildId, userId);
  } else {
    if (row.oral_start) SQL.clearOralStart.run(guildId, userId);
  }

  if (state.strict > 0) {
    if (!row.strict_start) SQL.setStrictStart.run(t, guildId, userId);
  } else {
    if (row.strict_start) SQL.clearStrictStart.run(guildId, userId);
  }

  if (state.reattest) {
    if (!row.reattest_start) SQL.setReattestStart.run(t, guildId, userId);
  } else {
    if (row.reattest_start) SQL.clearReattestStart.run(guildId, userId);
  }
}

/* =========================
   DISCIPLINE LOGIC
========================= */
async function applyIncrement(member, type) {
  const oral = getOralLevel(member);
  const strict = getStrictLevel(member);
  const reattest = hasReattest(member);

  let typeLine = '';
  let systemNote = '';

  if (type === 'reattest') {
    await setReattest(member, true);
    typeLine = 'Переатестація';
    return { typeLine, systemNote: '' };
  }

  if (type === 'oral') {
    if (strict > 0) {
      const nextStrict = Math.min(3, strict + 1);
      await setStrictLevel(member, nextStrict);

      if (nextStrict === 2) {
        typeLine = 'Сувора догана (2/3)';
        systemNote = 'Пониження в посаді';
      } else if (nextStrict === 3) {
        typeLine = 'Сувора догана (3/3)';
        systemNote = 'Звільнення';
      } else {
        typeLine = 'Сувора догана (1/3)';
      }

      return { typeLine, systemNote };
    }

    if (oral === 0) {
      await setOralLevel(member, 1);
      typeLine = 'Усна догана (1/2)';
      return { typeLine, systemNote: '' };
    }

    if (oral === 1) {
      await setOralLevel(member, 0);
      await setStrictLevel(member, 1);
      typeLine = 'Усна догана (2/2) → Сувора догана (1/3)';
      return { typeLine, systemNote: '' };
    }

    if (oral === 2) {
      await setOralLevel(member, 0);
      await setStrictLevel(member, 1);
      typeLine = 'Усна догана (2/2) → Сувора догана (1/3)';
      return { typeLine, systemNote: '' };
    }
  }

  if (type === 'strict') {
    const nextStrict = Math.min(3, strict + 1);
    await setOralLevel(member, 0);
    await setStrictLevel(member, nextStrict);

    if (nextStrict === 1) {
      typeLine = 'Сувора догана (1/3)';
      return { typeLine, systemNote: '' };
    }

    if (nextStrict === 2) {
      typeLine = 'Сувора догана (2/3)';
      systemNote = 'Пониження в посаді';
      return { typeLine, systemNote };
    }

    if (nextStrict === 3) {
      typeLine = 'Сувора догана (3/3)';
      systemNote = 'Звільнення';
      return { typeLine, systemNote };
    }
  }

  return {
    typeLine: 'Невідомий тип стягнення',
    systemNote: '',
  };
}

async function applyDecrement(member, token) {
  let typeLine = '';

  switch (token) {
    case 'oral_1':
      await setOralLevel(member, 0);
      typeLine = 'Усна догана (1/2) → Знято';
      break;

    case 'oral_2':
      await setOralLevel(member, 1);
      typeLine = 'Усна догана (2/2) → Усна догана (1/2)';
      break;

    case 'strict_1':
      await setStrictLevel(member, 0);
      typeLine = 'Сувора догана (1/3) → Знято';
      break;

    case 'strict_2':
      await setStrictLevel(member, 1);
      typeLine = 'Сувора догана (2/3) → Сувора догана (1/3)';
      break;

    case 'strict_3':
      await setStrictLevel(member, 2);
      typeLine = 'Сувора догана (3/3) → Сувора догана (2/3)';
      break;

    case 'reattest':
      await setReattest(member, false);
      typeLine = 'Переатестація → Знято';
      break;

    default:
      typeLine = 'Невідомий тип зняття';
      break;
  }

  return { typeLine };
}

/* =========================
   EMBEDS
========================= */
function buildEmbed({ title, kind, issuerId, targetId, reason, typeLine, systemNote }) {
  const botIconUrl = getBotIconUrl();
  const botName = BRAND_NAME || client.user?.username || 'Lespere Discipline';

  const emb = new EmbedBuilder()
    .setTitle(title)
    .setColor(COLOR[kind] ?? 0x95A5A6)
    .setThumbnail(botIconUrl);

  if (botName && botIconUrl) {
    emb.setAuthor({ name: botName, iconURL: botIconUrl });
  }

  emb.addFields(
    { name: 'Хто видав', value: `<@${issuerId}>`, inline: false },
    { name: 'Кому видано', value: `<@${targetId}>`, inline: false },
    { name: 'Тип стягнення', value: typeLine, inline: false },
    { name: 'Причина', value: reason, inline: false },
    { name: 'Час', value: formatTime(), inline: false },
  );

  if (systemNote) {
    emb.addFields({
      name: 'Системна примітка',
      value: systemNote,
      inline: false,
    });
  }

  return emb;
}

async function postEvidenceCase({ issuerId, targetId, reason, typeLine, punishMsgUrl, systemNote }) {
  if (!EVIDENCE_CHANNEL_ID) return;

  const evidenceChannel = await client.channels.fetch(EVIDENCE_CHANNEL_ID).catch(() => null);
  if (!evidenceChannel) return;

  const mentionUsers = [...new Set([issuerId, targetId].filter(Boolean))];

  const headerLines = [
    `**Потрібне підтвердження дисциплінарного стягнення**`,
    `Кому: <@${targetId}>`,
    `Хто видав: <@${issuerId}>`,
    `Причина: **${reason}**`,
    `Стягнення: **${typeLine}**`,
    systemNote ? `Системна примітка: **${systemNote}**` : null,
    punishMsgUrl ? `Посилання на повідомлення: ${punishMsgUrl}` : null,
    EVIDENCE_FORM_URL ? `Форма / звіт: ${EVIDENCE_FORM_URL}` : null,
  ].filter(Boolean);

  const msg = await evidenceChannel.send({
    content: headerLines.join('\n'),
    allowedMentions: { users: mentionUsers },
  }).catch(() => null);

  if (!msg) return;

  const safeTypeLine = String(typeLine || '').replace(/\n/g, ' ').trim();
  const threadName = `Докази • ${targetId} • ${safeTypeLine}`.slice(0, 95);

  const thread = await msg.startThread({
    name: threadName,
    autoArchiveDuration: 1440,
    reason: 'Докази видачі стягнення',
  }).catch(() => null);

  if (!thread) return;

  await thread.send({
    content:
      `||<@${issuerId}>||, додайте, будь ласка, **докази** сюди.` +
      (punishMsgUrl ? `\n🔗 Повідомлення: ${punishMsgUrl}` : ''),
    allowedMentions: { users: [issuerId] },
  }).catch(() => {});
}

/* =========================
   INFO MESSAGE
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

  const msg = await infoChannel.send({ content: '⏳ Завантажую Info-Dogan...' });
  SQL.setSetting.run(guild.id, 'info_message_id', String(msg.id));
  return msg;
}

async function renderInfoMessage(guild) {
  const infoMsg = await getOrCreateInfoMessage(guild);
  if (!infoMsg) return;

  const rows = SQL.listUsers.all(guild.id);
  const blocks = [];

  for (const row of rows) {
    const member = await guild.members.fetch(row.user_id).catch(() => null);
    if (!member) continue;

    const oral = getOralLevel(member);
    const strict = getStrictLevel(member);
    const reattest = hasReattest(member);

    if (oral === 0 && strict === 0 && !reattest) continue;

    syncStartsWithCurrentState(guild.id, member.id, {
      oral,
      strict,
      reattest,
    });

    const fresh = SQL.getRow.get(guild.id, member.id) || {};
    const items = [];

    if (oral > 0) {
      let line = `Усна догана (${oral}/2)`;
      if (isPassed(fresh.oral_start, MS.DOGAN_DUE)) {
        line += ` — ⚠️ **Пройшло 24 год, потрібно видати повторно**`;
      }
      items.push(line);
    }

    if (strict > 0) {
      let line = `Сувора догана (${strict}/3)`;

      if (strict === 2) {
        line += ` — **Пониження в посаді**`;
      }
      if (strict === 3) {
        line += ` — **Звільнення**`;
      }

      if (isPassed(fresh.strict_start, MS.DOGAN_DUE)) {
        line += ` — ⚠️ **Пройшло 24 год, потрібно видати повторно**`;
      }

      items.push(line);
    }

    if (reattest) {
      items.push(`Переатестація`);
    }

    blocks.push(
      `> **<@${member.id}>**\n` +
      items.map(x => `> • ${x}`).join('\n')
    );
  }

  const header =
    `**Info-Dogan — активні дисциплінарні стягнення**\n` +
    `Оновлено: **${formatTime()}**\n\n`;

  const body = blocks.length ? blocks.join('\n\n') : '✅ Немає активних дисциплінарних стягнень.';
  await infoMsg.edit({ content: (header + body).slice(0, 1900) }).catch(() => {});
}

/* =========================
   READY
========================= */
client.once('clientReady', async () => {
  console.log(`✅ Бот запущений як ${client.user.tag}`);

  setInterval(async () => {
    try {
      if (!GUILD_ID) return;
      const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
      if (!guild) return;
      await renderInfoMessage(guild);
    } catch (e) {
      console.error('Info-Dogan update error:', e?.message || e);
    }
  }, 10 * 60_000);

  if (GUILD_ID) {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (guild) await renderInfoMessage(guild);
  }
});

/* =========================
   INTERACTIONS
========================= */
client.on('interactionCreate', async (interaction) => {
  /* ---------- AUTOCOMPLETE ---------- */
  if (interaction.isAutocomplete()) {
    if (interaction.commandName !== 'undogan') return;

    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'type') return;

    const userOpt = interaction.options.get('user');
    const userId = userOpt?.value;
    if (!userId || !interaction.guild) {
      return interaction.respond([]);
    }

    const member = await interaction.guild.members.fetch({ user: userId, force: true }).catch(() => null);
    if (!member) {
      return interaction.respond([]);
    }

    const items = [];
    const oral = getOralLevel(member);
    const strict = getStrictLevel(member);
    const reattest = hasReattest(member);

    if (oral === 1) items.push({ name: 'Усна догана (1/2)', value: 'oral_1' });
    if (oral === 2) items.push({ name: 'Усна догана (2/2)', value: 'oral_2' });

    if (strict === 1) items.push({ name: 'Сувора догана (1/3)', value: 'strict_1' });
    if (strict === 2) items.push({ name: 'Сувора догана (2/3)', value: 'strict_2' });
    if (strict === 3) items.push({ name: 'Сувора догана (3/3)', value: 'strict_3' });

    if (reattest) items.push({ name: 'Переатестація', value: 'reattest' });

    if (!items.length) {
      return interaction.respond([{ name: 'Немає активних стягнень', value: 'none' }]);
    }

    const q = String(focused.value || '').toLowerCase();
    return interaction.respond(
      items.filter(x => x.name.toLowerCase().includes(q)).slice(0, 25)
    );
  }

  /* ---------- COMMANDS ---------- */
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;
  if (cmd !== 'dogan' && cmd !== 'undogan') return;

  const mem = interaction.member;
  const isAdmin = mem.permissions.has(PermissionsBitField.Flags.Administrator);

  if (!isAdmin && !hasDisciplineAccess(mem)) {
    return interaction.reply({
      content: '❌ У вас немає доступу до дисциплінарної системи.',
      ephemeral: true,
    });
  }

  if (!interaction.guild) {
    return interaction.reply({
      content: '❌ Команда доступна лише на сервері.',
      ephemeral: true,
    });
  }

  const punishChannel = PUNISH_CHANNEL_ID
    ? await interaction.guild.channels.fetch(PUNISH_CHANNEL_ID).catch(() => null)
    : null;

  if (!punishChannel) {
    return interaction.reply({
      content: `❌ Не знайдено канал для стягнень. ID: ${PUNISH_CHANNEL_ID || 'empty'}`,
      ephemeral: true,
    });
  }

  const targetUser = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason', true);

  const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  if (!targetMember) {
    return interaction.reply({
      content: '❌ Не можу знайти цього учасника на сервері.',
      ephemeral: true,
    });
  }

  const issuerId = interaction.user.id;

  if (cmd === 'dogan') {
    const type = interaction.options.getString('type', true); // oral / strict / reattest

    let res;
    try {
      res = await applyIncrement(targetMember, type);
    } catch (e) {
      return interaction.reply({
        content: '❌ Не вдалося змінити ролі. Перевір Manage Roles та позицію ролі бота.',
        ephemeral: true,
      });
    }

    const oral = getOralLevel(targetMember);
    const strict = getStrictLevel(targetMember);
    const reattest = hasReattest(targetMember);

    syncStartsWithCurrentState(interaction.guild.id, targetMember.id, {
      oral,
      strict,
      reattest,
    });

    if (type === 'oral') {
      if (strict > 0) {
        SQL.clearOralStart.run(interaction.guild.id, targetMember.id);
        SQL.setStrictStart.run(nowMs(), interaction.guild.id, targetMember.id);
      } else if (oral > 0) {
        SQL.setOralStart.run(nowMs(), interaction.guild.id, targetMember.id);
      }
    }

    if (type === 'strict') {
      SQL.clearOralStart.run(interaction.guild.id, targetMember.id);
      SQL.setStrictStart.run(nowMs(), interaction.guild.id, targetMember.id);
    }

    if (type === 'reattest') {
      SQL.setReattestStart.run(nowMs(), interaction.guild.id, targetMember.id);
    }

    const punishMsg = await punishChannel.send({
      content: `||<@${targetUser.id}>||`,
      embeds: [buildEmbed({
        title: 'Дисциплінарне стягнення',
        kind: 'punish',
        issuerId,
        targetId: targetUser.id,
        reason,
        typeLine: res.typeLine,
        systemNote: res.systemNote,
      })],
      allowedMentions: { users: [targetUser.id] },
    });

    await postEvidenceCase({
      issuerId,
      targetId: targetUser.id,
      reason,
      typeLine: res.typeLine,
      systemNote: res.systemNote,
      punishMsgUrl: punishMsg.url,
    });

    await renderInfoMessage(interaction.guild);
    return silentAck(interaction);
  }

  if (cmd === 'undogan') {
    const token = interaction.options.getString('type', true);

    if (token === 'none') {
      return interaction.reply({
        content: 'ℹ️ У користувача немає активних стягнень.',
        ephemeral: true,
      });
    }

    let res;
    try {
      res = await applyDecrement(targetMember, token);
    } catch (e) {
      return interaction.reply({
        content: '❌ Не вдалося змінити ролі. Перевір Manage Roles та позицію ролі бота.',
        ephemeral: true,
      });
    }

    const oral = getOralLevel(targetMember);
    const strict = getStrictLevel(targetMember);
    const reattest = hasReattest(targetMember);

    syncStartsWithCurrentState(interaction.guild.id, targetMember.id, {
      oral,
      strict,
      reattest,
    });

    await punishChannel.send({
      content: `||<@${targetUser.id}>||`,
      embeds: [buildEmbed({
        title: 'Зняття дисциплінарного стягнення',
        kind: 'unpunish',
        issuerId,
        targetId: targetUser.id,
        reason,
        typeLine: res.typeLine,
        systemNote: '',
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
