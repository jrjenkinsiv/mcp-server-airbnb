#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { cleanObject, flattenArraysInObject, pickBySchema, diagnoseJsonPath } from "./util.js";
import { AirbnbBrowserError, manageWishlist, runTripPlanner } from "./browser.js";
import robotsParser from "robots-parser";
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
    return process.env.MCP_SERVER_VERSION || packageJson.version || "unknown";
  } catch (error) {
    return process.env.MCP_SERVER_VERSION || "unknown";
  }
}

const VERSION = getVersion();

// Tool definitions
const AIRBNB_SEARCH_TOOL: Tool = {
  name: "airbnb_search",
  annotations: { title: "Search Airbnb", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Search for Airbnb listings with various filters and pagination. Provide direct links to the user",
  inputSchema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "Location to search for (city, state, etc.)"
      },
      placeId: {
        type: "string",
        description: "Google Maps Place ID (overrides the location parameter)"
      },
      checkin: {
        type: "string",
        description: "Check-in date (YYYY-MM-DD)"
      },
      checkout: {
        type: "string",
        description: "Check-out date (YYYY-MM-DD)"
      },
      adults: {
        type: "number",
        description: "Number of adults"
      },
      children: {
        type: "number",
        description: "Number of children"
      },
      infants: {
        type: "number",
        description: "Number of infants"
      },
      pets: {
        type: "number",
        description: "Number of pets"
      },
      minPrice: {
        type: "number",
        description: "Minimum price for the stay"
      },
      maxPrice: {
        type: "number",
        description: "Maximum price for the stay"
      },
      cursor: {
        type: "string",
        description: "Base64-encoded string used for Pagination"
      },
      propertyType: {
        type: "string",
        enum: ["entire_home", "private_room", "shared_room", "hotel_room"],
        description: "Filter by property type: 'entire_home' (entire homes/apartments), 'private_room' (private rooms in shared homes), 'shared_room' (shared/dorm-style rooms), 'hotel_room' (hotel rooms)"
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Bypass Airbnb robots.txt for this request. Disabled by default."
      },
    },
    required: ["location"]
  }
};

const AIRBNB_LISTING_DETAILS_TOOL: Tool = {
  name: "airbnb_listing_details",
  annotations: { title: "Get Airbnb listing details", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Get detailed information about a specific Airbnb listing. Provide direct links to the user",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The Airbnb listing ID"
      },
      checkin: {
        type: "string",
        description: "Check-in date (YYYY-MM-DD)"
      },
      checkout: {
        type: "string",
        description: "Check-out date (YYYY-MM-DD)"
      },
      adults: {
        type: "number",
        description: "Number of adults"
      },
      children: {
        type: "number",
        description: "Number of children"
      },
      infants: {
        type: "number",
        description: "Number of infants"
      },
      pets: {
        type: "number",
        description: "Number of pets"
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Bypass Airbnb robots.txt for this request. Disabled by default."
      },
    },
    required: ["id"]
  }
};

const AIRBNB_TRIP_SEARCH_TOOL: Tool = {
  name: "airbnb_trip_search",
  description: "Plan and rank Airbnb stays in one call from a destination, a saved wishlist, or a list of explicit listing URLs. Discovers or accepts candidates, checks exact dates and guests, reads best-available pre-submit pricing through the dedicated browser profile, and returns normalized quote confidence. Read-only; never reserves or enters checkout.",
  annotations: { title: "Plan Airbnb stay", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      wishlistUrl: { type: "string", pattern: "^https://(www\\.)?airbnb\\.com/wishlists/[0-9]+/?$", description: "Full Airbnb wishlist URL" },
      location: { type: "string", maxLength: 200, description: "Destination to search when wishlistUrl and listingUrls are not supplied" },
      listingUrls: {
        type: "array",
        minItems: 1,
        maxItems: 25,
        items: { type: "string", pattern: "^https://(www\\.)?airbnb\\.com/rooms/[0-9]+/?$" },
        description: "1-25 explicit Airbnb room-listing URLs to quote directly, instead of location or wishlistUrl"
      },
      checkin: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", description: "Check-in date in YYYY-MM-DD format" },
      checkout: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", description: "Checkout date in YYYY-MM-DD format" },
      adults: { type: "number", minimum: 1, maximum: 50, description: "Number of adults" },
      children: { type: "number", minimum: 0, maximum: 50, description: "Number of children; defaults to 0" },
      infants: { type: "number", minimum: 0, maximum: 50, description: "Number of infants; defaults to 0" },
      pets: { type: "number", minimum: 0, maximum: 50, description: "Number of pets; defaults to 0" },
      budgetTotal: { type: "number", minimum: 0, description: "Optional maximum total-stay budget used for ranking" },
      maxCandidates: { type: "number", minimum: 1, maximum: 25, description: "Maximum candidates to quote; defaults to 10" },
      propertyType: { type: "string", enum: ["entire_home", "private_room", "shared_room", "hotel_room"], description: "Property type for destination discovery; defaults to any" }
    },
    required: ["checkin", "checkout", "adults"],
    oneOf: [
      {
        required: ["location"],
        not: { anyOf: [{ required: ["wishlistUrl"] }, { required: ["listingUrls"] }] }
      },
      {
        required: ["wishlistUrl"],
        not: { anyOf: [{ required: ["location"] }, { required: ["listingUrls"] }] }
      },
      {
        required: ["listingUrls"],
        not: { anyOf: [{ required: ["location"] }, { required: ["wishlistUrl"] }] }
      }
    ]
  }
};

const AIRBNB_WISHLIST_MANAGE_TOOL: Tool = {
  name: "airbnb_wishlist_manage",
  description: "Manage Airbnb wishlists through the signed-in dedicated browser profile. List wishlists, create a wishlist seeded with one listing, or explicitly add/remove one listing from one wishlist. Never books or enters checkout.",
  annotations: { title: "Manage Airbnb wishlists", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "create", "add", "remove"], description: "Wishlist operation; defaults to list" },
      wishlistUrl: { type: "string", pattern: "^https://(www\\.)?airbnb\\.com/wishlists/[0-9]+/?$", description: "Exact target wishlist URL for add/remove" },
      wishlistName: { type: "string", minLength: 1, maxLength: 80, description: "New name for create, or exact existing name for add/remove" },
      listingUrl: { type: "string", pattern: "^https://(www\\.)?airbnb\\.com/rooms/[0-9]+/?$", description: "Exact listing URL for create, or a single add/remove" },
      listingUrls: { type: "array", minItems: 1, maxItems: 25, items: { type: "string", pattern: "^https://(www\\.)?airbnb\\.com/rooms/[0-9]+/?$" }, description: "Explicit listing URLs for a batched add/remove" }
    }
  }
};

const AIRBNB_TOOLS = [
  AIRBNB_SEARCH_TOOL,
  AIRBNB_LISTING_DETAILS_TOOL,
  AIRBNB_TRIP_SEARCH_TOOL,
  AIRBNB_WISHLIST_MANAGE_TOOL,
] as const;

// Utility functions
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BASE_URL = "https://www.airbnb.com";
const configuredMaxResponseBytes = Number.parseInt(process.env.MAX_RESPONSE_BYTES || "2000000", 10);
const MAX_RESPONSE_BYTES = Number.isSafeInteger(configuredMaxResponseBytes) && configuredMaxResponseBytes > 0
  ? configuredMaxResponseBytes
  : 2000000;

type RobotsPolicyStatus = "uninitialized" | "available" | "unavailable";
let robotsPolicyStatus: RobotsPolicyStatus = "uninitialized";

function requireNonEmptyString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new McpError(ErrorCode.InvalidParams, `${field} must be a non-empty string up to ${maxLength} characters`);
  }
  return value.trim();
}

function parseNonNegativeInteger(value: unknown, field: string, fallback: number): number {
  if (value == null) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 50) {
    throw new McpError(ErrorCode.InvalidParams, `${field} must be an integer from 0 to 50`);
  }
  return parsed;
}

function requireIsoDate(value: unknown, field: string): string {
  const date = requireNonEmptyString(value, field, 10);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new McpError(ErrorCode.InvalidParams, `${field} must be a valid YYYY-MM-DD date`);
  }
  return date;
}

// Restricts explicit-listing quote-mode input to HTTPS Airbnb room-listing
// URLs before any browser invocation. Runs independently of the descriptive
// JSON-schema `pattern` above (nothing in this server enforces schema-level
// validation against the wire arguments), so this is the actual enforcement
// point for allowlist/redirect/adversarial rejection.
const AIRBNB_ROOM_HOSTS = new Set(["airbnb.com", "www.airbnb.com"]);
const AIRBNB_ROOM_PATH_PATTERN = /^\/rooms\/[0-9]+\/?$/;

function normalizeAirbnbRoomUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `listingUrls entries must be valid URLs: ${raw}`);
  }
  if (parsed.protocol !== "https:") {
    throw new McpError(ErrorCode.InvalidParams, `listingUrls entries must use https:// : ${raw}`);
  }
  if (parsed.username || parsed.password) {
    throw new McpError(ErrorCode.InvalidParams, `listingUrls entries must not include userinfo: ${raw}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!AIRBNB_ROOM_HOSTS.has(hostname)) {
    throw new McpError(ErrorCode.InvalidParams, `listingUrls entries must be airbnb.com room listings: ${raw}`);
  }
  if (!AIRBNB_ROOM_PATH_PATTERN.test(parsed.pathname)) {
    throw new McpError(ErrorCode.InvalidParams, `listingUrls entries must point at /rooms/<id>: ${raw}`);
  }
  // Normalize away query strings/fragments (open-redirect-shaped params) and
  // trailing slashes; only the scheme, canonical host, and room path survive.
  const roomId = parsed.pathname.replace(/\/$/, "").split("/").pop();
  return `https://${hostname}/rooms/${roomId}`;
}

function normalizeListingUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new McpError(ErrorCode.InvalidParams, "listingUrls must be an array of Airbnb room URLs");
  }
  if (raw.length < 1 || raw.length > 25) {
    throw new McpError(ErrorCode.InvalidParams, "listingUrls must contain 1 to 25 entries");
  }
  return raw.map((entry) => normalizeAirbnbRoomUrl(requireNonEmptyString(entry, "listingUrls[]", 500)));
}

// Geocode location using Photon (fast, no rate limits) with Nominatim fallback.
// This bypasses Airbnb's broken server-side geocoding for non-US locations.
// Photon doesn't rank by importance, so we fetch multiple results and prefer
// cities/states/countries over hamlets/houses/POIs.
const PHOTON_TYPE_PRIORITY: Record<string, number> = {
  country: 1, state: 2, county: 3, city: 4, district: 5,
  locality: 6, street: 7, house: 8, other: 9,
};
const GEOCODE_CACHE_TTL_MS = 15 * 60 * 1000;
const geocodeCache = new Map<string, {
  expiresAt: number;
  value: { ne_lat: string; ne_lng: string; sw_lat: string; sw_lng: string; displayName: string };
}>();

function pickBestPhotonFeature(features: any[]): any | null {
  // Pick the feature with the highest-priority type (city > hamlet > house etc).
  // Don't filter by extent here — the best match (e.g. Stockholm, Sweden) may
  // lack an extent, and we'll fall back to Nominatim for the bbox.
  if (!features || features.length === 0) return null;

  return features.reduce((best: any, f: any) => {
    const bestPri = PHOTON_TYPE_PRIORITY[best.properties?.type] ?? PHOTON_TYPE_PRIORITY.other;
    const fPri = PHOTON_TYPE_PRIORITY[f.properties?.type] ?? PHOTON_TYPE_PRIORITY.other;
    return fPri < bestPri ? f : best;
  });
}

async function geocodeLocation(location: string): Promise<{
  ne_lat: string; ne_lng: string; sw_lat: string; sw_lng: string;
  displayName: string;
} | null> {
  const cacheKey = location.toLocaleLowerCase("en-US");
  const cached = geocodeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    log('info', 'Using cached geocode result');
    return cached.value;
  }
  let extent: number[] | null = null;
  let displayName = location;

  // Try Photon first — fast, no strict rate limits, OSM data.
  try {
    log('info', 'Geocoding location via Photon');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(location)}&limit=5`;
    let response;
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": `mcp-server-airbnb/${VERSION} (+https://github.com/openbnb-org/mcp-server-airbnb)`,
          "Accept": "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.ok) {
      const data = await response.json() as any;
      const feature = pickBestPhotonFeature(data?.features ?? []);
      if (feature) {
        if (feature.properties?.extent?.length === 4) {
          extent = feature.properties.extent; // [west_lng, north_lat, east_lng, south_lat]
        }
        displayName = feature.properties?.name || location;
        log('info', 'Photon selected feature', { hasExtent: !!extent });
      }
    }
  } catch (error) {
    log('warn', 'Photon geocoding failed');
  }

  // Fall back to Nominatim if Photon didn't return a bbox.
  // Nominatim ranks by importance so it handles ambiguous names well.
  // Nominatim usage policy requires an identifying User-Agent (not a browser UA).
  // See https://operations.osmfoundation.org/policies/nominatim/
  if (!extent) {
    try {
      log('info', 'Falling back to Nominatim for geocoding');
      const nomController = new AbortController();
      const nomTimeout = setTimeout(() => nomController.abort(), 5000);
      const nomUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
      let nomResponse;
      try {
        nomResponse = await fetch(nomUrl, {
          headers: {
            "User-Agent": `mcp-server-airbnb/${VERSION} (+https://github.com/openbnb-org/mcp-server-airbnb)`,
            "Accept": "application/json",
          },
          signal: nomController.signal,
        });
      } finally {
        clearTimeout(nomTimeout);
      }
      if (nomResponse.ok) {
        const nomResults = await nomResponse.json() as any[];
        if (nomResults?.[0]?.boundingbox?.length === 4) {
          const bb = nomResults[0].boundingbox; // [south_lat, north_lat, west_lng, east_lng]
          extent = [parseFloat(bb[2]), parseFloat(bb[1]), parseFloat(bb[3]), parseFloat(bb[0])];
          displayName = nomResults[0].display_name?.split(",")?.[0] || location;
          log('info', 'Nominatim fallback succeeded');
        }
      }
    } catch (nomError) {
      log('warn', 'Nominatim fallback also failed');
    }
  }

  if (!extent || extent.length !== 4) {
    log('warn', 'No bounding box from either geocoder');
    return null;
  }

  // Expand bounding box by 25% in each direction (minimum 0.1°, ~11km)
  // to capture suburbs, beaches, and surrounding areas. OSM returns tight
  // administrative boundaries (e.g., Paris = just the arrondissements,
  // Pensacola = city limits without the beach on the barrier island).
  const swLat = extent[3];
  const neLat = extent[1];
  const swLng = extent[0];
  const neLng = extent[2];
  const latPadding = Math.max((neLat - swLat) * 0.25, 0.1);
  const lngPadding = Math.max((neLng - swLng) * 0.25, 0.1);

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

  const coords = {
    sw_lat: clamp(swLat - latPadding, -90, 90).toFixed(7),
    ne_lat: clamp(neLat + latPadding, -90, 90).toFixed(7),
    sw_lng: clamp(swLng - lngPadding, -180, 180).toFixed(7),
    ne_lng: clamp(neLng + lngPadding, -180, 180).toFixed(7),
    displayName,
  };

  geocodeCache.set(cacheKey, { expiresAt: Date.now() + GEOCODE_CACHE_TTL_MS, value: coords });
  log('info', 'Geocoded successfully (with 25% padding)');
  return coords;
}

const PROPERTY_TYPE_IDS: Record<string, string> = {
  entire_home:  "1",
  private_room: "2",
  shared_room:  "3",
  hotel_room:   "4",
};

// When true, skip the Photon/Nominatim geocoding step and let Airbnb's own
// server-side geocoder handle the location string. Defaults to false so the
// fix for non-US locations stays on by default; users who want zero third-party
// outbound calls can opt out by setting DISABLE_GEOCODING=true.
const DISABLE_GEOCODING = process.env.DISABLE_GEOCODING === "true";
const IGNORE_ROBOTS_TXT = process.env.IGNORE_ROBOTS_TXT === "true" || process.argv.slice(2).includes("--ignore-robots-txt");

const robotsErrorMessage = "This path is disallowed by Airbnb's robots.txt, or the robots policy is currently unavailable."
let robotsTxtContent = "";

// Enhanced robots.txt fetch with timeout and error handling
async function fetchRobotsTxt() {
  if (IGNORE_ROBOTS_TXT) {
    robotsPolicyStatus = "available";
    log('info', 'Robots policy bypass is enabled');
    return;
  }
  try {
    log('info', 'Fetching robots.txt from Airbnb');
    
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    const response = await fetch(`${BASE_URL}/robots.txt`, {
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    robotsTxtContent = await response.text();
    robotsPolicyStatus = "available";
    log('info', 'Successfully fetched robots.txt');
  } catch (error) {
    robotsPolicyStatus = "unavailable";
    log('warn', 'Error fetching robots.txt; blocking requests until policy is available', {
      error: error instanceof Error ? error.message : String(error)
    });
    robotsTxtContent = "";
  }
}

function isPathAllowed(path: string): boolean {  
  if (IGNORE_ROBOTS_TXT) return true;
  if (robotsPolicyStatus !== "available") {
    log('warn', 'Robots policy is unavailable; blocking request');
    return false;
  }
  if (!robotsTxtContent) {
    return true;
  }

  try {
    const robots = robotsParser(`${BASE_URL}/robots.txt`, robotsTxtContent);
    const allowed = robots.isAllowed(path, USER_AGENT);
    
    if (!allowed) {
      log('warn', 'Path disallowed by robots.txt');
    }
    
    return allowed;
  } catch (error) {
    log('warn', 'Error parsing robots.txt; blocking request');
    return false;
  }
}

async function fetchWithUserAgent(url: string, timeout: number = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const contentLength = Number(response.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} byte limit`);
    }
    
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    
    throw error;
  }
}

// API handlers
async function handleAirbnbSearch(params: any) {
  const {
    location,
    placeId,
    checkin,
    checkout,
    adults = 1,
    children = 0,
    infants = 0,
    pets = 0,
    minPrice,
    maxPrice,
    cursor,
    propertyType,
    ignoreRobotsText = false,
  } = params;
  const normalizedLocation = requireNonEmptyString(location, "location", 200);
  const adults_int = parseNonNegativeInteger(adults, "adults", 1);
  const children_int = parseNonNegativeInteger(children, "children", 0);
  const infants_int = parseNonNegativeInteger(infants, "infants", 0);
  const pets_int = parseNonNegativeInteger(pets, "pets", 0);

  // Build search URL
  // Airbnb path segments use "--" as the separator (e.g. "Paris--France"),
  // not URL-encoded punctuation.  encodeURIComponent turns commas into %2C
  // which confuses Airbnb's geocoder (e.g. Paris → Barneville-Carteret).
  const slug = normalizedLocation
    .replace(/,\s*/g, "--")   // "Paris, France" → "Paris--France"
    .replace(/\s+/g, "-");    // remaining spaces → single dash
  const searchUrl = new URL(`${BASE_URL}/s/${encodeURIComponent(slug)}/homes`);
  
  // Add placeId
  if (placeId) searchUrl.searchParams.append("place_id", placeId);
  
  // Geocode and add bounding box to fix broken server-side geocoding.
  // Skipped when placeId is supplied (Airbnb's place lookup is reliable for those)
  // or when DISABLE_GEOCODING=true (user opt-out from third-party calls).
  if (!placeId && !DISABLE_GEOCODING) {
    const coords = await geocodeLocation(normalizedLocation);
    if (coords) {
      searchUrl.searchParams.append("ne_lat", coords.ne_lat);
      searchUrl.searchParams.append("ne_lng", coords.ne_lng);
      searchUrl.searchParams.append("sw_lat", coords.sw_lat);
      searchUrl.searchParams.append("sw_lng", coords.sw_lng);
    }
  }
  
  // Add query parameters
  if (checkin) searchUrl.searchParams.append("checkin", checkin);
  if (checkout) searchUrl.searchParams.append("checkout", checkout);
  
  // Add guests
  const totalGuests = adults_int + children_int;
  if (totalGuests > 0) {
    searchUrl.searchParams.append("adults", adults_int.toString());
    searchUrl.searchParams.append("children", children_int.toString());
    searchUrl.searchParams.append("infants", infants_int.toString());
    searchUrl.searchParams.append("pets", pets_int.toString());
  }
  
  // Add price range
  if (minPrice != null) searchUrl.searchParams.append("price_min", minPrice.toString());
  if (maxPrice != null) searchUrl.searchParams.append("price_max", maxPrice.toString());
  
  // Add property type filter
  if (propertyType && PROPERTY_TYPE_IDS[propertyType]) {
    searchUrl.searchParams.append("l2_property_type_ids[]", PROPERTY_TYPE_IDS[propertyType]);
  }

  // Add cursor for pagination
  if (cursor) {
    searchUrl.searchParams.append("cursor", cursor);
  }

  // Check if path is allowed by robots.txt
  const path = searchUrl.pathname + searchUrl.search;
  if (!ignoreRobotsText && !isPathAllowed(path)) {
    log('warn', 'Search blocked by robots.txt');
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: robotsErrorMessage,
          url: searchUrl.toString(),
          suggestion: "Enable the explicit robots bypass only when you accept the scraper's operational and policy risk."
        }, null, 2)
      }],
      isError: true
    };
  }

  const allowSearchResultSchema: Record<string, any> = {
    demandStayListing : {
      id: true,
      description: true,
      location: true,
    },
    badges: {
      text: true,
    },
    structuredContent: {
      mapCategoryInfo: {
        body: true
      },
      mapSecondaryLine: {
        body: true
      },
      primaryLine: {
        body: true
      },
      secondaryLine: {
        body: true
      },
    },
    avgRatingA11yLabel: true,
    listingParamOverrides: true,
    structuredDisplayPrice: {
      primaryLine: {
        accessibilityLabel: true,
      },
      secondaryLine: {
        accessibilityLabel: true,
      },
      explanationData: {
        title: true,
        priceDetails: {
          items: {
            description: true,
            priceString: true
          }
        }
      }
    },
    // contextualPictures: {
    //   picture: true
    // }
  };

  try {
    log('info', 'Performing Airbnb search');
    
    const response = await fetchWithUserAgent(searchUrl.toString());
    const html = await response.text();
    const $ = cheerio.load(html);
    
    let staysSearchResults: any = {};
    let scriptContent = '';
    
    try {
      const scriptElement = $("#data-deferred-state-0").first();
      if (scriptElement.length === 0) {
        throw new Error("Could not find data script element - page structure may have changed");
      }
      
      scriptContent = $(scriptElement).text();
      if (!scriptContent) {
        throw new Error("Data script element is empty");
      }
      
      const clientData = JSON.parse(scriptContent);
      const results = clientData.niobeClientData[0][1].data.presentation.staysSearch.results;
      cleanObject(results);
      
      staysSearchResults = {
        searchResults: results.searchResults
          .map((result: any) => flattenArraysInObject(pickBySchema(result, allowSearchResultSchema)))
          .map((result: any) => {
            const id = atob(result.demandStayListing.id).split(":")[1];
            return {id, url: `${BASE_URL}/rooms/${id}`, ...result }
          }),
        paginationInfo: results.paginationInfo
      }
      
      log('info', 'Search completed successfully', { 
        resultCount: staysSearchResults.searchResults?.length || 0 
      });
    } catch (parseError) {
      let parsedRaw: any = null;
      try { parsedRaw = JSON.parse(scriptContent); } catch (_) {}
      const searchPath = ['niobeClientData', '0', '1', 'data', 'presentation', 'staysSearch', 'results'];
      const diagnosis = parsedRaw ? diagnoseJsonPath(parsedRaw, searchPath) : 'Could not parse script content as JSON';

      log('error', 'Failed to parse search results', { diagnosis });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Failed to parse search results from Airbnb. The page structure may have changed.",
            details: parseError instanceof Error ? parseError.message : String(parseError),
            diagnosis,
            searchUrl: searchUrl.toString()
          }, null, 2)
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          searchUrl: searchUrl.toString(),
          ...staysSearchResults
        }, null, 2)
      }],
      isError: false
    };
  } catch (error) {
    log('error', 'Search request failed');
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          searchUrl: searchUrl.toString(),
          timestamp: new Date().toISOString()
        }, null, 2)
      }],
      isError: true
    };
  }
}

async function handleAirbnbListingDetails(params: any) {
  const {
    id,
    checkin,
    checkout,
    adults = 1,
    children = 0,
    infants = 0,
    pets = 0,
    ignoreRobotsText = false,
  } = params;
  const listingId = requireNonEmptyString(id, "id", 24);
  if (!/^\d+$/.test(listingId)) {
    throw new McpError(ErrorCode.InvalidParams, "id must be a numeric Airbnb listing id");
  }
  const adults_int = parseNonNegativeInteger(adults, "adults", 1);
  const children_int = parseNonNegativeInteger(children, "children", 0);
  const infants_int = parseNonNegativeInteger(infants, "infants", 0);
  const pets_int = parseNonNegativeInteger(pets, "pets", 0);

  // Build listing URL
  const listingUrl = new URL(`${BASE_URL}/rooms/${listingId}`);
  
  // Add query parameters
  if (checkin) listingUrl.searchParams.append("check_in", checkin);
  if (checkout) listingUrl.searchParams.append("check_out", checkout);
  
  // Add guests
  const totalGuests = adults_int + children_int;
  if (totalGuests > 0) {
    listingUrl.searchParams.append("adults", adults_int.toString());
    listingUrl.searchParams.append("children", children_int.toString());
    listingUrl.searchParams.append("infants", infants_int.toString());
    listingUrl.searchParams.append("pets", pets_int.toString());
  }

  // Check if path is allowed by robots.txt
  const path = listingUrl.pathname + listingUrl.search;
  if (!ignoreRobotsText && !isPathAllowed(path)) {
    log('warn', 'Listing details blocked by robots.txt');
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: robotsErrorMessage,
          url: listingUrl.toString(),
          suggestion: "Enable the explicit robots bypass only when you accept the scraper's operational and policy risk."
        }, null, 2)
      }],
      isError: true
    };
  }

  const allowSectionSchema: Record<string, any> = {
    "LOCATION_DEFAULT": {
      lat: true,
      lng: true,
      subtitle: true,
      title: true
    },
    "POLICIES_DEFAULT": {
      title: true,
      houseRulesSections: {
        title: true,
        items : {
          title: true
        }
      }
    },
    "HIGHLIGHTS_DEFAULT": {
      highlights: {
        title: true
      }
    },
    "DESCRIPTION_DEFAULT": {
      htmlDescription: {
        htmlText: true
      }
    },
    "AMENITIES_DEFAULT": {
      title: true,
      seeAllAmenitiesGroups: {
        title: true,
        amenities: {
          title: true
        }
      }
    },
    //"AVAILABLITY_CALENDAR_DEFAULT": true,
  };

  try {
    log('info', 'Fetching listing details');
    
    const response = await fetchWithUserAgent(listingUrl.toString());
    const html = await response.text();
    const $ = cheerio.load(html);
    
    let details = {};
    let scriptContent = '';
    
    try {
      const scriptElement = $("#data-deferred-state-0").first();
      if (scriptElement.length === 0) {
        throw new Error("Could not find data script element - page structure may have changed");
      }
      
      scriptContent = $(scriptElement).text();
      if (!scriptContent) {
        throw new Error("Data script element is empty");
      }
      
      const clientData = JSON.parse(scriptContent);
      const sections = clientData.niobeClientData[0][1].data.presentation.stayProductDetailPage.sections.sections;
      sections.forEach((section: any) => cleanObject(section));
      
      details = sections
        .filter((section: any) => allowSectionSchema.hasOwnProperty(section.sectionId))
        .map((section: any) => {
          return {
            id: section.sectionId,
            ...flattenArraysInObject(pickBySchema(section.section, allowSectionSchema[section.sectionId]))
          }
        });
        
      log('info', 'Listing details fetched successfully', { sectionsFound: Array.isArray(details) ? details.length : 0 });
    } catch (parseError) {
      let parsedRaw: any = null;
      try { parsedRaw = JSON.parse(scriptContent); } catch (_) {}
      const detailsPath = ['niobeClientData', '0', '1', 'data', 'presentation', 'stayProductDetailPage', 'sections', 'sections'];
      const diagnosis = parsedRaw ? diagnoseJsonPath(parsedRaw, detailsPath) : 'Could not parse script content as JSON';

      log('error', 'Failed to parse listing details', { diagnosis });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Failed to parse listing details from Airbnb. The page structure may have changed.",
            details: parseError instanceof Error ? parseError.message : String(parseError),
            diagnosis,
            listingUrl: listingUrl.toString()
          }, null, 2)
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          listingUrl: listingUrl.toString(),
          details: details
        }, null, 2)
      }],
      isError: false
    };
  } catch (error) {
    log('error', 'Listing details request failed');
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          listingUrl: listingUrl.toString(),
          timestamp: new Date().toISOString()
        }, null, 2)
      }],
      isError: true
    };
  }
}

async function handleAirbnbTripSearch(params: any) {
  const providedModeCount = [params.wishlistUrl, params.location, params.listingUrls].filter(v => v != null).length;
  if (providedModeCount !== 1) {
    throw new McpError(ErrorCode.InvalidParams, "Provide exactly one of location, wishlistUrl, or listingUrls");
  }
  const wishlistUrl = params.wishlistUrl == null ? null : requireNonEmptyString(params.wishlistUrl, "wishlistUrl", 300);
  const location = params.location == null ? null : requireNonEmptyString(params.location, "location", 200);
  const listingUrls = params.listingUrls == null ? null : normalizeListingUrls(params.listingUrls);
  const checkin = requireIsoDate(params.checkin, "checkin");
  const checkout = requireIsoDate(params.checkout, "checkout");
  if (checkout <= checkin) throw new McpError(ErrorCode.InvalidParams, "checkout must be after checkin");
  const adults = parseNonNegativeInteger(params.adults, "adults", 1);
  if (adults < 1) throw new McpError(ErrorCode.InvalidParams, "adults must be at least 1");
  const children = parseNonNegativeInteger(params.children, "children", 0);
  const infants = parseNonNegativeInteger(params.infants, "infants", 0);
  const pets = parseNonNegativeInteger(params.pets, "pets", 0);
  // Explicit-listing mode quotes every requested URL by default rather than
  // silently truncating to the destination-discovery default of 10.
  const maxCandidates = parseNonNegativeInteger(params.maxCandidates, "maxCandidates", listingUrls ? listingUrls.length : 10);
  if (maxCandidates < 1 || maxCandidates > 25) throw new McpError(ErrorCode.InvalidParams, "maxCandidates must be from 1 to 25");
  const budgetTotal = params.budgetTotal == null ? null : Number(params.budgetTotal);
  if (budgetTotal != null && (!Number.isFinite(budgetTotal) || budgetTotal < 0)) {
    throw new McpError(ErrorCode.InvalidParams, "budgetTotal must be a non-negative number");
  }
  let candidates: any[] = [];
  let sourceLabel: "location" | "wishlist" | "listingUrls" = "location";
  if (listingUrls) {
    sourceLabel = "listingUrls";
    candidates = listingUrls.map((url) => ({
      id: url.match(/\/rooms\/([0-9]+)/)?.[1] ?? null,
      url,
      title: "Airbnb listing",
      attributes: {},
    }));
  } else if (location) {
    const discovery = await handleAirbnbSearch({
      location, checkin, checkout, adults, children, infants, pets,
      propertyType: params.propertyType,
      ignoreRobotsText: true,
    });
    if (discovery.isError) return discovery;
    const payload = JSON.parse(discovery.content[0].text);
    candidates = (payload.searchResults || []).slice(0, maxCandidates).map((row: any) => ({
      id: row.id,
      url: row.url,
      title: row.demandStayListing?.description?.name?.localizedStringWithTranslationPreference || "Airbnb listing",
      attributes: {
        summary: row.structuredContent?.primaryLine || null,
        rating: row.avgRatingA11yLabel || null,
        searchPrice: row.structuredDisplayPrice?.primaryLine?.accessibilityLabel || null,
      },
    }));
  } else {
    sourceLabel = "wishlist";
  }
  try {
    // Exactly one bounded helper `run` invocation regardless of how many
    // listingUrls were requested: the helper already accepts a `candidates`
    // array (see airbnb-cdp.mjs `run()`), so explicit-listing mode reuses the
    // existing interface unchanged instead of issuing one call per URL.
    const result = await runTripPlanner({ wishlistUrl, location, checkin, checkout, adults, children, infants, pets, maxCandidates, budgetTotal, candidates });
    // The shared helper's `run()` return only distinguishes "wishlist" vs its
    // default "location" — it has no concept of explicit-listing mode, so the
    // top-level envelope label must be corrected here to match the labeling
    // already applied on the AirbnbBrowserError fallback path below.
    if (sourceLabel === "listingUrls" && result && typeof result === "object") {
      (result as Record<string, unknown>).source = "listingUrls";
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
  } catch (error) {
    if (candidates.length && error instanceof AirbnbBrowserError) {
      const checkedAt = new Date().toISOString();
      const fallback = {
        schema: "lookup-scaffold/v1",
        source: sourceLabel,
        status: "browser_unavailable",
        checkedAt,
        rows: candidates.map((candidate, index) => ({
          rank: index + 1,
          source: { name: "Airbnb", url: candidate.url },
          candidate: { label: candidate.title, attributes: candidate.attributes },
          price: { subtotal: null, fees: [], taxes: [], total: null, currency: null },
          availability: { status: "available", window: { checkin, checkout } },
          ranking: { score: null, reasons: [], tradeoffs: [] },
          quoteStatus: "unknown",
          checkedAt,
          evidence: [{ kind: sourceLabel === "listingUrls" ? "listing" : "search", label: sourceLabel === "listingUrls" ? "Explicit Airbnb listing URL" : "Airbnb dated search result", url: candidate.url }],
          caveats: sourceLabel === "listingUrls"
            ? ["Authenticated browser quote unavailable for this explicit listing URL."]
            : ["Authenticated browser quote unavailable; search-card price is not a full total."],
        })),
        caveats: [error.message],
      };
      return { content: [{ type: "text", text: JSON.stringify(fallback, null, 2) }], isError: false };
    }
    const message = error instanceof AirbnbBrowserError ? error.message : "Airbnb trip search failed";
    return { content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }], isError: true };
  }
}

async function handleAirbnbWishlistManage(params: any) {
  const action = params.action == null ? "list" : requireNonEmptyString(params.action, "action", 20);
  if (!["list", "create", "add", "remove"].includes(action)) {
    throw new McpError(ErrorCode.InvalidParams, "action must be list, create, add, or remove");
  }
  const wishlistUrl = params.wishlistUrl == null ? null : requireNonEmptyString(params.wishlistUrl, "wishlistUrl", 300);
  const wishlistName = params.wishlistName == null ? null : requireNonEmptyString(params.wishlistName, "wishlistName", 80);
  const listingUrl = params.listingUrl == null ? null : requireNonEmptyString(params.listingUrl, "listingUrl", 300);
  const listingUrls = params.listingUrls == null ? null : params.listingUrls;
  if (listingUrls != null && (!Array.isArray(listingUrls) || listingUrls.length < 1 || listingUrls.length > 25 || listingUrls.some(value => typeof value !== "string" || !value.trim()))) {
    throw new McpError(ErrorCode.InvalidParams, "listingUrls must contain 1-25 non-empty listing URLs");
  }
  if (action === "create" && (!wishlistName || !listingUrl)) {
    throw new McpError(ErrorCode.InvalidParams, "create requires wishlistName and listingUrl");
  }
  if (["add", "remove"].includes(action) && (Boolean(listingUrl) === Boolean(listingUrls) || Boolean(wishlistUrl) === Boolean(wishlistName))) {
    throw new McpError(ErrorCode.InvalidParams, `${action} requires exactly one of listingUrl or listingUrls, and exactly one of wishlistUrl or wishlistName`);
  }
  try {
    const result = await manageWishlist({ action, wishlistUrl, wishlistName, listingUrl, listingUrls });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
  } catch (error) {
    const message = error instanceof AirbnbBrowserError ? error.message : "Airbnb wishlist management failed";
    return { content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }], isError: true };
  }
}

// Server setup
const server = new Server(
  {
    name: "airbnb",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Enhanced logging for DXT
function log(level: 'info' | 'warn' | 'error', message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  
  if (data) {
    console.error(`${logMessage}:`, JSON.stringify(data, null, 2));
  } else {
    console.error(logMessage);
  }
}

log('info', 'Airbnb MCP Server starting', {
  version: VERSION,
  disableGeocoding: DISABLE_GEOCODING,
  robotsBypassEnabled: IGNORE_ROBOTS_TXT,
  nodeVersion: process.version,
  platform: process.platform
});

// Set up request handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: AIRBNB_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const startTime = Date.now();
  
  try {
    // Validate request parameters
    if (!request.params.name) {
      throw new McpError(ErrorCode.InvalidParams, "Tool name is required");
    }
    
    if (!request.params.arguments) {
      throw new McpError(ErrorCode.InvalidParams, "Tool arguments are required");
    }
    
    log('info', 'Tool call received', { tool: request.params.name });
    
    // Ensure robots.txt is loaded
    if (robotsPolicyStatus === "uninitialized" && !IGNORE_ROBOTS_TXT) {
      await fetchRobotsTxt();
    }

    let result;
    switch (request.params.name) {
      case "airbnb_search": {
        result = await handleAirbnbSearch(request.params.arguments);
        break;
      }

      case "airbnb_listing_details": {
        result = await handleAirbnbListingDetails(request.params.arguments);
        break;
      }

      case "airbnb_trip_search": {
        result = await handleAirbnbTripSearch(request.params.arguments);
        break;
      }

      case "airbnb_wishlist_manage": {
        result = await handleAirbnbWishlistManage(request.params.arguments);
        break;
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
    }
    
    const duration = Date.now() - startTime;
    log('info', 'Tool call completed', { 
      tool: request.params.name, 
      duration: `${duration}ms`,
      success: !result.isError 
    });
    
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    log('error', 'Tool call failed', {
      tool: request.params.name,
      duration: `${duration}ms`,
      error: error instanceof Error ? error.message : String(error)
    });
    
    if (error instanceof McpError) {
      throw error;
    }
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString()
        }, null, 2)
      }],
      isError: true
    };
  }
});

async function runServer() {
  try {
    // Initialize robots.txt on startup
    await fetchRobotsTxt();
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    log('info', 'Airbnb MCP Server running on stdio', {
      version: VERSION,
      robotsRespected: !IGNORE_ROBOTS_TXT
    });
    
    // Graceful shutdown handling
    process.on('SIGINT', () => {
      log('info', 'Received SIGINT, shutting down gracefully');
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      log('info', 'Received SIGTERM, shutting down gracefully');
      process.exit(0);
    });
    
  } catch (error) {
    log('error', 'Failed to start server', {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  }
}

runServer().catch((error) => {
  log('error', 'Fatal error running server', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
