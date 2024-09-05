require('dotenv').config();
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');

// ESPN API endpoints
const nflScoreboardApiUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const nflTeamApiUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams';

const accessToken = process.env.ACCESS_TOKEN; // Using environment variable for access token
const whatsappApiUrl = process.env.WHATSAPP_API_URL; 

(async () => {
    // Express setup
    const app = express();
    app.use(bodyParser.urlencoded({ extended: false }));
    app.use(bodyParser.json());
    const port = process.env.PORT || 3000;

    // In-memory storage for users who opt-in and prompts
    const optInUsers = {};

    // Function to send a message via WhatsApp API
    async function sendMessage(message, number) {
        try {
            const payload = {
                messaging_product: "whatsapp",
                to: number,
                type: "text",
                text: {
                    body: message
                }
            };
            const response = await axios.post(whatsappApiUrl, payload, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log('Message sent to', number, ':', response.data);
        } catch (error) {
            console.error(`Failed to send message to ${number}:`, error.response ? error.response.data : error.message);
            if (error.response && error.response.data.error.code === 190) {
                console.error('Access token expired. Please refresh the token.');
            }
        }
    }

    // Expanded NFL Scores Command
    async function getNflScoresDetailed() {
        try {
            const response = await axios.get(nflScoreboardApiUrl);
            const scoreboard = response.data;

            if (!scoreboard || scoreboard.events.length === 0) {
                return { message: 'No games are currently available.', data: [] };
            }

            let message = 'NFL Scores and Details:\n';
            scoreboard.events.forEach(event => {
                const homeTeam = event.competitions[0].competitors[0].team.displayName;
                const awayTeam = event.competitions[0].competitors[1].team.displayName;
                const homeScore = event.competitions[0].competitors[0].score;
                const awayScore = event.competitions[0].competitors[1].score;

                const venue = event.competitions[0].venue.fullName;
                const location = `${event.competitions[0].venue.address.city}, ${event.competitions[0].venue.address.state}`;
                const broadcasts = event.competitions[0].broadcasts.map(broadcast => broadcast.names.join(', ')).join(' | ');
                const odds = event.competitions[0].odds.map(odd => `${odd.details} (O/U: ${odd.overUnder})`).join(', ');

                message += `${homeTeam} vs ${awayTeam}: ${homeScore} - ${awayScore}\n`;
                message += `Venue: ${venue} (${location})\n`;
                message += `Broadcasts: ${broadcasts}\n`;
                message += `Odds: ${odds}\n`;
                message += `------------------------\n`;
            });

            return { message, data: scoreboard.events };
        } catch (error) {
            console.error('Error fetching NFL scores:', error);
            return { message: 'Error fetching NFL scores.', data: [] };
        }
    }

    // Expanded Team Info Command
    async function getTeamInfoDetailed(teamName) {
        try {
            const response = await axios.get(nflTeamApiUrl);
            const teams = response.data.sports[0].leagues[0].teams;
            const matchedTeam = teams.find(team => team.team.displayName.toLowerCase() === teamName.toLowerCase());

            if (matchedTeam) {
                const team = matchedTeam.team;
                const record = team.record.items.map(item => `${item.name}: ${item.summary}`).join(', ');
                const scheduleLink = team.links.find(link => link.rel.includes('schedule')).href;
                const rosterLink = team.links.find(link => link.rel.includes('roster')).href;

                let message = `${team.displayName} Info:\n`;
                message += `Location: ${team.location}\n`;
                message += `Record: ${record}\n`;
                message += `Colors: ${team.color} (Primary), ${team.alternateColor} (Alternate)\n`;
                message += `Upcoming Schedule: ${scheduleLink}\n`;
                message += `Roster: ${rosterLink}\n`;
                message += `------------------------\n`;

                return message;
            } else {
                return `Team ${teamName} not found.`;
            }
        } catch (error) {
            console.error('Error fetching team info:', error);
            return `Error fetching team info.`;
        }
    }

    // Expanded Follow Teams Command
    async function followTeamsDetailed(teamNames, frequency, optInUsers, number) {
        const teams = teamNames.split(',').map(name => name.trim());
        optInUsers[number] = { teams, frequency };
        scheduleNflUpdatesDetailed(optInUsers, number);
        return `You have opted in to receive detailed updates for teams: ${teamNames} every ${frequency} minutes.`;
    }

    function scheduleNflUpdatesDetailed(optInUsers, number) {
        const user = optInUsers[number];
        if (user.teams.length > 0) {
            const job = cron.schedule(`*/${user.frequency} * * * *`, async () => {
                const teamUpdates = await Promise.all(user.teams.map(team => getTeamInfoDetailed(team)));
                const message = teamUpdates.join('\n');
                sendMessage(message, number);
            });
            user.job = job;
        }
    }

    // Expanded Finish Updates Command
    function finishUpdates(optInUsers, number) {
        if (optInUsers[number] && optInUsers[number].job) {
            optInUsers[number].job.stop();
            delete optInUsers[number];
            return 'You have successfully opted out of updates.';
        } else {
            return 'You are not currently receiving updates.';
        }
    }

    // Expanded Welcome Message
    function sendWelcomeMessage(number) {
        const welcomeMessage = `🎉 Welcome to NFL Feed! 🏈

Here are some commands you can use:
- "nfl scores" 📊: Get the current NFL scores with detailed information including venue, broadcasts, and odds.
- "team [team name]" 🏈: Get detailed stats, records, and upcoming schedules for a specific team.
- "follow [team names] [minutes]" 🏈: Receive detailed updates for specific teams at your chosen interval.
- "finish updates" 🚫: Stop receiving updates.

Enjoy and stay tuned for NFL updates! 🏈`;

        sendMessage(welcomeMessage, number);
    }

    // Handle incoming messages and commands
    app.post('/webhook', async (req, res) => {
        try {
            const incomingMsg = req.body.entry[0].changes[0].value.messages[0].text.body.trim().toLowerCase();
            const fromNumber = req.body.entry[0].changes[0].value.messages[0].from;

            if (incomingMsg === 'nfl scores') {
                const scoresData = await getNflScoresDetailed();
                sendMessage(scoresData.message, fromNumber);
            } else if (incomingMsg.startsWith('team ')) {
                const teamName = incomingMsg.slice(5).trim();
                const teamInfoMessage = await getTeamInfoDetailed(teamName);
                sendMessage(teamInfoMessage, fromNumber);
            } else if (incomingMsg.startsWith('follow ')) {
                const parts = incomingMsg.split(' ');
                const teamNames = parts.slice(1, parts.length - 1).join(' ');
                const frequency = parseInt(parts[parts.length - 1], 10);
                const followMessage = await followTeamsDetailed(teamNames, frequency, optInUsers, fromNumber);
                sendMessage(followMessage, fromNumber);
            } else if (incomingMsg === 'finish updates') {
                const finishMessage = finishUpdates(optInUsers, fromNumber);
                sendMessage(finishMessage, fromNumber);
            } else {
                sendWelcomeMessage(fromNumber);
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
