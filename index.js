
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { createAuth } from "./lib/auth.ts";
import { toNodeHandler } from "better-auth/node";
import dns from 'node:dns';
import { createServicesRouter } from "./routes/services.js";
import { createBookingsRouter } from "./routes/bookings.js";
import { createPaymentsRouter, markBookingPaid } from "./routes/payments.js";
import { createUsersRouter } from "./routes/users.js";
import { createTokenRouter } from "./routes/token.js";
import Stripe from "stripe";

const app = express();
const port = process.env.PORT || 8000;

// Middleware
// CORS
app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  })
);
// Use Google DNS for MongoDB SRV lookup
dns.setServers(['8.8.8.8', '8.8.4.4']);



// MongoDB connection
console.log('MongoDB URI loaded:', !!process.env.MONGODB_URI);

const client = new MongoClient(process.env.MONGODB_URI);
const db = client.db('fixmate');
// Shared with middleware/verifyToken.js so a JWT can be re-checked against
// the account's suspended flag on every protected request.
app.locals.db = db;
async function createCollections() {
  try {
    const collections = [
      'users',
      'services',
      'bookings',
      'payments'
    ];

    for (const collectionName of collections) {
      const exists = await db
        .listCollections({ name: collectionName })
        .hasNext();

      if (!exists) {
        await db.createCollection(collectionName);
        console.log(`${collectionName} collection created`);
      }
    }
  } catch (error) {
    console.error('Collection creation failed:', error);
  }
}

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log('You successfully connected to MongoDB!');
    return client;
  } catch (err) {
    console.error('MongoDB connection failed:', err);
    process.exit(1);
  }
}

await connectToMongoDB();
await createCollections();

const auth = createAuth(client);
// Better Auth handler
app.all("/api/auth/{*any}", toNodeHandler(auth));

// Stripe webhook needs the RAW request body for signature verification,
// so it must be registered before express.json().
const stripeSecret = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

app.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe || !stripeWebhookSecret) {
      return res.status(503).json({
        error: "Stripe is not configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET missing).",
      });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        stripeWebhookSecret
      );
    } catch (err) {
      console.error("Stripe webhook signature verification failed:", err.message);
      return res.status(400).json({ error: "Invalid webhook signature." });
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        if (session.payment_status === "paid") {
          await markBookingPaid(db, session);
        }
      }
      res.json({ received: true });
    } catch (err) {
      console.error("Stripe webhook handling failed:", err);
      res.status(500).json({ error: "Webhook handling failed." });
    }
  }
);

// Body parser for other Express routes.
// Cover images arrive as base64 (`imageBase64`), which is ~1.37x the file
// size — the 100kb default rejected every real photo with 413 before the
// upload code could run. 10mb matches the largest image the API accepts.
app.use(express.json({ limit: "10mb" }));

// Home route
app.get('/', (req, res) => {
  res.send('FixMate server is running!');
});

// Feature APIs (identity comes from a JWT issued by /auth/token after the
// Better Auth session has been verified — see middleware/verifyToken.js)
app.use(createTokenRouter({ db, auth }));
app.use(createServicesRouter({ db, auth }));
app.use(createBookingsRouter({ db, auth }));
app.use(createPaymentsRouter({ db, auth }));
app.use(createUsersRouter({ db, auth }));

// Start server
app.listen(port, () => {
  console.log(`FixMate is running on port ${port}`);
  console.log(stripe ? "Stripe: configured" : "Stripe: NOT configured (set STRIPE_SECRET_KEY)");
  console.log(process.env.IMGBB_API_KEY ? "ImgBB: configured" : "ImgBB: NOT configured (set IMGBB_API_KEY)");
});
