/**
 * Boundary validation + normalisation for the two write endpoints.
 *
 * Everything that arrives from the browser is untrusted, so it is checked
 * here - once, at the API boundary - before any Mongo write happens. Routes
 * downstream can then trust the typed object.
 */

const CATEGORIES = [
  "Photo Studio",
  "Film Stage",
  "Podcast Lounge",
  "Music Suite",
  "Workshop",
];

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toStringArray = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0);
};

const isEmail = (value) =>
  typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

export const createSlug = (title, fallbackId) => {
  const base = String(title || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return base ? `${base}-${fallbackId.slice(-4)}` : `studio-${fallbackId.slice(-6)}`;
};

/**
 * Normalises an add/update studio payload. Returns { data } or { errors }.
 * Deliberately strict: the same object shape is used for create and update.
 */
export function validateStudio(body, { user, existing } = {}) {
  const errors = [];

  const title = String(body?.title ?? "").trim();
  if (title.length < 4) errors.push("Title must be at least 4 characters.");

  const category = String(body?.category ?? "").trim();
  if (!CATEGORIES.includes(category)) {
    errors.push(`Category must be one of: ${CATEGORIES.join(", ")}.`);
  }

  const description = String(body?.description ?? "").trim();
  if (description.length < 30) {
    errors.push("Detailed overview must be at least 30 characters.");
  }

  const city = String(body?.location?.city ?? "").trim();
  if (!city) errors.push("City is required.");

  const address = String(body?.location?.address ?? "").trim();
  if (!address) errors.push("Address is required.");

  const hourlyRate = toNumber(body?.pricing?.hourlyRate, 0);
  if (hourlyRate <= 0) errors.push("Hourly rate must be greater than 0.");

  const securityDeposit = toNumber(body?.pricing?.securityDeposit, 0);
  if (securityDeposit < 0) errors.push("Security deposit cannot be negative.");

  const maxCapacity = toNumber(body?.specs?.maxCapacity, 0);
  if (maxCapacity < 1) errors.push("Max capacity must be at least 1.");

  const primaryImage = String(body?.images?.[0]?.url ?? "").trim();
  if (!/^https?:\/\/.+/i.test(primaryImage)) {
    errors.push("A primary image URL starting with http(s) is required.");
  }

  if (errors.length > 0) return { errors };

  const ownerEmail =
    existing?.host?.email || (isEmail(user?.email) ? user.email : "");

  if (!ownerEmail) {
    return { errors: ["Could not resolve the signed-in user's email."] };
  }

  const hostName =
    existing?.host?.name || String(user?.name ?? "").trim() || ownerEmail;

  // Keep only image entries that carry a usable url, primary first.
  const images = (Array.isArray(body.images) ? body.images : [])
    .map((image) => ({
      url: String(image?.url ?? "").trim(),
      caption: String(image?.caption ?? "").trim() || title,
      isPrimary: Boolean(image?.isPrimary),
    }))
    .filter((image) => /^https?:\/\/.+/i.test(image.url));

  if (images.length > 0) {
    images.forEach((image, index) => {
      image.isPrimary = index === 0;
    });
  }

  const data = {
    title,
    slug: existing?.slug || createSlug(title, existing?._id?.toString?.() || "0000"),
    category,
    tagline: String(body?.tagline ?? "").trim() || description.slice(0, 120),
    description,
    location: {
      address,
      city,
      state: String(body?.location?.state ?? "").trim(),
      zipCode: String(body?.location?.zipCode ?? "").trim(),
      country: String(body?.location?.country ?? "").trim() || "Bangladesh",
      coordinates: {
        lat: toNumber(body?.location?.coordinates?.lat, 23.8103),
        lng: toNumber(body?.location?.coordinates?.lng, 90.4125),
      },
    },
    pricing: {
      hourlyRate,
      dailyRate: toNumber(body?.pricing?.dailyRate, hourlyRate * 8),
      securityDeposit,
      cleaningFee: toNumber(body?.pricing?.cleaningFee, 0),
      minimumHours: Math.max(1, toNumber(body?.pricing?.minimumHours, 1)),
      currency: "USD",
    },
    specs: {
      squareFeet: toNumber(body?.specs?.squareFeet, 0),
      ceilingHeightFt: toNumber(body?.specs?.ceilingHeightFt, 0),
      maxCapacity,
      powerCapacity: String(body?.specs?.powerCapacity ?? "").trim(),
      soundproofRating: String(body?.specs?.soundproofRating ?? "").trim(),
    },
    images,
    amenities: toStringArray(body?.amenities),
    includedGear: toStringArray(body?.includedGear),
    rules: toStringArray(body?.rules),
    host: {
      hostId: existing?.host?.hostId || String(user?.id ?? `usr_${ownerEmail}`),
      name: hostName,
      email: ownerEmail,
      phone: existing?.host?.phone || "",
      avatar: existing?.host?.avatar || String(user?.image ?? ""),
      isSuperhost: existing?.host?.isSuperhost ?? false,
      responseRatePercent: existing?.host?.responseRatePercent ?? 90,
      responseTime: existing?.host?.responseTime ?? "Within 1 hour",
    },
    rating: existing?.rating ?? 0,
    reviewCount: existing?.reviewCount ?? 0,
    isFeatured: existing?.isFeatured ?? false,
    isActive: existing?.isActive ?? true,
    updatedAt: new Date().toISOString(),
  };

  return { data };
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const timeToMinutes = (value) => {
  if (!TIME_PATTERN.test(String(value ?? ""))) return null;
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
};

export function validateBooking(body) {
  const errors = [];

  const studioId = String(body?.studioId ?? "").trim();
  if (!/^[a-f\d]{24}$/i.test(studioId)) errors.push("A valid studioId is required.");

  const bookingDate = String(body?.schedule?.bookingDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) {
    errors.push("Booking date must use the YYYY-MM-DD format.");
  }

  const start = timeToMinutes(body?.schedule?.startTime);
  const end = timeToMinutes(body?.schedule?.endTime);

  if (start === null) errors.push("Start time must use the HH:MM format.");
  if (end === null) errors.push("End time must use the HH:MM format.");
  if (start !== null && end !== null && end <= start) {
    errors.push("End time must be later than the start time.");
  }

  const projectTitle = String(body?.projectDetails?.projectTitle ?? "").trim();
  if (projectTitle.length < 3) {
    errors.push("Project title must be at least 3 characters.");
  }

  if (errors.length > 0) return { errors };

  const totalHours = (end - start) / 60;

  const data = {
    bookingNumber: String(body?.bookingNumber ?? "").trim(),
    studioId,
    studioTitle: String(body?.studioTitle ?? "").trim(),
    studioCategory: String(body?.studioCategory ?? "").trim(),
    studioImage: String(body?.studioImage ?? "").trim(),
    schedule: {
      bookingDate,
      startTime: body.schedule.startTime,
      endTime: body.schedule.endTime,
      totalHours,
      timezone: String(body?.schedule?.timezone ?? "Asia/Dhaka"),
    },
    projectDetails: {
      projectTitle,
      crewSize: toNumber(body?.projectDetails?.crewSize, 1),
      specialRequirements: String(
        body?.projectDetails?.specialRequirements ?? "",
      ).trim(),
    },
    pricingSummary: {
      hourlyRate: toNumber(body?.pricingSummary?.hourlyRate, 0),
      subtotal: toNumber(body?.pricingSummary?.subtotal, 0),
      securityDeposit: toNumber(body?.pricingSummary?.securityDeposit, 0),
      cleaningFee: toNumber(body?.pricingSummary?.cleaningFee, 0),
      platformFee: toNumber(body?.pricingSummary?.platformFee, 0),
      totalAmount: toNumber(body?.pricingSummary?.totalAmount, 0),
      currency: "USD",
    },
    status: "Pending",
    payment: {
      paymentStatus: "Unpaid",
      paymentMethod: "Pending",
      transactionId: null,
      paidAt: null,
    },
    invoice: { pdfUrl: null, generatedAt: null },
  };

  return { data, startMinutes: start, endMinutes: end };
}

export { CATEGORIES };
