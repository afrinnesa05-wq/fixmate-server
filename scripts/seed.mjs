/**
 * Idempotent seed data for FixMate.
 * Creates (without overwriting):
 *  - 2 technician accounts + 1 customer account + 1 admin account (via Better Auth HTTP API)
 *  - 12 approved services across those technicians
 *  - bookings in requested / accepted / in_progress / completed / cancelled states
 *
 * Run:  node --env-file=.env scripts/seed.mjs   (backend must be running on :8000)
 */
import dns from "node:dns";
dns.setServers(["8.8.8.8", "8.8.4.4"]);

import { MongoClient, ObjectId } from "mongodb";

const API = process.env.SEED_API_URL || "http://localhost:8000";
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI is required (use --env-file=.env)");
  process.exit(1);
}

const PASSWORD = "Password123!";

async function signUp(name, email, role) {
  const res = await fetch(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: API },
    body: JSON.stringify({ name, email, password: PASSWORD, role }),
  });
  const json = await res.json().catch(() => null);
  if (res.ok) return json?.user || null;
  // Already registered → sign in instead
  if (res.status === 422 || res.status === 409 || res.status === 403) {
    const si = await fetch(`${API}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: API },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    if (si.ok) return (await si.json())?.user || null;
  }
  console.warn(`  skip user ${email}: ${res.status} ${JSON.stringify(json)}`);
  return null;
}

const CATEGORY_NAMES = {
  smartphone: "Smartphone",
  "laptop-pc": "Laptop & PC",
  ac: "AC",
  refrigerator: "Refrigerator",
  tv: "TV",
  "washing-machine": "Washing Machine",
  electrical: "Electrical",
};

const SERVICES = [
  { title: "iPhone Screen Replacement", category: "smartphone", price: 129, duration: "60 min", tech: 0 },
  { title: "Android Battery Replacement", category: "smartphone", price: 79, duration: "45 min", tech: 0 },
  { title: "Laptop SSD Upgrade", category: "laptop-pc", price: 99, duration: "90 min", tech: 1 },
  { title: "Laptop Screen Replacement", category: "laptop-pc", price: 159, duration: "120 min", tech: 1 },
  { title: "Desktop Virus Removal", category: "laptop-pc", price: 69, duration: "60 min", tech: 1 },
  { title: "AC Deep Cleaning", category: "ac", price: 89, duration: "90 min", tech: 0 },
  { title: "AC Gas Refill", category: "ac", price: 119, duration: "60 min", tech: 0 },
  { title: "Refrigerator Thermostat Fix", category: "refrigerator", price: 109, duration: "75 min", tech: 1 },
  { title: "TV Panel Diagnostics", category: "tv", price: 59, duration: "45 min", tech: 1 },
  { title: "Washing Machine Drain Repair", category: "washing-machine", price: 95, duration: "90 min", tech: 0 },
  { title: "Washing Machine Belt Replacement", category: "washing-machine", price: 85, duration: "60 min", tech: 1 },
  { title: "Home Wiring Safety Check", category: "electrical", price: 75, duration: "60 min", tech: 0 },
];

async function main() {
  console.log("Seeding FixMate…");
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db("fixmate");
  const users = db.collection("users");
  const services = db.collection("services");
  const bookings = db.collection("bookings");
  const payments = db.collection("payments");

  // --- Users ---
  const techUsers = [];
  for (const [i, spec] of [
    ["Ayesha Rahman", "seed.tech1@fixmate.dev"],
    ["Marcus Lee", "seed.tech2@fixmate.dev"],
  ].entries()) {
    const user = await signUp(spec[0], spec[1], "technician");
    if (user) {
      // Ensure role is technician (hook preserves it, but be safe)
      const doc = await users.findOne({ email: spec[1] });
      if (doc && doc.role !== "technician") {
        await users.updateOne({ _id: doc._id }, { $set: { role: "technician" } });
        doc.role = "technician";
      }
      techUsers.push(doc || { _id: user.id, name: spec[0], email: spec[1] });
      console.log(`  technician ok: ${spec[1]}`);
    }
  }
  if (techUsers.length < 2) {
    console.error("Need at least 2 technician accounts to seed services.");
    process.exit(1);
  }

  await signUp("Seed Customer", "seed.customer@fixmate.dev", "customer");
  const customer = await users.findOne({ email: "seed.customer@fixmate.dev" });
  console.log(`  customer: ${customer ? "ok" : "MISSING"}`);

  // --- Admin (not a public registration role) ---
  // Better Auth's user.create hook only allows technician/customer, so the
  // account is created like any other user and then promoted in MongoDB —
  // the same promotion mechanism the README documents for manual admin setup.
  await signUp("Seed Admin", "seed.admin@fixmate.dev", "customer");
  const admin = await users.findOne({ email: "seed.admin@fixmate.dev" });
  if (admin && admin.role !== "admin") {
    await users.updateOne({ _id: admin._id }, { $set: { role: "admin" } });
  }
  console.log(`  admin: ${admin ? "ok" : "MISSING"}`);

  // --- Services (skip titles that already exist) ---
  let createdServices = 0;
  const now = new Date();
  for (const [index, s] of SERVICES.entries()) {
    const exists = await services.findOne({ title: s.title });
    if (exists) continue;
    const tech = techUsers[s.tech];
    const techId = String(tech._id);
    await services.insertOne({
      title: s.title,
      category: CATEGORY_NAMES[s.category],
      categorySlug: s.category,
      serviceMode: index % 2 === 0 ? "on-site" : "in-shop",
      price: s.price,
      duration: s.duration,
      description: `${s.title} by verified FixMate technicians. Includes diagnosis, parts assessment and a 30-day workmanship guarantee.`,
      image: "",
      technicianId: techId,
      technicianName: tech.name || "",
      approvalStatus: "approved",
      isAvailable: true,
      rating: 4.5 + (index % 5) * 0.1,
      reviewCount: 8 + index * 3,
      createdAt: new Date(now.getTime() - index * 86400000),
      updatedAt: now,
    });
    createdServices++;
  }
  console.log(`  services created: ${createdServices} (target 12 approved)`);

  const allServices = await services
    .find({ approvalStatus: "approved" })
    .limit(12)
    .toArray();

  // --- Bookings with different statuses ---
  const bookingStatuses = [
    "requested",
    "accepted",
    "in_progress",
    "completed",
    "cancelled",
  ];
  let createdBookings = 0;
  if (customer && allServices.length >= 3) {
    for (const [i, status] of bookingStatuses.entries()) {
      const service = allServices[i % allServices.length];
      const exists = await bookings.findOne({
        customerId: String(customer._id),
        serviceId: String(service._id),
        status,
      });
      if (exists) continue;
      const amount = service.price;
      const finalAmount =
        status === "completed" ? Math.round(amount * 1.1) : null;
      await bookings.insertOne({
        serviceId: String(service._id),
        serviceName: service.title,
        categorySlug: service.categorySlug || "",
        customerName: customer.name || "Seed Customer",
        customerId: String(customer._id),
        technicianId: service.technicianId,
        date: `2${i + 1} Nov 2026`,
        time: `${10 + i}:00 AM`,
        address: `${12 + i} Maple Street, Brookfield`,
        status,
        amount: finalAmount ?? amount,
        finalAmount,
        paymentStatus:
          status === "completed" && i % 2 === 0 ? "paid" : "unpaid",
        cancelledBy: status === "cancelled" ? "customer" : null,
        createdAt: new Date(now.getTime() - (5 - i) * 3600000),
        updatedAt: now,
      });
      createdBookings++;
    }
  }
  console.log(`  bookings created: ${createdBookings}`);

  // --- One payment record so admin transactions aren't empty ---
  const paidBooking = await bookings.findOne({ paymentStatus: "paid" });
  if (paidBooking) {
    const exists = await payments.findOne({ bookingId: String(paidBooking._id) });
    if (!exists) {
      await payments.insertOne({
        bookingId: String(paidBooking._id),
        customerId: paidBooking.customerId,
        serviceName: paidBooking.serviceName,
        amount: paidBooking.finalAmount ?? paidBooking.amount,
        status: "paid",
        method: "Card",
        stripeSessionId: `seed_${paidBooking._id}`,
        createdAt: paidBooking.updatedAt || now,
        updatedAt: now,
      });
      console.log("  payment record created");
    }
  }

  const counts = {
    users: await users.countDocuments(),
    services: await services.countDocuments(),
    bookings: await bookings.countDocuments(),
    payments: await payments.countDocuments(),
  };
  console.log("Seed complete:", counts);
  console.log(`Test accounts (password ${PASSWORD}):`);
  console.log("  seed.admin@fixmate.dev   (admin)");
  console.log("  seed.tech1@fixmate.dev  (technician)");
  console.log("  seed.tech2@fixmate.dev  (technician)");
  console.log("  seed.customer@fixmate.dev (customer)");
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
