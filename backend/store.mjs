// Tiny data layer over one DynamoDB table (pk, sk, ttl).
// MEMORY_STORE=1 swaps in an in-memory copy for local development and tests.
export class Conflict extends Error {}

let impl = null;
export async function store() {
  if (!impl) impl = process.env.MEMORY_STORE ? memory() : await dynamo();
  return impl;
}

async function dynamo() {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand } = await import('@aws-sdk/lib-dynamodb');
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const TableName = process.env.TABLE;
  return {
    async get(pk, sk) {
      return (await db.send(new GetCommand({ TableName, Key: { pk, sk } }))).Item || null;
    },
    // opts.ifNew: only if the key is unused. opts.ifVersion: only if item.v still equals it.
    async put(item, opts = {}) {
      const p = { TableName, Item: item };
      if (opts.ifNew) p.ConditionExpression = 'attribute_not_exists(pk)';
      if (opts.ifVersion !== undefined) {
        p.ConditionExpression = 'v = :v';
        p.ExpressionAttributeValues = { ':v': opts.ifVersion };
      }
      try { await db.send(new PutCommand(p)); }
      catch (e) { if (e.name === 'ConditionalCheckFailedException') throw new Conflict(); throw e; }
    },
    async del(pk, sk) {
      await db.send(new DeleteCommand({ TableName, Key: { pk, sk } }));
    },
    async query(pk, prefix = '') {
      const out = [];
      let ExclusiveStartKey;
      do {
        const r = await db.send(new QueryCommand({
          TableName, ExclusiveStartKey,
          KeyConditionExpression: prefix ? 'pk = :pk AND begins_with(sk, :s)' : 'pk = :pk',
          ExpressionAttributeValues: prefix ? { ':pk': pk, ':s': prefix } : { ':pk': pk },
        }));
        out.push(...(r.Items || []));
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out;
    },
  };
}

function memory() {
  const rows = new Map();
  const key = (pk, sk) => pk + '\u0000' + sk;
  const copy = (x) => (x ? structuredClone(x) : null);
  return {
    rows,
    async get(pk, sk) { return copy(rows.get(key(pk, sk))); },
    async put(item, opts = {}) {
      const k = key(item.pk, item.sk);
      const old = rows.get(k);
      if (opts.ifNew && old) throw new Conflict();
      if (opts.ifVersion !== undefined && (!old || old.v !== opts.ifVersion)) throw new Conflict();
      rows.set(k, copy(item));
    },
    async del(pk, sk) { rows.delete(key(pk, sk)); },
    async query(pk, prefix = '') {
      return [...rows.values()].filter((r) => r.pk === pk && r.sk.startsWith(prefix))
        .sort((a, b) => (a.sk < b.sk ? -1 : 1)).map(copy);
    },
  };
}
