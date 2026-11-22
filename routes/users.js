import { Router } from "express";
import { ObjectId } from "mongodb";
import verifyToken from "../middleware/verifyToken.js";
import verifyAdmin from "../middleware/verifyAdmin.js";

function toAdminUser(doc) {
  return {
    id: String(doc._id),
    name: doc.name || "",
    email: doc.email || "",
    role: doc.role || "customer",
    joined: doc.createdAt
      ? new Date(doc.createdAt).toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })
      : "",
    status: doc.suspended ? "suspended" : doc.emailVerified ? "active" : "pending",
  };
}

export function createUsersRouter({ db, auth }) {
  const router = Router();
  const users = db.collection("users");

  // GET /users/me — profile for the signed-in user.
  router.get("/users/me", verifyToken, async (req, res) => {
    try {
      const user = req.user;

      const doc = await users.findOne({ _id: new ObjectId(user.id) });
      if (!doc) {
        return res.status(401).json({ error: "Authentication required." });
      }
      // The profile is served from MongoDB so a token issued before a profile
      // update never returns stale name/contact data.
      res.json({
        user: {
          id: user.id,
          name: doc.name || "",
          email: doc.email || "",
          role: doc.role || "customer",
          phone: doc.phone ?? "",
          area: doc.area ?? "",
          address: doc.address ?? "",
          bio: doc.bio ?? "",
          image: doc.image ?? "",
          emailVerified: Boolean(doc.emailVerified),
        },
      });
    } catch (error) {
      console.error("GET /users/me failed:", error);
      res.status(500).json({ error: "Failed to load the profile." });
    }
  });

  // PATCH /users/me — profile update.
  router.patch("/users/me", verifyToken, async (req, res) => {
    try {
      const user = req.user;

      const { name, phone, area, address, bio, image } = req.body || {};
      const updates = {};
      if (name !== undefined) updates.name = String(name).trim();
      if (phone !== undefined) updates.phone = String(phone);
      if (area !== undefined) updates.area = String(area);
      if (address !== undefined) updates.address = String(address);
      if (bio !== undefined) updates.bio = String(bio);
      if (image !== undefined) updates.image = String(image);

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "Nothing to update." });
      }

      await users.updateOne({ _id: new ObjectId(user.id) }, { $set: updates });

      const updated = await users.findOne({ _id: new ObjectId(user.id) });
      res.json({
        user: {
          id: user.id,
          name: updated.name || "",
          email: updated.email || "",
          role: updated.role || "customer",
          phone: updated.phone ?? "",
          area: updated.area ?? "",
          address: updated.address ?? "",
          bio: updated.bio ?? "",
          image: updated.image ?? "",
          emailVerified: Boolean(updated.emailVerified),
        },
      });
    } catch (error) {
      console.error("PATCH /users/me failed:", error);
      res.status(500).json({ error: "Failed to update the profile." });
    }
  });

  // GET /users — admin user management list.
  router.get("/users", verifyToken, verifyAdmin, async (req, res) => {
    try {
      const user = req.user;
      if (user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required." });
      }

      const docs = await users
        .find({})
        .sort({ createdAt: -1 })
        .limit(200)
        .toArray();

      res.json({ users: docs.map(toAdminUser) });
    } catch (error) {
      console.error("GET /users failed:", error);
      res.status(500).json({ error: "Failed to load users." });
    }
  });

  // PATCH /users/:id — admin updates a user's suspended flag and/or role.
  router.patch("/users/:id", verifyToken, verifyAdmin, async (req, res) => {
    try {
      const user = req.user;
      if (user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required." });
      }

      const { suspended, role } = req.body || {};
      const updates = {};

      if (suspended !== undefined) {
        if (typeof suspended !== "boolean") {
          return res.status(400).json({ error: "suspended must be a boolean." });
        }
        updates.suspended = suspended;
      }

      if (role !== undefined) {
        if (!["customer", "technician", "admin"].includes(role)) {
          return res
            .status(400)
            .json({ error: "role must be customer, technician or admin." });
        }
        // Never let an admin demote their own account out of the role.
        if (String(req.params.id) === user.id && role !== "admin") {
          return res
            .status(400)
            .json({ error: "You cannot change your own role." });
        }
        updates.role = role;
      }

      if (Object.keys(updates).length === 0) {
        return res
          .status(400)
          .json({ error: "Provide suspended and/or role." });
      }

      if (!ObjectId.isValid(req.params.id)) {
        return res.status(404).json({ error: "User not found." });
      }

      const result = await users.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: updates }
      );
      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "User not found." });
      }

      const updated = await users.findOne({ _id: new ObjectId(req.params.id) });
      res.json({ user: toAdminUser(updated) });
    } catch (error) {
      console.error("PATCH /users/:id failed:", error);
      res.status(500).json({ error: "Failed to update the user." });
    }
  });

  return router;
}
