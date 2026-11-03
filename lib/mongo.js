import { MongoClient } from "mongodb";
import "dotenv/config";

const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error("MONGODB_URI is missing. Copy .env.example to .env first.");
}

// A single client is reused for the whole process (MongoClient keeps its own
// connection pool), so we never open a new connection per request.
const client = new MongoClient(uri);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
    throw err;
  }
}

// Call this only when the application terminates.
export async function disconnectFromMongoDB() {
  await client.close();
}

export { client };
