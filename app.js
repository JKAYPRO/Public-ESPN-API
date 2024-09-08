require('dotenv').config();
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const port = process.env.PORT || 3000;
const accessToken = process.env.ACCESS_TOKEN;
const whatsappApiUrl = process.env.WHATSAPP_API_URL;

const nflScoreboardApiUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const nflTeamApiUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams';

let userSubscriptions = {};

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

// Fetch NFL scores
async function fetchNflScores() {
    try {
        const response = await axios.get(nflScoreboardApiUrl);
        return response.data.events || [];
    } catch (error) {
        console.error('Error fetching NFL scores:', error.message || error);
        return [];
    }
}

// Fetch team information
async function fetchTeamInfo(teamName) {
    try {
        const response = await axios.get(nflTeamApiUrl);
        const teams = response.data.sports[0].leagues[0].teams;
        return teams.find(team => team.team.displayName.toLowerCase().includes(teamName.toLowerCase())) || null;
    } catch (error) {
        console.error('Error fetching team info:', error.message || error);
        return null;
    }
}

// Format game summary
function formatGameSummary(game) {
    if (!game || !game.competitions[0]) return 'No game data available.';
    
    const home = game.competitions[0].competitors[0];
    const away = game.competitions[0].competitors[1];
    return `${home.team.displayName} vs ${away.team.displayName}: ${home.score} - ${away.score}`;
}

// Format venue information
function formatVenueInfo(game) {
    const venue = game.competitions[0].venue;
    return venue ? `Venue: ${venue.fullName} (${venue.address.city}, ${venue.address.state})` : 'Venue information not available.';
}

// Format broadcast information
function formatBroadcastInfo(game) {
    const broadcasts = game.competitions[0].broadcasts.map(b => b.names.join(', ')).join(', ');
    return broadcasts ? `Broadcasts: ${broadcasts}` : 'Broadcast information not available.';
}

// Format odds information
function formatOddsInfo(game) {
    if (!game.competitions[0].odds || !game.competitions[0].odds[0]) return 'Odds information not available.';
    
    const odds = game.competitions[0].odds[0];
    return `Odds: ${odds.homeTeamOdds.team.abbreviation} ${odds.details} (O/U: ${odds.overUnder})`;
}

// Handle user subscriptions
function handleUserSubscriptions() {
    Object.keys(userSubscriptions).forEach(number => {
        const { teams, frequency } = userSubscriptions[number];
        if (teams && frequency) {
            cron.schedule(`*/${frequency} * * * *`, async () => {
                const scoreboard = await fetchNflScores();
                const messages = teams.map(teamName => {
                    const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase().includes(teamName.toLowerCase())));
                    return game ? formatGameSummary(game) : `No game found for ${teamName}.`;
                }).join('\n');
                await sendMessage(messages, number);
            });
        }
    });
}

// Send a combined help/start message
async function sendHelpMessage(number) {
    const message = `🎉 Welcome to NFL Feed! 🏈

Here are some commands you can use:
- "scores [team]" 📊: Get the current score for a specific team.
- "venue [team]" 🏟️: Get the venue information for a specific team.
- "TV [team]" 📺: Get the broadcast information for a specific team.
- "odds [team]" 🎲: Get the odds information for a specific team.
- "set updates [team names] [minutes]" 🕒: Set update frequency for specific teams (e.g., "set updates Chiefs, Giants 15").
- "stop updates" 🚫: Stop receiving updates.
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
        } else if (incomingMsg.startsWith('scores ')) {
            const teamName = incomingMsg.slice(7).trim();
            const scoreboard = await fetchNflScores();
            const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase().includes(teamName.toLowerCase())));
            const message = game ? formatGameSummary(game) : `No game found for ${teamName}.`;
            await sendMessage(message, fromNumber);
        } else if (incomingMsg.startsWith('venue ')) {
            const teamName = incomingMsg.slice(6).trim();
            const scoreboard = await fetchNflScores();
            const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase().includes(teamName.toLowerCase())));
            const message = game ? formatVenueInfo(game) : `No game found for ${teamName}.`;
            await sendMessage(message, fromNumber);
        } else if (incomingMsg.startsWith('tv ')) {
            const teamName = incomingMsg.slice(3).trim();
            const scoreboard = await fetchNflScores();
            const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase().includes(teamName.toLowerCase())));
            const message = game ? formatBroadcastInfo(game) : `No game found for ${teamName}.`;
            await sendMessage(message, fromNumber);
        } else if (incomingMsg.startsWith('odds ')) {
            const teamName = incomingMsg.slice(5).trim();
            const scoreboard = await fetchNflScores();
            const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase().includes(teamName.toLowerCase())));
            const message = game ? formatOddsInfo(game) : `No game found for ${teamName}.`;
            await sendMessage(message, fromNumber);
        } else if (incomingMsg.startsWith('set updates ')) {
            const [teamNames, frequency] = incomingMsg.slice(12).trim().split(/ +(?=\d+$)/);
            if (!isNaN(frequency)) {
                userSubscriptions[fromNumber] = { teams: teamNames.split(','), frequency: parseInt(frequency) };
                handleUserSubscriptions();
                await sendMessage(`You will receive updates every ${frequency} minutes for: ${teamNames}.`, fromNumber);
            } else {
                await sendMessage('Please provide a valid frequency in minutes.', fromNumber);
            }
        } else if (incomingMsg === 'stop updates') {
            delete userSubscriptions[fromNumber];
            await sendMessage('You have successfully stopped updates.', fromNumber);
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
