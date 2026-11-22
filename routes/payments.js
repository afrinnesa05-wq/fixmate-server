import { Router } from "express";
import { ObjectId } from "mongodb";
import Stripe from "stripe";
import verifyToken from "../middleware/verifyToken.js";
import verifyCustomer from "../middleware/verifyCustomer.js";
import verifyAdmin from "../middleware/verifyAdmin.js";

function isValidId(id) {
  return ObjectId.isValid(id);
}

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

function frontendOrigin() {
  return (
    process.env.FRONTEND_URL ||
    process.env.BETTER_AUTH_URL ||
    "http://localhost:3000"
  );
}

function toPayment(doc, serviceName) {
  return {
    id: String(doc._id),
    bookingId: doc.bookingId,
    serviceName: serviceName || doc.serviceName || "",
    amount: doc.amount,
    status: doc.status,
    method: doc.method ?? null,
    date: doc.createdAt
      ? new Date(doc.createdAt).toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })
      : "",
    createdAt: doc.createdAt,
  };
}

export function createPaymentsRouter({ db, auth }) {
  const router = Router();
  const payments = db.collection("payments");
  const bookings = db.collection("bookings");

  // POST /payments/checkout — pay for a completed, unpaid booking you own.
  router.post("/payments/checkout", verifyToken, verifyCustomer, async (req, res) => {
    try {
      const user = req.user;

      const { bookingId } = req.body || {};
      if (!bookingId || !isValidId(bookingId)) {
        return res.status(400).json({ error: "A valid booking is required." });
      }

      const booking = await bookings.findOne({ _id: new ObjectId(bookingId) });
      if (!booking) return res.status(404).json({ error: "Booking not found." });

      // Ownership + state rules (checked before any payment configuration).
      if (booking.customerId !== user.id) {
        return res
          .status(403)
          .json({ error: "Only the booking owner can pay for this booking." });
      }
      if (booking.status !== "completed") {
        return res
          .status(409)
          .json({ error: "Payment is only available for completed bookings." });
      }
      if (booking.paymentStatus !== "unpaid") {
        return res.status(409).json({ error: "This booking is already paid." });
      }

      const stripe = getStripe();
      if (!stripe) {
        return res.status(503).json({
          error:
            "Payments are not configured yet (STRIPE_SECRET_KEY is missing on the server).",
        });
      }

      // Prevent duplicate in-flight payments for the same booking.
      const existing = await payments.findOne({
        bookingId: String(bookingId),
        status: { $in: ["paid", "pending"] },
      });
      if (existing && existing.status === "paid") {
        return res.status(409).json({ error: "This booking is already paid." });
      }
      if (existing && existing.stripeSessionId) {
        const session = await stripe.checkout.sessions.retrieve(
          existing.stripeSessionId
        );
        if (session.status === "open" && session.url) {
          return res.json({ url: session.url });
        }
      }

      const amount = booking.finalAmount ?? booking.amount;
      const stripeSession = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: booking.serviceName || "FixMate booking",
                description: `Booking ${String(bookingId)}`,
              },
              unit_amount: Math.round(Number(amount) * 100),
            },
            quantity: 1,
          },
        ],
        metadata: { bookingId: String(bookingId), userId: user.id },
        success_url: `${frontendOrigin()}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${frontendOrigin()}/payment/cancel?booking_id=${String(bookingId)}`,
      });

      const now = new Date();
      const paymentDoc = {
        bookingId: String(bookingId),
        customerId: user.id,
        serviceName: booking.serviceName,
        amount: Number(amount),
        status: "pending",
        method: null,
        stripeSessionId: stripeSession.id,
        createdAt: now,
        updatedAt: now,
      };

      if (existing) {
        await payments.updateOne(
          { _id: existing._id },
          { $set: { stripeSessionId: stripeSession.id, updatedAt: now } }
        );
      } else {
        await payments.insertOne(paymentDoc);
      }

      res.json({ url: stripeSession.url });
    } catch (error) {
      console.error("POST /payments/checkout failed:", error);
      res.status(500).json({ error: "Could not start the payment." });
    }
  });

  // GET /payments/verify?session_id= — idempotent confirmation for the success page.
  router.get("/payments/verify", async (req, res) => {
    try {
      const stripe = getStripe();
      const sessionId = String(req.query.session_id || "");
      if (!stripe || !sessionId) {
        return res.status(400).json({ error: "Missing session_id." });
      }

      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== "paid") {
        return res.json({ paid: false });
      }

      const bookingId = session.metadata?.bookingId;
      if (bookingId && ObjectId.isValid(bookingId)) {
        await markBookingPaid(db, session);
      }

      res.json({ paid: true, bookingId: bookingId || null });
    } catch (error) {
      console.error("GET /payments/verify failed:", error);
      res.status(500).json({ error: "Could not verify the payment." });
    }
  });

  // GET /payments?scope=customer|all
  router.get("/payments", verifyToken, async (req, res) => {
    try {
      const user = req.user;

      const scope = String(req.query.scope || "customer");
      const filter = {};
      if (scope === "customer") {
        filter.customerId = user.id;
      } else if (scope === "all") {
        if (user.role !== "admin") {
          return res.status(403).json({ error: "Admin access required." });
        }
      } else {
        return res.status(400).json({ error: "Invalid scope." });
      }

      const docs = await payments
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(200)
        .toArray();

      res.json({
        payments: docs.map((doc) => toPayment(doc, doc.serviceName)),
      });
    } catch (error) {
      console.error("GET /payments failed:", error);
      res.status(500).json({ error: "Failed to load payments." });
    }
  });

  // GET /transactions — admin ledger derived from real payments.
  router.get("/transactions", verifyToken, verifyAdmin, async (req, res) => {
    try {
      const user = req.user;

      const docs = await payments
        .find({ status: { $in: ["paid", "refunded"] } })
        .sort({ createdAt: -1 })
        .limit(200)
        .toArray();

      const transactions = docs.map((doc) => ({
        id: String(doc._id),
        date: doc.createdAt
          ? new Date(doc.createdAt).toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })
          : "",
        description:
          doc.status === "refunded"
            ? `Refund — ${doc.serviceName || doc.bookingId}`
            : `${doc.serviceName || "Booking"} payment`,
        type: doc.status === "refunded" ? "refund" : "earning",
        amount: doc.amount,
        status: "completed",
      }));

      res.json({ transactions });
    } catch (error) {
      console.error("GET /transactions failed:", error);
      res.status(500).json({ error: "Failed to load transactions." });
    }
  });

  return router;
}

// Marks a booking + payment as paid (idempotent). Used by verify + webhook.
export async function markBookingPaid(db, stripeSession) {
  const bookingId = stripeSession.metadata?.bookingId;
  if (!bookingId || !ObjectId.isValid(bookingId)) return;

  const bookings = db.collection("bookings");
  const payments = db.collection("payments");
  const now = new Date();

  const method =
    stripeSession.payment_intent_details?.card?.brand && stripeSession.payment_intent_details?.card?.last4
      ? `${stripeSession.payment_intent_details.card.brand} •••• ${stripeSession.payment_intent_details.card.last4}`
      : "Card";

  // Only flip unpaid → paid once, and append the Paid timeline step server-side.
  const bookingResult = await bookings.updateOne(
    { _id: new ObjectId(bookingId), paymentStatus: { $ne: "paid" } },
    {
      $set: { paymentStatus: "paid", updatedAt: now },
      $push: { statusHistory: { status: "paid", changedAt: now } },
    }
  );

  // If already paid, still ensure payment doc is marked paid (idempotent).
  if (bookingResult.matchedCount === 0) {
    await bookings.updateOne(
      { _id: new ObjectId(bookingId) },
      { $set: { paymentStatus: "paid", updatedAt: now } }
    );
  }

  await payments.updateOne(
    { stripeSessionId: stripeSession.id },
    {
      $set: {
        status: "paid",
        method,
        updatedAt: now,
      },
      $setOnInsert: {
        bookingId: String(bookingId),
        customerId: stripeSession.metadata?.userId || "",
        serviceName: "",
        amount: (stripeSession.amount_total ?? 0) / 100,
        createdAt: now,
      },
    },
    { upsert: true }
  );
}
