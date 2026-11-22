import { Router } from "express";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { getSessionUser } from "../lib/session.js";

const TOKEN_TTL = "1h";
const TOKEN_TTL_SECONDS = 3600;

/**
 * POST /auth/token — exchanges a live Better Auth session for the short-lived
 * JWT the REST APIs require in `Authorization: Bearer <token>`.
 *
 * Better Auth keeps owning signup/signin/signout/sessions; this endpoint only
 * mints a derived API credential. The role and user id are read from
 * MongoDB here, never from the request body, and suspended accounts are
 * refused so they cannot mint a fresh token.
 */
export function createTokenRouter({ db, auth }) {
  const router = Router();
  const users = db.collection("users");

  router.post("/auth/token", async (req, res) => {
    try {
      const sessionUser = await getSessionUser(req, auth, db);
      if (!sessionUser) {
        return res.status(401).json({ error: "Authentication required." });
      }
      if (sessionUser.suspended) {
        return res.status(403).json({ error: "This account has been suspended." });
      }

      const secret = process.env.JWT_SECRET;
      if (!secret) {
        return res.status(503).json({
          error: "JWT is not configured (JWT_SECRET is missing on the server).",
        });
      }

      const doc = await users.findOne(
        { _id: new ObjectId(sessionUser.id) },
        { projection: { role: 1, name: 1, email: 1, suspended: 1 } }
      );
      if (!doc) {
        return res.status(401).json({ error: "Authentication required." });
      }
      if (doc.suspended) {
        return res.status(403).json({ error: "This account has been suspended." });
      }

      const payload = {
        sub: String(sessionUser.id),
        role: doc.role || "customer",
        name: doc.name || "",
        email: doc.email || "",
      };

      const token = jwt.sign(payload, secret, { expiresIn: TOKEN_TTL });

      res.json({
        token,
        expiresIn: TOKEN_TTL_SECONDS,
        user: {
          id: payload.sub,
          role: payload.role,
          name: payload.name,
          email: payload.email,
        },
      });
    } catch (error) {
      console.error("POST /auth/token failed:", error);
      res.status(500).json({ error: "Could not issue an access token." });
    }
  });

  return router;
}
