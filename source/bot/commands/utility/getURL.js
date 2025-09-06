const { SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, MessageFlags } = require('discord.js');
const { apiBaseUrl, apiKey } = require('../../config.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('geturl')
        .setDescription('Get URL for a playtest session'),

    async execute(interaction) {
        try {
            // First API call to get list of playtest sessions for this user
            const sessionsResponse = await fetch(`${apiBaseUrl}/GetPlaytestersTestSessions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                },
                body: JSON.stringify({
                    playtesterId: interaction.user.username
                })
            });

            const sessions = await sessionsResponse.json();

            // Create select menu options from the sessions array
            const selectOptions = sessions.map(session => ({
                label: session.name,
                value: session.playtestingID,
                description: `${session.startDate} to ${session.endDate}`
            }));

            // Check if there are any sessions available
            if (selectOptions.length === 0) {
                await interaction.reply({
                    content: 'No playtest sessions are currently available.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // Create the select menu
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('playtest_session_select')
                .setPlaceholder('Select a playtest session')
                .addOptions(selectOptions);

            const row = new ActionRowBuilder()
                .addComponents(selectMenu);

            // Send the selection menu to the user
            await interaction.reply({
                content: 'Please select a playtest session:',
                components: [row],
                flags: MessageFlags.Ephemeral,
            });

            // Create a message component collector
            const filter = i => i.customId === 'playtest_session_select' && i.user.id === interaction.user.id;
            const collector = interaction.channel.createMessageComponentCollector({ 
                filter, 
                time: 30000,
                max: 1 
            });

            collector.on('collect', async i => {
                const selectedSessionId = i.values[0];

                // Second API call to get playtester URL
                try {
                    const urlResponse = await fetch(`${apiBaseUrl}/GetPlaytesterURL`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': apiKey,
                        },
                        body: JSON.stringify({
                            playtesterId: interaction.user.username,
                            playtestsessionId: selectedSessionId
                        })
                    });

                    if (!urlResponse.ok) {
                        throw new Error(`Failed to get playtester URL: ${urlResponse.status}`);
                    }

                    console.log(urlResponse);

                    const urlData = await urlResponse.json();

                    console.log(urlData);

                    await i.update({
                        content: `Here is your playtest URL: [link.](${urlData.playtestURL})`,
                        components: [],
                        flags: MessageFlags.Ephemeral,
                    });

                } catch (error) {
                    console.error('Error getting playtester URL:', error);
                    await i.update({
                        content: 'Sorry, there was an error getting your playtest URL.',
                        components: [],
                        flags: MessageFlags.Ephemeral,
                    });
                }
            });

            collector.on('end', collected => {
                if (collected.size === 0) {
                    interaction.editReply({
                        content: 'Selection timed out. Please try again.',
                        components: [],
                        flags: MessageFlags.Ephemeral,
                    });
                }
            });

        } catch (error) {
            console.error('Error:', error);
            await interaction.reply({
                content: 'Sorry, there was an error fetching the playtest sessions.',
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};