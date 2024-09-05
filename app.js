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

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // The token you set up in the Facebook Developer Console
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

// ESPN API endpoints
const nflScoreboardApiUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const nflTeamApiUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams';

(async () => {
    // Google Cloud Text-to-Speech and Storage setup
    const ttsClient = new TextToSpeechClient({ keyFilename: process.env.TTS_KEY_FILE });
    const storage = new Storage({ keyFilename: process.env.STORAGE_KEY_FILE });
    const bucketName = process.env.BUCKET_NAME;

    // In-memory storage for users who opt-in and prompts
    const optInUsers = {};
    const userPrompts = [];
    const lastMessages = {}; // To store the last message sent to each user

    // Webhook verification endpoint
    app.get('/webhook', (req, res) => {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (mode && token) {
            if (mode === 'subscribe' && token === VERIFY_TOKEN) {
                console.log('WEBHOOK_VERIFIED');
                res.status(200).send(challenge);
            } else {
                res.status(403).send('Verification failed');
            }
        } else {
            res.status(400).send('Bad Request');
        }
    });

    // Handle incoming messages from WhatsApp
    app.post('/webhook', async (req, res) => {
        try {
            console.log('Incoming webhook payload:', JSON.stringify(req.body, null, 2));

            if (!req.body.entry || !req.body.entry[0].changes[0].value.messages[0]) {
                console.log('Invalid webhook payload:', JSON.stringify(req.body, null, 2));
                return res.status(400).send('Invalid webhook payload');
            }

            const incomingMsg = req.body.entry[0].changes[0].value.messages[0].text.body.trim();
            const fromNumber = req.body.entry[0].changes[0].value.messages[0].from;

            console.log(`Received message from ${fromNumber}: ${incomingMsg}`);

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
                const teamNames = incomingMsg.slice(7).trim();
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

    // Function to send a message via WhatsApp API
    async function sendMessage(message, number) {
        // Check for duplicate messages
        if (lastMessages[number] && lastMessages[number] === message) {
            console.log(`Duplicate message to ${number} detected, skipping send.`);
            return;
        }

        try {
            const payload = {
                messaging_product: "whatsapp",
                to: number,
                type: "text",
                text: { body: message }
            };

            console.log('Payload:', JSON.stringify(payload));

            const response = await axios.post(WHATSAPP_API_URL, payload, {
                headers: {
                    Authorization: `Bearer ${ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('Message sent to', number, ':', response.data);
            lastMessages[number] = message; // Update the last message sent
        } catch (error) {
            console.error(`Failed to send message to ${number}:`, error.response ? error.response.data : error.message);
            if (error.response && error.response.data.error.code === 190) {
                console.error('Access token expired. Please refresh the token.');
            }
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
            console.error('Error handling multiple teams:', error);
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

    // Start the Express server
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log('Server is running on port', port);
    });
})();
