import { Router } from "express";
import { ObjectId } from "mongodb";
import { getSessionUser } from "../lib/session.js";
import verifyToken from "../middleware/verifyToken.js";
import verifyTechnician from "../middleware/verifyTechnician.js";

const CATEGORY_NAMES = {
  smartphone: "Smartphone",
  "laptop-pc": "Laptop & PC",
  ac: "AC",
  refrigerator: "Refrigerator",
  tv: "TV",
  "washing-machine": "Washing Machine",
  electrical: "Electrical",
};

async function uploadToImgBB(base64Input) {
  const key = process.env.IMGBB_API_KEY;
  if (!key) {
    const err = new Error(
      "Image upload is not configured (IMGBB_API_KEY is missing on the server)."
    );
    err.status = 503;
    throw err;
  }

  const image = String(base64Input).replace(/^data:image\/[\w+-]+;base64,/, "");
  const form = new FormData();
  form.append("image", image);

  let response;
  try {
    response = await fetch(
      `https://api.imgbb.com/1/upload?key=${encodeURIComponent(key)}`,
      { method: "POST", body: form }
    );
  } catch {
    const err = new Error(
      "Could not reach the image host. Check the server's network connection and try again."
    );
    err.status = 502;
    throw err;
  }

  const json = await response.json().catch(() => null);
  const url = json?.data?.display_url || json?.data?.url;
  if (!response.ok || !json?.success || !url || !/^https:\/\//i.test(url)) {
    // Surface the image host's own reason (never the API key) so the
    // technician sees why the upload was rejected instead of a blank error.
    const reason = json?.error?.message;
    const err = new Error(
      reason
        ? `Image upload failed: ${reason}`
        : "Image upload failed. Please try a different image."
    );
    err.status = 502;
    throw err;
  }
  return url;
}

function toService(doc) {
  return {
    id: String(doc._id),
    title: doc.title,
    category: doc.category,
    categorySlug: doc.categorySlug,
    serviceMode: doc.serviceMode,
    price: doc.price,
    duration: doc.duration,
    description: doc.description,
    image: doc.image || "",
    technicianId: doc.technicianId,
    technicianName: doc.technicianName || "",
    approvalStatus: doc.approvalStatus,
    isAvailable: doc.isAvailable !== false,
    rating: doc.rating ?? 0,
    reviewCount: doc.reviewCount ?? 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function isValidId(id) {
  return ObjectId.isValid(id);
}

export function createServicesRouter({ db, auth }) {
  const router = Router();
  const services = db.collection("services");

  // GET /services — public callers only ever see approved + available listings.
  router.get("/services", async (req, res) => {
    try {
      const user = await getSessionUser(req, auth, db);
      const {
        approvalStatus,
        isAvailable,
        category,
        serviceMode,
        q,
        technicianId,
        limit,
        sort,
        order,
      } = req.query;

      const filter = {};
      const wantsOwn =
        technicianId &&
        user &&
        (technicianId === "me" || technicianId === user.id);
      const isAdmin = user?.role === "admin";

      if (wantsOwn) {
        filter.technicianId = user.id;
        if (approvalStatus) filter.approvalStatus = String(approvalStatus);
        if (isAvailable !== undefined && isAvailable !== "") {
          filter.isAvailable = isAvailable === "true";
        }
      } else if (isAdmin) {
        // Admins may browse the full catalogue with explicit filters.
        if (approvalStatus) filter.approvalStatus = String(approvalStatus);
        if (technicianId) filter.technicianId = String(technicianId);
        if (isAvailable !== undefined && isAvailable !== "") {
          filter.isAvailable = isAvailable === "true";
        }
      } else {
        // Public visibility rule: only approved + available services.
        filter.approvalStatus = "approved";
        filter.isAvailable = true;
      }

      // Challenge 1: every search/filter clause is combined with $and and
      // evaluated inside MongoDB — never post-filtered in application code.
      const andClauses = [];
      if (category) {
        andClauses.push({
          $or: [
            { categorySlug: String(category) },
            { category: String(category) },
          ],
        });
      }
      if (serviceMode) {
        andClauses.push({ serviceMode: String(serviceMode) });
      }
      if (q) {
        const regex = { $regex: String(q), $options: "i" };
        andClauses.push({
          $or: [
            { title: regex },
            { category: regex },
            { categorySlug: regex },
            { description: regex },
          ],
        });
      }
      if (andClauses.length > 0) filter.$and = andClauses;

      const sortField =
        sort === "price" ? "price" : sort === "title" ? "title" : "createdAt";
      const sortDir = order === "asc" ? 1 : -1;
      const max = Math.min(Number(limit) || 6, 100);

      const docs = await services
        .find(filter)
        .sort({ [sortField]: sortDir })
        .limit(max)
        .toArray();

      res.json({ services: docs.map(toService) });
    } catch (error) {
      console.error("GET /services failed:", error);
      res.status(500).json({ error: "Failed to load services." });
    }
  });

  // GET /services/:id
  router.get("/services/:id", async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) {
        return res.status(404).json({ error: "Service not found." });
      }

      const doc = await services.findOne({ _id: new ObjectId(id) });
      if (!doc) {
        return res.status(404).json({ error: "Service not found." });
      }

      const user = await getSessionUser(req, auth, db);
      const isOwner = user && doc.technicianId === user.id;
      const isAdmin = user?.role === "admin";
      const publiclyVisible = doc.approvalStatus === "approved" && doc.isAvailable !== false;

      if (!publiclyVisible && !isOwner && !isAdmin) {
        return res.status(404).json({ error: "Service not found." });
      }

      res.json({ service: toService(doc) });
    } catch (error) {
      console.error("GET /services/:id failed:", error);
      res.status(500).json({ error: "Failed to load the service." });
    }
  });

  // POST /services — technician submits a new listing (starts pending).
  router.post("/services", verifyToken, verifyTechnician, async (req, res) => {
    try {
      const user = req.user;

      const {
        title,
        category,
        serviceMode,
        price,
        duration,
        description,
        imageBase64,
      } = req.body || {};

      if (!title || !category || !serviceMode || price === undefined || !description) {
        return res.status(400).json({
          error:
            "Title, category, service mode, price and description are required.",
        });
      }

      const numericPrice = Number(price);
      if (!Number.isFinite(numericPrice) || numericPrice < 0) {
        return res.status(400).json({ error: "Price must be a valid amount." });
      }

      let imageUrl = "";
      if (imageBase64) {
        imageUrl = await uploadToImgBB(imageBase64);
      }

      const categorySlug = String(category);
      const now = new Date();
      const doc = {
        title: String(title).trim(),
        category: CATEGORY_NAMES[categorySlug] ?? categorySlug,
        categorySlug,
        serviceMode: String(serviceMode),
        price: numericPrice,
        duration: duration ? String(duration) : "",
        description: String(description).trim(),
        image: imageUrl,
        technicianId: user.id,
        technicianName: user.name || "",
        approvalStatus: "pending",
        isAvailable: true,
        rating: 0,
        reviewCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      const result = await services.insertOne(doc);
      res.status(201).json({ service: toService({ ...doc, _id: result.insertedId }) });
    } catch (error) {
      console.error("POST /services failed:", error);
      res
        .status(error.status || 500)
        .json({ error: error.message || "Failed to create the service." });
    }
  });

  // PUT /services/:id — owner edit; approval resets to pending.
  router.put("/services/:id", verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) {
        return res.status(404).json({ error: "Service not found." });
      }

      const user = req.user;

      const doc = await services.findOne({ _id: new ObjectId(id) });
      if (!doc) return res.status(404).json({ error: "Service not found." });
      if (doc.technicianId !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "You can only edit your own services." });
      }

      const { title, category, serviceMode, price, duration, description, imageBase64 } =
        req.body || {};

      const updates = { updatedAt: new Date() };
      if (title !== undefined) updates.title = String(title).trim();
      if (category !== undefined) {
        const slug = String(category);
        updates.categorySlug = slug;
        updates.category = CATEGORY_NAMES[slug] ?? slug;
      }
      if (serviceMode !== undefined) updates.serviceMode = String(serviceMode);
      if (price !== undefined) {
        const numericPrice = Number(price);
        if (!Number.isFinite(numericPrice) || numericPrice < 0) {
          return res.status(400).json({ error: "Price must be a valid amount." });
        }
        updates.price = numericPrice;
      }
      if (duration !== undefined) updates.duration = String(duration);
      if (description !== undefined) updates.description = String(description).trim();
      if (imageBase64) updates.image = await uploadToImgBB(imageBase64);

      // Assignment rule: any edit resets approval to pending.
      updates.approvalStatus = "pending";

      await services.updateOne({ _id: new ObjectId(id) }, { $set: updates });
      const updated = await services.findOne({ _id: new ObjectId(id) });
      res.json({ service: toService(updated) });
    } catch (error) {
      console.error("PUT /services/:id failed:", error);
      res
        .status(error.status || 500)
        .json({ error: error.message || "Failed to update the service." });
    }
  });

  // PATCH /services/:id — approval decisions / availability toggles.
  router.patch("/services/:id", verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) {
        return res.status(404).json({ error: "Service not found." });
      }

      const user = req.user;

      const doc = await services.findOne({ _id: new ObjectId(id) });
      if (!doc) return res.status(404).json({ error: "Service not found." });

      const { approvalStatus, isAvailable } = req.body || {};
      const updates = { updatedAt: new Date() };

      if (approvalStatus !== undefined) {
        const allowed = ["pending", "approved", "rejected", "suspended"];
        if (!allowed.includes(approvalStatus)) {
          return res.status(400).json({ error: "Invalid approval status." });
        }
        // Approval decisions are an admin action; ownership edits are not.
        if (user.role !== "admin") {
          return res.status(403).json({ error: "Only admins can change approval status." });
        }
        updates.approvalStatus = approvalStatus;
        if (approvalStatus === "approved") updates.isAvailable = true;
      }

      if (isAvailable !== undefined) {
        const isOwner = doc.technicianId === user.id;
        if (!isOwner && user.role !== "admin") {
          return res.status(403).json({ error: "Not allowed." });
        }
        updates.isAvailable = Boolean(isAvailable);
      }

      if (Object.keys(updates).length === 1) {
        return res.status(400).json({ error: "Nothing to update." });
      }

      await services.updateOne({ _id: new ObjectId(id) }, { $set: updates });
      const updated = await services.findOne({ _id: new ObjectId(id) });
      res.json({ service: toService(updated) });
    } catch (error) {
      console.error("PATCH /services/:id failed:", error);
      res.status(500).json({ error: "Failed to update the service." });
    }
  });

  // DELETE /services/:id — owner or admin removes a listing.
  router.delete("/services/:id", verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) {
        return res.status(404).json({ error: "Service not found." });
      }

      const user = req.user;

      const doc = await services.findOne({ _id: new ObjectId(id) });
      if (!doc) return res.status(404).json({ error: "Service not found." });
      if (doc.technicianId !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "You can only delete your own services." });
      }

      await services.deleteOne({ _id: new ObjectId(id) });
      res.json({ ok: true });
    } catch (error) {
      console.error("DELETE /services/:id failed:", error);
      res.status(500).json({ error: "Failed to delete the service." });
    }
  });

  return router;
}
