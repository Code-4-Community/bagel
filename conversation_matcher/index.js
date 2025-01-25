const { WebClient } = require('@slack/web-api');
const assert = require('assert');
const AWS = require('aws-sdk');
const dotenv = require('dotenv')

dotenv.config()
// Need to manually configure the region: https://stackoverflow.com/questions/31039948/configuring-region-in-node-js-aws-sdk
AWS.config.update({region: process.env.AWS_REGION});

/*
Lambda scheduled to run every week:
1. Get all members of #c4conversation 
2. Group them into pairs (with a triplet if odd)
3. For each group, start a DM with an intro message
  3a. Intro message contains some facts added by the user, if present
4. Ping #c4conversation
*/

///// CONSTANTS /////
const C4C_SLACK_TOKEN = process.env.C4C_SLACK_TOKEN;

const C4CONVERSATION_ID = process.env.C4CONVERSATION; // #c4conversation
// const C4CONVERSATION_ID = process.env.TEST_BAGEL; // #test-bagel
const BOT_USER_ID = 'U089723F15G';

const LOCATION_PREF = {
  IN_PERSON: 'IN_PERSON',
  VIRTUAL: 'VIRTUAL',
  NO_PREF: 'NO_PREF',
};

const LOCATION_PREF_MAP = {
  in_person: LOCATION_PREF.IN_PERSON,
  virtual: LOCATION_PREF.VIRTUAL,
  no_pref: LOCATION_PREF.NO_PREF,
};

///// CODE /////

// Initialize Slack client
const client = new WebClient(C4C_SLACK_TOKEN);

// Initialize Dynamo client
const dynamo = new AWS.DynamoDB.DocumentClient();

exports.handler = async (event) => {
  await startConversations();

  const response = {
    statusCode: 200,
    body: JSON.stringify('Done!'),
  };
  return response;
};

async function startConversations() {
  const response = await client.conversations.members({
    channel: C4CONVERSATION_ID,
  });

  let members = response.members;
  console.log(`Initial members: ${members}`);

  if (members == null) {
    throw new Error('Response from conversations.members was null');
  }
  members = members.filter((member) => member != BOT_USER_ID);
  shuffleArray(members);
  console.log(`Shuffled members: ${members}`);

  // members = [1, 3, 2];
  members = await getUsersInfo(members);
  const memberMap = members.reduce((currentMap, memberInfo) => ({ ...currentMap, [memberInfo.id]: memberInfo }), {});
  // members = [
  //   { id: 1, location_pref: LOCATION_PREF.IN_PERSON, lastThreeMatched: [], facts: ['i enjoy exploring boston'] },
  //   { id: 3, location_pref: LOCATION_PREF.VIRTUAL, lastThreeMatched: [], facts: [] },
  //   { id: 2, location_pref: LOCATION_PREF.IN_PERSON, lastThreeMatched: [], facts: [] },
  // ];
  console.log('Members user info');
  console.log(members);  

  const groups = matchEveryone(members);
  for (const group of groups) {
    console.log(`Group: ${group}`);
    const response = await client.conversations.open({
      users: group.join(','),
    });
    const channelId = response.channel.id;

    // TODO uncomment at the end!!
    // await client.chat.postMessage({
    //   channel: channelId,
    //   text: `Hi ${group
    //     .map((userId) => `<@${userId}>`)
    //     .join(
    //       ' and '
    //     )}, you've been matched for a random sync. Introduce yourself and ask to get coffee sometime!`,
    // });

    let messageParts = [`Hi ${group
        .map((userId) => `<@${userId}>`)
        .join(
          ' and '
        )}, you've been matched for a random sync. Introduce yourself and ask to get coffee sometime!`
      ];
    
    for (let member of group) {
      if (memberMap[member].facts.length > 0) {
        const memberFacts = memberMap[member].facts.map(fact => `- ${fact}`).join('\n');
        messageParts.push(`<@${member}> has some interesting facts about themselves to share:\n${memberFacts}`);
      }
    }

    // TODO uncomment at the end!!
    await client.chat.postMessage({
      channel: channelId,
      text: messageParts.join('\n-------\n'),
    });
  }

  // TODO uncomment at end!!
  await client.chat.postMessage({
    channel: C4CONVERSATION_ID,
    text: "Another round of random syncs have been initiated. React with a 👍 if you've met your partner",
  });

  // update last matched users in Dynamo table
  for (const group of groups) {
    for (const memberId of group) {
      const otherMembers = group.filter((id) => id !== memberId);
      await updateLastThreeMatched(memberId, otherMembers);
    }
  }

  console.log('Done!');
}

// https://stackoverflow.com/questions/2450954/how-to-randomize-shuffle-a-javascript-array
// Shuffle array in-place
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }

  return array;
}

const matchEveryone = (people) => {
  if (people.length <= 1) {
    throw new Error(`Can't group ${people.length} people!`);
  } else if (people.length <= 3) {
    return [people.map((person) => person.id)];
  } else {
    const [matchedPeople, remainingPeople] = matchFirstPerson(people);
    return [matchedPeople, ...matchEveryone(remainingPeople)];
  }
};

const matchFirstPerson = (people) => {
  if (people.length < 2) {
    throw Error(
      `Can't match if there are only ${people.length} people in the list`
    );
  }

  const personToMatch = people[0];
  let matchedPerson = people
    .slice(1)
    .find((person) => canBeMatched(personToMatch, person));

  if (!matchedPerson) {
    // can't match personToMatch with anyone in the list of people. Just match them with the second person
    matchedPerson = people[1];
  }

  const remainingPeople = people.filter(
    (person) => person.id !== personToMatch.id && person.id !== matchedPerson.id
  );

  return [[personToMatch.id, matchedPerson.id], remainingPeople];
};

const canBeMatched = (personOne, personTwo) => {
  if (
    personOne.lastThreeMatched.includes(personTwo.id) ||
    personTwo.lastThreeMatched.includes(personOne.id)
  ) {
    return false;
  }

  if (
    personOne.location_pref === LOCATION_PREF.NO_PREF ||
    personTwo.location_pref === LOCATION_PREF.NO_PREF
  ) {
    return true;
  }

  if (personOne.location_pref !== personTwo.location_pref) {
    return false;
  }

  return true;
};

///// DYNAMO /////
// const getUserInfo = async (userId) => {
//   let userInfo = await dynamo
//     .get({
//       TableName: 'BagelUsers',
//       Key: {
//         user_id: userId,
//       },
//     })
//     .promise();

//   if (!userInfo || !userInfo['Item']) {
//     return {
//       id: userId,
//       location_pref: LOCATION_PREF.NO_PREF,
//       lastThreeMatched: [],
//     };
//   }

//   userInfo = userInfo['Item'];
//   console.log(userInfo);

//   return {
//     id: userId,
//     location_pref: LOCATION_PREF_MAP[userInfo['location_pref'] || 'no_pref'],
//     lastThreeMatched: (userInfo['last_three_matched'] || []).slice(-3),
//   };
// };

const getUsersInfo = async (userIds) => {
  const userKeys = userIds.map(userId => {
    return { user_id: userId }
  })

  const result = await dynamo.batchGet({
    RequestItems: {
      BagelUsers: {
        Keys: userKeys,
        AttributesToGet: [
          'location_pref',
          'last_three_matched',
          'facts',
          'user_id'
        ]
      }
    }
  }).promise();

  const memberMap = result.Responses.BagelUsers.reduce((currentMap, userRow) => {
    return {...currentMap, [userRow.user_id]: userRow}
  }, {});

  const processedMembers = userIds.map(userId => {
    const userInfo = memberMap[userId];
    if (userInfo !== undefined) {
      return {
        id: userId,
        location_pref: LOCATION_PREF_MAP[userInfo['location_pref'] || 'no_pref'],
        lastThreeMatched: (userInfo['last_three_matched'] || []).slice(-3),
        facts: shuffleArray(userInfo['facts'] || []).slice(-3),
      }
    } else {
      return {
        id: userId,
        location_pref: LOCATION_PREF.NO_PREF,
        lastThreeMatched: [],
        facts: []
      }
    }
  })

  return processedMembers;
}

const updateLastThreeMatched = async (userId, otherUserIds) => {
  console.log('updateLastThreeMatched', userId, otherUserIds);

  const params = {
    TableName: 'BagelUsers',
    Key: {
      user_id: userId,
    },
    UpdateExpression:
      'set #ltm = list_append(if_not_exists(#ltm, :empty_list), :p)',
    ExpressionAttributeNames: {
      '#ltm': 'last_three_matched',
    },
    ExpressionAttributeValues: {
      ':p': otherUserIds,
      ':empty_list': [],
    },
  };

  await dynamo.update(params).promise();
};

///// TESTS /////
const testGroupIntoPairs = () => {
  assert.throws(() => groupIntoPairs([]));
  assert.throws(() => groupIntoPairs([1]));

  let actual = groupIntoPairs(['a', 'b']);
  let expected = [['a', 'b']];
  assert.deepEqual(actual, expected);

  actual = groupIntoPairs([1.1, 2.2, 3.3, 4]);
  expected = [
    [1.1, 2.2],
    [3.3, 4],
  ];
  assert.deepEqual(actual, expected);

  actual = groupIntoPairs([1, 2, 3, 4, 5]);
  expected = [
    [1, 2],
    [3, 4, 5],
  ];
  assert.deepEqual(actual, expected);
};

const testMatchFirstPerson = () => {
  assert.throws(() => matchFirstPerson([]));
  assert.throws(() =>
    matchFirstPerson([
      { id: 1, location_pref: LOCATION_PREF.VIRTUAL, lastThreeMatched: [] },
    ])
  );

  let people = [
    { id: 1, location_pref: LOCATION_PREF.IN_PERSON, lastThreeMatched: [] },
    { id: 3, location_pref: LOCATION_PREF.VIRTUAL, lastThreeMatched: [] },
    { id: 2, location_pref: LOCATION_PREF.IN_PERSON, lastThreeMatched: [] },
  ];
  let actual = matchFirstPerson(people);
  let expected = [
    [1, 2],
    [{ id: 3, location_pref: LOCATION_PREF.VIRTUAL, lastThreeMatched: [] }],
  ];
  assert.deepEqual(actual, expected);

  people = [
    { id: 4, location_pref: LOCATION_PREF.VIRTUAL, lastThreeMatched: [] },
    { id: 2, location_pref: LOCATION_PREF.NO_PREF, lastThreeMatched: [4] },
    { id: 6, location_pref: LOCATION_PREF.IN_PERSON, lastThreeMatched: [] },
    { id: 5, location_pref: LOCATION_PREF.VIRTUAL, lastThreeMatched: [] },
  ];
  actual = matchFirstPerson(people);
  expected = [
    [4, 5],
    [
      { id: 2, location_pref: LOCATION_PREF.NO_PREF, lastThreeMatched: [4] },
      { id: 6, location_pref: LOCATION_PREF.IN_PERSON, lastThreeMatched: [] },
    ],
  ];
  assert.deepEqual(actual, expected);

  // first person can't be matched with anyone
  people = [
    {
      id: 14,
      location_pref: LOCATION_PREF.VIRTUAL,
      lastThreeMatched: [4],
    },
    {
      id: 3,
      location_pref: LOCATION_PREF.IN_PERSON,
      lastThreeMatched: [],
    },
    {
      id: 8,
      location_pref: LOCATION_PREF.NO_PREF,
      lastThreeMatched: [14],
    },
    {
      id: 6,
      location_pref: LOCATION_PREF.VIRTUAL,
      lastThreeMatched: [14],
    },
  ];
  actual = matchFirstPerson(people);
  expected = [
    [14, 3],
    [
      {
        id: 8,
        location_pref: LOCATION_PREF.NO_PREF,
        lastThreeMatched: [14],
      },
      {
        id: 6,
        location_pref: LOCATION_PREF.VIRTUAL,
        lastThreeMatched: [14],
      },
    ],
  ];
  assert.deepEqual(actual, expected);
};

const testCanBeMatched = () => {
  // match two people with the same location_pref preference
  let personOne = {
    id: 1,
    location_pref: LOCATION_PREF.IN_PERSON,
    lastThreeMatched: [],
  };
  let personTwo = {
    id: 2,
    location_pref: LOCATION_PREF.IN_PERSON,
    lastThreeMatched: [],
  };
  let actual = canBeMatched(personOne, personTwo);
  assert(actual === true);

  // don't match people with different location_pref preferences
  personOne = {
    id: 4,
    location_pref: LOCATION_PREF.VIRTUAL,
    lastThreeMatched: [],
  };
  personTwo = {
    id: 3,
    location_pref: LOCATION_PREF.IN_PERSON,
    lastThreeMatched: [],
  };
  actual = canBeMatched(personOne, personTwo);
  assert(actual === false);

  // don't match people if either has been matched with the other in their last two matches
  personOne = {
    id: 8,
    location_pref: LOCATION_PREF.IN_PERSON,
    lastThreeMatched: [3],
  };
  personTwo = {
    id: 3,
    location_pref: LOCATION_PREF.IN_PERSON,
    lastThreeMatched: [],
  };
  actual = canBeMatched(personOne, personTwo);
  assert(actual === false);
  personOne = {
    id: 12,
    location_pref: LOCATION_PREF.IN_PERSON,
    lastThreeMatched: [],
  };
  personTwo = {
    id: 32,
    location_pref: LOCATION_PREF.IN_PERSON,
    lastThreeMatched: [12],
  };
  actual = canBeMatched(personOne, personTwo);
  assert(actual === false);

  // match two people if one person's location_pref preference is NO_PREF
  personOne = {
    id: 9,
    location_pref: LOCATION_PREF.VIRTUAL,
    lastThreeMatched: [],
  };
  personTwo = {
    id: 10,
    location_pref: LOCATION_PREF.NO_PREF,
    lastThreeMatched: [],
  };
  actual = canBeMatched(personOne, personTwo);
  assert(actual === true);
  // ... but not if one of them has been matched with the other in their last two matches
  personOne = {
    id: 12,
    location_pref: LOCATION_PREF.VIRTUAL,
    lastThreeMatched: [],
  };
  personTwo = {
    id: 1,
    location_pref: LOCATION_PREF.NO_PREF,
    lastThreeMatched: [2, 12],
  };
  actual = canBeMatched(personOne, personTwo);
  assert(actual === false);

  // match two people if both people's location_pref preference is NO_PREF
  personOne = {
    id: 2,
    location_pref: LOCATION_PREF.NO_PREF,
    lastThreeMatched: [],
  };
  personTwo = {
    id: 12,
    location_pref: LOCATION_PREF.NO_PREF,
    lastThreeMatched: [],
  };
  actual = canBeMatched(personOne, personTwo);
  assert(actual === true);
  // ... but not if one of them has been matched with the other in their last two matches
  personOne = {
    id: 9,
    location_pref: LOCATION_PREF.VIRTUAL,
    lastThreeMatched: [10, 1],
  };
  personTwo = {
    id: 10,
    location_pref: LOCATION_PREF.NO_PREF,
    lastThreeMatched: [],
  };
  actual = canBeMatched(personOne, personTwo);
  assert(actual === false);
};

// testGroupIntoPairs(); // DEPRECATED
// testMatchFirstPerson();
// testCanBeMatched();
