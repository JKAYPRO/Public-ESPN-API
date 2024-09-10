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

// Fetch NFL scoreboard data
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
        return teams.find(team => team.team.displayName.toLowerCase() === teamName.toLowerCase()) || null;
    } catch (error) {
        console.error('Error fetching team info:', error.message || error);
        return null;
    }
}

// Sample player data function (this is mock data, adapt it according to your real data)
function fetchPlayerStats(playerName) {
    const playerData = {
        'patrick mahomes': {
            name: 'Patrick Mahomes',
            position: 'Quarterback (QB)',
            team: 'Kansas City Chiefs',
            passingYards: 4740,
            touchdowns: 38,
            interceptions: 7,
            completionPercentage: '66.3%',
            qbRating: '108.2',
            lastGame: {
                date: 'September 8, 2024',
                opponent: 'Baltimore Ravens',
                passingYards: 385,
                touchdowns: 3,
                interceptions: 1,
            }
        }
        // Add more players as needed
    };

    return playerData[playerName.toLowerCase()] || null;
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

// Handle incoming messages
async function handleIncomingMessage(message, number) {
    const incomingMsg = message.trim().toLowerCase();

    if (incomingMsg === 'start' || incomingMsg === 'help') {
        await sendHelpMessage(number);
    } else if (incomingMsg === 'scores') {
        const scoreboard = await fetchNflScores();
        const responseMessage = scoreboard.length > 0 
            ? scoreboard.map(game => formatGameSummary(game)).join('\n')
            : 'No current NFL games available.';
        await sendMessage(responseMessage, number);
    } else if (incomingMsg.startsWith('player ')) {
        const playerName = incomingMsg.slice(7).trim();
        const playerStats = fetchPlayerStats(playerName);
        const responseMessage = playerStats 
            ? `Player: ${playerStats.name}\nPosition: ${playerStats.position}\nTeam: ${playerStats.team}\nSeason Stats:\n- Passing Yards: ${playerStats.passingYards}\n- Touchdowns: ${playerStats.touchdowns}\n- Interceptions: ${playerStats.interceptions}\n- Completion Percentage: ${playerStats.completionPercentage}\n- QB Rating: ${playerStats.qbRating}\n\nLatest Game:\n- Date: ${playerStats.lastGame.date}\n- Opponent: ${playerStats.lastGame.opponent}\n- Passing Yards: ${playerStats.lastGame.passingYards}\n- Touchdowns: ${playerStats.lastGame.touchdowns}\n- Interceptions: ${playerStats.lastGame.interceptions}`
            : `Player ${playerName} not found.`;
        await sendMessage(responseMessage, number);
    } else if (incomingMsg.startsWith('recap ')) {
        const teamName = incomingMsg.slice(6).trim();
        const scoreboard = await fetchNflScores();
        const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase() === teamName.toLowerCase()));
        const responseMessage = game ? formatGameSummary(game) : `No recent game found for ${teamName}.`;
        await sendMessage(responseMessage, number);
    } else if (incomingMsg.startsWith('schedule ')) {
        const teamName = incomingMsg.slice(9).trim();
        const teamInfo = await fetchTeamInfo(teamName);
        const responseMessage = teamInfo 
            ? `Upcoming Games for ${teamInfo.team.displayName}:\n1. Date: September 15, 2024\n   Opponent: Los Angeles Chargers\n   Time: 4:25 PM EDT\n   Venue: SoFi Stadium\n\n2. Date: September 22, 2024\n   Opponent: Green Bay Packers\n   Time: 8:20 PM EDT\n   Venue: Lambeau Field\n\n3. Date: September 29, 2024\n   Opponent: Denver Broncos\n   Time: 1:00 PM EDT\n   Venue: Arrowhead Stadium`
            : `No upcoming games found for ${teamName}.`;
        await sendMessage(responseMessage, number);
    } else if (incomingMsg.startsWith('top ')) {
        const statType = incomingMsg.slice(4).trim();
        let responseMessage = '';
        if (statType === 'passing') {
            responseMessage = `Top 5 Quarterbacks - Passing Yards:\n1. Patrick Mahomes (Kansas City Chiefs): 4,740 yards\n2. Josh Allen (Buffalo Bills): 4,630 yards\n3. Justin Herbert (Los Angeles Chargers): 4,520 yards\n4. Joe Burrow (Cincinnati Bengals): 4,490 yards\n5. Lamar Jackson (Baltimore Ravens): 4,350 yards`;
        } else {
            responseMessage = `Top ${statType} stats not available.`;
        }
        await sendMessage(responseMessage, number);
    } else if (incomingMsg.startsWith('game leader ')) {
        const teamName = incomingMsg.slice(12).trim();
        const scoreboard = await fetchNflScores();
        const game = scoreboard.find(g => g.competitions[0].competitors.some(c => c.team.displayName.toLowerCase() === teamName.toLowerCase()));
        const responseMessage = game 
            ? `Game Leaders for ${game.competitions[0].competitors[0].team.displayName} vs. ${game.competitions[0].competitors[1].team.displayName}:\nDate: ${game.competitions[0].date}\nFinal Score: ${game.competitions[0].competitors[0].team.displayName} ${game.competitions[0].competitors[0].score}, ${game.competitions[0].competitors[1].team.displayName} ${game.competitions[0].competitors[1].score}\nTop Performers:\n- Passing: ${game.competitions[0].competitors[0].team.abbreviation} - ${game.competitions[0].competitors[0].team.displayName} ${game.competitions[0].competitors[0].team.displayName} - 320 yards, 2 touchdowns\n- Rushing: ${game.competitions[0].competitors[0].team.abbreviation} - ${game.competitions[0].competitors[0].team.displayName} ${game.competitions[0].competitors[0].team.displayName} - 110 yards, 1 touchdown\n- Receiving: ${game.competitions[0].competitors[0].team.abbreviation} - ${game.competitions[0].competitors[0].team.displayName} ${game.competitions[0].competitors[0].team.displayName} - 8 receptions, 135 yards, 1 touchdown`
            : `No game leaders found for ${teamName}.`;
        await sendMessage(responseMessage, number);
    } else {
        await sendMessage(`Unknown command. Type "help" to see available commands.`, number);
    }
}

// Cron job scheduling for user-specific updates
function scheduleUpdates(number, frequency) {
    const task = cron.schedule(`*/${frequency} * * * *`, async () => {
        const scoreboard = await fetchNflScores();
        const responseMessage = scoreboard.length > 0 
            ? scoreboard.map(game => formatGameSummary(game)).join('\n')
            : 'No current NFL games available.';
        await sendMessage(responseMessage, number);
    });

    return task;
}

// Send a combined help/start message
async function sendHelpMessage(number) {
    const message = `🎉 Welcome to Football Feed! 🏈

Here are some commands you can use:
- "scores" 📊: Get the current NFL scores.
- "player [player name]" 🏈: Get the stats for a specific player.
- "recap [team]" 📝: Get a recap of the latest game for a specific team.
- "schedule [team]" 📅: Get the upcoming schedule for a specific team.
- "top [stat type]" 🏆: Get the top performers in a specific stat category (e.g., passing).
- "game leader [team]" 🏅: Get the game leaders for a specific team.
- "frequency [minutes]" ⏰: Set how often you want to receive updates.
- "help" 📖: Display this help message.

Enjoy and stay tuned for Football updates! 🏈`;

    await sendMessage(message, number);
}

app.post('/webhook', async (req, res) => {
    try {
        const incomingMsg = req.body.entry[0].changes[0].value.messages[0].text.body.trim().toLowerCase();
        const fromNumber = req.body.entry[0].changes[0].value.messages[0].from;

        await handleIncomingMessage(incomingMsg, fromNumber);

        res.sendStatus(200);
    } catch (error) {
        console.error('Error handling webhook:', error.message || error);
        res.status(500).send('Internal server error');
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
