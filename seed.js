/**
 * Seed script - `npm run seed`
 *
 * 1. data/studios.json  + data/bookings.json  = the official sample data from
 *    the assignment root folder, imported verbatim (never edited).
 * 2. data/seed-extra.json = extra demo listings so every category, filter and
 *    booking badge on the site has something to show.
 *
 * Running it twice is safe: each document is upserted by its _id.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ObjectId } from "mongodb";

import { connectToMongoDB, disconnectFromMongoDB } from "./lib/mongo.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = async (name) =>
  JSON.parse(await readFile(join(here, "data", name), "utf8"));

// The JSON keeps _id as a plain string; Mongo stores an ObjectId so that
// /studios/:id can look documents up with new ObjectId(id).
const withObjectId = (document) => ({
  ...document,
  _id: new ObjectId(document._id),
});

async function seed() {
  const client = await connectToMongoDB();
  const db = client.db("studiospace");
  const studioCollection = db.collection("studios");
  const bookingCollection = db.collection("bookings");

  const [officialStudios, officialBookings, extra] = await Promise.all([
    read("studios.json"),
    read("bookings.json"),
    read("seed-extra.json"),
  ]);

  const studios = [...officialStudios, ...extra.studios].map(withObjectId);
  const bookings = [...officialBookings, ...extra.bookings].map(withObjectId);

  for (const studio of studios) {
    await studioCollection.updateOne(
      { _id: studio._id },
      { $set: studio },
      { upsert: true },
    );
  }

  for (const booking of bookings) {
    await bookingCollection.updateOne(
      { _id: booking._id },
      { $set: booking },
      { upsert: true },
    );
  }

  console.log(
    `Seeded ${studios.length} studios (${officialStudios.length} official) and ` +
      `${bookings.length} bookings (${officialBookings.length} official).`,
  );
  console.log(
    "Register with email examiner@studiospace.io to see a listing on " +
      "/my-listings and bookings on /my-bookings.",
  );

  const countByCategory = await studioCollection
    .aggregate([{ $group: { _id: "$category", count: { $sum: 1 } } }, { $sort: { count: -1 } }])
    .toArray();
  console.table(countByCategory.map((row) => ({ category: row._id, count: row.count })));

  await disconnectFromMongoDB();
}

seed().catch(async (error) => {
  console.error(error);
  await disconnectFromMongoDB().catch(() => {});
  process.exit(1);
});
