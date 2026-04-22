require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

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
          { name: 'Переатестація', value: 'reattest' }
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
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Починаю реєстрацію команд...');

    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands.map(cmd => cmd.toJSON()) }
    );

    console.log('Команди успішно зареєстровані.');
  } catch (error) {
    console.error('Помилка реєстрації команд:', error);
  }
})();
