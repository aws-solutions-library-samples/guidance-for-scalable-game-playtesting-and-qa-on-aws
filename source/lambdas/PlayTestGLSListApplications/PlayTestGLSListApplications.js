//import { GameLiftStreamsClient, ListApplicationsCommand } from "@aws-sdk/client-gameliftstreams"; // ES Modules import
const { GameLiftStreams, ListApplicationsCommand } = require('@aws-sdk/client-gameliftstreams');

exports.handler = async function (event, context) {
    //console.log('Received event:', JSON.stringify(event, null, 2));

    const headers = {
        'Content-Type': 'application/json',
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
        "X-Requested-With": "*",
    };

    try {
        
      //Going to list out all applications from GameLiftStreams
      const data = await new GameLiftStreams().send(new ListApplicationsCommand({}));

        return {
          statusCode: 200,
          headers: headers,
            body: JSON.stringify(data.Items),
        };
      } catch (error) {
        return {
          statusCode: 500,
          //body: JSON.stringify({ message: error.message }),
          headers: headers
        };
      }
};
