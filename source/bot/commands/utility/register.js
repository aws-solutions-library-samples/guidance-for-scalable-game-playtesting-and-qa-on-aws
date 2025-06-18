/* eslint-disable indent */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { apiBaseUrl, apiKey, playtestSessionID } = require('../../config.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('register')
        .setDescription('Registration for the upcoming playtesting event')
        .addStringOption(option =>
            option
                .setName('input')
                .setDescription('Choose to register for the upcoming playtesting event?')
                .setRequired(true)
                .addChoices(
                    { name: 'Yes', value: 'yes' },
                    { name: 'No', value: 'no' },
                )),

    async execute(interaction) {
        const input = interaction.options.getString('input');

        if (input === 'yes') {
            try {
                const headers = {
                    'content-type': 'application/json',
                    'x-api-key': apiKey,
                };
                console.log('Request Headers:', headers);

                const response = await fetch(`${apiBaseUrl}/register/`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                    },
                    body: JSON.stringify({
                        playtesterId: `${interaction.user.username}`,
                        playtestsessionId: playtestSessionID,
                    }),
                });

                if (!response.ok) {
                    throw new Error(`POST request failed with status: ${response.status}`);
                }

                const data = await response.json();

                console.log('API Response:', data);
                await interaction.reply({
                    content: `The user ${interaction.user.username} has successfully registered! Here is your [link.](${data.playtestURL})\n\nYour log-in is:\n\nusername: ${data.username}\npassword: ${data.password}\n
                    `,
                    flags: MessageFlags.Ephemeral,
                });
            }
            catch (error) {
                console.error('Error:', error);
                await interaction.reply({
                    content: 'Sorry, there was an error processing your registration.',
                    flags: MessageFlags.Ephemeral,
                });
            }
        }
        else {
            await interaction.reply({
                content: 'You have selected no 😢',
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
