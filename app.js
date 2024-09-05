require('dotenv').config();
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const port = process.env.PORT || 3000;
const accessToken = process.env.ACCESS_TOKEN;
const whatsappApiUrl = process.env.WHATSAPP_API_URL;

const nflScoreboardApiUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const nflTeamApiUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams';

const ttsClient = new TextToSpeechClient({ keyFilename: process.env.TTS_KEY_FILE });
const storage = new Storage({ keyFilename: process.env.STORAGE_KEY_FILE });
const bucketName = process.env.BUCKET_NAME;

let userPreferences = {};

// Helper function to send a WhatsApp message
async function sendMessage(message, number) {
    try {
        const payload = {
            messaging_product: "whatsapp",
            to: number,
            type: "text",
            text: { body: message }
        };
        await axios.post(whatsappApiUrl, payload, {
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error(`Failed to send message: ${error.response ? error.response.data : error.message}`);
    }
}

// Fetch NFL scores with error handling
async function fetchNflScores() {
    try {
        const response = await axios.get(nflScoreboardApiUrl);
        return response.data.events || [];
    } catch (error) {
        console.error('Error fetching NFL scores:', error.message || error);
        return [];
    }
}

// Fetch team information with proper checks
async function fetchTeamInfo(teamName) {
    try {
        const response = await axios.get(nflTeamApiUrl);
        const teams = response.data.sports[0].leagues[0].teams;
        return teams.find(team => team.team.displayName.toLowerCase() === teamName.toLowerCase()) || null;
    } catch (error) {
        console.error('Error fetching team info:', error.message || error);
        return null;
    }
}

// Format game information
function formatGameSummary(game) {
    if (!game || !game.competitions[0]) return 'No game data available.';
    
    const home = game.competitions[0].competitors[0];
    const away = game.competitions[0].competitors[1];
    return `${home.team.displayName} vs ${away.team.displayName}: ${home.score} - ${away.score}`;
}

function formatVenueInfo(game) {
    const venue = game.competitions[0].venue;
    return venue ? `Venue: ${venue.fullName} (${venue.address.city}, ${venue.address.state})` : 'Venue information not available.';
}

function formatBroadcastInfo(game) {
    const broadcasts = game.competitions[0].broadcasts.map(b => b.names.join(', ')).join(', ');
    return broadcasts ? `Broadcasts: ${broadcasts}` : 'Broadcast information not available.';
}

function formatOddsInfo(game) {
    if (!game.competitions[0].odds || !game.competitions[0].odds[0]) return 'Odds information not available.';
    
    const odds = game.competitions[0].odds[0];
    return `Odds: ${odds.homeTeamOdds.team.abbreviation} ${odds.details} (O/U: ${odds.overUnder})`;
}

// Send a combined help/start message
async function sendHelpMessage(number) {
    const message = `🎉 Welcome to NFL Feed! 🏈

Here are some commands you can use:
- "nfl scores" 📊: Get the current NFL scores.
- "team [team name]" 🏈: Get the stats for a specific team.
- "follow [team names] [minutes]" 🏈: Receive updates for specific teams at your chosen interval.
- "finish updates" 🚫: Stop receiving updates.
- "game score [team]" 🏟️: Get the score of a game involving a specific team.
- "venue [team]" 🏟️: Get the venue information of a game involving a specific team.
- "TV [team]" 📺: Get the broadcast information of a game involving a specific team.
- "odds [team]" 🎲: Get the odds information of a game involving a specific team.
- "set favorite [team]" ⭐: Set your favorite team to get quick updates.
- "my team" 🏈: Get updates about your favorite team.
- "help" 📖: Display this help message.

Enjoy and stay tuned for NFL updates! 🏈`;

    await sendMessage(message, number);
}

app.post('/webhook', async (req, res) => {
    try {
        const incomingMsg = req.body.entry[0].changes[0].value.messages[0].text.body.trim().toLowerCase();
        const fromNumber = req.body.entry[0].changes[0].value.messages[0].from;

        if (incomingMsg === 'start' || incomingMsg === 'help') {
            await sendHelpMessage(fromNumber);
        } else if (incomingMsg === 'nfl scores') {
            const scoreboard = await fetchNflScores();
            const message = scoreboard.length > 0 
                ? scoreboard.map(game => formatGameSummary(game)).join('\n')
                : 'No current NFL games available.';
            await sendMessage(message, fromNumber);
        } else if (incomingMsg.startsWith('team ')) {
            const teamName = incomingMsg.slice(5).trim();
            const teamInfo = await fetchTeamInfo(teamName);
            const message = teamInfo 
                ? `${teamInfo.team.displayName} Stats:\n${JSON.stringify(teamInfo.team, null, 2)}` 
                : `Team ${teamName} not found.`;
            await sendMessage(message, fromNumber);
        } else if (incomingMsg.startsWith('game score ')) {
            const teamName = incomingMsg.slice(11).trim();
            const scoreboard = await fetchNflScores();
            const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase() === teamName.toLowerCase()));
            const message = game ? formatGameSummary(game) : `No game found for ${teamName}.`;
            await sendMessage(message, fromNumber);
        } else if (incomingMsg.startsWith('venue ')) {
            const teamName = incomingMsg.slice(6).trim();
            const scoreboard = await fetchNflScores();
            const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase() === teamName.toLowerCase()));
            const message = game ? formatVenueInfo(game) : `No game found for ${teamName}.`;
            await sendMessage(message, fromNumber);
        } else if (incomingMsg.startsWith('tv ')) {
            const teamName = incomingMsg.slice(3).trim();
            const scoreboard = await fetchNflScores();
            const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase() === teamName.toLowerCase()));
            const message = game ? formatBroadcastInfo(game) : `No game found for ${teamName}.`;
            await sendMessage(message, fromNumber);
        } else if (incomingMsg.startsWith('odds ')) {
            const teamName = incomingMsg.slice(5).trim();
            const scoreboard = await fetchNflScores();
            const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase() === teamName.toLowerCase()));
            const message = game ? formatOddsInfo(game) : `No game found for ${teamName}.`;
            await sendMessage(message, fromNumber);
        } else if (incomingMsg.startsWith('set favorite ')) {
            const teamName = incomingMsg.slice(13).trim();
            userPreferences[fromNumber] = teamName;
            await sendMessage(`Your favorite team is set to ${teamName}.`, fromNumber);
        } else if (incomingMsg === 'my team') {
            const teamName = userPreferences[fromNumber];
            if (teamName) {
                const teamInfo = await fetchTeamInfo(teamName);
                const message = teamInfo 
                    ? `${teamInfo.team.displayName} Stats:\n${JSON.stringify(teamInfo.team, null, 2)}` 
                    : `Team ${teamName} not found.`;
                await sendMessage(message, fromNumber);
            } else {
                await sendMessage(`You haven't set a favorite team yet. Use "set favorite [team]" to set one.`, fromNumber);
            }
        } else {
            await sendMessage(`Unknown command. Type "help" to see available commands.`, fromNumber);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Error handling webhook:', error.message || error);
        res.status(500).send('Internal server error');
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
