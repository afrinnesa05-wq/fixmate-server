
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({
      message: "Unauthorized access",
    });
  }

  const token = authHeader.split(" ")[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).send({
      message: "Invalid or expired token",
    });
  }

  if (!decoded || !decoded.sub) {
    return res.status(401).send({
      message: "Invalid or expired token",
    });
  }

  req.user = decoded;
  // Handlers address the account as `user.id` (Better Auth stores it in `sub`).
  req.user.id = decoded.sub;

  // A JWT stays usable until it expires, so an account suspended after the
  // token was issued must still be refused on every protected request.
  const db = req.app.locals.db;
  if (!db) {
    return res.status(500).send({
      message: "Server is not connected to the database.",
    });
  }

  let userId;
  try {
    userId = new ObjectId(req.user.id);
  } catch {
    return res.status(401).send({
      message: "Invalid or expired token",
    });
  }

  db.collection("users")
    .findOne({ _id: userId }, { projection: { suspended: 1 } })
    .then((doc) => {
      if (doc?.suspended) {
        return res.status(403).send({
          message: "Forbidden: account suspended",
        });
      }
      next();
    })
    .catch(() => {
      res.status(500).send({
        message: "Authentication check failed.",
      });
    });
};

export default verifyToken;
