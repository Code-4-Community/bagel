const { App, AwsLambdaReceiver } = require('@slack/bolt');
const dotenv = require('dotenv');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb')

dotenv.config();

/**
 * Divides command text into a list of arguments.
 * Arguments consisting of multiple words are enclosed by double brackets.
 * For example, the following command text:
 *  "arg one" arg2 arg3 "arg 4"
 * gets parsed into:
 *  ["arg one", "arg2", "arg3", "arg 4"]
 * 
 * Note: right now, this isn't mandatory to do, but I'm doing this to keep the command syntax consistent
 * in case we want to add commands that take multiple args that can each be multiple words
 * 
 * @param {*} rawArgs 
 * @returns
 */
function parseCommandArgs(rawArgs) {
  const regex = /["“”]([^"“”]+)["“”]|\S+/g;

  const matches = [...rawArgs.matchAll(regex)].map(match => {
    return match[1] || match[0];
  })

  return matches;
}

/**
 * Adds a fact to a user's bio by appending the fact to the list field `facts` in the `BagelUsers` table.
 * 
 * @param {*} userId the user ID calling (and who to add the fact to)
 * @param {*} fact the fact to add
 * @returns a promise for the DynamoDB add operation
 */
function addUserFact(userId, fact) {
  const command = new UpdateCommand({
    TableName: BAGEL_USERS_TABLE,
    Key: {
      user_id: userId,
    },
    UpdateExpression: "set #facts = list_append(if_not_exists(#facts, :empty_list), :f)",
    ExpressionAttributeNames: {
      "#facts": USER_FACT_COLUMN,
    },
    ExpressionAttributeValues: {
      ":empty_list": [],
      ":f": [fact],
    },
  });

  return docClient.send(command);
}

/**
 * Removes the fact from a user's bio at the given index
 * @param {*} userId the user ID calling (and from who to remove the fact from)
 * @param {*} index which fact should be removed
 * @returns a promise for the DynamoDB remove operation
 */
function removeUserFact(userId, index) {
  const command = new UpdateCommand({
    TableName: BAGEL_USERS_TABLE,
    Key: {
      user_id: userId,
    },
    UpdateExpression: `REMOVE #facts[${index}]`,
    ExpressionAttributeNames: {
      "#facts": USER_FACT_COLUMN,
    },
    ReturnValues: 'ALL_OLD', // return previous state so we can get the fact we removed
  });

  return docClient.send(command);
}

/**
 * Gets all current facts stored for a user
 * @param {*} userId the user whose facts to retrieve
 * @returns a promise for the DynamoDB get operation (which resolves to an object w/ the user's facts)
 */
function getUserFacts(userId) {
  const command = new GetCommand({
    TableName: BAGEL_USERS_TABLE,
    Key: {
      user_id: userId,
    },
    ProjectionExpression: USER_FACT_COLUMN
  });

  return docClient.send(command);
}

function extractBlockText(blocks) {
  const blockText = [];
  for (let block of blocks) {
    if (block.type === 'section') {
      blockText.push(block.text.text);
    }
  }

  return blockText.join(' ');
}

const awsReceiver = new AwsLambdaReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  // signingSecret: process.env.SLACK_SIGNING_SECRET
  receiver: awsReceiver,
});

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

// App constants
const MAX_DISPLAYED_BIO_FIELDS = 3;
const BAGEL_USERS_TABLE = "BagelUsers";
const USER_FACT_COLUMN = "facts";

app.command('/test', async ({ command, ack, respond }) => {
  await ack();

  await respond('working as intended :)');
});

// TODO: refactor this mess please
app.command('/bio', async ({ command, ack, respond, say }) => {
  await ack();

  const args = parseCommandArgs(command.text);
  const operation = args[0];
  
  let errorMessage = null;
  let successMessage = null;

  switch (operation) {
    case "add":
      const fact = args[1];
      
      if (fact === undefined) {
        errorMessage = "You need to specify a fact about yourself to add!";
        break;
      }

      await addUserFact(command.user_id, fact);
      successMessage = `Successfully added to your bio: ${fact}`;
      
      break;
    case "remove":
      const indexToRemove = parseInt(args[1]);

      if (indexToRemove === NaN) {
        errorMessage = "You need to specify which number fact to remove!";
        break;
      }

      const response = await removeUserFact(command.user_id, indexToRemove);
      if (response.Attributes === undefined) {
        errorMessage = `You don't currently have a profile stored! Try /bio add to add some facts about yourself.`;
        break;
      }

      const removedFact = response.Attributes[USER_FACT_COLUMN][indexToRemove];

      if (removedFact !== undefined) {
        successMessage = `Succesfully removed from bio: ${removedFact}`;
      } else {
        errorMessage = `Unable to delete fact ${indexToRemove} - are you sure it exists? (try /bio show to view your current facts)`;
      }
      
      break;
    case "show":
      const userFacts = await getUserFacts(command.user_id);
      
      if (userFacts.Item === undefined || userFacts.Item[USER_FACT_COLUMN].length === 0) {
        errorMessage = `You don't currently have a profile stored! Try /bio add to add some facts about yourself.`;
        break;
      }

      const responseBlocks = [
        {
          type: "section",
          text: {
            type: "plain_text",
            text: "Here are the current facts on your bio:"
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: userFacts.Item[USER_FACT_COLUMN].map((fact, index) => `${index}: ${fact}`).join('\n'),
          }
        }
      ];

      if (userFacts.Item[USER_FACT_COLUMN].length > MAX_DISPLAYED_BIO_FIELDS) {
        responseBlocks.push({
          type: "section",
          text: {
            type: "plain_text",
            text: `Note: only ${MAX_DISPLAYED_BIO_FIELDS} facts, chosen at random, will be displayed to your chat partner.`
          }
        })
      }

      await say({
        text: extractBlockText(responseBlocks), // TODO: figure out a better way of putting message text here
        blocks: responseBlocks
      });

      break;
    default:
      errorMessage = "Unknown command! Try /help to see what you can do.";
      break;
  }

  if (errorMessage !== null) {
    await respond(errorMessage);
  } else if (successMessage !== null) {
    await respond(successMessage);
  }
});

const commandInfo = {
  bio: {
    description: "update your bio for \#c4conversation random matches",
    usage: `> - bio show: shows all facts listed on your profile\n> - bio add ["fact"]: adds the fact to your profile. Must be enclosed in double quotes ("")\n> - bio remove [index]: removes the fact at the given index from your profile`
  },
  help: {
    description: "learn how to use Bagel commands",
    usage: "> help [command]: get help on how to use the specified command"
  },
  test: {
    description: "test that the bot is up and running",
    usage: "> Sends a dummy message back as confirmation that the bot is active"
  },
}

app.command('/help', async ({ command, ack, respond, say }) => {
  await ack();

  const args = parseCommandArgs(command.text);
  const requestedCommand = args[0];

  let blocks;
  switch (requestedCommand) {
    case "bio":
    case "help":
    case "test":
      blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${requestedCommand}: ${commandInfo[requestedCommand].description}`
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Usage:\n${commandInfo[requestedCommand].usage}`
          }
        }
      ]
      break;

    default: 
      const helpText = Object.entries(commandInfo).map(([ c, info ]) => `- ${c}: ${info.description}`).join('\n');
      blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `help [command]: get help on how to use the specified command\n\nAvailable commands:\n${helpText}`
          }
        },
      ]

      if (requestedCommand !== undefined) {
        // command was specified but unrecognized: let the user know with an error message in front of command info
        blocks.splice(0, 0, {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Command "${requestedCommand}" is not recognized!`
          }
        })
      }
      break;
  }

  blocks.push({
    type: "divider"
  })

  await say({
    text: extractBlockText(blocks), // TODO: figure out a better way of putting message text here
    blocks
  });
});


// (async () => {
//   await app.start(process.env.PORT || 3000);

//   app.logger.info('⚡️ Bolt app is running!');
// })();

module.exports.handler = async (event, context, callback) => {
  const handler = await awsReceiver.start();
  return handler(event, context, callback);
}
