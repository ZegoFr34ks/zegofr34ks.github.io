const Discord = require('discord.js');
const client = new Discord.Client();
const dotenv = require('dotenv');
dotenv.config();
client.login(process.env.DISCORD_BOT_TOKEN);

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

function updateProfilePicture() {
    client.users.fetch('459015764436058112')
        .then(user => {
            const pictureUrl = user.displayAvatarURL({ format: "png", size: 256 });
            document.getElementById('my_discord').src = pictureUrl;
        })
        .catch(console.error);
}

setInterval(updateProfilePicture, 1000); // Run every 1 seconds
