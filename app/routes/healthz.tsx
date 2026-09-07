import { json } from "@remix-run/node";

/**
 * Liveness probe for CI and the platform. Deliberately does not touch the
 * database: this answers "is the server up", not "is everything healthy",
 * so a DB blip cannot take the whole app out of rotation.
 */
export const loader = async () =>
  json(
    { status: "ok", service: "mannon", time: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
