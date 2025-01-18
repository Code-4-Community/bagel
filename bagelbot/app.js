const { App } = require('@slack/bolt');
const dotenv = require('dotenv');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');

dotenv.config();

/**
 * Divides command text into a list of arguments.
 * Arguments consisting of multiple words are enclosed by double brackets.
 * For example, the following command text:
 *  "arg one" arg2 arg3 "arg 4"
 * gets parsed into:
 *  ["arg one", "arg2", "arg3", "arg 4"]
 * 
 * @param {*} rawArgs 
 * @returns
 */
function parseCommandArgs(rawArgs) {
  const regex = /"([^"]+)"|\S+/g;

  const matches = [...rawArgs.matchAll(regex)].map(match => {
    console.info(match);
    return match[1] || match[0];
  })

  return matches;
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

app.command('/test', async ({ command, ack, respond }) => {
  await ack();

  console.log(command)
  console.log(parseCommandArgs(command.text))

  await respond('working as intended :)');
});

app.command('/help', async ({ command, ack, respond }) => {

});

app.command('/bio', async ({ command, ack, respond }) => {

});



(async () => {
  // Start your app
  await app.start(process.env.PORT || 3000);

  app.logger.info('⚡️ Bolt app is running!');
})();