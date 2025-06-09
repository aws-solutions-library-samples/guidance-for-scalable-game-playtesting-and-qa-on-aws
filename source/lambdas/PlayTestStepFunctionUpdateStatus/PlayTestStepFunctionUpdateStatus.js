import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

const dynamo = DynamoDBDocument.from(new DynamoDB());

export const handler = async (event) => {
    const tableName = process.env.PLAYTESTSESSION_TABLE;

    if (event.status === 'ERROR') {
        // Just update the status field
        await dynamo.update({
            TableName: tableName,
            Key: { playtestingID: event.playtestingID },
            UpdateExpression: 'SET #s = :s',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':s': event.status },
        });

        return { message: 'Status updated to ERROR' };
    } else if (event.status === 'ACTIVE' && event.streamGroupID) {
        // 1. Get the existing item
        const existing = await dynamo.get({
            TableName: tableName,
            Key: { playtestingID: event.playtestingID },
        });

        if (!existing.Item) {
            throw new Error(`Item with playtestingID ${event.playtestingID} not found.`);
        }

        // 2. Copy the item to the new playtestingID
        const newItem = {
            ...existing.Item,
            playtestingID: event.streamGroupID + "--" + event.applicationID,
            status: 'ACTIVE',
        };

        await dynamo.put({
            TableName: tableName,
            Item: newItem,
        });

        // 3. Delete the old item
        await dynamo.delete({
            TableName: tableName,
            Key: { playtestingID: event.playtestingID },
        });

        return { message: 'Status set to ACTIVE and playtestingID migrated' };
    }

    throw new Error('Invalid payload: must include status and optionally stream and application IDs for ACTIVE');
};

