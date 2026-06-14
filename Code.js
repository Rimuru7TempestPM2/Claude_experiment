// =============================================================================
// SwiftHaul Logistics — Google Apps Script Backend (Code.gs)
// Version: 1.0.0
// =============================================================================
//
// WHAT THIS FILE DOES:
//   Acts as the serverless API gateway between the frontend (index.html /
//   driver.html) and the Google Sheets database. All requests arrive as HTTP
//   GET/POST calls to the deployed Web App URL. This file routes them,
//   validates them, reads/writes to Sheets, and returns JSON responses.
//
// HOW IT IS DEPLOYED:
//   1. Open your Google Sheet → Extensions → Apps Script
//   2. Paste this entire file into the editor (replace any existing code)
//   3. Click Deploy → New Deployment → Web App
//      - Execute as: Me (your Google account)
//      - Who has access: Anyone
//   4. Copy the Web App URL and paste it into app.js as BACKEND_URL
//   5. Re-deploy (create new version) every time you change this file
//
// SHEET TAB NAMES (must match EXACTLY — case-sensitive, no spaces):
//   ClientBookingsLedger | VerifiedDriversPool | JobBoard
//
// =============================================================================


// =============================================================================
// SECTION 1: GLOBAL CONFIGURATION
// =============================================================================
// All operational constants live here. Edit ONLY this section — never hardcode
// these values inside the functions below.

var CONFIG = {

  // TODO: SHEET ID
  // Replace "YOUR_GOOGLE_SHEET_ID_HERE" with your actual Sheet ID.
  // Found in the Sheet URL: docs.google.com/spreadsheets/d/YOUR_ID_HERE/edit
  SHEET_ID: "YOUR_GOOGLE_SHEET_ID_HERE",

  // Sheet tab names — must match the actual tab names character-for-character
  TABS: {
    BOOKINGS: "ClientBookingsLedger",
    DRIVERS:  "VerifiedDriversPool",
    JOBBOARD: "JobBoard"
  },

  // Tracking code prefix — matches your branding. "SH" → codes like "SH-A3F9K2M1"
  // Change this once the final business name is confirmed.
  TRACKING_PREFIX: "SH",

  // Random characters in tracking code. 8 chars = 36^8 ≈ 2.8 trillion combos.
  // Safe against sequential guessing attacks.
  TRACKING_RANDOM_LENGTH: 8,

  // Lock timeout in ms for job-accept race condition guard.
  // 3000ms = 3 seconds. Second driver waits this long, then gets "unavailable".
  LOCK_TIMEOUT_MS: 3000,
};


// =============================================================================
// SECTION 2: HTTP REQUEST ROUTER
// =============================================================================
// Apps Script exposes two HTTP endpoints: doGet() and doPost().
// We route different operations using an "action" parameter.
//
// GET actions:  trackOrder | getOpenJobs | loginDriver
// POST actions: submitBooking | acceptJob | registerDriver

function doGet(e) {
  Logger.log("doGet | action: " + (e.parameter.action || "none"));
  var action = e.parameter.action;
  try {
    switch (action) {
      case "trackOrder":  return respond(trackOrder(e.parameter));
      case "getOpenJobs": return respond(getOpenJobs(e.parameter));
      case "loginDriver": return respond(loginDriver(e.parameter));
      default: return respond({ success: false, error: "Unknown GET action: " + action });
    }
  } catch (err) {
    Logger.log("doGet error: " + err.message);
    return respond({ success: false, error: "Server error: " + err.message });
  }
}

function doPost(e) {
  Logger.log("doPost called");
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (parseErr) {
    return respond({ success: false, error: "Invalid JSON body." });
  }
  Logger.log("doPost action: " + body.action);
  try {
    switch (body.action) {
      case "submitBooking":  return respond(submitBooking(body));
      case "acceptJob":      return respond(acceptJob(body));
      case "registerDriver": return respond(registerDriver(body));
      default: return respond({ success: false, error: "Unknown POST action: " + body.action });
    }
  } catch (err) {
    Logger.log("doPost error: " + err.message);
    return respond({ success: false, error: "Server error: " + err.message });
  }
}

// Wrap any object as a JSON response
function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}


// =============================================================================
// SECTION 3: SHEET ACCESS HELPERS
// =============================================================================
// Tab names only ever appear here — change CONFIG.TABS above to rename them.

function getSpreadsheet() {
  return SpreadsheetApp.openById(CONFIG.SHEET_ID);
}

function getBookingsSheet() {
  var s = getSpreadsheet().getSheetByName(CONFIG.TABS.BOOKINGS);
  if (!s) throw new Error("Tab '" + CONFIG.TABS.BOOKINGS + "' not found. Check name (case-sensitive).");
  return s;
}

function getDriversSheet() {
  var s = getSpreadsheet().getSheetByName(CONFIG.TABS.DRIVERS);
  if (!s) throw new Error("Tab '" + CONFIG.TABS.DRIVERS + "' not found.");
  return s;
}

function getJobBoardSheet() {
  var s = getSpreadsheet().getSheetByName(CONFIG.TABS.JOBBOARD);
  if (!s) throw new Error("Tab '" + CONFIG.TABS.JOBBOARD + "' not found.");
  return s;
}


// =============================================================================
// SECTION 4: TRACKING CODE GENERATOR
// =============================================================================
// Format: PREFIX-XXXXXXXX  e.g. "SH-A3F9K2M1"
// 8 alphanumeric chars = ~2.8 trillion combos → sequential guessing impractical.

function generateTrackingCode() {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  var result = CONFIG.TRACKING_PREFIX + "-";
  for (var i = 0; i < CONFIG.TRACKING_RANDOM_LENGTH; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}


// =============================================================================
// SECTION 5: CLIENT BOOKING SUBMISSION
// =============================================================================
// Called when client clicks "Confirm Booking".
// Writes row to ClientBookingsLedger with status PENDING_CONFIRMATION.
// Job is NOT visible to drivers until ops manually sets status to OPEN.
//
// Expected body fields:
//   customerName, customerMobile, pickupAddress, destinationAddress,
//   cargoClass, cargoType, factoredDistanceKm, epraFuelPrice,
//   surchargePercent, totalQuoteKes, driverCutKes, platformFeeKes

function submitBooking(body) {
  // Validate required fields
  var required = ["customerName","customerMobile","pickupAddress","destinationAddress",
                  "cargoClass","cargoType","factoredDistanceKm","totalQuoteKes"];
  for (var i = 0; i < required.length; i++) {
    if (!body[required[i]] && body[required[i]] !== 0) {
      return { success: false, error: "Missing required field: " + required[i] };
    }
  }

  // Sanitise mobile
  var mobile = String(body.customerMobile).replace(/\s+/g, "");
  if (!/^\d{9,12}$/.test(mobile)) {
    return { success: false, error: "Invalid mobile number. Use 9-12 digits." };
  }

  var trackingCode = generateTrackingCode();
  var now = new Date();

  // Row mapped to ClientBookingsLedger columns A→P
  var row = [
    now,                                    // A: System Entry Date
    body.customerName,                      // B: Customer Name
    mobile,                                 // C: Customer Mobile
    body.pickupAddress,                     // D: Pickup Address
    body.destinationAddress,                // E: Destination Address
    String(body.cargoClass).toUpperCase(),  // F: Cargo Class Code
    String(body.cargoType).toUpperCase(),   // G: Cargo Type Risk Factor
    body.factoredDistanceKm,                // H: Factored Distance (KM) — post 1.3x buffer
    body.epraFuelPrice || "",               // I: EPRA Index Price used at time of quote
    body.surchargePercent || 0,             // J: Surcharge Applied %
    body.totalQuoteKes,                     // K: Total Gross Cost (KES)
    body.driverCutKes || "",                // L: Driver Cut
    body.platformFeeKes || "",              // M: Platform Fee
    "PENDING_CONFIRMATION",                  // N: Job Status
    "",                                     // O: Matched Driver (empty until accepted)
    trackingCode                            // P: Tracking Code
  ];

  getBookingsSheet().appendRow(row);
  Logger.log("Booking logged: " + trackingCode + " | " + body.customerName);

  return {
    success: true,
    trackingCode: trackingCode,
    message: "Booking received. We will confirm via WhatsApp shortly."
  };
}


// =============================================================================
// SECTION 6: ORDER TRACKING LOOKUP
// =============================================================================
// Client queries by Tracking Code OR mobile number.
// Returns job status + driver details if a driver has been assigned.
// Driver contact shown ONLY after status = ACCEPTED / IN_PROGRESS / COMPLETED.
//
// Privacy protection: tracking codes are 8-char random — safe against guessing.
// Mobile lookup returns the most recent booking for that number.

// Human-readable status labels shown to clients
var STATUS_LABELS = {
  "PENDING_CONFIRMATION": "Awaiting Confirmation — we'll WhatsApp you shortly",
  "OPEN":                 "Confirmed — matching you with a driver now",
  "ACCEPTED":             "Driver Assigned — en route to pickup",
  "IN_PROGRESS":          "In Transit — your cargo is on its way",
  "COMPLETED":            "Delivered — thank you for using SwiftHaul!",
  "CANCELLED":            "Cancelled — please contact us if unexpected"
};

function trackOrder(params) {
  var trackingCode = params.trackingCode ? params.trackingCode.trim().toUpperCase() : null;
  var mobile       = params.mobile ? String(params.mobile).replace(/\s+/g, "") : null;

  if (!trackingCode && !mobile) {
    return { success: false, error: "Provide a tracking code or mobile number." };
  }

  var sheet = getBookingsSheet();
  var data  = sheet.getDataRange().getValues(); // All rows including header row

  // ClientBookingsLedger column indices (0-based):
  // P=15 (TrackingCode), C=2 (Mobile), N=13 (Status), O=14 (Driver), D=3,E=4,F=5,G=6,K=10

  var foundRow = null;
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rowCode   = String(row[15]).trim().toUpperCase();
    var rowMobile = String(row[2]).trim();

    if (trackingCode && rowCode === trackingCode) { foundRow = row; break; }
    if (mobile && rowMobile === mobile) { foundRow = row; } // keep scanning for latest
  }

  if (!foundRow) {
    return { success: false, error: "No booking found. Check your tracking code or mobile number." };
  }

  var status    = String(foundRow[13]).trim();
  var driverRaw = String(foundRow[14]).trim();

  // Parse driver details JSON (stored by acceptJob in column O)
  var driverDetails = null;
  if (driverRaw && driverRaw.startsWith("{")) {
    try { driverDetails = JSON.parse(driverRaw); } catch(e) {}
  }

  // Only expose driver info once they are assigned
  var showDriver = ["ACCEPTED","IN_PROGRESS","COMPLETED"].indexOf(status) >= 0;

  return {
    success: true,
    trackingCode: foundRow[15],
    status: status,
    statusLabel: STATUS_LABELS[status] || status,
    pickup: foundRow[3],
    destination: foundRow[4],
    cargoClass: foundRow[5],
    cargoType: foundRow[6],
    totalQuote: foundRow[10],
    // Driver details shown only after assignment — null before that
    driver: showDriver ? driverDetails : null
  };
}


// =============================================================================
// SECTION 7: DRIVER LOGIN VALIDATION
// =============================================================================
// Validates WhatsApp number + PIN against VerifiedDriversPool.
// Only "Active" drivers (Column F) can log in.
//
// VerifiedDriversPool column map (0-based):
//   A=0 Timestamp | B=1 Name | C=2 WhatsApp | D=3 Plate |
//   E=4 CargoClass | F=5 Status | G=6 CommissionStatus | H=7 PIN
//
// TODO: SECURITY UPGRADE — PINs stored as plain text in v1.
// Before scaling, replace with hashed storage:
//   var hashed = Utilities.base64Encode(
//     Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pin));
// Then compare hashed values. Requires re-hashing all existing PINs.

function loginDriver(params) {
  var whatsapp = params.whatsapp ? String(params.whatsapp).replace(/\s+/g,"") : null;
  var pin      = params.pin ? String(params.pin).trim() : null;

  if (!whatsapp || !pin) {
    return { success: false, error: "WhatsApp number and PIN are required." };
  }

  var sheet = getDriversSheet();
  var data  = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    var row         = data[i];
    var rowWA       = String(row[2]).replace(/\s+/g,"");
    var rowStatus   = String(row[5]).trim();
    var rowPin      = String(row[7]).trim();

    if (rowWA === whatsapp) {
      if (rowPin !== pin) {
        return { success: false, error: "Incorrect PIN. Please try again." };
      }
      if (rowStatus !== "Active") {
        return {
          success: false,
          error: "Account pending verification. You will be notified on WhatsApp once approved."
        };
      }
      // Success — return driver profile (no PIN sent back to frontend)
      return {
        success: true,
        driver: {
          name:       row[1],
          whatsapp:   row[2],
          plate:      String(row[3]).toUpperCase(),
          cargoClass: String(row[4]).toLowerCase()
        }
      };
    }
  }

  return { success: false, error: "WhatsApp number not found. Contact ops if you believe this is an error." };
}


// =============================================================================
// SECTION 8: JOB BOARD — FETCH OPEN JOBS FOR DRIVER
// =============================================================================
// Returns OPEN jobs from JobBoard matching the driver's cargo class.
// Drivers only see jobs they can physically handle.
//
// JobBoard column map (0-based):
//   A=0 TrackingCode | B=1 CargoClass | C=2 Route | D=3 Quote |
//   E=4 Status | F=5 AcceptedBy | G=6 AcceptTimestamp

function getOpenJobs(params) {
  var cargoClass = params.cargoClass ? String(params.cargoClass).trim().toUpperCase() : null;
  if (!cargoClass) {
    return { success: false, error: "cargoClass parameter is required." };
  }

  var sheet = getJobBoardSheet();
  var data  = sheet.getDataRange().getValues();
  var jobs  = [];

  for (var i = 1; i < data.length; i++) {
    var row      = data[i];
    var jobClass = String(row[1]).trim().toUpperCase();
    var jobStatus= String(row[4]).trim().toUpperCase();

    if (jobStatus === "OPEN" && jobClass === cargoClass) {
      jobs.push({
        trackingCode: row[0],
        cargoClass:   row[1],
        route:        row[2],
        quote:        row[3]
      });
    }
  }

  return { success: true, jobs: jobs };
}


// =============================================================================
// SECTION 9: JOB ACCEPT — WITH CONCURRENCY LOCK
// =============================================================================
// This is the critical race condition section.
// Two drivers may tap "Accept" simultaneously — LockService ensures only
// the FIRST write succeeds. The second driver gets a "job taken" response.
//
// HOW THE LOCK WORKS:
//   1. Both drivers call acceptJob simultaneously.
//   2. LockService.getScriptLock() is a mutex — only one holder at a time.
//   3. Driver A gets the lock. Driver B waits (up to LOCK_TIMEOUT_MS).
//   4. Driver A writes "TAKEN", releases the lock.
//   5. Driver B gets the lock, re-reads status, sees "TAKEN", returns error.
//
// IMPORTANT: We read the job status INSIDE the lock (step 5), not before.
// Reading before acquiring the lock would create a TOCTOU race condition.
//
// TODO: SCALE — LockService locks the ENTIRE script (one request at a time).
// For high driver volume (100+ concurrent), migrate to:
//   - Firestore with atomic transactions (document-level locking)
//   - Cloud Run + PostgreSQL with SELECT FOR UPDATE
// For v1 with a small driver pool this is completely adequate.

function acceptJob(body) {
  var trackingCode   = body.trackingCode;
  var driverWhatsApp = body.driverWhatsApp;
  var driverName     = body.driverName;
  var driverPlate    = body.driverPlate;

  if (!trackingCode || !driverWhatsApp) {
    return { success: false, error: "trackingCode and driverWhatsApp are required." };
  }

  // Acquire the script-level mutex lock
  var lock = LockService.getScriptLock();
  var lockAcquired = false;
  try {
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
    lockAcquired = true;
  } catch (lockErr) {
    return { success: false, error: "Server busy — please try again in a moment." };
  }

  try {
    // ── INSIDE THE LOCK — all reads and writes happen here ──────────────────

    // Re-read job status NOW (authoritative check, inside lock)
    var jobBoard = getJobBoardSheet();
    var jobData  = jobBoard.getDataRange().getValues();

    var jobRowIndex = -1;
    for (var i = 1; i < jobData.length; i++) {
      if (String(jobData[i][0]).trim().toUpperCase() === trackingCode.toUpperCase()) {
        jobRowIndex = i;
        break;
      }
    }

    if (jobRowIndex === -1) {
      return { success: false, error: "Job not found: " + trackingCode };
    }

    var currentStatus = String(jobData[jobRowIndex][4]).trim().toUpperCase();
    if (currentStatus !== "OPEN") {
      return {
        success: false,
        error: "This job has already been accepted by another driver. Check the board for other available jobs."
      };
    }

    // First accept — write to JobBoard
    var now      = new Date();
    var sheetRow = jobRowIndex + 1; // Sheet rows are 1-indexed; row 1 = header

    jobBoard.getRange(sheetRow, 5).setValue("TAKEN");        // E: Status
    jobBoard.getRange(sheetRow, 6).setValue(driverWhatsApp); // F: Accepted By
    jobBoard.getRange(sheetRow, 7).setValue(now);            // G: Accept Timestamp

    // Store driver details as JSON in ClientBookingsLedger col O
    // This is what the tracking page shows to clients
    var driverJson = JSON.stringify({
      name:     driverName  || "Driver",
      whatsapp: driverWhatsApp,
      plate:    driverPlate || ""
    });

    var bookingsSheet = getBookingsSheet();
    var bookingsData  = bookingsSheet.getDataRange().getValues();

    for (var j = 1; j < bookingsData.length; j++) {
      if (String(bookingsData[j][15]).trim().toUpperCase() === trackingCode.toUpperCase()) {
        var bRow = j + 1;
        bookingsSheet.getRange(bRow, 14).setValue("ACCEPTED");  // N: Status
        bookingsSheet.getRange(bRow, 15).setValue(driverJson);  // O: Driver details
        break;
      }
    }

    Logger.log("Job ACCEPTED: " + trackingCode + " | driver: " + driverWhatsApp + " | " + driverPlate);

    return {
      success: true,
      message: "Job accepted! Contact the client to confirm pickup arrangements."
    };

  } finally {
    // ALWAYS release — runs even if an error was thrown inside try
    if (lockAcquired) lock.releaseLock();
  }
}


// =============================================================================
// SECTION 10: DRIVER REGISTRATION
// =============================================================================
// New drivers submit from driver.html registration form.
// Added to VerifiedDriversPool with status "Pending Document Verification".
// Ops verifies documents via WhatsApp, then manually sets Column F to "Active".
//
// Expected body: driverName | whatsapp | plate | cargoClass | pin
//
// VerifiedDriversPool column layout written here:
//   A=Timestamp | B=Name | C=WhatsApp | D=Plate | E=CargoClass |
//   F=ApprovalStatus | G=CommissionStatus | H=PIN

function registerDriver(body) {
  var required = ["driverName","whatsapp","plate","cargoClass","pin"];
  for (var i = 0; i < required.length; i++) {
    if (!body[required[i]]) {
      return { success: false, error: "Missing required field: " + required[i] };
    }
  }

  if (!/^\d{4}$/.test(String(body.pin))) {
    return { success: false, error: "PIN must be exactly 4 digits (numbers only)." };
  }

  // Check for duplicate WhatsApp number
  var sheet = getDriversSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][2]).replace(/\s+/g,"") === String(body.whatsapp).replace(/\s+/g,"")) {
      return { success: false, error: "This WhatsApp number is already registered. Contact ops for help." };
    }
  }

  // TODO: PIN SECURITY — v1 stores PIN as plain text.
  // Upgrade path: hash before storing:
  //   var hashedPin = Utilities.base64Encode(
  //     Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, body.pin));
  // Store hashedPin instead of body.pin. Then compare hashes in loginDriver().

  var row = [
    new Date(),                                      // A: Timestamp
    body.driverName,                                 // B: Driver Legal Name
    String(body.whatsapp).replace(/\s+/g,""),        // C: WhatsApp (login identifier)
    String(body.plate).toUpperCase(),                // D: Vehicle Plate
    String(body.cargoClass).toLowerCase(),           // E: Cargo Class (pickup/canter/lorry)
    "Pending Document Verification",                 // F: Approval Status
    "",                                              // G: Commission Payment Status
    String(body.pin)                                 // H: PIN (plain text — v1 only)
  ];

  sheet.appendRow(row);
  Logger.log("Driver registered: " + body.driverName + " | WA: " + body.whatsapp);

  return {
    success: true,
    message: "Registration received! Ops will contact you on WhatsApp to verify your documents. Once approved, you can log in and start accepting jobs."
  };
}


// =============================================================================
// SECTION 11: onEdit INSTALLABLE TRIGGER — AUTO-MIRROR JOBS TO BOARD
// =============================================================================
// Fires automatically when ops manually edits Column N (Job Status) in
// ClientBookingsLedger to "OPEN". Copies the job to JobBoard so drivers see it.
//
// WHY INSTALLABLE (not simple onEdit):
//   Simple onEdit() cannot write to other sheets (security restriction).
//   An installable trigger runs with your authorization level and can write anywhere.
//
// ONE-TIME SETUP (required before this works):
//   1. Apps Script editor → left sidebar → clock icon (Triggers)
//   2. "+ Add Trigger"
//   3. Function: onEditInstallable
//   4. Event source: From spreadsheet
//   5. Event type: On edit
//   6. Save → Authorize when prompted
//
// After setup, every time ops types "OPEN" in Column N, the job auto-appears
// in the driver portal JobBoard. No code changes needed.

function onEditInstallable(e) {
  var range     = e.range;
  var sheet     = range.getSheet();
  var sheetName = sheet.getName();

  // Ignore edits outside ClientBookingsLedger
  if (sheetName !== CONFIG.TABS.BOOKINGS) return;

  // Column N is the 14th column (1-indexed)
  if (range.getColumn() !== 14) return;

  // Only act on "OPEN" — ignore all other status changes
  var newValue = String(e.value || "").trim().toUpperCase();
  if (newValue !== "OPEN") return;

  // Read the full row for this booking
  var rowData      = sheet.getRange(range.getRow(), 1, 1, 16).getValues()[0];
  var trackingCode = String(rowData[15]);       // P: Tracking Code
  var cargoClass   = String(rowData[5]);        // F: Cargo Class
  var pickup       = String(rowData[3]);        // D: Pickup
  var destination  = String(rowData[4]);        // E: Destination
  var totalQuote   = rowData[10];               // K: Total Quote

  // Prevent duplicates — check if already on JobBoard
  var jobBoard = getJobBoardSheet();
  var existing = jobBoard.getDataRange().getValues();
  for (var i = 1; i < existing.length; i++) {
    if (String(existing[i][0]).trim() === trackingCode) {
      Logger.log("Duplicate ignored — already on JobBoard: " + trackingCode);
      return;
    }
  }

  // Route summary for driver display (truncate if very long)
  var route = pickup + " → " + destination;
  if (route.length > 80) route = route.substring(0, 77) + "...";

  // Append to JobBoard
  jobBoard.appendRow([
    trackingCode,  // A: Tracking Code (links to ClientBookingsLedger)
    cargoClass,    // B: Cargo Class Code
    route,         // C: Pickup → Destination summary
    totalQuote,    // D: Quote shown to driver
    "OPEN",        // E: Status
    "",            // F: Accepted By (empty until claimed)
    ""             // G: Accept Timestamp (empty until claimed)
  ]);

  Logger.log("Mirrored to JobBoard: " + trackingCode + " | " + cargoClass);
}
