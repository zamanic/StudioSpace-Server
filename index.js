import express from "express";
import cors from "cors";
import { ObjectId } from "mongodb";
import "dotenv/config";

import { connectToMongoDB } from "./lib/mongo.js";
import { verifyToken } from "./middleware/verifyToken.js";
import {
  validateStudio,
  validateBooking,
  timeToMinutes,
} from "./lib/validate.js";

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------- database
const mongoClient = await connectToMongoDB();
const db = mongoClient.db("studiospace");
const studioCollection = db.collection("studios");
const bookingCollection = db.collection("bookings");
const reviewCollection = db.collection("reviews");
const wishlistCollection = db.collection("wishlists");

// ---------------------------------------------------------------- helpers

// express 4 does not forward rejected promises to the error handler, so every
// async route is wrapped instead of duplicating try/catch everywhere.
const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

const fail = (res, status, code, message) =>
  res.status(status).json({ code, message });

const toObjectId = (id) =>
  /^[a-f\d]{24}$/i.test(id) ? new ObjectId(id) : null;

// An invalid / expired JWT must be 401, so verifyToken never returns 500.
const ownerEmailOf = (req) => String(req.user?.email ?? "").toLowerCase();

// Only these booking statuses block a new reservation. The brief pins this to
// "Confirmed"; change it here if pending holds should block too.
const BLOCKING_STATUSES = ["Confirmed"];

// ---------------------------------------------------------------- health
app.get("/", (req, res) => {
  res.json({ message: "Server is running fine!", service: "StudioSpace API" });
});

// ---------------------------------------------------------------- studios
/**
 * GET /studios - public explore feed.
 * Query: search, category (repeatable or comma separated), minPrice, maxPrice,
 * minCapacity, sort, limit.
 */
app.get(
  "/studios",
  asyncHandler(async (req, res) => {
    const { search, category, minPrice, maxPrice, minCapacity, sort, limit } =
      req.query;

    const filter = { isActive: { $ne: false } };

    if (category) {
      const list = String(category)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (list.length > 0) filter.category = { $in: list };
    }

    if (minPrice || maxPrice) {
      const range = {};
      if (minPrice) range.$gte = Number(minPrice);
      if (maxPrice) range.$lte = Number(maxPrice);
      if (Object.keys(range).length > 0) filter["pricing.hourlyRate"] = range;
    }

    if (minCapacity) {
      filter["specs.maxCapacity"] = { $gte: Number(minCapacity) };
    }

    if (search) {
      // $or + $regex across the fields a visitor would actually type into.
      const term = String(search).trim();
      filter.$or = [
        { title: { $regex: term, $options: "i" } },
        { tagline: { $regex: term, $options: "i" } },
        { category: { $regex: term, $options: "i" } },
        { "location.city": { $regex: term, $options: "i" } },
        { amenities: { $regex: term, $options: "i" } },
      ];
    }

    const sortMap = {
      newest: { createdAt: -1 },
      "price-asc": { "pricing.hourlyRate": 1 },
      "price-desc": { "pricing.hourlyRate": -1 },
      rating: { rating: -1 },
    };

    const cursor = studioCollection
      .find(filter)
      .sort(sortMap[sort] || { createdAt: -1 });

    if (limit) cursor.limit(Math.min(Number(limit) || 0, 60));

    const result = await cursor.toArray();
    res.json(result);
  }),
);

/** GET /featured-studios - the six studios shown on the home page. */
app.get(
  "/featured-studios",
  asyncHandler(async (req, res) => {
    const result = await studioCollection
      .find({ isActive: { $ne: false } })
      .sort({ isFeatured: -1, rating: -1, createdAt: -1 })
      .limit(6)
      .toArray();

    res.json(result);
  }),
);

/**
 * GET /stats - aggregation over the catalogue for the About page.
 * $facet runs several pipelines in one round trip: counts per category,
 * an average hourly rate and the cheapest / priciest listing.
 */
app.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const [facets] = await studioCollection
      .aggregate([
        { $match: { isActive: { $ne: false } } },
        {
          $facet: {
            byCategory: [
              { $group: { _id: "$category", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              {
                $project: {
                  _id: 0,
                  category: "$_id",
                  count: 1,
                },
              },
            ],
            pricing: [
              {
                $group: {
                  _id: null,
                  averageHourlyRate: { $avg: "$pricing.hourlyRate" },
                  cheapest: { $min: "$pricing.hourlyRate" },
                  priciest: { $max: "$pricing.hourlyRate" },
                  listings: { $sum: 1 },
                },
              },
              { $project: { _id: 0 } },
            ],
          },
        },
      ])
      .toArray();

    res.json({
      byCategory: facets?.byCategory ?? [],
      pricing: facets?.pricing?.[0] ?? {
        averageHourlyRate: 0,
        cheapest: 0,
        priciest: 0,
        listings: 0,
      },
    });
  }),
);

/** GET /studios/:id - public studio details. */
app.get(
  "/studios/:id",
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) return fail(res, 404, "NOT_FOUND", "Studio not found.");

    const result = await studioCollection.findOne({ _id });
    if (!result) return fail(res, 404, "NOT_FOUND", "Studio not found.");

    res.json(result);
  }),
);

/**
 * GET /studios/:id/reviews - public creator reviews for one studio, newest
 * first. studioId is stored as the plain 24-char hex string (same convention
 * as bookings.studioId) so it is matched directly, no ObjectId cast needed.
 */
app.get(
  "/studios/:id/reviews",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!/^[a-f\d]{24}$/i.test(id)) return res.json([]);

    const result = await reviewCollection
      .find({ studioId: id })
      .sort({ createdAt: -1 })
      .limit(30)
      .toArray();

    res.json(result);
  }),
);

/** POST /add-studio - protected create. */
app.post(
  "/add-studio",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { data, errors } = validateStudio(req.body, { user: req.user });
    if (errors) return fail(res, 400, "VALIDATION_ERROR", errors.join(" "));

    const now = new Date().toISOString();
    const document = { ...data, createdAt: now, updatedAt: now };

    const result = await studioCollection.insertOne(document);
    res.status(201).json({ ...document, _id: result.insertedId });
  }),
);

/** GET /my-listings - protected, only the signed-in host's own studios. */
app.get(
  "/my-listings",
  verifyToken,
  asyncHandler(async (req, res) => {
    const email = String(req.query.email ?? ownerEmailOf(req)).toLowerCase();
    if (email !== ownerEmailOf(req)) {
      return fail(
        res,
        403,
        "FORBIDDEN",
        "You can only view your own listings.",
      );
    }

    // Filtering by the owner inside the query itself - never "find all then
    // filter in JS".
    const result = await studioCollection
      .find({ "host.email": email })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(result);
  }),
);

/** PATCH /studios/:id - protected update, owner only. */
app.patch(
  "/studios/:id",
  verifyToken,
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) return fail(res, 404, "NOT_FOUND", "Studio not found.");

    const existing = await studioCollection.findOne({ _id });
    if (!existing) return fail(res, 404, "NOT_FOUND", "Studio not found.");

    if (String(existing.host?.email).toLowerCase() !== ownerEmailOf(req)) {
      return fail(
        res,
        403,
        "FORBIDDEN",
        "You can only edit your own listings.",
      );
    }

    const { data, errors } = validateStudio(req.body, {
      user: req.user,
      existing,
    });
    if (errors) return fail(res, 400, "VALIDATION_ERROR", errors.join(" "));

    // $set updates only the fields present in the payload.
    const result = await studioCollection.updateOne({ _id }, { $set: data });

    res.json({
      modifiedCount: result.modifiedCount,
      studio: { ...existing, ...data },
    });
  }),
);

/** DELETE /studios/:id - protected delete, owner only. */
app.delete(
  "/studios/:id",
  verifyToken,
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) return fail(res, 404, "NOT_FOUND", "Studio not found.");

    const existing = await studioCollection.findOne({ _id });
    if (!existing) return fail(res, 404, "NOT_FOUND", "Studio not found.");

    if (String(existing.host?.email).toLowerCase() !== ownerEmailOf(req)) {
      return fail(
        res,
        403,
        "FORBIDDEN",
        "You can only delete your own listings.",
      );
    }

    const result = await studioCollection.deleteOne({ _id });
    res.json({ deletedCount: result.deletedCount });
  }),
);

// ---------------------------------------------------------------- bookings
/**
 * POST /bookings - protected. Saves the reservation as "Pending" and refuses
 * a slot that overlaps an existing Confirmed booking for the same studio
 * (409 Conflict).
 */
app.post(
  "/bookings",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { data, errors, startMinutes, endMinutes } = validateBooking(
      req.body,
    );
    if (errors) return fail(res, 400, "VALIDATION_ERROR", errors.join(" "));

    const _studioId = toObjectId(data.studioId);
    if (!_studioId) return fail(res, 404, "NOT_FOUND", "Studio not found.");

    const studio = await studioCollection.findOne({ _id: _studioId });
    if (!studio) return fail(res, 404, "NOT_FOUND", "Studio not found.");

    if (String(studio.host?.email).toLowerCase() === ownerEmailOf(req)) {
      return fail(
        res,
        403,
        "FORBIDDEN",
        "You cannot book your own studio space.",
      );
    }

    const minimumHours = Number(studio.pricing?.minimumHours ?? 1);
    if (data.schedule.totalHours < minimumHours) {
      return fail(
        res,
        400,
        "VALIDATION_ERROR",
        `This studio has a ${minimumHours} hour minimum booking.`,
      );
    }

    // Overlap test on zero-padded HH:MM strings: an existing booking blocks
    // the slot when it starts before the new end AND ends after the new start.
    const clash = await bookingCollection.findOne({
      studioId: data.studioId,
      "schedule.bookingDate": data.schedule.bookingDate,
      status: { $in: BLOCKING_STATUSES },
      "schedule.startTime": { $lt: data.schedule.endTime },
      "schedule.endTime": { $gt: data.schedule.startTime },
    });

    if (clash) {
      return fail(
        res,
        409,
        "DOUBLE_BOOKING",
        `This slot overlaps a confirmed booking (${clash.schedule?.startTime} - ${clash.schedule?.endTime}). Please pick another time.`,
      );
    }

    const now = new Date().toISOString();
    const document = {
      ...data,
      bookingNumber:
        data.bookingNumber ||
        `BK-${now.slice(0, 7).replace("-", "")}-${Math.floor(1000 + Math.random() * 8999)}`,
      studioTitle: studio.title,
      studioCategory: studio.category,
      studioImage:
        studio.images?.find((image) => image.isPrimary)?.url ||
        studio.images?.[0]?.url ||
        "",
      hostEmail: studio.host?.email ?? "",
      creator: {
        userId: String(req.user?.id ?? ""),
        name: String(req.user?.name ?? ""),
        email: ownerEmailOf(req),
        phone: "",
        avatar: String(req.user?.image ?? ""),
        company: data.projectDetails?.projectTitle ?? "",
      },
      createdAt: now,
      updatedAt: now,
    };

    const result = await bookingCollection.insertOne(document);
    res
      .status(201)
      .json({ ...document, _id: result.insertedId, startMinutes, endMinutes });
  }),
);

/** GET /my-bookings - protected, only the signed-in creator's reservations. */
app.get(
  "/my-bookings",
  verifyToken,
  asyncHandler(async (req, res) => {
    const email = String(req.query.email ?? ownerEmailOf(req)).toLowerCase();
    if (email !== ownerEmailOf(req)) {
      return fail(
        res,
        403,
        "FORBIDDEN",
        "You can only view your own bookings.",
      );
    }

    const result = await bookingCollection
      .find({ "creator.email": email })
      .sort({ "schedule.bookingDate": -1, createdAt: -1 })
      .toArray();

    res.json(result);
  }),
);

/** PATCH /bookings/:id/cancel - only a Pending booking can be cancelled. */
app.patch(
  "/bookings/:id/cancel",
  verifyToken,
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) return fail(res, 404, "NOT_FOUND", "Booking not found.");

    const booking = await bookingCollection.findOne({ _id });
    if (!booking) return fail(res, 404, "NOT_FOUND", "Booking not found.");

    if (String(booking.creator?.email).toLowerCase() !== ownerEmailOf(req)) {
      return fail(
        res,
        403,
        "FORBIDDEN",
        "You can only cancel your own bookings.",
      );
    }

    if (booking.status !== "Pending") {
      return fail(
        res,
        409,
        "INVALID_STATE",
        `A ${booking.status} booking can no longer be cancelled.`,
      );
    }

    const result = await bookingCollection.updateOne(
      { _id, status: "Pending" },
      {
        $set: {
          status: "Cancelled",
          updatedAt: new Date().toISOString(),
        },
      },
    );

    res.json({ modifiedCount: result.modifiedCount, status: "Cancelled" });
  }),
);

/** GET /bookings/studio/:studioId - availability used by the booking modal. */
app.get(
  "/bookings/studio/:studioId",
  asyncHandler(async (req, res) => {
    const result = await bookingCollection
      .find(
        { studioId: req.params.studioId, status: { $in: BLOCKING_STATUSES } },
        {
          projection: {
            "schedule.bookingDate": 1,
            "schedule.startTime": 1,
            "schedule.endTime": 1,
          },
        },
      )
      .toArray();

    res.json(
      result.map((booking) => ({
        bookingDate: booking.schedule?.bookingDate,
        startTime: booking.schedule?.startTime,
        endTime: booking.schedule?.endTime,
      })),
    );
  }),
);

// ---------------------------------------------------------------- wishlist
/**
 * A saved studio is one document per account: { userEmail, studioId, createdAt }.
 * studioId stays the plain 24-char hex string, the same convention bookings and
 * reviews already use, so writes never need an ObjectId cast.
 */
app.post(
  "/wishlist/:studioId",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { studioId } = req.params;
    const _studioId = toObjectId(studioId);
    if (!_studioId) return fail(res, 404, "NOT_FOUND", "Studio not found.");

    const studio = await studioCollection.findOne(
      { _id: _studioId },
      { projection: { _id: 1 } },
    );
    if (!studio) return fail(res, 404, "NOT_FOUND", "Studio not found.");

    // upsert + $setOnInsert: clicking the heart twice never duplicates a row
    // and never rewrites the date the studio was first saved.
    await wishlistCollection.updateOne(
      { userEmail: ownerEmailOf(req), studioId },
      {
        $setOnInsert: {
          userEmail: ownerEmailOf(req),
          studioId,
          createdAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );

    res.status(201).json({ saved: true, studioId });
  }),
);

/** DELETE /wishlist/:studioId - protected. Idempotent: removing twice is a 200. */
app.delete(
  "/wishlist/:studioId",
  verifyToken,
  asyncHandler(async (req, res) => {
    const result = await wishlistCollection.deleteOne({
      userEmail: ownerEmailOf(req),
      studioId: req.params.studioId,
    });

    res.json({ saved: false, removed: result.deletedCount });
  }),
);

/**
 * GET /my-wishlist/ids - the light list every card's heart reads. Kept separate
 * from the full listing so a catalogue page never downloads the studio bodies
 * just to know which hearts are filled.
 */
app.get(
  "/my-wishlist/ids",
  verifyToken,
  asyncHandler(async (req, res) => {
    const rows = await wishlistCollection
      .find(
        { userEmail: ownerEmailOf(req) },
        { projection: { _id: 0, studioId: 1 } },
      )
      .toArray();

    res.json(rows.map((row) => row.studioId));
  }),
);

/**
 * GET /my-wishlist - protected. One aggregation joins the saved ids back to the
 * studios: saved newest first, so $sort runs before $lookup/$unwind and the
 * document order survives the join.
 */
app.get(
  "/my-wishlist",
  verifyToken,
  asyncHandler(async (req, res) => {
    const result = await wishlistCollection
      .aggregate([
        { $match: { userEmail: ownerEmailOf(req) } },
        { $sort: { createdAt: -1 } },
        { $addFields: { studioObjectId: { $toObjectId: "$studioId" } } },
        {
          $lookup: {
            from: "studios",
            localField: "studioObjectId",
            foreignField: "_id",
            as: "studio",
          },
        },
        { $unwind: "$studio" },
        { $replaceRoot: { newRoot: "$studio" } },
        { $match: { isActive: { $ne: false } } },
      ])
      .toArray();

    res.json(result);
  }),
);

// ---------------------------------------------------------------- errors
app.use((req, res) => {
  fail(res, 404, "NOT_FOUND", `No route matches ${req.method} ${req.path}.`);
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  console.error(error);
  fail(res, 500, "SERVER_ERROR", "Something went wrong on the server.");
});

app.listen(PORT, () => {
  console.log(`Server is running at ${PORT}`);
});

export default app;
export { timeToMinutes };
