import { ObjectId } from "mongodb";

// Reads the Better Auth session from an Express request (identity only —
// no JWT / role middleware is introduced here on purpose).
// `db` lets the session be rejected for accounts an admin has suspended.
export async function getSessionUser(req, auth, db) {
  try {
    const result = await auth.api.getSession({ headers: req.headers });
    const user = result?.user ?? null;
    if (!user || !db) return user;

    const doc = await db
      .collection("users")
      .findOne({ _id: new ObjectId(user.id) }, { projection: { suspended: 1 } });
    if (doc?.suspended) return { ...user, suspended: true };
    return user;
  } catch {
    return null;
  }
}

export function requireAuth(res, user) {
  if (!user) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }
  if (user.suspended) {
    res.status(403).json({ error: "This account has been suspended." });
    return false;
  }
  return true;
}
