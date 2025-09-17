const { SlashCommandBuilder, MessageFlags, StringSelectMenuBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { apiBaseUrl, apiKey } = require('../../config.json');

// Suppress deprecation warning
process.removeAllListeners('warning');

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
                // Fetch available playtest sessions
                const sessionsResponse = await fetch(`${apiBaseUrl}/GetPlayTestSessions`, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                    }
                });

                if (!sessionsResponse.ok) {
                    throw new Error(`Failed to fetch playtest sessions: ${sessionsResponse.status}`);
                }

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

                try {
                    // Create a message component collector with safer filter
                    const filter = (i) => {
                        if (!i?.user) return false;
                        return i.customId === 'playtest_session_select' && i.user.id === interaction.user.id;
                    };

                    const collector = interaction.channel.createMessageComponentCollector({ 
                        filter, 
                        time: 30000,
                        max: 1 
                    });

                    collector.on('collect', async i => {
                        try {
                            const selectedSessionId = i.values[0];

                            //Now we ask for email
                            const modal = new ModalBuilder()
                                .setCustomId('email_modal')
                                .setTitle('Enter your email');

                            const emailInput = new TextInputBuilder()
                                .setCustomId('email_input')
                                .setLabel("What's your email address?")
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setPlaceholder('Enter your email address');

                            const firstActionRow = new ActionRowBuilder().addComponents(emailInput);
                            modal.addComponents(firstActionRow);

                            await i.showModal(modal);

                            try {
                                const modalSubmit = await i.awaitModalSubmit({ 
                                    time: 30000,
                                    filter: (modalInteraction) => {
                                        if (!modalInteraction?.user) return false;
                                        return modalInteraction.user.id === interaction.user.id;
                                    }
                                });

                                await modalSubmit.deferReply({ ephemeral: true });

                                const email = modalSubmit.fields.getTextInputValue('email_input');

                                try {
                                    // Final registration API call
                                    const registerResponse = await fetch(`${apiBaseUrl}/register/`, {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json',
                                            'x-api-key': apiKey,
                                        },
                                        body: JSON.stringify({
                                            playtesterId: interaction.user.username,
                                            playtestsessionId: selectedSessionId,
                                            playtesterEmail: email
                                        }),
                                    });

                                    const registerData = await registerResponse.json();

                                    // Check for both 500 error with invalid email and InvalidParameterException
                                    if (!registerResponse.ok || 
                                        (registerData.error && (
                                            registerData.error.includes('Invalid email address format') || 
                                            registerData.error.includes('InvalidParameterException')
                                        ))
                                    ) {
                                        if (registerData.error && registerData.error.includes('Invalid email address format')) {
                                            await modalSubmit.editReply({
                                                content: 'Please provide a valid email address format.',
                                                flags: MessageFlags.Ephemeral,
                                            });
                                            return;
                                        }
                                        if (registerData.error && registerData.error.includes('InvalidParameterException')) {
                                            await modalSubmit.editReply({
                                                content: 'The email address provided is not valid. Please try the registration process again with a valid email address.',
                                                flags: MessageFlags.Ephemeral,
                                            });
                                            return;
                                        }
                                        throw new Error(registerData.message || `Registration failed with status: ${registerResponse.status}`);
                                    }

                                    let replyContent;
                                    if (registerData.username) {
                                        replyContent = `You have successfully registered! Here is your [link.](${registerData.playtestURL})\n\nYour username is: ${registerData.username}\n\n${registerData.message}`;
                                    } else {
                                        replyContent = `${registerData.message}\n\nHere is your [link.](${registerData.playtestURL})`;
                                    }


                                    await modalSubmit.editReply({
                                        content: replyContent,
                                        flags: MessageFlags.Ephemeral,
                                    });

                                } catch (apiError) {
                                    console.error('API Error:', apiError?.message || apiError);
                                    await modalSubmit.editReply({
                                        content: 'There was an error processing your registration. Please try again later.',
                                        flags: MessageFlags.Ephemeral,
                                    });
                                }

                            } catch (modalError) {
                                if (modalError.code === 'InteractionCollectorError') {
                                    await i.followUp({
                                        content: 'Email submission timed out. Please try the registration process again.',
                                        flags: MessageFlags.Ephemeral,
                                    });
                                } else {
                                    console.error('Modal Error:', modalError?.message || modalError);
                                    await i.followUp({
                                        content: 'There was an error processing your input. Please try again.',
                                        flags: MessageFlags.Ephemeral,
                                    });
                                }
                            }
                        } catch (error) {
                            console.error('Interaction Error:', error?.message || error);
                            if (!i.replied) {
                                await i.reply({
                                    content: 'An error occurred during registration. Please try again.',
                                    flags: MessageFlags.Ephemeral,
                                });
                            }
                        }
                    });

                    collector.on('end', collected => {
                        if (collected.size === 0) {
                            interaction.editReply({
                                content: 'Selection timed out. Please try again.',
                                components: [],
                                flags: MessageFlags.Ephemeral,
                            }).catch(console.error);
                        }
                    });

                    collector.on('error', error => {
                        console.error('Collector Error:', error?.message || error);
                        interaction.editReply({
                            content: 'An error occurred. Please try again.',
                            components: [],
                            flags: MessageFlags.Ephemeral,
                        }).catch(console.error);
                    });

                } catch (collectorError) {
                    console.error('Collector Setup Error:', collectorError?.message || collectorError);
                    await interaction.editReply({
                        content: 'An error occurred. Please try again.',
                        components: [],
                        flags: MessageFlags.Ephemeral,
                    });
                }

            } catch (error) {
                console.error('Initial Error:', error?.message || error);
                if (!interaction.replied) {
                    await interaction.reply({
                        content: 'Sorry, there was an error processing your registration.',
                        flags: MessageFlags.Ephemeral,
                    });
                }
            }
        } else {
            await interaction.reply({
                content: 'You have selected no 😢',
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
