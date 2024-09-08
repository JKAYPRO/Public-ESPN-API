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

// Fetch NFL scores with proper error handling
async function fetchNflScores() {
    try {
        const response = await axios.get(nflScoreboardApiUrl);
        return response.data.events || [];
    } catch (error) {
        console.error('Error fetching NFL scores:', error.message || error);
        return [];
    }
}

// Fetch team information with proper checks and error handling
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

// Format game summary with validation
function formatGameSummary(game) {
    if (!game || !game.competitions || !game.competitions[0] || !game.competitions[0].competitors) {
        return 'No game data available.';
    }

    const home = game.competitions[0].competitors.find(c => c.homeAway === 'home');
    const away = game.competitions[0].competitors.find(c => c.homeAway === 'away');
    return `${home.team.displayName} vs ${away.team.displayName}: ${home.score} - ${away.score}`;
}

// Format venue information with validation
function formatVenueInfo(game) {
    if (!game || !game.competitions || !game.competitions[0] || !game.competitions[0].venue) {
        return 'Venue information not available.';
    }

    const venue = game.competitions[0].venue;
    return `Venue: ${venue.fullName} (${venue.address.city}, ${venue.address.state})`;
}

// Format broadcast information with validation
function formatBroadcastInfo(game) {
    if (!game || !game.competitions || !game.competitions[0] || !game.competitions[0].broadcasts) {
        return 'Broadcast information not available.';
    }

    const broadcasts = game.competitions[0].broadcasts.map(b => b.names.join(', ')).join(', ');
    return `Broadcasts: ${broadcasts}`;
}

// Format odds information with validation
function formatOddsInfo(game) {
    if (!game || !game.competitions || !game.competitions[0] || !game.competitions[0].odds || !game.competitions[0].odds[0]) {
        return 'Odds information not available.';
    }

    const odds = game.competitions[0].odds[0];
    return `Odds: ${odds.homeTeamOdds.team.abbreviation} ${odds.details} (O/U: ${odds.overUnder})`;
}

// Handle user subscriptions with proper checks
async function handleUserSubscriptions() {
    const scoreboard = await fetchNflScores();
    const currentTime = new Date();

    for (const number in userSubscriptions) {
        const { teams, frequency, lastUpdated } = userSubscriptions[number];
        const timeSinceLastUpdate = (currentTime - new Date(lastUpdated)) / 60000; // time in minutes

        if (timeSinceLastUpdate >= frequency) {
            const messages = teams.map(teamName => {
                const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase().includes(teamName.toLowerCase())));
                return game ? formatGameSummary(game) : `No game found for ${teamName}.`;
            }).join('\n');

            await sendMessage(messages, number);
            userSubscriptions[number].lastUpdated = currentTime; // Update last updated time
        }
    }
}

// Cron job to check and send updates
cron.schedule('* * * * *', handleUserSubscriptions); // Runs every minute

// Send a combined help/start message
async function sendHelpMessage(number) {
    const message = `🎉 Welcome to NFL Feed! 🏈

Here are some commands you can use:
- "score [team]" 📊: Get the current score for a specific team.
- "all scores" 📊: Get the current scores for all ongoing NFL games.
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
        } else if (incomingMsg.startsWith('score ')) {
            const teamName = incomingMsg.slice(6).trim();
            const scoreboard = await fetchNflScores();
            const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase().includes(teamName.toLowerCase())));
            const message = game ? formatGameSummary(game) : `No game found for ${teamName}.`;
            await sendMessage(message, fromNumber);
        } else if (incomingMsg === 'all scores') {
            const scoreboard = await fetchNflScores();
            const message = scoreboard.length > 0 
                ? scoreboard.map(game => formatGameSummary(game)).join('\n')
                : 'No current NFL games available.';
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
            if (!isNaN(frequency) && parseInt(frequency) > 0) {
                userSubscriptions[fromNumber] = {
                    teams: teamNames.split(',').map(t => t.trim()),
                    frequency: parseInt(frequency),
                    lastUpdated: new Date()
                };
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
