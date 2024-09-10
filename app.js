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
const nflPlayerStatsApiUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/athletes/stats';

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

// Fetch team information dynamically
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

// Fetch player stats dynamically for the 2024 season
async function fetchPlayerStats(playerId) {
    try {
        const response = await axios.get(`${nflPlayerStatsApiUrl}/${playerId}?season=2024`);
        return response.data.athlete || null;
    } catch (error) {
        console.error('Error fetching player stats:', error.message || error);
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

// Enhanced Team Recap
async function formatTeamRecap(team) {
    if (!team) return 'No team data available.';

    const recentGames = team.team.recentGames.map(game => formatGameSummary(game)).join('\n');
    const keyPlayers = team.team.roster.entries.map(player => `${player.athlete.displayName}: ${player.stats.summary}`).join('\n');
    const injuries = team.team.injuries.map(injury => `${injury.athlete.displayName}: ${injury.status} (${injury.detail})`).join('\n');
    const upcomingFixtures = team.team.schedule.map(fixture => `${fixture.date} vs ${fixture.opponent.displayName}`).join('\n');

    return `Team Recap for ${team.team.displayName}:
    - Recent Games:\n${recentGames}
    - Key Players:\n${keyPlayers}
    - Injuries:\n${injuries}
    - Upcoming Fixtures:\n${upcomingFixtures}`;
}

// In-Depth Game Leader Information
async function formatGameLeaderInfo(game) {
    if (!game || !game.competitions[0]) return 'No game data available.';

    const leaders = game.competitions[0].leaders.map(leader => {
        const player = leader.athlete.displayName;
        const stat = leader.displayValue;
        return `${player}: ${stat}`;
    }).join('\n');

    return `Game Leaders:\n${leaders}`;
}

// Send a combined help/start message
async function sendHelpMessage(number) {
    const message = `🎉 Welcome to NFL Feed! 🏈

Here are some commands you can use:
- "scores" 📊: Get the current NFL scores.
- "team [team name]" 🏈: Get detailed stats for a specific team.
- "game score [team]" 🏟️: Get the score of a game involving a specific team.
- "venue [team]" 🏟️: Get the venue information of a game involving a specific team.
- "tv [team]" 📺: Get the broadcast information of a game involving a specific team.
- "odds [team]" 🎲: Get the odds information of a game involving a specific team.
- "recap [team]" 📋: Get an in-depth recap of a specific team.
- "leaders [team]" 🏆: Get detailed game leader information.
- "set frequency [minutes]" ⏲️: Set how often you want to receive updates.

Enjoy and stay tuned for NFL updates! 🏈`;

    await sendMessage(message, number);
}

// Handle incoming messages
app.post('/webhook', async (req, res) => {
    try {
        const incomingMsg = req.body.entry[0].changes[0].value.messages[0].text.body.trim().toLowerCase();
        const fromNumber = req.body.entry[0].changes[0].value.messages[0].from;

        if (incomingMsg === 'start' || incomingMsg === 'help') {
            await sendHelpMessage(fromNumber);
        } else if (incomingMsg === 'scores') {
            const scoreboard = await fetchNflScores();
            const message = scoreboard.length > 0 
                ? scoreboard.map(game => formatGameSummary(game)).join('\n')
                : 'No current NFL games available.';
            await sendMessage(message, fromNumber);
        } else if (incomingMsg.startsWith('team ')) {
            const teamName = incomingMsg.slice(5).trim();
            const teamInfo = await fetchTeamInfo(teamName);
            const message = teamInfo 
                ? await formatTeamRecap(teamInfo) 
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
        } else if (incomingMsg.startsWith('recap ')) {
            const teamName = incomingMsg.slice(6).trim();
            const teamInfo = await fetchTeamInfo(teamName);
            const message = teamInfo 
                ? await formatTeamRecap(teamInfo) 
                : `Team ${teamName} not found.`;
            await sendMessage(message, fromNumber);
        } else if (incomingMsg.startsWith('leaders ')) {
            const teamName = incomingMsg.slice(8).trim();
            const scoreboard = await fetchNflScores();
            const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase() === teamName.toLowerCase()));
            const message = game ? await formatGameLeaderInfo(game) : `No game found for ${teamName}.`;
            await sendMessage(message, fromNumber);
        } else if (incomingMsg.startsWith('set frequency ')) {
            const frequency = parseInt(incomingMsg.slice(14).trim(), 10);
            if (!isNaN(frequency) && frequency > 0) {
                userPreferences[fromNumber] = frequency;
                cron.schedule(`*/${frequency} * * * *`, async () => {
                    const scoreboard = await fetchNflScores();
                    const message = scoreboard.length > 0 
                        ? scoreboard.map(game => formatGameSummary(game)).join('\n')
                        : 'No current NFL games available.';
                    await sendMessage(message, fromNumber);
                });
                await sendMessage(`Update frequency set to every ${frequency} minutes.`, fromNumber);
            } else {
                await sendMessage('Invalid frequency. Please provide a valid number.', fromNumber);
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
