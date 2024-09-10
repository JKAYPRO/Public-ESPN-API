require('dotenv').config();
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { Storage } = require('@google-cloud/storage');
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

let teamMap = {
    giants: "new york giants",
    jets: "new york jets",
    falcons: "atlanta falcons",
    // Add more shorthand to full name mappings as needed
};

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

// Format team recap information
async function formatTeamRecap(teamInfo) {
    const statsUrl = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamInfo.team.id}/stats?season=2024`;
    const statsResponse = await axios.get(statsUrl);
    const stats = statsResponse.data || {};

    return `Team Recap for ${teamInfo.team.displayName}:\nWins: ${stats.wins}, Losses: ${stats.losses}\nTotal Yards: ${stats.totalYards}, Points Scored: ${stats.pointsScored}`;
}

// Format game leader information
function formatGameLeaderInfo(game) {
    const leaders = game.competitions[0].leaders || [];
    return leaders.length > 0
        ? leaders.map(leader => `${leader.displayName}: ${leader.athlete.displayName} (${leader.value})`).join('\n')
        : 'Game leader information not available.';
}

// Send a combined help/start message
async function sendHelpMessage(number) {
    const message = `🎉 Welcome to NFL Feed! 🏈

Here are some commands you can use:
- "scores" 📊: Get the current NFL scores.
- "team [team name]" 🏈: Get the stats for a specific team.
- "recap [team name]" 🏈: Get a recap for a specific team.
- "leaders [team name]" 🏆: Get the game leaders for a specific team.
- "game score [team]" 🏟️: Get the score of a game involving a specific team.
- "venue [team]" 🏟️: Get the venue information of a game involving a specific team.
- "TV [team]" 📺: Get the broadcast information of a game involving a specific team.
- "odds [team]" 🎲: Get the odds information of a game involving a specific team.
- "set frequency [minutes]" ⏰: Set how often you want to receive updates.
- "stop updates" 🚫: Stop receiving updates.
- "help" 📖: Display this help message.

Enjoy and stay tuned for NFL updates! 🏈`;

    await sendMessage(message, number);
}

app.post('/webhook', async (req, res) => {
    try {
        const incomingMsg = req.body.entry[0].changes[0].value.messages[0].text.body.trim().toLowerCase();
        const fromNumber = req.body.entry[0].changes[0].value.messages[0].from;

        // Handle shorthand team names
        const incomingTeamName = incomingMsg.split(' ').slice(-1)[0];
        const fullTeamName = teamMap[incomingTeamName] || incomingTeamName;

        // Command patterns with team name extraction
        const commands = {
            scores: /^scores$/,
            team: new RegExp(`^team\\s${fullTeamName}$`),
            gameScore: new RegExp(`^game score\\s${fullTeamName}$`),
            venue: new RegExp(`^venue\\s${fullTeamName}$`),
            tv: new RegExp(`^tv\\s${fullTeamName}$`),
            odds: new RegExp(`^odds\\s${fullTeamName}$`),
            recap: new RegExp(`^recap\\s${fullTeamName}$`),
            leaders: new RegExp(`^leaders\\s${fullTeamName}$`),
            setFrequency: /^set frequency\s(\d+)$/
        };

        let match;
        if (incomingMsg === 'start' || incomingMsg === 'help') {
            await sendHelpMessage(fromNumber);
        } else if (match = incomingMsg.match(commands.scores)) {
            const scoreboard = await fetchNflScores();
            const message = scoreboard.length > 0 
                ? scoreboard.map(game => formatGameSummary(game)).join('\n')
                : 'No current NFL games available.';
            await sendMessage(message, fromNumber);
        } else if (match = incomingMsg.match(commands.team)) {
            const teamInfo = await fetchTeamInfo(fullTeamName);
            const message = teamInfo 
                ? await formatTeamRecap(teamInfo) 
                : `Team ${fullTeamName} not found.`;
            await sendMessage(message, fromNumber);
        } else if (match = incomingMsg.match(commands.gameScore)) {
            const scoreboard = await fetchNflScores();
            const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase() === fullTeamName.toLowerCase()));
            const message = game ? formatGameSummary(game) : `No game found for ${fullTeamName}.`;
            await sendMessage(message, fromNumber);
        } else if (match = incomingMsg.match(commands.venue)) {
            const scoreboard = await fetchNflScores();
            const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase() === fullTeamName.toLowerCase()));
            const message = game ? formatVenueInfo(game) : `No game found for ${fullTeamName}.`;
            await sendMessage(message, fromNumber);
        } else if (match = incomingMsg.match(commands.tv)) {
            const scoreboard = await fetchNflScores();
            const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase() === fullTeamName.toLowerCase()));
            const message = game ? formatBroadcastInfo(game) : `No game found for ${fullTeamName}.`;
            await sendMessage(message, fromNumber);
        } else if (match = incomingMsg.match(commands.odds)) {
            const scoreboard = await fetchNflScores();
            const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase() === fullTeamName.toLowerCase()));
            const message = game ? formatOddsInfo(game) : `No game found for ${fullTeamName}.`;
            await sendMessage(message, fromNumber);
        } else if (match = incomingMsg.match(commands.recap)) {
            const teamInfo = await fetchTeamInfo(fullTeamName);
            const message = teamInfo 
                ? await formatTeamRecap(teamInfo) 
                : `Team ${fullTeamName} not found.`;
            await sendMessage(message, fromNumber);
        } else if (match = incomingMsg.match(commands.leaders)) {
            const scoreboard = await fetchNflScores();
            const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase() === fullTeamName.toLowerCase()));
            const message = game ? formatGameLeaderInfo(game) : `No game found for ${fullTeamName}.`;
            await sendMessage(message, fromNumber);
        } else if (match = incomingMsg.match(commands.setFrequency)) {
            const minutes = parseInt(match[1], 10);
            // Logic to set up a cron job for sending updates every X minutes
            const cronExpression = `*/${minutes} * * * *`;
            cron.schedule(cronExpression, async () => {
                const scoreboard = await fetchNflScores();
                const message = scoreboard.length > 0 
                    ? scoreboard.map(game => formatGameSummary(game)).join('\n')
                    : 'No current NFL games available.';
                await sendMessage(message, fromNumber);
            });
            await sendMessage(`You will receive updates every ${minutes} minutes.`, fromNumber);
        } else if (incomingMsg === 'stop updates') {
            // Logic to stop all cron jobs or notifications for this user
            cron.getTasks().forEach(task => task.stop());
            await sendMessage('Updates have been stopped.', fromNumber);
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
