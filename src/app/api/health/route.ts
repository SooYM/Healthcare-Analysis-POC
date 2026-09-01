/**
 * @file route.ts
 * @module app/api/health/route
 * @description Liveness and health check endpoint for monitoring and container orchestration.
 *
 * @example
 * ```bash
 * curl -X GET http://localhost:3000/api/health
 * # Returns: {"ok": true, "service": "healthcare-dashboard"}
 * ```
 */

import { NextResponse } from "next/server";

/**
 * Handles HTTP GET requests to verify service health status.
 *
 * @returns JSON response with `{ ok: true, service: "healthcare-dashboard" }`
 */
export function GET() {
  return NextResponse.json({ ok: true, service: "healthcare-dashboard" });
}
