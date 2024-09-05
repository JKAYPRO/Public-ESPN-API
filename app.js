require('dotenv').config();
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

const stringSimilarity = require('string-similarity');
const cron = require('node-cron');
const { createCanvas } = require('canvas');
const Chart = require('chart.js');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { Storage } = require('@google-cloud/storage');
const fs = require('fs');



// ESPN API endpoints
const nflScoreboardApiUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const nflTeamApiUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams';

const accessToken = process.env.ACCESS_TOKEN; // Using environment variable for access token
const whatsappApiUrl = 'https://graph.facebook.com/v13.0/355645230970425/messages';

(async () => {
    // Google Cloud Text-to-Speech and Storage
    const ttsClient = new TextToSpeechClient({
        keyFilename: process.env.TTS_KEY_FILE // Ensure this path is correct
    });
    const storage = new Storage({
        keyFilename: process.env.STORAGE_KEY_FILE // Ensure this path is correct
    });
    const bucketName = process.env.BUCKET_NAME; // Google Cloud Storage bucket name

    // Express setup
    const app = express();
    app.use(bodyParser.urlencoded({ extended: false }));
    app.use(bodyParser.json());
    const port = process.env.PORT || 3000;

    // In-memory storage for users who opt-in and prompts
    const optInUsers = {};
    const userPrompts = [];
    const lastMessages = {}; // To store the last message sent to each user

    // Function to send a message via WhatsApp API
    async function sendMessage(message, number) {
        // Check for duplicate messages
        if (lastMessages[number] && lastMessages[number] === message) {
            console.log(chalk.yellow(`Duplicate message to ${number} detected, skipping send.`));
            return;
        }

        try {
            const payload = {
                messaging_product: "whatsapp",
                to: number,
                type: "text",
                text: {
                    body: message
                }
            };
            console.log('Payload:', JSON.stringify(payload)); // Logging payload

            const response = await axios.post(whatsappApiUrl, payload, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log(chalk.green('Message sent to', number, ':', response.data));
            lastMessages[number] = message; // Update the last message sent
        } catch (error) {
            console.error(chalk.red(`Failed to send message to ${number}:`, error.response ? error.response.data : error.message));
            if (error.response && error.response.data.error.code === 190) {
                console.error(chalk.red('Access token expired. Please refresh the token.'));
            }
        }
    }

    // Function to send an image message via WhatsApp API
    async function sendImageMessage(imageUrl, number) {
        try {
            const payload = {
                messaging_product: "whatsapp",
                to: number,
                type: "image",
                image: {
                    link: imageUrl
                }
            };
            console.log('Payload:', JSON.stringify(payload)); // Logging payload

            const response = await axios.post(whatsappApiUrl, payload, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log(chalk.green('Image message sent to', number, ':', response.data));
        } catch (error) {
            console.error(chalk.red(`Failed to send image message to ${number}:`, error.response.data));
        }
    }

    // Function to send an audio message via WhatsApp API
    async function sendAudioMessage(audioUrl, number) {
        try {
            const payload = {
                messaging_product: "whatsapp",
                to: number,
                type: "audio",
                audio: {
                    link: audioUrl
                }
            };
            console.log('Payload:', JSON.stringify(payload)); // Logging payload

            const response = await axios.post(whatsappApiUrl, payload, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log(chalk.green('Audio message sent to', number, ':', response.data));
        } catch (error) {
            console.error(chalk.red(`Failed to send audio message to ${number}:`, error.response.data));
        }
    }

    // Function to generate and upload audio commentary using Google Cloud Text-to-Speech
    async function generateAndUploadAudio(text, fileName, fromNumber) {
        const ssmlText = `
            <speak>
                ${text.replace(/\n/g, '<break time="500ms"/>')}
            </speak>`;

        const request = {
            input: { ssml: ssmlText },
            voice: { languageCode: 'en-US', ssmlGender: 'MALE' },
            audioConfig: { audioEncoding: 'MP3' },
        };

        try {
            const [response] = await ttsClient.synthesizeSpeech(request);
            const audioPath = `${fileName.replace(/ /g, '_')}.mp3`;
            await fs.promises.writeFile(audioPath, response.audioContent, 'binary');
            await storage.bucket(bucketName).upload(audioPath, { destination: audioPath });
            const publicAudioUrl = `https://storage.googleapis.com/${bucketName}/${audioPath}`;
            console.log(`Public URL for audio: ${publicAudioUrl}`);
            sendAudioMessage(publicAudioUrl, fromNumber);
            await fs.promises.unlink(audioPath);
        } catch (err) {
            console.error(chalk.red('Error generating or uploading audio:', JSON.stringify(err, null, 2)));
            sendMessage('Error generating or uploading audio commentary.', fromNumber);
        }
    }

    // Function to fetch NFL scores
    async function getNflScores() {
        try {
            const response = await axios.get(nflScoreboardApiUrl);
            const scoreboard = response.data;

            if (!scoreboard || scoreboard.events.length === 0) {
                return { message: 'No games are currently available.', data: [] };
            }

            let message = 'NFL Scores:\n';
            scoreboard.events.forEach(event => {
                const homeTeam = event.competitions[0].competitors[0].team.displayName;
                const awayTeam = event.competitions[0].competitors[1].team.displayName;
                const homeScore = event.competitions[0].competitors[0].score;
                const awayScore = event.competitions[0].competitors[1].score;
                message += `${homeTeam} vs ${awayTeam}: ${homeScore} - ${awayScore}\n`;
            });

            return { message, data: scoreboard.events };
        } catch (error) {
            console.error('Error fetching NFL scores:', error);
            return { message: 'Error fetching NFL scores.', data: [] };
        }
    }

    // Function to fetch NFL team information
    async function getTeamInfo(teamName) {
        try {
            const response = await axios.get(nflTeamApiUrl);
            const teams = response.data.sports[0].leagues[0].teams;
            const matchedTeam = teams.find(team => team.team.displayName.toLowerCase() === teamName.toLowerCase());

            if (matchedTeam) {
                return `${matchedTeam.team.displayName} Info:\nWins: ${matchedTeam.team.record.items[0].summary}\nRank: ${matchedTeam.team.standingSummary}`;
            } else {
                return `Team ${teamName} not found.`;
            }
        } catch (error) {
            console.error('Error fetching team info:', error);
            return `Error fetching team info.`;
        }
    }

    // Function to handle multiple teams or commands
    async function handleMultipleTeams(teamNames, fromNumber) {
        try {
            const teamNameList = teamNames.split(',').map(name => name.trim());
            const results = await Promise.all(teamNameList.map(name => getTeamInfo(name)));
            const message = results.join('\n');
            sendMessage(message, fromNumber);
        } catch (error) {
            console.error(chalk.red('Error handling multiple teams:', error));
            sendMessage('Error fetching team data.', fromNumber);
        }
    }

    // Function to schedule NFL updates for opted-in users
    function scheduleNflUpdates() {
        Object.keys(optInUsers).forEach(number => {
            const user = optInUsers[number];
            if (user.teams.length > 0) {
                // Schedule updates for each followed team
                const job = cron.schedule(`*/${user.frequency} * * * *`, async () => {
                    const scoresData = await getNflScores();
                    const teamUpdates = await Promise.all(user.teams.map(team => getTeamInfo(team)));
                    const message = teamUpdates.join('\n');

                    if (lastMessages[number] !== message) {
                        sendMessage(message, number);
                    }
                });
                user.job = job;
            }
        });
    }

    // Function to send a welcome message with instructions
    function sendWelcomeMessage(number) {
        const welcomeMessage = `🎉 Welcome to NFL Feed! 🏈

Here are some commands you can use:
- "nfl scores" 📊: Get the current NFL scores.
- "team [team name]" 🏈: Get the stats for a specific team.
- "follow [team names] [minutes]" 🏈: Receive updates for specific teams at your chosen interval.
- "finish updates" 🚫: Stop receiving updates.

Enjoy and stay tuned for NFL updates! 🏈`;

        sendMessage(welcomeMessage, number);
    }

    // Simple GET route for testing
    app.get('/', (req, res) => {
        res.send('NFL Info Service is running');
    });

    // Webhook to handle incoming messages
    app.post('/webhook', async (req, res) => {
        try {
            console.log('Incoming webhook payload:', JSON.stringify(req.body, null, 2));
            
            if (!req.body.entry || !req.body.entry[0].changes[0].value.messages[0]) {
                console.log('Invalid webhook payload:', JSON.stringify(req.body, null, 2));
                return res.status(400).send('Invalid webhook payload');
            }

            const incomingMsg = req.body.entry[0].changes[0].value.messages[0].text.body.trim();
            const fromNumber = req.body.entry[0].changes[0].value.messages[0].from;

            console.log(chalk.blue(`Received message from ${fromNumber}: ${incomingMsg}`));

            userPrompts.push(incomingMsg); // Save the prompt
            const parts = incomingMsg.toLowerCase().split(' ');

            if (parts[0] === 'start') {
                sendWelcomeMessage(fromNumber);
            } else if (incomingMsg.toLowerCase() === 'nfl scores') {
                const scoresData = await getNflScores();
                sendMessage(scoresData.message, fromNumber);
            } else if (incomingMsg.toLowerCase().startsWith('team ')) {
                const teamName = incomingMsg.slice(5).trim();
                const teamInfoMessage = await getTeamInfo(teamName);
                sendMessage(teamInfoMessage, fromNumber);
            } else if (incomingMsg.toLowerCase().startsWith('follow ')) {
                const teamNames = incomingMsg.slice(7, -1).trim();
                const frequency = parseInt(parts[parts.length - 1], 10);
                if (!isNaN(frequency)) {
                    if (optInUsers[fromNumber] && optInUsers[fromNumber].job) {
                        optInUsers[fromNumber].job.stop();
                    }
                    optInUsers[fromNumber] = { teams: teamNames.split(','), frequency };
                    scheduleNflUpdates();
                    sendMessage(`You have opted in to receive updates for teams: ${teamNames} every ${frequency} minutes.`, fromNumber);
                } else {
                    sendMessage('Please provide a valid frequency in minutes.', fromNumber);
                }
            } else if (incomingMsg.toLowerCase() === 'finish updates') {
                if (optInUsers[fromNumber] && optInUsers[fromNumber].job) {
                    optInUsers[fromNumber].job.stop();
                    delete optInUsers[fromNumber].job;
                }
                sendMessage('You have successfully opted out of updates.', fromNumber);
            } else {
                handleMultipleTeams(incomingMsg, fromNumber);
            }

            res.send('<Response></Response>');
        } catch (error) {
            console.error('Error handling webhook:', error);
            res.status(500).send('Internal server error');
        }
    });

    // Start the Express server
    app.listen(port, () => {
        console.log('Server is running on port', port);

    });
})();
