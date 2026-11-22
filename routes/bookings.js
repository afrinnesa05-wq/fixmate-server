import { Router } from "express";
import { ObjectId } from "mongodb";
import verifyToken from "../middleware/verifyToken.js";
import verifyCustomer from "../middleware/verifyCustomer.js";

const ACTIVE_STATUSES = ["requested", "accepted", "in_progress"];

function isValidId(id) {
  return ObjectId.isValid(id);
}

function toBooking(doc) {
  return {
    id: String(doc._id),
    serviceId: doc.serviceId,
    serviceName: doc.serviceName,
    categorySlug: doc.categorySlug,
    customerName: doc.customerName,
    customerId: doc.customerId,
    technicianId: doc.technicianId,
    date: doc.date,
    time: doc.time,
    address: doc.address,
    status: doc.status,
    amount: doc.amount,
    finalAmount: doc.finalAmount ?? null,
    paymentStatus: doc.paymentStatus,
    cancelledBy: doc.cancelledBy ?? null,
    statusHistory: Array.isArray(doc.statusHistory) ? doc.statusHistory : [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// Allowed state machine for booking status transitions.
const TRANSITIONS = {
  cancel: { from: ["requested"], to: "cancelled", actor: "customer" },
  accept: { from: ["requested"], to: "accepted", actor: "technician" },
  decline: { from: ["requested"], to: "cancelled", actor: "technician" },
  start: { from: ["accepted"], to: "in_progress", actor: "technician" },
  complete: {
    from: ["accepted", "in_progress"],
    to: "completed",
    actor: "technician",
  },
};

export function createBookingsRouter({ db, auth }) {
  const router = Router();
  const bookings = db.collection("bookings");
  const services = db.collection("services");

  // POST /bookings — customer requests an approved + available service.
  router.post("/bookings", verifyToken, verifyCustomer, async (req, res) => {
    try {
      const user = req.user;

      // Only customers may create booking requests (technicians/admins excluded).
      if (user.role !== "customer") {
        return res.status(403).json({
          error: "Only customer accounts can request bookings.",
        });
      }

      const { serviceId, date, time, address } = req.body || {};
      if (!serviceId || !isValidId(serviceId)) {
        return res.status(400).json({ error: "A valid service is required." });
      }
      if (!date || !time || !address) {
        return res
          .status(400)
          .json({ error: "Date, time and address are required." });
      }

      const service = await services.findOne({ _id: new ObjectId(serviceId) });
      if (!service) {
        return res.status(404).json({ error: "Service not found." });
      }
      if (service.approvalStatus !== "approved" || service.isAvailable === false) {
        return res
          .status(409)
          .json({ error: "This service is not available for booking." });
      }
      if (service.technicianId === user.id) {
        return res
          .status(400)
          .json({ error: "You cannot book your own service." });
      }

      // Prevent duplicate active requests for the same service.
      const duplicate = await bookings.findOne({
        customerId: user.id,
        serviceId: String(serviceId),
        status: { $in: ACTIVE_STATUSES },
      });
      if (duplicate) {
        return res.status(409).json({
          error:
            "You already have an active request for this service. Wait for it to finish before requesting again.",
        });
      }

      const now = new Date();
      const doc = {
        serviceId: String(serviceId),
        serviceName: service.title,
        categorySlug: service.categorySlug || "",
        customerName: user.name || "",
        customerId: user.id,
        technicianId: service.technicianId,
        date: String(date),
        time: String(time),
        address: String(address),
        status: "requested",
        amount: service.price,
        finalAmount: null,
        paymentStatus: "unpaid",
        cancelledBy: null,
        // Server-authored timeline only — never taken from the client body.
        statusHistory: [{ status: "requested", changedAt: now }],
        createdAt: now,
        updatedAt: now,
      };

      const result = await bookings.insertOne(doc);
      res.status(201).json({ booking: toBooking({ ...doc, _id: result.insertedId }) });
    } catch (error) {
      console.error("POST /bookings failed:", error);
      res.status(500).json({ error: "Failed to create the booking." });
    }
  });

  // GET /bookings?scope=customer|technician|all
  router.get("/bookings", verifyToken, async (req, res) => {
    try {
      const user = req.user;

      const scope = String(req.query.scope || "customer");
      const filter = {};

      if (scope === "customer") {
        filter.customerId = user.id;
      } else if (scope === "technician") {
        filter.technicianId = user.id;
      } else if (scope === "all") {
        if (user.role !== "admin") {
          return res.status(403).json({ error: "Admin access required." });
        }
      } else {
        return res.status(400).json({ error: "Invalid scope." });
      }

      const docs = await bookings
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(200)
        .toArray();

      res.json({ bookings: docs.map(toBooking) });
    } catch (error) {
      console.error("GET /bookings failed:", error);
      res.status(500).json({ error: "Failed to load bookings." });
    }
  });

  // PATCH /bookings/:id — validated status transitions.
  router.patch("/bookings/:id", verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) {
        return res.status(404).json({ error: "Booking not found." });
      }

      const user = req.user;

      const doc = await bookings.findOne({ _id: new ObjectId(id) });
      if (!doc) return res.status(404).json({ error: "Booking not found." });

      // Client may only send action/finalAmount — statusHistory is never accepted.
      const { action, finalAmount } = req.body || {};
      const rule = TRANSITIONS[action];
      if (!rule) {
        return res.status(400).json({ error: "Unknown booking action." });
      }

      // Ownership/actor first: non-owners must not learn booking state.
      const isCustomer = doc.customerId === user.id;
      const isTechnician = doc.technicianId === user.id;
      const isAdmin = user.role === "admin";

      if (rule.actor === "customer" && !isCustomer && !isAdmin) {
        return res.status(403).json({ error: "Only the booking owner can cancel." });
      }
      if (rule.actor === "technician" && !isTechnician && !isAdmin) {
        return res
          .status(403)
          .json({ error: "Only the assigned technician can do this." });
      }

      if (!rule.from.includes(doc.status)) {
        return res.status(409).json({
          error: `A booking that is "${doc.status}" cannot be ${action}ed.`,
        });
      }

      const now = new Date();
      const updates = { status: rule.to, updatedAt: now };
      if (action === "decline") {
        updates.cancelledBy = "technician";
      }
      if (action === "cancel") {
        updates.cancelledBy = "customer";
      }
      if (action === "complete") {
        const final =
          finalAmount !== undefined && finalAmount !== null && finalAmount !== ""
            ? Number(finalAmount)
            : doc.amount;
        if (!Number.isFinite(final) || final < 0) {
          return res.status(400).json({ error: "Final amount must be valid." });
        }
        updates.finalAmount = final;
        updates.amount = final;
      }

      await bookings.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: updates,
          // Append the new status on the server; ignore any client-supplied history.
          $push: { statusHistory: { status: rule.to, changedAt: now } },
        }
      );
      const updated = await bookings.findOne({ _id: new ObjectId(id) });
      res.json({ booking: toBooking(updated) });
    } catch (error) {
      console.error("PATCH /bookings/:id failed:", error);
      res.status(500).json({ error: "Failed to update the booking." });
    }
  });

  return router;
}
