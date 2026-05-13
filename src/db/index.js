import { MongoClient, ObjectId } from 'mongodb';
import { config } from '../config.js';

let client;
let db;

export async function connectDb() {
  if (db) return db;
  client = new MongoClient(config.databaseUrl);
  await client.connect();
  db = client.db();
  return db;
}

export function getDb() {
  if (!db) throw new Error('DB not connected. Call connectDb() first.');
  return db;
}

export function getCollection(name) {
  return getDb().collection(name);
}

export { ObjectId };

/** Serialize doc for API: _id -> id (string), remove __v if present */
export function toObj(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id?.toString(), ...rest };
}

export function toObjArray(docs) {
  return (docs || []).map(toObj);
}
