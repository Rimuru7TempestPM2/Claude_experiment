// =============================================================================
// SwiftHaul Logistics — Client Logic Engine (app.js)
// Version: 1.0.0
// =============================================================================
//
// WHAT THIS FILE DOES:
//   All client-side logic lives here. This file is responsible for:
//   1. Pricing engine — calculates quotes using the Hybrid Cost-Plus model
//   2. Distance fetching — Google Distance Matrix API or manual KM fallback
//   3. Form validation — checks inputs before sending to backend
//   4. Backend API calls — submits bookings, fetches tracking, handles driver ops
//   5. UI state management — shows/hides views without page reloads
//   6. WhatsApp deep links — pre-filled messages to ops and drivers
//
// IMPORTANT SECURITY NOTE:
//   All pricing internals (base rates, per-km rates, commission splits,
//   fuel surcharge formula) are computed HERE in app.js. While a determined
//   person could open browser DevTools and read these values, they are NOT
//   rendered in the HTML or sent in API responses. This is the correct
//   trade-off for a serverless frontend-computed pricing model.
//   For stronger protection (hiding from DevTools too), move pricing to
//   Code.gs and only return the final quote — flag this as a future upgrade.
//
// FILE DEPENDENCIES:
//   - index.html: loads this file, calls initApp() on DOMContentLoaded
//   - driver.html: loads this file, calls initDriverApp() on DOMContentLoaded
//   - Code.gs: receives POST/GET requests from the functions in this file
//
// =============================================================================


// =============================================================================
// SECTION 1: GLOBAL CONFIGURATION
// =============================================================================
// !! EDIT THIS SECTION ONLY — never hardcode these values inside functions !!
// Updating values here propagates changes across the entire system.

var APP_CONFIG = {

  // ── Business Identity ────────────────────────────────────────────────────
  // TODO: BUSINESS NAME — update once final name is confirmed.
  // This single variable is referenced in WhatsApp messages and page content.
  APP_NAME: "SwiftHaul Logistics",

  // TODO: BACKEND URL
  // After deploying Code.gs as a Web App, paste the URL here.
  // Path: Apps Script editor → Deploy → Manage Deployments → copy Web App URL
  // Format: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec"
  BACKEND_URL: "https://script.google.com/macros/s/AKfycby-LE5gtYKCdXrk7GRKeNj_Sa7YuFwus71-nU_dEw_L3j_aTB4Qyz_a9amaQNDiGD8/exec",

  // TODO: OPS WHATSAPP NUMBER
  // The number ops uses to receive booking confirmations and driver verification.
  // Format: international without "+", e.g. "254712345678" for a Kenyan number.
  // Every booking confirmation and driver registration WhatsApp link uses this.
  OPS_WHATSAPP: "254794152875",

  // TODO: GOOGLE MAPS API KEY
  // Required for Google Places Autocomplete (address suggestions) and
  // Distance Matrix API (real driving distances).
  //
  // How to get it:
  //   1. Go to https://console.cloud.google.com/
  //   2. Create a project (or select existing)
  //   3. Enable these APIs: "Distance Matrix API" + "Places API"
  //   4. Credentials → Create Credentials → API Key
  //   5. Restrict the key to your domain (HTTP referrer restriction)
  //   6. Google Maps Platform gives $200/month free credit — more than enough
  //      for a small operation (~40,000 Distance Matrix requests/month free).
  //
  // Until this is added, the system falls back to MANUAL_KM_MODE below.
  GOOGLE_MAPS_API_KEY: null, // Set to "YOUR_API_KEY_HERE" when ready

  // When true: shows a manual KM input field instead of calling the Distance
  // Matrix API. Allows full testing of the pricing engine without an API key.
  // Set to false once GOOGLE_MAPS_API_KEY is filled in.
  MANUAL_KM_MODE: true, // CHANGE TO false once API key is added

  // ── Pricing Engine Config ────────────────────────────────────────────────
  // These are the only numbers you need to touch when rates change.
  // The pricing formula is: [Base + (KM × PerKm)] × (1 + Surcharge%) × CargoMultiplier

  // Driving distance buffer — multiplied by raw API distance to account for
  // informal/unmapped roads not fully reflected in Google Maps routing.
  DISTANCE_BUFFER: 1.3,

  // Vehicle cost structure — all prices in KES
  // To add a new vehicle type: add a new key here, update the HTML <select> options,
  // and add a label in VEHICLE_LABELS below.
  VEHICLE_RATES: {
    PICKUP: { baseRate: 1500, perKmRate: 50,  label: "1-Ton Pick-up" },
    CANTER: { baseRate: 3000, perKmRate: 75,  label: "3-Ton Canter"  },
    LORRY:  { baseRate: 6000, perKmRate: 120, label: "10-Ton Lorry"  }
  },

  // ── Time Hire Config (added v1.1) ────────────────────────────────────────
  // Used ONLY for bookingType === "TIME_HIRE". Client hires one vehicle for
  // a block of hours instead of paying per-KM for a single route.
  // Formula: (HourlyRate × hours) × (1 + FuelSurcharge%) × CargoMultiplier
  // Same fuel surcharge and cargo multiplier logic as trip pricing — only
  // the base cost calculation differs (hours×rate instead of base+km×rate).
  //
  // TODO: HOURLY RATE REVIEW — these are placeholder starting rates.
  // Adjust based on real driver feedback on what an hour of their time
  // (with vehicle, fuel, wear) is worth versus the per-trip rates above.
  HOURLY_RATES: {
    PICKUP: { rate: 600,  label: "1-Ton Pick-up" },
    CANTER: { rate: 1000, label: "3-Ton Canter"  },
    LORRY:  { rate: 1800, label: "10-Ton Lorry"  }
  },

  // Minimum hours for a Time Hire booking — prevents someone booking a
  // 15-minute "hire" that's really just a short trip (which should use
  // Single Trip pricing instead, it's cheaper for them and clearer for us).
  TIME_HIRE_MIN_HOURS: 2,
  TIME_HIRE_MAX_HOURS: 12, // beyond this, ops should arrange a custom multi-day quote manually

  // Cargo type multipliers — applied to the subtotal after vehicle+distance calc
  // To update a multiplier, change the number here only.
  CARGO_MULTIPLIERS: {
    STANDARD:   1.00,
    FRAGILE:    1.20,
    PERISHABLE: 1.30,
    BULKY:      1.15
  },

  // ── Multiple Trips Config (added v1.1) ───────────────────────────────────
  // Caps how many trip-blocks the form will let a client add in one
  // Multiple Trips submission. Matches the limit enforced server-side in
  // Code.gs submitBookingBatch() — keep these two values in sync.
  MAX_TRIPS_PER_BATCH: 20,
  MIN_TRIPS_PER_BATCH: 2, // below this, it should just be a Single Trip booking

  // Max characters for the free-text cargo description field. Long enough
  // for a useful description, short enough to stay skimmable for drivers.
  CARGO_DESCRIPTION_MAX_LENGTH: 300,

  // ── Fuel Surcharge Config (EPRA Index Protection) ────────────────────────
  // Updated manually when EPRA publishes new pump prices.
  // Check: https://www.epra.go.ke/pricing/
  //
  // How the surcharge works:
  //   For every KES 5 change from BASELINE, price changes by STEP_PERCENT.
  //   Example: fuel at 195 = (195-180)/5 = 3 steps × 2% = +6% surcharge.
  //   If fuel drops below baseline, surcharge is negative (discount).
  //   Surcharge is capped at ±20% to prevent extreme swings.
  //
  // TODO: FUEL PRICE UPDATE — check EPRA website and update CURRENT_FUEL_PRICE
  // whenever diesel prices change. This is the only manual maintenance task
  // for the pricing engine.
  FUEL_BASELINE_KES: 180,    // Baseline diesel price in KES/litre
  FUEL_CURRENT_KES: 180,     // TODO: Update this to the current EPRA price
  FUEL_STEP_KES: 5,          // Price change per step
  FUEL_STEP_PERCENT: 0.02,   // 2% per step
  FUEL_SURCHARGE_CAP: 0.20,  // Maximum surcharge magnitude (±20%)

  // ── Commission Structure (HIDDEN from frontend output/HTML) ─────────────
  // These values are used to calculate Driver Cut and Platform Fee for the
  // Sheet ledger. They are NEVER displayed to clients.
  //
  // TODO: COMMISSION RATE — decide on final commission percentage.
  // Current placeholder: 15% platform fee, 85% driver cut.
  PLATFORM_COMMISSION_RATE: 0.15,  // 15% of total quote → Platform Fee
  // Driver cut is automatically 1 - PLATFORM_COMMISSION_RATE
};


// =============================================================================
// SECTION 2: PRICING ENGINE
// =============================================================================
// The core formula: [Base + (KM × PerKm)] × (1 + Surcharge%) × CargoMultiplier
//
// HOW TO CHANGE PRICING:
//   - Adjust BASE rates or PER-KM rates: edit VEHICLE_RATES in Section 1
//   - Adjust cargo multipliers: edit CARGO_MULTIPLIERS in Section 1
//   - Update fuel price: edit FUEL_CURRENT_KES in Section 1
//   - Change distance buffer: edit DISTANCE_BUFFER in Section 1
//
// This function returns a RESULT OBJECT with all internal variables for the
// Sheet ledger. Only "totalQuote" is displayed to the client.

function calculateQuote(rawDistanceKm, vehicleClass, cargoType) {
  // --- Step 1: Apply distance buffer ---
  // Raw distance (from API or manual input) × buffer for unmapped local roads
  var factoredKm = rawDistanceKm * APP_CONFIG.DISTANCE_BUFFER;

  // --- Step 2: Vehicle cost calculation ---
  var rates = APP_CONFIG.VEHICLE_RATES[vehicleClass];
  if (!rates) {
    console.error("Unknown vehicle class:", vehicleClass);
    return null;
  }
  var vehicleCost = rates.baseRate + (factoredKm * rates.perKmRate);

  // --- Step 3: Fuel surcharge ---
  // How many KES-5-steps has the price moved from baseline?
  var fuelDelta   = APP_CONFIG.FUEL_CURRENT_KES - APP_CONFIG.FUEL_BASELINE_KES;
  var fuelSteps   = fuelDelta / APP_CONFIG.FUEL_STEP_KES;
  var rawSurcharge= fuelSteps * APP_CONFIG.FUEL_STEP_PERCENT;
  // Cap surcharge to prevent extreme values
  var surcharge   = Math.max(-APP_CONFIG.FUEL_SURCHARGE_CAP,
                    Math.min( APP_CONFIG.FUEL_SURCHARGE_CAP, rawSurcharge));

  // --- Step 4: Cargo multiplier ---
  var multiplier = APP_CONFIG.CARGO_MULTIPLIERS[cargoType];
  if (!multiplier) {
    console.warn("Unknown cargo type, defaulting to STANDARD:", cargoType);
    multiplier = 1.0;
  }

  // --- Step 5: Final total ---
  var subtotal   = vehicleCost * (1 + surcharge);
  var totalQuote = Math.ceil(subtotal * multiplier); // Round up to nearest KES

  // --- Internal ledger values (never shown to client) ---
  var driverCut    = Math.round(totalQuote * (1 - APP_CONFIG.PLATFORM_COMMISSION_RATE));
  var platformFee  = totalQuote - driverCut;

  // Return full breakdown — most fields go to the Sheet, only totalQuote to UI
  return {
    rawDistanceKm:    rawDistanceKm,
    factoredDistanceKm: parseFloat(factoredKm.toFixed(2)),
    vehicleClass:     vehicleClass,
    cargoType:        cargoType,
    baseRate:         rates.baseRate,
    perKmRate:        rates.perKmRate,
    vehicleCost:      Math.round(vehicleCost),
    epraFuelPrice:    APP_CONFIG.FUEL_CURRENT_KES,
    surchargePercent: parseFloat((surcharge * 100).toFixed(2)),
    cargoMultiplier:  multiplier,
    totalQuote:       totalQuote,        // ← This is the ONLY value shown to client
    driverCutKes:     driverCut,         // ← Sheet ledger only
    platformFeeKes:   platformFee        // ← Sheet ledger only
  };
}


// =============================================================================
// SECTION 2B: TIME HIRE PRICING (added v1.1)
// =============================================================================
// Sibling to calculateQuote() above, used when bookingType === "TIME_HIRE".
// No distance involved — billed by hours instead of KM.
//
// Formula: (HourlyRate × hours) × (1 + FuelSurcharge%) × CargoMultiplier
//
// HOW TO CHANGE TIME HIRE PRICING:
//   - Adjust hourly rates: edit HOURLY_RATES in Section 1
//   - Adjust min/max hours: edit TIME_HIRE_MIN_HOURS / TIME_HIRE_MAX_HOURS
//   - Fuel surcharge and cargo multiplier reuse the SAME config as trip
//     pricing (Section 1) — no separate values to maintain for those.

function calculateTimeHireQuote(hours, vehicleClass, cargoType) {
  // --- Step 1: Validate hours against configured bounds ---
  if (!hours || hours < APP_CONFIG.TIME_HIRE_MIN_HOURS) {
    console.error("Hours below minimum:", hours, "min:", APP_CONFIG.TIME_HIRE_MIN_HOURS);
    return null;
  }
  if (hours > APP_CONFIG.TIME_HIRE_MAX_HOURS) {
    console.error("Hours above maximum — direct to manual quote:", hours);
    return null;
  }

  // --- Step 2: Base hourly cost ---
  var rates = APP_CONFIG.HOURLY_RATES[vehicleClass];
  if (!rates) {
    console.error("Unknown vehicle class for Time Hire:", vehicleClass);
    return null;
  }
  var hireCost = rates.rate * hours;

  // --- Step 3: Fuel surcharge — identical logic to calculateQuote() ---
  // Reusing the same EPRA-indexed formula since diesel cost is diesel cost
  // whether the vehicle is driving a route or idling/working through a hire.
  var fuelDelta    = APP_CONFIG.FUEL_CURRENT_KES - APP_CONFIG.FUEL_BASELINE_KES;
  var fuelSteps    = fuelDelta / APP_CONFIG.FUEL_STEP_KES;
  var rawSurcharge = fuelSteps * APP_CONFIG.FUEL_STEP_PERCENT;
  var surcharge    = Math.max(-APP_CONFIG.FUEL_SURCHARGE_CAP,
                     Math.min( APP_CONFIG.FUEL_SURCHARGE_CAP, rawSurcharge));

  // --- Step 4: Cargo multiplier — same table as trip pricing ---
  var multiplier = APP_CONFIG.CARGO_MULTIPLIERS[cargoType];
  if (!multiplier) {
    console.warn("Unknown cargo type for Time Hire, defaulting to STANDARD:", cargoType);
    multiplier = 1.0;
  }

  // --- Step 5: Final total ---
  var subtotal   = hireCost * (1 + surcharge);
  var totalQuote = Math.ceil(subtotal * multiplier);

  // --- Internal ledger values (never shown to client) ---
  var driverCut   = Math.round(totalQuote * (1 - APP_CONFIG.PLATFORM_COMMISSION_RATE));
  var platformFee = totalQuote - driverCut;

  return {
    hours:            hours,
    vehicleClass:     vehicleClass,
    cargoType:        cargoType,
    hourlyRate:       rates.rate,
    hireCost:         Math.round(hireCost),
    epraFuelPrice:    APP_CONFIG.FUEL_CURRENT_KES,
    surchargePercent: parseFloat((surcharge * 100).toFixed(2)),
    cargoMultiplier:  multiplier,
    totalQuote:       totalQuote,        // ← Only value shown to client
    driverCutKes:     driverCut,         // ← Sheet ledger only
    platformFeeKes:   platformFee,       // ← Sheet ledger only
    // factoredDistanceKm intentionally 0 — Code.gs Section 5 field notes
    // explain why TIME_HIRE rows store 0 here instead of omitting the column.
    factoredDistanceKm: 0
  };
}


// =============================================================================
// SECTION 3: DISTANCE FETCHING
// =============================================================================
// Two modes:
//   A) Google Distance Matrix API (production) — requires API key
//   B) Manual KM input (fallback/development) — no API key needed
//
// HOW TO SWITCH MODES:
//   Set MANUAL_KM_MODE in Section 1 to false (and add your API key)
//   to activate Google Maps. Flip it back to true to test without the key.

// Called when both address fields have values
// Returns a Promise resolving to distance in KM (raw, before buffer)
function fetchDrivingDistance(origin, destination) {
  if (APP_CONFIG.MANUAL_KM_MODE || !APP_CONFIG.GOOGLE_MAPS_API_KEY) {
    // Fallback: resolve with null — UI will show manual input field instead
    return Promise.resolve(null);
  }

  // TODO: DISTANCE MATRIX API CALL
  // When API key is added and MANUAL_KM_MODE = false, this block activates.
  //
  // The Distance Matrix API is called from the frontend here.
  // For production, consider proxying through Code.gs to hide the API key
  // from browser network requests. For v1, calling directly is acceptable.
  //
  // API docs: https://developers.google.com/maps/documentation/distance-matrix

  var url = "https://maps.googleapis.com/maps/api/distancematrix/json" +
    "?origins=" + encodeURIComponent(origin) +
    "&destinations=" + encodeURIComponent(destination) +
    "&mode=driving" +
    "&region=ke" +              // Bias results toward Kenya
    "&key=" + APP_CONFIG.GOOGLE_MAPS_API_KEY;

  return fetch(url)
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.status !== "OK") {
        console.error("Distance Matrix API error:", data.status);
        return null;
      }
      var element = data.rows[0].elements[0];
      if (element.status !== "OK") {
        console.error("Route not found:", element.status);
        return null;
      }
      // API returns distance in metres — convert to KM
      return element.distance.value / 1000;
    })
    .catch(function(err) {
      console.error("Distance fetch failed:", err);
      return null; // Fall through — UI will show manual input
    });
}

// TODO: GOOGLE PLACES AUTOCOMPLETE
// When API key is added, call this to attach autocomplete to address inputs.
// This improves address accuracy which improves Distance Matrix results.
//
// function initPlacesAutocomplete() {
//   if (!APP_CONFIG.GOOGLE_MAPS_API_KEY) return;
//   // Requires <script src="https://maps.googleapis.com/maps/api/js?key=KEY&libraries=places">
//   // in index.html (uncomment the script tag in the <head> section)
//   var pickupInput = document.getElementById("pickup-address");
//   var destInput   = document.getElementById("dest-address");
//   var pickupAuto  = new google.maps.places.Autocomplete(pickupInput, { componentRestrictions: { country: "ke" } });
//   var destAuto    = new google.maps.places.Autocomplete(destInput,   { componentRestrictions: { country: "ke" } });
// }


// =============================================================================
// SECTION 4: BACKEND API CALLS
// =============================================================================
// All communication with Code.gs goes through these functions.
// They return Promises so callers can chain .then() / .catch().

// Generic POST to backend
function apiPost(action, data) {
  if (!APP_CONFIG.BACKEND_URL || APP_CONFIG.BACKEND_URL === "YOUR_APPS_SCRIPT_WEB_APP_URL_HERE") {
    console.error("BACKEND_URL not set in app.js APP_CONFIG");
    return Promise.reject(new Error("Backend URL not configured. See app.js Section 1."));
  }
  return fetch(APP_CONFIG.BACKEND_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" }, // Apps Script requires text/plain for CORS
    body: JSON.stringify(Object.assign({ action: action }, data))
  }).then(function(res) { return res.json(); });
}

// Generic GET from backend
function apiGet(action, params) {
  if (!APP_CONFIG.BACKEND_URL || APP_CONFIG.BACKEND_URL === "YOUR_APPS_SCRIPT_WEB_APP_URL_HERE") {
    console.error("BACKEND_URL not set in app.js APP_CONFIG");
    return Promise.reject(new Error("Backend URL not configured."));
  }
  var query = Object.assign({ action: action }, params);
  var qs = Object.keys(query).map(function(k) {
    return encodeURIComponent(k) + "=" + encodeURIComponent(query[k]);
  }).join("&");
  return fetch(APP_CONFIG.BACKEND_URL + "?" + qs)
    .then(function(res) { return res.json(); });
}

// Submit a new SINGLE booking
function submitBooking(bookingData) {
  return apiPost("submitBooking", bookingData);
}

// Submit a MULTI_TRIP batch — one call carrying all trips, instead of
// firing one HTTP request per trip (which would be slow for up to 20 trips
// and could hit Apps Script's concurrent-request limits).
// batchData shape: { customerName, customerMobile, trips: [...] }
function submitBookingBatch(batchData) {
  return apiPost("submitBookingBatch", batchData);
}

// Lookup order status by tracking code or mobile
function trackOrder(trackingCode, mobile) {
  var params = {};
  if (trackingCode) params.trackingCode = trackingCode;
  if (mobile)       params.mobile = mobile;
  return apiGet("trackOrder", params);
}

// Driver login
function loginDriver(whatsapp, pin) {
  return apiGet("loginDriver", { whatsapp: whatsapp, pin: pin });
}

// Fetch open jobs for driver's cargo class
function fetchOpenJobs(cargoClass) {
  return apiGet("getOpenJobs", { cargoClass: cargoClass });
}

// Driver accepts a job
function acceptJob(trackingCode, driver) {
  return apiPost("acceptJob", {
    trackingCode:   trackingCode,
    driverWhatsApp: driver.whatsapp,
    driverName:     driver.name,
    driverPlate:    driver.plate
  });
}

// Register a new driver
function registerDriver(driverData) {
  return apiPost("registerDriver", driverData);
}


// =============================================================================
// SECTION 5: WHATSAPP MESSAGE SYSTEM
// =============================================================================
// Generates pre-filled WhatsApp deep links for ops notifications.
// All messages route to APP_CONFIG.OPS_WHATSAPP.
//
// HOW WHATSAPP DEEP LINKS WORK:
//   Opening "https://wa.me/PHONE?text=MESSAGE" opens WhatsApp (web or app)
//   with the number pre-filled and a draft message ready to send.
//   The user still has to tap Send — we can't send automatically without
//   the WhatsApp Business API (a future upgrade if volume warrants it).
//
// TODO: WHATSAPP BUSINESS API UPGRADE
//   For fully automated notifications (no manual send needed), integrate
//   Twilio (https://www.twilio.com/whatsapp) or the official Meta WhatsApp
//   Business API. This is a future phase — v1 uses deep links.

// Booking confirmation message sent to ops
function buildOpsBookingMessage(quote, trackingCode, clientName, clientMobile, pickup, dest, vehicleClass, cargoType) {
  var vehicleLabel = APP_CONFIG.VEHICLE_RATES[vehicleClass]
    ? APP_CONFIG.VEHICLE_RATES[vehicleClass].label
    : vehicleClass;
  var msg = [
    "🚛 *NEW BOOKING — " + APP_CONFIG.APP_NAME + "*",
    "Tracking: *" + trackingCode + "*",
    "",
    "👤 Client: " + clientName,
    "📱 Mobile: " + clientMobile,
    "📦 Cargo: " + cargoType + " | " + vehicleLabel,
    "📍 Pickup: " + pickup,
    "🏁 Destination: " + dest,
    "💰 Quote: KES " + Number(quote).toLocaleString(),
    "",
    "ACTION: Please confirm with client then update status to OPEN in the sheet."
  ].join("\n");
  return buildWhatsAppLink(APP_CONFIG.OPS_WHATSAPP, msg);
}

// Driver registration verification message sent to ops
function buildOpsDriverRegMessage(driverName, whatsapp, plate, cargoClass) {
  var msg = [
    "🔍 *DRIVER VERIFICATION REQUEST*",
    "Name: " + driverName,
    "WhatsApp: " + whatsapp,
    "Plate: " + plate,
    "Vehicle Class: " + cargoClass.toUpperCase(),
    "",
    "Verification checklist:",
    "☐ Valid smartphone with WhatsApp",
    "☐ National ID + Driving License",
    "☐ Vehicle Insurance (valid)",
    "☐ Vehicle Inspection Certificate",
    "",
    "Once verified, set Column F to 'Active' in VerifiedDriversPool."
  ].join("\n");
  return buildWhatsAppLink(APP_CONFIG.OPS_WHATSAPP, msg);
}

// Generic WhatsApp deep link builder
function buildWhatsAppLink(phone, message) {
  return "https://wa.me/" + phone + "?text=" + encodeURIComponent(message);
}


// =============================================================================
// SECTION 6: CLIENT-SIDE STATE MANAGEMENT (index.html)
// =============================================================================
// Controls which "view" (page section) is visible on index.html.
// Only one section is visible at a time — simulates multi-page navigation
// without reloading. All sections are in the DOM; show/hide via CSS class.
//
// VIEW NAMES: booking | tracking | how-it-works | privacy | terms-client
//
// HOW TO ADD A NEW VIEW:
//   1. Add a <section id="view-YOURNAME"> in index.html
//   2. Add "YOURNAME" to the VIEWS array below
//   3. Call showView("YOURNAME") from a nav link or button

var VIEWS = ["booking", "tracking", "how-it-works", "privacy", "terms-client"];

function showView(viewName) {
  VIEWS.forEach(function(v) {
    var el = document.getElementById("view-" + v);
    if (el) el.classList.add("hidden");
  });
  var target = document.getElementById("view-" + viewName);
  if (target) {
    target.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  // Update URL hash for browser back button / bookmarking
  history.pushState(null, "", "#" + viewName);
}

// Handle browser back/forward navigation
window.addEventListener("popstate", function() {
  var hash = window.location.hash.replace("#", "") || "booking";
  if (VIEWS.indexOf(hash) >= 0) showView(hash);
});


// =============================================================================
// SECTION 7: CLIENT BOOKING FLOW (index.html)
// =============================================================================
// Handles the complete booking journey across THREE booking types:
//
//   SINGLE     — one pickup, one destination, one price. (Original v1 flow.)
//   MULTI_TRIP — 2-20 trips in one submission, each with its own route and
//                price, summed into a batch total. Each trip becomes its
//                own independent job that any driver can accept.
//   TIME_HIRE  — one vehicle hired for a block of hours, priced by the hour
//                instead of by distance.
//
// The client picks a booking type via a tab/radio control in index.html
// (#booking-type-single / #booking-type-multi / #booking-type-hire), which
// calls switchBookingType() below. Each type has its own form panel and its
// own submit handler, but they all funnel into the shared success-display
// logic at the bottom of this section.
//
// HOW TO ADD A FOURTH BOOKING TYPE LATER:
//   1. Add a new panel in index.html (#booking-panel-yourtype)
//   2. Add a case in switchBookingType() below
//   3. Write a calculateYourTypeQuote() in Section 2/2B
//   4. Write a handleYourTypeSubmit() following the pattern of the three below
//   5. Add a case in Code.gs doPost() router + a submit function

// ── Shared state across all three booking types ────────────────────────────
var bookingState = {
  currentType: "SINGLE",      // SINGLE | MULTI_TRIP | TIME_HIRE — which panel is active

  // Single Trip state (unchanged from v1)
  rawDistanceKm: null,
  quoteResult: null,
  distanceFetchPending: false,

  // Multiple Trips state — array of trip-row state objects, one per trip block
  // Each entry: { rawDistanceKm, quoteResult, distanceFetchPending }
  trips: [],

  // Time Hire state
  timeHireQuoteResult: null
};


// =============================================================================
// SECTION 7A: BOOKING TYPE SWITCHER
// =============================================================================
// Shows the relevant form panel and resets state for the other two types so
// stale data from a previously-viewed panel can't leak into a submission.

function switchBookingType(type) {
  bookingState.currentType = type;

  var panels = { SINGLE: "panel-single", MULTI_TRIP: "panel-multi", TIME_HIRE: "panel-hire" };
  Object.keys(panels).forEach(function(key) {
    var el = document.getElementById(panels[key]);
    if (el) el.classList.toggle("hidden", key !== type);
  });

  // Update tab active states
  ["SINGLE", "MULTI_TRIP", "TIME_HIRE"].forEach(function(key) {
    var tabEl = document.getElementById("type-tab-" + key.toLowerCase().replace("_","-"));
    if (tabEl) tabEl.classList.toggle("active", key === type);
  });

  // Initialise the relevant panel's first-time setup
  if (type === "MULTI_TRIP" && bookingState.trips.length === 0) {
    addTripBlock(); // start with one trip block visible
    addTripBlock(); // and a second, since Multi-Trip implies 2+ by definition
  }
}


// =============================================================================
// SECTION 7B: SINGLE TRIP FLOW (unchanged logic from v1, renamed for clarity)
// =============================================================================

// Called from index.html when the booking form initialises
function initBookingForm() {
  // Address input change handlers — trigger distance fetch when both are filled
  var pickupField = document.getElementById("pickup-address");
  var destField   = document.getElementById("dest-address");
  var kmField     = document.getElementById("manual-km");

  if (pickupField && destField) {
    // Show/hide manual KM field based on mode
    var kmContainer = document.getElementById("manual-km-container");
    if (kmContainer) {
      kmContainer.style.display = APP_CONFIG.MANUAL_KM_MODE ? "block" : "none";
    }

    function onAddressChange() {
      var pickup = pickupField.value.trim();
      var dest   = destField.value.trim();
      if (!pickup || !dest) return;
      if (bookingState.distanceFetchPending) return;

      if (APP_CONFIG.MANUAL_KM_MODE) {
        updateQuoteDisplay();
        return;
      }

      bookingState.distanceFetchPending = true;
      updateQuoteDisplay("Calculating distance...");

      fetchDrivingDistance(pickup, dest).then(function(km) {
        bookingState.distanceFetchPending = false;
        if (km === null) {
          if (kmContainer) kmContainer.style.display = "block";
          updateQuoteDisplay();
        } else {
          bookingState.rawDistanceKm = km;
          updateQuoteDisplay();
        }
      });
    }

    pickupField.addEventListener("input", debounce(onAddressChange, 800));
    destField.addEventListener("input",   debounce(onAddressChange, 800));
    if (kmField) {
      kmField.addEventListener("input", function() {
        bookingState.rawDistanceKm = parseFloat(this.value) || null;
        updateQuoteDisplay();
      });
    }

    ["vehicle-class", "cargo-type"].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("change", updateQuoteDisplay);
    });
  }

  // Cargo description character counter (shared pattern, used by all 3 types
  // via their own description fields — wired individually where each panel
  // is built, e.g. wireCargoDescriptionCounter("cargo-description", "cargo-description-count"))
  wireCargoDescriptionCounter("cargo-description", "cargo-description-count");

  // Time Hire panel listeners
  initTimeHireForm();

  // Default to Single Trip on load
  switchBookingType("SINGLE");
}

// Recalculate and render the Single Trip price quote
function updateQuoteDisplay(loadingMsg) {
  var quoteEl = document.getElementById("quote-display");
  if (!quoteEl) return;

  if (loadingMsg) {
    quoteEl.textContent = loadingMsg;
    return;
  }

  var vehicleClass = document.getElementById("vehicle-class")
    ? document.getElementById("vehicle-class").value : null;
  var cargoType = document.getElementById("cargo-type")
    ? document.getElementById("cargo-type").value : null;

  var kmInput = document.getElementById("manual-km");
  if (APP_CONFIG.MANUAL_KM_MODE && kmInput) {
    bookingState.rawDistanceKm = parseFloat(kmInput.value) || null;
  }

  if (!bookingState.rawDistanceKm || !vehicleClass || !cargoType) {
    quoteEl.textContent = "Fill in all fields to see your quote";
    bookingState.quoteResult = null;
    return;
  }

  var result = calculateQuote(bookingState.rawDistanceKm, vehicleClass, cargoType);
  if (!result) {
    quoteEl.textContent = "Unable to calculate. Check vehicle selection.";
    return;
  }

  bookingState.quoteResult = result;
  quoteEl.textContent = "KES " + Number(result.totalQuote).toLocaleString();

  var distEl = document.getElementById("distance-display");
  if (distEl) {
    distEl.textContent = result.factoredDistanceKm.toFixed(1) + " km (estimated driving distance)";
  }
}

// Handles "Confirm Booking" click for SINGLE trip type
function handleBookingSubmit() {
  var btn = document.getElementById("book-btn");
  if (btn) setButtonLoading(btn, true);

  var customerName      = getValue("customer-name");
  var customerMobile    = getValue("customer-mobile");
  var pickupAddress     = getValue("pickup-address");
  var destAddress       = getValue("dest-address");
  var vehicleClass      = getValue("vehicle-class");
  var cargoType         = getValue("cargo-type");
  var cargoDescription  = getValue("cargo-description");

  var errors = [];
  if (!customerName)   errors.push("Your name is required.");
  if (!customerMobile) errors.push("Mobile number is required.");
  if (!pickupAddress)  errors.push("Pickup address is required.");
  if (!destAddress)    errors.push("Destination address is required.");
  if (!vehicleClass)   errors.push("Please select a vehicle type.");
  if (!cargoType)      errors.push("Please select a cargo type.");
  if (cargoDescription.length > APP_CONFIG.CARGO_DESCRIPTION_MAX_LENGTH) {
    errors.push("Cargo description is too long — please shorten it.");
  }
  if (!bookingState.quoteResult) errors.push("Please wait for the price calculation to complete.");

  if (errors.length > 0) {
    showFormError("booking-error", errors.join(" "));
    if (btn) setButtonLoading(btn, false);
    return;
  }

  var termsCheck = document.getElementById("terms-agree");
  if (termsCheck && !termsCheck.checked) {
    showFormError("booking-error", "Please accept the Terms & Conditions to continue.");
    if (btn) setButtonLoading(btn, false);
    return;
  }

  var payload = Object.assign({
    customerName:       customerName,
    customerMobile:     customerMobile,
    pickupAddress:       pickupAddress,
    destinationAddress: destAddress,
    cargoClass:         vehicleClass,
    cargoType:          cargoType,
    cargoDescription:   cargoDescription,
    bookingType:        "SINGLE"
  }, bookingState.quoteResult);

  submitBooking(payload).then(function(response) {
    if (btn) setButtonLoading(btn, false);
    if (response.success) {
      showBookingSuccess({
        trackingCodes: [response.trackingCode],
        name: customerName, mobile: customerMobile,
        pickup: pickupAddress, dest: destAddress,
        vehicleClass: vehicleClass, cargoType: cargoType,
        totalQuote: bookingState.quoteResult.totalQuote
      });
    } else {
      showFormError("booking-error", response.error || "Booking failed. Please try again.");
    }
  }).catch(function(err) {
    if (btn) setButtonLoading(btn, false);
    showFormError("booking-error", "Connection error. Please check your internet and try again.");
    console.error("Booking submit error:", err);
  });
}


// =============================================================================
// SECTION 7C: MULTIPLE TRIPS FLOW (added v1.1)
// =============================================================================
// Renders repeating trip blocks (up to MAX_TRIPS_PER_BATCH). Each block has
// its own pickup/destination/vehicle/cargo fields and its own live quote,
// calculated the same way as Single Trip. On submit, all trips are sent in
// ONE request to submitBookingBatch() in Code.gs.

var nextTripBlockId = 1; // simple incrementing ID for DOM element naming

// Adds a new trip block to the Multiple Trips form
function addTripBlock() {
  if (bookingState.trips.length >= APP_CONFIG.MAX_TRIPS_PER_BATCH) {
    showToast("Maximum " + APP_CONFIG.MAX_TRIPS_PER_BATCH + " trips per booking.", "error");
    return;
  }

  var tripId = nextTripBlockId++;
  bookingState.trips.push({ id: tripId, rawDistanceKm: null, quoteResult: null, distanceFetchPending: false });

  var container = document.getElementById("trip-blocks-container");
  if (!container) return;

  var blockHtml = buildTripBlockHtml(tripId, bookingState.trips.length);
  container.insertAdjacentHTML("beforeend", blockHtml);

  wireTripBlockListeners(tripId);
  wireCargoDescriptionCounter("trip-cargo-desc-" + tripId, "trip-cargo-desc-count-" + tripId);
  updateMultiTripTotal();
  updateTripBlockNumbers();
}

// Removes a trip block by ID. Keeps at least MIN_TRIPS_PER_BATCH blocks —
// if a client wants fewer than that, they should use Single Trip instead.
function removeTripBlock(tripId) {
  if (bookingState.trips.length <= APP_CONFIG.MIN_TRIPS_PER_BATCH) {
    showToast("A Multiple Trips booking needs at least " + APP_CONFIG.MIN_TRIPS_PER_BATCH + " trips. Use Single Trip for one route.", "error");
    return;
  }
  bookingState.trips = bookingState.trips.filter(function(t) { return t.id !== tripId; });
  var blockEl = document.getElementById("trip-block-" + tripId);
  if (blockEl) blockEl.remove();
  updateMultiTripTotal();
  updateTripBlockNumbers();
}

// Builds the HTML for one trip block. Field IDs are suffixed with tripId so
// multiple blocks don't collide (e.g. "trip-pickup-3" for the 3rd block).
function buildTripBlockHtml(tripId, displayNumber) {
  return [
    "<div class='trip-block' id='trip-block-" + tripId + "'>",
    "  <div class='trip-block-header'>",
    "    <span class='trip-block-number'>Trip <span class='trip-display-number'>" + displayNumber + "</span></span>",
    "    <button type='button' class='trip-remove-btn' onclick='removeTripBlock(" + tripId + ")'>Remove</button>",
    "  </div>",
    "  <div class='form-group'>",
    "    <label class='form-label'>Pickup Location <span class='req'>*</span></label>",
    "    <input class='form-input' type='text' id='trip-pickup-" + tripId + "' placeholder='e.g. Industrial Area, Nairobi' />",
    "  </div>",
    "  <div class='form-group'>",
    "    <label class='form-label'>Destination <span class='req'>*</span></label>",
    "    <input class='form-input' type='text' id='trip-dest-" + tripId + "' placeholder='e.g. Thika Road, Ruiru' />",
    "  </div>",
    "  <div class='form-group' id='trip-km-container-" + tripId + "'>",
    "    <label class='form-label'>Approximate Distance (KM) <span class='req'>*</span></label>",
    "    <input class='form-input' type='number' id='trip-km-" + tripId + "' placeholder='e.g. 25' min='1' max='2000' />",
    "  </div>",
    "  <div class='form-row'>",
    "    <div class='form-group'>",
    "      <label class='form-label'>Vehicle Type <span class='req'>*</span></label>",
    "      <select class='form-select' id='trip-vehicle-" + tripId + "'>",
    "        <option value=''>Select vehicle...</option>",
    "        <option value='PICKUP'>1-Ton Pick-up</option>",
    "        <option value='CANTER'>3-Ton Canter</option>",
    "        <option value='LORRY'>10-Ton Lorry</option>",
    "      </select>",
    "    </div>",
    "    <div class='form-group'>",
    "      <label class='form-label'>Cargo Type <span class='req'>*</span></label>",
    "      <select class='form-select' id='trip-cargo-type-" + tripId + "'>",
    "        <option value=''>Select type...</option>",
    "        <option value='STANDARD'>Standard / General Goods</option>",
    "        <option value='FRAGILE'>Fragile / Electronics</option>",
    "        <option value='PERISHABLE'>Perishable / Cold Items</option>",
    "        <option value='BULKY'>Bulky / Construction Materials</option>",
    "      </select>",
    "    </div>",
    "  </div>",
    "  <div class='form-group'>",
    "    <label class='form-label'>Describe Your Goods <span class='req'>*</span></label>",
    "    <textarea class='form-input' id='trip-cargo-desc-" + tripId + "' rows='2' maxlength='" + APP_CONFIG.CARGO_DESCRIPTION_MAX_LENGTH + "' placeholder='e.g. 50 bags of cement, approx 2 tons'></textarea>",
    "    <p class='form-hint'>Keep it short and specific — this helps your driver prepare. <span id='trip-cargo-desc-count-" + tripId + "'>0</span>/" + APP_CONFIG.CARGO_DESCRIPTION_MAX_LENGTH + "</p>",
    "  </div>",
    "  <div class='trip-quote-line'>",
    "    <span>Trip price:</span>",
    "    <span class='trip-quote-amount' id='trip-quote-" + tripId + "'>—</span>",
    "  </div>",
    "</div>"
  ].join("\n");
}

// Renumbers visible "Trip 1", "Trip 2"... labels after add/remove
function updateTripBlockNumbers() {
  bookingState.trips.forEach(function(trip, index) {
    var el = document.querySelector("#trip-block-" + trip.id + " .trip-display-number");
    if (el) el.textContent = index + 1;
  });
}

// Wires input listeners for one trip block's fields
function wireTripBlockListeners(tripId) {
  var pickupField = document.getElementById("trip-pickup-" + tripId);
  var destField    = document.getElementById("trip-dest-" + tripId);
  var kmField      = document.getElementById("trip-km-" + tripId);
  var kmContainer  = document.getElementById("trip-km-container-" + tripId);

  if (kmContainer) kmContainer.style.display = APP_CONFIG.MANUAL_KM_MODE ? "block" : "none";

  function recalc() {
    updateTripBlockQuote(tripId);
  }

  function onAddressChange() {
    var trip = bookingState.trips.find(function(t) { return t.id === tripId; });
    if (!trip) return;
    var pickup = pickupField.value.trim();
    var dest   = destField.value.trim();
    if (!pickup || !dest) return;
    if (trip.distanceFetchPending) return;

    if (APP_CONFIG.MANUAL_KM_MODE) { recalc(); return; }

    trip.distanceFetchPending = true;
    fetchDrivingDistance(pickup, dest).then(function(km) {
      trip.distanceFetchPending = false;
      if (km === null) {
        if (kmContainer) kmContainer.style.display = "block";
      } else {
        trip.rawDistanceKm = km;
      }
      recalc();
    });
  }

  if (pickupField) pickupField.addEventListener("input", debounce(onAddressChange, 800));
  if (destField)   destField.addEventListener("input",   debounce(onAddressChange, 800));
  if (kmField) {
    kmField.addEventListener("input", function() {
      var trip = bookingState.trips.find(function(t) { return t.id === tripId; });
      if (trip) trip.rawDistanceKm = parseFloat(this.value) || null;
      recalc();
    });
  }

  ["trip-vehicle-" + tripId, "trip-cargo-type-" + tripId].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("change", recalc);
  });
}

// Recalculates one trip block's price and updates its display + the running total
function updateTripBlockQuote(tripId) {
  var trip = bookingState.trips.find(function(t) { return t.id === tripId; });
  if (!trip) return;

  var vehicleClass = getValue("trip-vehicle-" + tripId);
  var cargoType    = getValue("trip-cargo-type-" + tripId);
  var kmInput      = document.getElementById("trip-km-" + tripId);

  if (APP_CONFIG.MANUAL_KM_MODE && kmInput) {
    trip.rawDistanceKm = parseFloat(kmInput.value) || null;
  }

  var quoteEl = document.getElementById("trip-quote-" + tripId);

  if (!trip.rawDistanceKm || !vehicleClass || !cargoType) {
    trip.quoteResult = null;
    if (quoteEl) quoteEl.textContent = "—";
    updateMultiTripTotal();
    return;
  }

  var result = calculateQuote(trip.rawDistanceKm, vehicleClass, cargoType);
  trip.quoteResult = result;
  if (quoteEl && result) {
    quoteEl.textContent = "KES " + Number(result.totalQuote).toLocaleString();
  }
  updateMultiTripTotal();
}

// Sums all priced trips and displays the batch total
function updateMultiTripTotal() {
  var totalEl = document.getElementById("multi-trip-total");
  if (!totalEl) return;

  var total = 0;
  var pricedCount = 0;
  bookingState.trips.forEach(function(trip) {
    if (trip.quoteResult) {
      total += trip.quoteResult.totalQuote;
      pricedCount++;
    }
  });

  if (pricedCount === 0) {
    totalEl.textContent = "Fill in trip details to see total";
  } else if (pricedCount < bookingState.trips.length) {
    totalEl.textContent = "KES " + total.toLocaleString() + " so far (" + pricedCount + "/" + bookingState.trips.length + " trips priced)";
  } else {
    totalEl.textContent = "KES " + total.toLocaleString();
  }
}

// Handles "Confirm All Trips" click for MULTI_TRIP booking type
function handleMultiTripSubmit() {
  var btn = document.getElementById("multi-trip-book-btn");
  if (btn) setButtonLoading(btn, true);

  var customerName   = getValue("multi-customer-name");
  var customerMobile = getValue("multi-customer-mobile");

  var errors = [];
  if (!customerName)   errors.push("Your name is required.");
  if (!customerMobile) errors.push("Mobile number is required.");
  if (bookingState.trips.length < APP_CONFIG.MIN_TRIPS_PER_BATCH) {
    errors.push("Add at least " + APP_CONFIG.MIN_TRIPS_PER_BATCH + " trips.");
  }

  // Validate every trip block has a complete quote
  var trips = [];
  bookingState.trips.forEach(function(trip, index) {
    var pickup  = getValue("trip-pickup-" + trip.id);
    var dest    = getValue("trip-dest-" + trip.id);
    var desc    = getValue("trip-cargo-desc-" + trip.id);
    if (!pickup || !dest || !trip.quoteResult) {
      errors.push("Trip " + (index + 1) + " is incomplete.");
      return;
    }
    trips.push(Object.assign({
      pickupAddress:       pickup,
      destinationAddress: dest,
      cargoClass:          trip.quoteResult.vehicleClass,
      cargoType:           trip.quoteResult.cargoType,
      cargoDescription:    desc
    }, trip.quoteResult));
  });

  if (errors.length > 0) {
    showFormError("multi-trip-error", errors.join(" "));
    if (btn) setButtonLoading(btn, false);
    return;
  }

  var termsCheck = document.getElementById("multi-terms-agree");
  if (termsCheck && !termsCheck.checked) {
    showFormError("multi-trip-error", "Please accept the Terms & Conditions to continue.");
    if (btn) setButtonLoading(btn, false);
    return;
  }

  submitBookingBatch({
    customerName:   customerName,
    customerMobile: customerMobile,
    trips:          trips
  }).then(function(response) {
    if (btn) setButtonLoading(btn, false);
    if (response.success) {
      // Build a route summary string for the WhatsApp message
      var routeSummary = trips.map(function(t) {
        return t.pickupAddress + "→" + t.destinationAddress;
      }).join(" | ");

      showBookingSuccess({
        trackingCodes: response.trackingCodes,
        batchId:       response.batchId,
        name: customerName, mobile: customerMobile,
        pickup: trips.length + " trips", dest: routeSummary,
        vehicleClass: "MULTIPLE", cargoType: "VARIED",
        totalQuote: response.totalBatchQuote
      });
    } else {
      showFormError("multi-trip-error", response.error || "Booking failed. Please try again.");
    }
  }).catch(function(err) {
    if (btn) setButtonLoading(btn, false);
    showFormError("multi-trip-error", "Connection error. Please check your internet and try again.");
    console.error("Multi-trip submit error:", err);
  });
}


// =============================================================================
// SECTION 7D: TIME HIRE FLOW (added v1.1)
// =============================================================================
// One vehicle, one cargo type, N hours. Simplest of the three flows — no
// distance involved, no repeating blocks.

function initTimeHireForm() {
  ["hire-vehicle-class", "hire-cargo-type", "hire-hours"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(id === "hire-hours" ? "input" : "change", updateTimeHireQuoteDisplay);
  });
  wireCargoDescriptionCounter("hire-cargo-description", "hire-cargo-description-count");
}

function updateTimeHireQuoteDisplay() {
  var quoteEl = document.getElementById("hire-quote-display");
  if (!quoteEl) return;

  var vehicleClass = getValue("hire-vehicle-class");
  var cargoType    = getValue("hire-cargo-type");
  var hours        = parseFloat(getValue("hire-hours"));

  if (!vehicleClass || !cargoType || !hours) {
    quoteEl.textContent = "Fill in all fields to see your quote";
    bookingState.timeHireQuoteResult = null;
    return;
  }

  if (hours < APP_CONFIG.TIME_HIRE_MIN_HOURS) {
    quoteEl.textContent = "Minimum hire is " + APP_CONFIG.TIME_HIRE_MIN_HOURS + " hours";
    bookingState.timeHireQuoteResult = null;
    return;
  }
  if (hours > APP_CONFIG.TIME_HIRE_MAX_HOURS) {
    quoteEl.textContent = "For hires over " + APP_CONFIG.TIME_HIRE_MAX_HOURS + " hours, please contact us directly on WhatsApp for a custom quote.";
    bookingState.timeHireQuoteResult = null;
    return;
  }

  var result = calculateTimeHireQuote(hours, vehicleClass, cargoType);
  if (!result) {
    quoteEl.textContent = "Unable to calculate. Check your selections.";
    return;
  }

  bookingState.timeHireQuoteResult = result;
  quoteEl.textContent = "KES " + Number(result.totalQuote).toLocaleString();
}

// Handles "Confirm Hire" click for TIME_HIRE booking type
function handleTimeHireSubmit() {
  var btn = document.getElementById("hire-book-btn");
  if (btn) setButtonLoading(btn, true);

  var customerName      = getValue("hire-customer-name");
  var customerMobile    = getValue("hire-customer-mobile");
  var hireLocation       = getValue("hire-location");
  var hours              = getValue("hire-hours");
  var vehicleClass       = getValue("hire-vehicle-class");
  var cargoType           = getValue("hire-cargo-type");
  var cargoDescription   = getValue("hire-cargo-description");

  var errors = [];
  if (!customerName)   errors.push("Your name is required.");
  if (!customerMobile) errors.push("Mobile number is required.");
  if (!hireLocation)   errors.push("Hire location/area is required.");
  if (!vehicleClass)   errors.push("Please select a vehicle type.");
  if (!cargoType)       errors.push("Please select a cargo type.");
  if (!bookingState.timeHireQuoteResult) errors.push("Please complete the hire details to see a price.");

  if (errors.length > 0) {
    showFormError("hire-error", errors.join(" "));
    if (btn) setButtonLoading(btn, false);
    return;
  }

  var termsCheck = document.getElementById("hire-terms-agree");
  if (termsCheck && !termsCheck.checked) {
    showFormError("hire-error", "Please accept the Terms & Conditions to continue.");
    if (btn) setButtonLoading(btn, false);
    return;
  }

  // TIME_HIRE repurposes pickupAddress/destinationAddress per the field
  // notes in Code.gs Section 5 — pickup holds the hire location, destination
  // holds a short human-readable summary of the hire.
  var hireSummary = "Time Hire — " + hours + " hours";

  var payload = Object.assign({
    customerName:        customerName,
    customerMobile:      customerMobile,
    pickupAddress:        hireLocation,
    destinationAddress:  hireSummary,
    cargoClass:           vehicleClass,
    cargoType:             cargoType,
    cargoDescription:     cargoDescription,
    bookingType:           "TIME_HIRE"
  }, bookingState.timeHireQuoteResult);

  submitBooking(payload).then(function(response) {
    if (btn) setButtonLoading(btn, false);
    if (response.success) {
      showBookingSuccess({
        trackingCodes: [response.trackingCode],
        name: customerName, mobile: customerMobile,
        pickup: hireLocation, dest: hireSummary,
        vehicleClass: vehicleClass, cargoType: cargoType,
        totalQuote: bookingState.timeHireQuoteResult.totalQuote
      });
    } else {
      showFormError("hire-error", response.error || "Booking failed. Please try again.");
    }
  }).catch(function(err) {
    if (btn) setButtonLoading(btn, false);
    showFormError("hire-error", "Connection error. Please check your internet and try again.");
    console.error("Time hire submit error:", err);
  });
}


// =============================================================================
// SECTION 7E: SHARED SUCCESS DISPLAY (all three booking types funnel here)
// =============================================================================
// data shape: { trackingCodes: [...], batchId?, name, mobile, pickup, dest,
//               vehicleClass, cargoType, totalQuote }

function showBookingSuccess(data) {
  // Hide all three form panels, show the shared success panel
  ["booking-form", "panel-multi", "panel-hire"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });
  var successEl = document.getElementById("booking-success");
  if (successEl) successEl.classList.remove("hidden");

  // Show either a single tracking code, or a list if it's a batch
  var codeEl = document.getElementById("success-tracking-code");
  var codeListEl = document.getElementById("success-tracking-code-list");
  if (data.trackingCodes.length === 1) {
    if (codeEl) { codeEl.textContent = data.trackingCodes[0]; codeEl.classList.remove("hidden"); }
    if (codeListEl) codeListEl.classList.add("hidden");
  } else {
    if (codeEl) codeEl.classList.add("hidden");
    if (codeListEl) {
      codeListEl.classList.remove("hidden");
      codeListEl.innerHTML = data.trackingCodes.map(function(code) {
        return "<span class='tracking-code-chip'>" + code + "</span>";
      }).join("");
    }
  }

  var waLink = buildOpsBookingMessage(
    data.totalQuote, data.trackingCodes.join(", "), data.name, data.mobile,
    data.pickup, data.dest, data.vehicleClass, data.cargoType
  );
  var waBtn = document.getElementById("whatsapp-confirm-btn");
  if (waBtn) { waBtn.href = waLink; waBtn.target = "_blank"; }
}


// =============================================================================
// SECTION 7F: CARGO DESCRIPTION CHARACTER COUNTER (shared utility)
// =============================================================================
// Wires a live character counter under any cargo-description textarea so
// clients can see they're within the limit without guessing. Used by all
// three booking type panels.

function wireCargoDescriptionCounter(fieldId, counterId) {
  var field   = document.getElementById(fieldId);
  var counter = document.getElementById(counterId);
  if (!field || !counter) return;

  function update() {
    counter.textContent = field.value.length;
    counter.classList.toggle("char-count-warning",
      field.value.length > APP_CONFIG.CARGO_DESCRIPTION_MAX_LENGTH * 0.9);
  }
  field.addEventListener("input", update);
  update();
}


// =============================================================================
// SECTION 8: ORDER TRACKING FLOW (index.html)
// =============================================================================
// Client enters tracking code or mobile number to see their order status.
// Driver details are revealed once a driver has been assigned.

function handleTrackingLookup() {
  var btn = document.getElementById("track-btn");
  if (btn) setButtonLoading(btn, true);

  var trackingCode = getValue("track-code");
  var mobile       = getValue("track-mobile");

  if (!trackingCode && !mobile) {
    showFormError("tracking-error", "Enter your tracking code or mobile number.");
    if (btn) setButtonLoading(btn, false);
    return;
  }

  // Clear previous results
  var resultEl = document.getElementById("tracking-result");
  if (resultEl) resultEl.classList.add("hidden");

  trackOrder(trackingCode || null, mobile || null)
    .then(function(response) {
      if (btn) setButtonLoading(btn, false);
      if (response.success) {
        renderTrackingResult(response);
      } else {
        showFormError("tracking-error", response.error || "Order not found.");
      }
    })
    .catch(function(err) {
      if (btn) setButtonLoading(btn, false);
      showFormError("tracking-error", "Connection error. Please try again.");
      console.error("Tracking error:", err);
    });
}

// Render the tracking result including driver details if assigned
function renderTrackingResult(data) {
  var resultEl = document.getElementById("tracking-result");
  if (!resultEl) return;

  // Status badge
  var statusEl = document.getElementById("tr-status");
  if (statusEl) {
    statusEl.textContent = data.statusLabel || data.status;
    // Colour the badge based on status
    statusEl.className = "status-badge status-" + data.status.toLowerCase().replace(/_/g, "-");
  }

  // Route info
  setText("tr-tracking-code", data.trackingCode);
  setText("tr-pickup",        data.pickup);
  setText("tr-destination",   data.destination);
  setText("tr-vehicle",       data.cargoClass);
  setText("tr-cargo",         data.cargoType);
  setText("tr-quote",         "KES " + Number(data.totalQuote).toLocaleString());

  // Driver details section — only shown when driver is assigned
  var driverSection = document.getElementById("tr-driver-section");
  if (data.driver && driverSection) {
    driverSection.classList.remove("hidden");
    setText("tr-driver-name",     data.driver.name     || "—");
    setText("tr-driver-plate",    data.driver.plate    || "—");
    setText("tr-driver-whatsapp", data.driver.whatsapp || "—");

    // WhatsApp link to contact the driver directly
    var driverWaBtn = document.getElementById("tr-driver-whatsapp-link");
    if (driverWaBtn && data.driver.whatsapp) {
      var driverMsg = "Hello, I have a " + APP_CONFIG.APP_NAME + " delivery with tracking code " +
                      data.trackingCode + ". When will you arrive?";
      driverWaBtn.href = buildWhatsAppLink(data.driver.whatsapp, driverMsg);
      driverWaBtn.target = "_blank";
    }
  } else if (driverSection) {
    driverSection.classList.add("hidden");
  }

  resultEl.classList.remove("hidden");
}


// =============================================================================
// SECTION 9: DRIVER PORTAL LOGIC (driver.html)
// =============================================================================
// Manages the three driver states: login | job board | registration
// State is held in driverState — cleared on logout.

var driverState = {
  loggedIn: false,
  driver: null  // { name, whatsapp, plate, cargoClass }
};

// Called from driver.html on load
function initDriverApp() {
  // Check for existing session (simple localStorage — not secure, but functional for v1)
  // TODO: SECURITY — for stronger session management, use a signed token
  // (e.g. JWT) rather than raw localStorage. Acceptable for v1 small driver pool.
  var saved = localStorage.getItem("sh_driver_session");
  if (saved) {
    try {
      var session = JSON.parse(saved);
      if (session && session.driver) {
        driverState.loggedIn = true;
        driverState.driver   = session.driver;
        showDriverView("job-board");
        loadJobBoard();
        return;
      }
    } catch(e) { localStorage.removeItem("sh_driver_session"); }
  }
  showDriverView("login");
}

// Driver views: login | job-board | registration
var DRIVER_VIEWS = ["login", "job-board", "registration"];

function showDriverView(viewName) {
  DRIVER_VIEWS.forEach(function(v) {
    var el = document.getElementById("dview-" + v);
    if (el) el.classList.add("hidden");
  });
  var target = document.getElementById("dview-" + viewName);
  if (target) target.classList.remove("hidden");
}

// Driver login handler
function handleDriverLogin() {
  var btn = document.getElementById("driver-login-btn");
  if (btn) setButtonLoading(btn, true);
  clearError("driver-login-error");

  var whatsapp = getValue("driver-whatsapp");
  var pin      = getValue("driver-pin");

  if (!whatsapp || !pin) {
    showFormError("driver-login-error", "WhatsApp number and PIN are required.");
    if (btn) setButtonLoading(btn, false);
    return;
  }

  loginDriver(whatsapp, pin).then(function(response) {
    if (btn) setButtonLoading(btn, false);
    if (response.success) {
      driverState.loggedIn = true;
      driverState.driver   = response.driver;
      // Save session to localStorage (cleared on logout or browser clear)
      localStorage.setItem("sh_driver_session", JSON.stringify({ driver: response.driver }));
      showDriverView("job-board");
      loadJobBoard();
    } else {
      showFormError("driver-login-error", response.error || "Login failed.");
    }
  }).catch(function(err) {
    if (btn) setButtonLoading(btn, false);
    showFormError("driver-login-error", "Connection error. Please try again.");
    console.error("Login error:", err);
  });
}

// Load available jobs for the logged-in driver
function loadJobBoard() {
  if (!driverState.driver) { showDriverView("login"); return; }

  // Show driver's name and vehicle info in the header
  setText("driver-welcome-name", driverState.driver.name);
  setText("driver-vehicle-info",
    (driverState.driver.cargoClass || "").toUpperCase() + " — " + driverState.driver.plate);

  var jobListEl = document.getElementById("job-list");
  if (jobListEl) jobListEl.innerHTML = "<p class='loading-msg'>Loading available jobs...</p>";

  fetchOpenJobs(driverState.driver.cargoClass.toUpperCase())
    .then(function(response) {
      if (response.success) {
        renderJobList(response.jobs);
      } else {
        if (jobListEl) jobListEl.innerHTML = "<p class='error-msg'>" + (response.error || "Failed to load jobs.") + "</p>";
      }
    })
    .catch(function(err) {
      if (jobListEl) jobListEl.innerHTML = "<p class='error-msg'>Connection error loading jobs. Refresh to retry.</p>";
      console.error("Job board error:", err);
    });
}

// Render the list of available jobs as cards
function renderJobList(jobs) {
  var jobListEl = document.getElementById("job-list");
  if (!jobListEl) return;

  if (!jobs || jobs.length === 0) {
    jobListEl.innerHTML = "<p class='empty-msg'>No jobs available right now. Check back soon or refresh.</p>";
    return;
  }

  var html = jobs.map(function(job) {
    return [
      "<div class='job-card' id='job-" + job.trackingCode + "'>",
      "  <div class='job-card-header'>",
      "    <span class='job-tracking'>#" + job.trackingCode + "</span>",
      "    <span class='job-class'>" + job.cargoClass + "</span>",
      "  </div>",
      "  <div class='job-route'>" + escapeHtml(job.route) + "</div>",
      "  <div class='job-footer'>",
      "    <span class='job-quote'>KES " + Number(job.quote).toLocaleString() + "</span>",
      "    <button class='btn-accept' onclick='handleAcceptJob(\"" + job.trackingCode + "\")'>",
      "      Accept Job",
      "    </button>",
      "  </div>",
      "</div>"
    ].join("\n");
  }).join("\n");

  jobListEl.innerHTML = html;
}

// Driver accepts a job
function handleAcceptJob(trackingCode) {
  if (!driverState.driver) { showDriverView("login"); return; }

  // Disable the accept button immediately to prevent double-tap
  var jobCard = document.getElementById("job-" + trackingCode);
  var acceptBtn = jobCard ? jobCard.querySelector(".btn-accept") : null;
  if (acceptBtn) {
    acceptBtn.disabled = true;
    acceptBtn.textContent = "Accepting...";
  }

  acceptJob(trackingCode, driverState.driver)
    .then(function(response) {
      if (response.success) {
        // Remove the accepted card from the list
        if (jobCard) jobCard.remove();
        showToast("Job accepted! Check your WhatsApp for client details.");
        // Check if board is now empty
        var jobListEl = document.getElementById("job-list");
        if (jobListEl && !jobListEl.querySelector(".job-card")) {
          jobListEl.innerHTML = "<p class='empty-msg'>No more jobs available. Refresh to check for new ones.</p>";
        }
      } else {
        // Job was taken by someone else — remove it and show message
        if (jobCard) jobCard.remove();
        showToast(response.error || "This job is no longer available.", "error");
      }
    })
    .catch(function(err) {
      if (acceptBtn) {
        acceptBtn.disabled = false;
        acceptBtn.textContent = "Accept Job";
      }
      showToast("Connection error. Please try again.", "error");
      console.error("Accept job error:", err);
    });
}

// Driver logout
function handleDriverLogout() {
  driverState.loggedIn = false;
  driverState.driver   = null;
  localStorage.removeItem("sh_driver_session");
  showDriverView("login");
}

// Driver registration handler
function handleDriverRegistration() {
  var btn = document.getElementById("driver-reg-btn");
  if (btn) setButtonLoading(btn, true);
  clearError("driver-reg-error");

  var driverName = getValue("reg-name");
  var whatsapp   = getValue("reg-whatsapp");
  var plate      = getValue("reg-plate");
  var cargoClass = getValue("reg-cargo-class");
  var pin        = getValue("reg-pin");
  var pinConfirm = getValue("reg-pin-confirm");

  // Validate
  var errors = [];
  if (!driverName)  errors.push("Full name required.");
  if (!whatsapp)    errors.push("WhatsApp number required.");
  if (!plate)       errors.push("Vehicle plate required.");
  if (!cargoClass)  errors.push("Vehicle type required.");
  if (!pin)         errors.push("PIN required.");
  if (!/^\d{4}$/.test(pin)) errors.push("PIN must be exactly 4 digits.");
  if (pin !== pinConfirm)   errors.push("PINs do not match.");

  // Check driver T&Cs agreement
  var termsCheck = document.getElementById("driver-terms-agree");
  if (termsCheck && !termsCheck.checked) errors.push("Please accept the Driver Terms & Conditions.");

  if (errors.length > 0) {
    showFormError("driver-reg-error", errors.join(" "));
    if (btn) setButtonLoading(btn, false);
    return;
  }

  registerDriver({ driverName, whatsapp, plate, cargoClass, pin })
    .then(function(response) {
      if (btn) setButtonLoading(btn, false);
      if (response.success) {
        // Show success message + WhatsApp verification link
        var regForm    = document.getElementById("driver-reg-form");
        var regSuccess = document.getElementById("driver-reg-success");
        if (regForm)    regForm.classList.add("hidden");
        if (regSuccess) regSuccess.classList.remove("hidden");

        // Open WhatsApp to ops with verification details
        var waLink = buildOpsDriverRegMessage(driverName, whatsapp, plate, cargoClass);
        var waBtn  = document.getElementById("driver-reg-wa-btn");
        if (waBtn) {
          waBtn.href   = waLink;
          waBtn.target = "_blank";
        }
      } else {
        showFormError("driver-reg-error", response.error || "Registration failed.");
      }
    })
    .catch(function(err) {
      if (btn) setButtonLoading(btn, false);
      showFormError("driver-reg-error", "Connection error. Please try again.");
      console.error("Registration error:", err);
    });
}


// =============================================================================
// SECTION 10: UI UTILITIES
// =============================================================================
// Reusable helper functions for DOM manipulation, validation, and feedback.

// Get trimmed value from an input element by ID
function getValue(id) {
  var el = document.getElementById(id);
  return el ? el.value.trim() : "";
}

// Set text content of an element by ID (safe — no HTML injection)
function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text || "—";
}

// Show a form error message
function showFormError(errorElId, message) {
  var el = document.getElementById(errorElId);
  if (el) {
    el.textContent = message;
    el.classList.remove("hidden");
  }
}

// Clear an error message
function clearError(errorElId) {
  var el = document.getElementById(errorElId);
  if (el) {
    el.textContent = "";
    el.classList.add("hidden");
  }
}

// Toggle button loading state
function setButtonLoading(btn, isLoading) {
  if (!btn) return;
  btn.disabled = isLoading;
  if (isLoading) {
    btn.dataset.originalText = btn.textContent;
    btn.textContent = "Please wait...";
  } else {
    btn.textContent = btn.dataset.originalText || "Submit";
  }
}

// Show a toast notification (non-blocking feedback)
function showToast(message, type) {
  var toast = document.createElement("div");
  toast.className = "toast toast-" + (type || "success");
  toast.textContent = message;
  document.body.appendChild(toast);
  // Animate in
  setTimeout(function() { toast.classList.add("toast-visible"); }, 10);
  // Auto-dismiss after 4 seconds
  setTimeout(function() {
    toast.classList.remove("toast-visible");
    setTimeout(function() { toast.remove(); }, 400);
  }, 4000);
}

// Debounce — prevents functions from firing too rapidly (e.g. on keypress)
function debounce(fn, delay) {
  var timer;
  return function() {
    var args = arguments;
    var ctx  = this;
    clearTimeout(timer);
    timer = setTimeout(function() { fn.apply(ctx, args); }, delay);
  };
}

// Escape HTML to prevent XSS when inserting user content into innerHTML
function escapeHtml(str) {
  var div = document.createElement("div");
  div.appendChild(document.createTextNode(str || ""));
  return div.innerHTML;
}

// Entry point — called from index.html
function initApp() {
  // Determine initial view from URL hash or default to booking
  var hash = window.location.hash.replace("#", "") || "booking";
  if (VIEWS.indexOf(hash) < 0) hash = "booking";
  showView(hash);
  initBookingForm();
}
