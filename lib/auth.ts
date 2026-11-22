
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { ObjectId, type MongoClient } from "mongodb";

/**
 * Origins the browser app is served from. Better Auth rejects any
 * state-changing request whose `Origin` header is not in this list
 * (CSRF protection), so the Next.js origin must be listed explicitly —
 * `BETTER_AUTH_URL` only describes the backend itself.
 * Reuses the same `FRONTEND_URL` the Stripe return URLs already use.
 * Additional origins can still be added with `BETTER_AUTH_TRUSTED_ORIGINS`.
 */
function frontendOrigin(): string {
  return (process.env.FRONTEND_URL || "http://localhost:3000").replace(
    /\/+$/,
    ""
  );
}

export function createAuth(client: MongoClient) {
  const db = client.db("fixmate");

  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    socialProviders.github = {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    };
  }

  return betterAuth({
    database: mongodbAdapter(db, { client }),

    trustedOrigins: [frontendOrigin()],

    emailAndPassword: {
      enabled: true,
    },

    ...(Object.keys(socialProviders).length > 0 ? { socialProviders } : {}),

    user: {
      modelName: "users",
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "customer",
        },
        phone: {
          type: "string",
          required: false,
        },
        area: {
          type: "string",
          required: false,
        },
        bio: {
          type: "string",
          required: false,
        },
        address: {
          type: "string",
          required: false,
        },
      },
    },

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const role =
              user.role === "technician" ? "technician" : "customer";

            return {
              data: {
                ...user,
                role,
              },
            };
          },
        },
      },
      session: {
        create: {
          // Admin suspension must actually block access: refuse to issue a
          // session for a suspended account (sign-in / sign-up).
          before: async (session) => {
            if (!session.userId || !ObjectId.isValid(session.userId)) return;
            const doc = await db
              .collection("users")
              .findOne(
                { _id: new ObjectId(session.userId) },
                { projection: { suspended: 1 } }
              );
            if (doc?.suspended) {
              throw new APIError("FORBIDDEN", {
                message: "This account has been suspended.",
              });
            }
          },
        },
      },
    },
  });
}
