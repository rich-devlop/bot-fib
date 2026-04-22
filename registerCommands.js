require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('dogan')
    .setDescription('Видати догану')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('Користувач')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Причина')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('undogan')
    .setDescription('Зняти догану')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('Користувач')
        .setRequired(true))
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Реєструю команди...');

    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );

    console.log('Команди зареєстровані ✅');
  } catch (error) {
    console.error(error);
  }
})();
