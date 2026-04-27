console.log('NEW VERSION LOADED');

require('dotenv').config();

const Database = require('better-sqlite3');

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

/* =========================
   CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

/* =========================
   
========================= */
const  = new Database('./lespere_discipline.sqlite');

.exec(`
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
  getRow: db.prepare(`
    SELECT * FROM punishments
    WHERE guild_id=? AND user_id=?
  `),

  createRow: db.prepare(`
    INSERT OR IGNORE INTO punishments (guild_id, user_id, oral_start, strict_start, reattest_start)
    VALUES (?, ?, NULL, NULL, NULL)
  `),

  setOralStart: db.prepare(`
    UPDATE punishments SET oral_start=?
    WHERE guild_id=? AND user_id=?
  `),

  setStrictStart: db.prepare(`
    UPDATE punishments SET strict_start=?
    WHERE guild_id=? AND user_id=?
  `),

  setReattestStart: db.prepare(`
    UPDATE punishments SET reattest_start=?
    WHERE guild_id=? AND user_id=?
  `),

  clearOralStart: db.prepare(`
    UPDATE punishments SET oral_start=NULL
    WHERE guild_id=? AND user_id=?
  `),

  clearStrictStart: db.prepare(`
    UPDATE punishments SET strict_start=NULL
    WHERE guild_id=? AND user_id=?
  `),

  clearReattestStart: db.prepare(`
    UPDATE punishments SET reattest_start=NULL
    WHERE guild_id=? AND user_id=?
  `),

  listUsers: db.prepare(`
    SELECT user_id FROM punishments
    WHERE guild_id=?
  `),

  getSetting: db.prepare(`
    SELECT value FROM settings
    WHERE guild_id=? AND key=?
  `),

  setSetting: db.prepare(`
    INSERT INTO settings (guild_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id, key) DO UPDATE SET value=excluded.value
  `),
};

/* =========================
   ENV
========================= */
function envId(key) {
  return (process.env[key] || '').trim();
}

const GUILD_ID = envId('GUILD_ID');
const CLIENT_ID = envId('CLIENT_ID');

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
    return null;
  }
}

function isPassed(startMs, durationMs) {
  if (!startMs) return false;
  return Date.now() - startMs >= durationMs;
}

function hasDisciplineAccess(member) {
  const allowed = (process.env.DISCIPLINE_ROLES || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

  if (!allowed.length) return false;

  return member.roles.cache.some(role => allowed.includes(role.id));
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

async function safeSend(channel, payload, label = 'channel.send') {
  try {
    return await channel.send(payload);
  } catch (e) {
    console.error(`❌ ${label}:`, e?.message || e);
    return null;
  }
}

async function safeEdit(message, payload, label = 'message.edit') {
  try {
    return await message.edit(payload);
  } catch (e) {
    console.error(`❌ ${label}:`, e?.message || e);
    return null;
  }
}

/* =========================
   BADGE SYSTEM
========================= */
function cleanNicknameName(text) {
  return String(text || '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDepartment(department) {
  const dep = String(department || '').trim();

  const map = {
    PA: 'Police Academy',
    'P.A': 'Police Academy',
    'P.A.': 'Police Academy',
    ACADEMY: 'Police Academy',
    CPD: 'CPD',
    IAD: 'IAD',
    PAI: 'PAI',
    DB: 'DB',
    SWAT: 'S.W.A.T.',
    'S.W.A.T': 'S.W.A.T.',
    'S.W.A.T.': 'S.W.A.T.',
  };

  const key = dep.toUpperCase().replace(/\s+/g, ' ').trim();
  return map[key] || dep;
}

function parseBadgeData(member) {
  const raw =
    member.nickname ||
    member.user.globalName ||
    member.user.username ||
    '';

  let text = String(raw)
    .replace(/[🟢🔴🟡🟣🔵⚫⚪🟠🟤⭐🌟🍀👑💎🔥🛡️]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  let staticId = '';

  const hashMatch = text.match(/#\s*(\d{2,10})/);
  if (hashMatch) {
    staticId = hashMatch[1];
  } else {
    const lastNumberMatch = text.match(/(\d{2,10})\s*$/);
    if (lastNumberMatch) staticId = lastNumberMatch[1];
  }

  text = text
    .replace(/#\s*\d{2,10}/g, '')
    .replace(/\|\s*\d{2,10}\s*$/g, '')
    .replace(/\s+\d{2,10}\s*$/g, '')
    .trim();

  let department = '';
  let fullName = '';

  if (text.includes('|')) {
    const parts = text
      .split('|')
      .map(x => x.trim())
      .filter(Boolean);

    department = parts[0] || '';
    fullName = parts[1] || '';
  } else {
    const parts = text.split(' ').filter(Boolean);
    department = parts[0] || '';
    fullName = parts.slice(1).join(' ');
  }

  return {
    department: normalizeDepartment(department),
    fullName: cleanNicknameName(fullName),
    staticId,
  };
}

function buildBadgeButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('badge_get')
      .setLabel('Створити бейдж')
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildBadgeModal(member, department = 'Police Academy') {
  const data = parseBadgeData(member);

  const modal = new ModalBuilder()
    .setCustomId(`badge_modal_${department}`)
    .setTitle('Оформлення бейджа');

  const nameInput = new TextInputBuilder()
    .setCustomId('fullName')
    .setLabel("Ім'я та прізвище")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(data.fullName || '');

  const staticInput = new TextInputBuilder()
    .setCustomId('staticId')
    .setLabel('Статичний ID')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(data.staticId || '');

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(staticInput),
  );

  return modal;
}

async function sendBadgePanel(channel) {
  const embed = new EmbedBuilder()
    .setColor(0x1f2b3a)
    .setTitle('Жетон LSPD')
    .addFields(
      {
        name: 'Жетон:',
        value:
          '```' +
          '/do На грудях висить жетон: [LSPD | Police Academy | Ім’я Прізвище | 12345].' +
          '```',
      },
      {
        name: 'Примітка:',
        value:
          'Натисніть кнопку **"Створити бейдж"**, оберіть відділ та введіть свої дані.',
      },
    );

  return safeSend(channel, {
    embeds: [embed],
    components: [buildBadgeButtonRow()],
  }, 'sendBadgePanel');
}

/* =========================
   SLASH COMMANDS
========================= */
async function registerSlashCommands() {
  if (!CLIENT_ID || !GUILD_ID || !process.env.DISCORD_TOKEN) {
    console.log('⏭ Пропускаю реєстрацію команд: немає CLIENT_ID / GUILD_ID / DISCORD_TOKEN');
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName('dogan')
      .setDescription('Видати дисциплінарне стягнення')
      .addStringOption(option =>
        option
          .setName('type')
          .setDescription('Тип стягнення')
          .setRequired(true)
          .addChoices(
            { name: 'Усна догана', value: 'oral' },
            { name: 'Сувора догана', value: 'strict' },
            { name: 'Переатестація', value: 'reattest' },
          ))
      .addUserOption(option =>
        option
          .setName('user')
          .setDescription('Користувач')
          .setRequired(true))
      .addStringOption(option =>
        option
          .setName('reason')
          .setDescription('Причина')
          .setRequired(true)),

    new SlashCommandBuilder()
      .setName('undogan')
      .setDescription('Зняти дисциплінарне стягнення')
      .addUserOption(option =>
        option
          .setName('user')
          .setDescription('Користувач')
          .setRequired(true))
      .addStringOption(option =>
        option
          .setName('type')
          .setDescription('Що саме зняти')
          .setRequired(true)
          .setAutocomplete(true))
      .addStringOption(option =>
        option
          .setName('reason')
          .setDescription('Причина зняття')
          .setRequired(true)),

    new SlashCommandBuilder()
      .setName('badge')
      .setDescription('Створити бейдж LSPD'),

    new SlashCommandBuilder()
      .setName('badgepanel')
      .setDescription('Створити панель бейджів'),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('🔁 Реєструю slash-команди...');
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands.map(cmd => cmd.toJSON()) },
    );
    console.log('✅ Slash-команди зареєстровані');
  } catch (error) {
    console.error('❌ Помилка реєстрації команд:', error?.message || error);
  }
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
   DB SYNC
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

  let typeLine = '';
  let systemNote = '';

  if (type === 'reattest') {
    await setReattest(member, true);
    return {
      typeLine: 'Переатестація',
      systemNote,
    };
  }

  if (type === 'oral') {
    if (strict > 0) {
      const nextStrict = Math.min(3, strict + 1);

      await setOralLevel(member, 0);
      await setStrictLevel(member, nextStrict);

      if (nextStrict === 1) {
        typeLine = 'Сувора догана (1/3)';
      } else if (nextStrict === 2) {
        typeLine = 'Сувора догана (2/3)';
        systemNote = 'Пониження в посаді';
      } else {
        typeLine = 'Сувора догана (3/3)';
        systemNote = 'Звільнення';
      }

      return { typeLine, systemNote };
    }

    if (oral === 0) {
      await setOralLevel(member, 1);
      return {
        typeLine: 'Усна догана (1/2)',
        systemNote,
      };
    }

    if (oral >= 1) {
      await setOralLevel(member, 0);
      await setStrictLevel(member, 1);

      return {
        typeLine: 'Усна догана (2/2) → Сувора догана (1/3)',
        systemNote,
      };
    }
  }

  if (type === 'strict') {
    const nextStrict = Math.min(3, strict + 1);

    await setOralLevel(member, 0);
    await setStrictLevel(member, nextStrict);

    if (nextStrict === 1) {
      typeLine = 'Сувора догана (1/3)';
    } else if (nextStrict === 2) {
      typeLine = 'Сувора догана (2/3)';
      systemNote = 'Пониження в посаді';
    } else {
      typeLine = 'Сувора догана (3/3)';
      systemNote = 'Звільнення';
    }

    return { typeLine, systemNote };
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
    .setColor(COLOR[kind] ?? 0x95A5A6);

  if (botIconUrl) {
    emb.setThumbnail(botIconUrl);
    emb.setAuthor({ name: botName, iconURL: botIconUrl });
  } else {
    emb.setAuthor({ name: botName });
  }

  emb.addFields(
    { name: 'Хто видав', value: `<@${issuerId}>`, inline: false },
    { name: 'Кому видано', value: `<@${targetId}>`, inline: false },
    { name: 'Тип стягнення', value: typeLine || 'Не вказано', inline: false },
    { name: 'Причина', value: reason || 'Не вказано', inline: false },
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

  const evidenceChannel = await client.channels.fetch(EVIDENCE_CHANNEL_ID).catch((e) => {
    console.error('❌ Не можу отримати EVIDENCE_CHANNEL_ID:', e?.message || e);
    return null;
  });

  if (!evidenceChannel) return;

  const mentionUsers = [...new Set([issuerId, targetId].filter(Boolean))];

  const headerLines = [
    '**Потрібне підтвердження дисциплінарного стягнення**',
    `Кому: <@${targetId}>`,
    `Хто видав: <@${issuerId}>`,
    `Причина: **${reason}**`,
    `Стягнення: **${typeLine}**`,
    systemNote ? `Системна примітка: **${systemNote}**` : null,
    punishMsgUrl ? `Посилання на повідомлення: ${punishMsgUrl}` : null,
    EVIDENCE_FORM_URL ? `Форма / звіт: ${EVIDENCE_FORM_URL}` : null,
  ].filter(Boolean);

  const msg = await safeSend(evidenceChannel, {
    content: headerLines.join('\n'),
    allowedMentions: { users: mentionUsers },
  }, 'postEvidenceCase send');

  if (!msg) return;

  const safeTypeLine = String(typeLine || '').replace(/\n/g, ' ').trim();
  const threadName = `Докази • ${targetId} • ${safeTypeLine}`.slice(0, 95);

  const thread = await msg.startThread({
    name: threadName,
    autoArchiveDuration: 1440,
    reason: 'Докази видачі стягнення',
  }).catch((e) => {
    console.error('❌ Не можу створити гілку доказів:', e?.message || e);
    return null;
  });

  if (!thread) return;

  await safeSend(thread, {
    content:
      `||<@${issuerId}>||, додайте, будь ласка, **докази** сюди.` +
      (punishMsgUrl ? `\n🔗 Повідомлення: ${punishMsgUrl}` : ''),
    allowedMentions: { users: [issuerId] },
  }, 'postEvidenceCase thread.send');
}

/* =========================
   INFO MESSAGE
========================= */
async function getOrCreateInfoMessage(guild) {
  const infoChannel = INFO_CHANNEL_ID
    ? await client.channels.fetch(INFO_CHANNEL_ID).catch((e) => {
        console.error('❌ Не можу отримати INFO_CHANNEL_ID:', e?.message || e);
        return null;
      })
    : null;

  if (!infoChannel) return null;

  const stored = SQL.getSetting.get(guild.id, 'info_message_id')?.value || null;

  if (stored) {
    const msg = await infoChannel.messages.fetch(stored).catch(() => null);
    if (msg) return msg;
  }

  const msg = await safeSend(infoChannel, {
    content: '⏳ Завантажую Info-Dogan...',
  }, 'getOrCreateInfoMessage');

  if (!msg) return null;

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
        line += ' — ⚠️ **Пройшло 24 год, потрібно видати повторно**';
      }

      items.push(line);
    }

    if (strict > 0) {
      let line = `Сувора догана (${strict}/3)`;

      if (strict === 2) line += ' — **Пониження в посаді**';
      if (strict === 3) line += ' — **Звільнення**';

      if (isPassed(fresh.strict_start, MS.DOGAN_DUE)) {
        line += ' — ⚠️ **Пройшло 24 год, потрібно видати повторно**';
      }

      items.push(line);
    }

    if (reattest) {
      items.push('Переатестація');
    }

    blocks.push(
      `> **<@${member.id}>**\n` +
      items.map(x => `> • ${x}`).join('\n'),
    );
  }

  const header =
    '**Info-Dogan — активні дисциплінарні стягнення**\n' +
    `Оновлено: **${formatTime()}**\n\n`;

  const body = blocks.length
    ? blocks.join('\n\n')
    : '✅ Немає активних дисциплінарних стягнень.';

  await safeEdit(infoMsg, {
    content: (header + body).slice(0, 1900),
  }, 'renderInfoMessage edit');
}

/* =========================
   READY
========================= */
client.once('ready', async () => {
  console.log(`✅ Бот запущений як ${client.user.tag}`);

  await registerSlashCommands();

  if (GUILD_ID) {
    const guild = await client.guilds.fetch(GUILD_ID).catch((e) => {
      console.error('❌ Не можу отримати guild:', e?.message || e);
      return null;
    });

    if (guild) await renderInfoMessage(guild);
  }

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
});

/* =========================
   INTERACTIONS
========================= */
client.on('interactionCreate', async (interaction) => {
  try {
    /* ---------- BUTTONS ---------- */
    if (interaction.isButton()) {
      if (interaction.customId === 'badge_get') {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('dep_PA')
            .setLabel('Police Academy')
            .setStyle(ButtonStyle.Secondary),

          new ButtonBuilder()
            .setCustomId('dep_CPD')
            .setLabel('CPD')
            .setStyle(ButtonStyle.Secondary),

          new ButtonBuilder()
            .setCustomId('dep_IAD')
            .setLabel('IAD')
            .setStyle(ButtonStyle.Secondary),

          new ButtonBuilder()
            .setCustomId('dep_PAI')
            .setLabel('PAI')
            .setStyle(ButtonStyle.Secondary),

          new ButtonBuilder()
            .setCustomId('dep_DB')
            .setLabel('DB')
            .setStyle(ButtonStyle.Secondary),
        );

        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('dep_SWAT')
            .setLabel('S.W.A.T.')
            .setStyle(ButtonStyle.Danger),
        );

        return interaction.reply({
          content: 'Оберіть відділ для бейджа:',
          components: [row, row2],
          ephemeral: true,
        });
      }

      if (interaction.customId.startsWith('dep_')) {
        if (!interaction.guild) {
          return interaction.reply({
            content: '❌ Це можна використовувати лише на сервері.',
            ephemeral: true,
          });
        }

        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

        if (!member) {
          return interaction.reply({
            content: '❌ Не можу знайти Ваш профіль на сервері.',
            ephemeral: true,
          });
        }

        const depMap = {
          dep_PA: 'Police Academy',
          dep_CPD: 'CPD',
          dep_IAD: 'IAD',
          dep_PAI: 'PAI',
          dep_DB: 'DB',
          dep_SWAT: 'S.W.A.T.',
        };

        const department = depMap[interaction.customId] || 'Police Academy';

        return interaction.showModal(buildBadgeModal(member, department));
      }

      return;
    }

    /* ---------- BADGE MODAL ---------- */
    if (interaction.isModalSubmit()) {
      if (!interaction.customId.startsWith('badge_modal_')) return;

      const departmentRaw = interaction.customId.replace('badge_modal_', '');
      const department = normalizeDepartment(departmentRaw);

      const fullName = cleanNicknameName(
        interaction.fields.getTextInputValue('fullName'),
      );

      const staticId = interaction.fields
        .getTextInputValue('staticId')
        .trim();

      if (!department || !fullName || !staticId) {
        return interaction.reply({
          content: '❌ Заповніть всі поля.',
          ephemeral: true,
        });
      }

      const embed = new EmbedBuilder()
        .setColor(0x1f2b3a)
        .setTitle('Жетон')
        .addFields(
          {
            name: 'Жетон:',
            value:
              '```' +
              `/do На грудях висить жетон: [LSPD | ${department} | ${fullName} | ${staticId}].` +
              '```',
          },
          {
            name: 'Примітка:',
            value:
              'Якщо дані введені невірно — натисніть **"Створити бейдж"** повторно.',
          },
        );

      await safeSend(interaction.channel, {
        content: `||<@${interaction.user.id}>||`,
        embeds: [embed],
        components: [buildBadgeButtonRow()],
        allowedMentions: { users: [interaction.user.id] },
      }, 'badge modal channel.send');

      return interaction.reply({
        content: '✅ Бейдж створено.',
        ephemeral: true,
      });
    }

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

      const member = await interaction.guild.members.fetch({
        user: userId,
        force: true,
      }).catch(() => null);

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
        return interaction.respond([
          { name: 'Немає активних стягнень', value: 'none' },
        ]);
      }

      const q = String(focused.value || '').toLowerCase();

      return interaction.respond(
        items
          .filter(x => x.name.toLowerCase().includes(q))
          .slice(0, 25),
      );
    }

    /* ---------- COMMANDS ---------- */
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'badge') {
      if (!interaction.guild) {
        return interaction.reply({
          content: '❌ Команда доступна лише на сервері.',
          ephemeral: true,
        });
      }

      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

      if (!member) {
        return interaction.reply({
          content: '❌ Не можу знайти Ваш профіль на сервері.',
          ephemeral: true,
        });
      }

      return interaction.showModal(buildBadgeModal(member));
    }

    if (interaction.commandName === 'badgepanel') {
      if (!interaction.guild) {
        return interaction.reply({
          content: '❌ Команда доступна лише на сервері.',
          ephemeral: true,
        });
      }

      const mem = interaction.member;
      const isAdmin = mem.permissions.has(PermissionsBitField.Flags.Administrator);

      if (!isAdmin) {
        return interaction.reply({
          content: '❌ Цю команду може використовувати лише адміністрація.',
          ephemeral: true,
        });
      }

      await sendBadgePanel(interaction.channel);

      return interaction.reply({
        content: '✅ Панель бейджів створена.',
        ephemeral: true,
      });
    }

    const cmd = interaction.commandName;
    if (cmd !== 'dogan' && cmd !== 'undogan') return;

    if (!interaction.guild) {
      return interaction.reply({
        content: '❌ Команда доступна лише на сервері.',
        ephemeral: true,
      });
    }

    const mem = interaction.member;
    const isAdmin = mem.permissions.has(PermissionsBitField.Flags.Administrator);

    if (!isAdmin && !hasDisciplineAccess(mem)) {
      return interaction.reply({
        content: '❌ У вас немає доступу до дисциплінарної системи.',
        ephemeral: true,
      });
    }

    const punishChannel = PUNISH_CHANNEL_ID
      ? await interaction.guild.channels.fetch(PUNISH_CHANNEL_ID).catch((e) => {
          console.error('❌ Не можу отримати PUNISH_CHANNEL_ID:', e?.message || e);
          return null;
        })
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
      const type = interaction.options.getString('type', true);

      let res;

      try {
        res = await applyIncrement(targetMember, type);
      } catch (e) {
        console.error('❌ Role add/remove error:', e?.message || e);

        return interaction.reply({
          content: '❌ Не вдалося змінити ролі. Перевір Manage Roles і позицію ролі бота.',
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

      const punishMsg = await safeSend(punishChannel, {
        content: `||<@${targetUser.id}>||`,
        embeds: [
          buildEmbed({
            title: 'Дисциплінарне стягнення',
            kind: 'punish',
            issuerId,
            targetId: targetUser.id,
            reason,
            typeLine: res.typeLine,
            systemNote: res.systemNote,
          }),
        ],
        allowedMentions: { users: [targetUser.id] },
      }, 'dogan punishChannel.send');

      if (!punishMsg) {
        return interaction.reply({
          content: '❌ Бот не зміг написати в канал стягнень. Перевір права каналу.',
          ephemeral: true,
        });
      }

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
        console.error('❌ Role add/remove error:', e?.message || e);

        return interaction.reply({
          content: '❌ Не вдалося змінити ролі. Перевір Manage Roles і позицію ролі бота.',
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

      const msg = await safeSend(punishChannel, {
        content: `||<@${targetUser.id}>||`,
        embeds: [
          buildEmbed({
            title: 'Зняття дисциплінарного стягнення',
            kind: 'unpunish',
            issuerId,
            targetId: targetUser.id,
            reason,
            typeLine: res.typeLine,
            systemNote: '',
          }),
        ],
        allowedMentions: { users: [targetUser.id] },
      }, 'undogan punishChannel.send');

      if (!msg) {
        return interaction.reply({
          content: '❌ Бот не зміг написати в канал стягнень. Перевір права каналу.',
          ephemeral: true,
        });
      }

      await renderInfoMessage(interaction.guild);

      return silentAck(interaction);
    }
  } catch (e) {
    console.error('❌ interactionCreate error:', e?.message || e);

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '❌ Виникла помилка при обробці дії.',
        ephemeral: true,
      }).catch(() => {});
    }
  }
});

/* =========================
   START
========================= */
client.login(process.env.DISCORD_TOKEN);

process.on('unhandledRejection', (err) => {
  console.error('UnhandledRejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('UncaughtException:', err);
});
