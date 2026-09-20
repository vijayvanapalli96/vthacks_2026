/**
 * mongo.ts — one lazily-connected Atlas client for the collections that are not
 * the audit log.
 *
 * `audit.ts` keeps its own client on purpose: it is the insert-only record the
 * whole trust pitch rests on, and it predates this file. Nothing here may change
 * how that collection behaves, so nothing here touches it.
 */
import { MongoClient, type Collection, type Document, type IndexDescription } from 'mongodb';

let client: Promise<MongoClient> | null = null;
const indexed = new Set<string>();

function uri(): string | null {
  // The Databricks secret can arrive with a trailing newline from stdin.
  return process.env.MONGODB_URI?.trim() || null;
}

/** Null — never a throw — when Mongo is not configured, so callers stay optional. */
export async function mongoCollection<T extends Document>(
  name: string,
  indexes: IndexDescription[] = [],
): Promise<Collection<T> | null> {
  const value = uri();
  if (!value) return null;
  client ??= new MongoClient(value, { serverSelectionTimeoutMS: 8000, appName: 'hirewire-app' })
    .connect()
    .catch((error: unknown) => {
      client = null;
      throw error;
    });
  const collection = (await client).db('hirewire').collection<T>(name);
  if (indexes.length && !indexed.has(name)) {
    indexed.add(name);
    await collection.createIndexes(indexes).catch((error: unknown) => {
      indexed.delete(name);
      console.error(`Could not create ${name} indexes`, error);
    });
  }
  return collection;
}
