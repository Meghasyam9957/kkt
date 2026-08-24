/* eslint-disable */
/**
 * AUTO-GENERATED — DO NOT EDIT BY HAND.
 * Source: homestay-ops/src/00_constants.gs
 * Regenerate: npm run contract:generate     Verify: npm run contract:check
 * Contract hash: 459a6a48fad6ea5f
 */

export const CONTRACT_HASH = "459a6a48fad6ea5f";
export const DATA_ROW = 4;
export const HEADER_ROW = 3;

export const SHEETS = {
  "DASHBOARD": "01_DASHBOARD",
  "SETTINGS": "02_SETTINGS",
  "PROPERTIES": "03_PROPERTIES",
  "RESERVATIONS": "04_RESERVATIONS",
  "REVENUE": "05_REVENUE",
  "EXPENSES": "06_EXPENSES",
  "CAPEX": "07_CAPEX_SETUP",
  "RENT": "08_RENT_FIXED_COSTS",
  "CASHFLOW": "09_CASH_FLOW",
  "PNL": "10_MONTHLY_PNL",
  "INVESTORS": "11_INVESTORS",
  "DIST": "12_INVESTOR_DISTRIBUTIONS",
  "HOUSEKEEPING": "13_HOUSEKEEPING",
  "MAINTENANCE": "14_MAINTENANCE",
  "INVENTORY": "15_INVENTORY",
  "ASSETS": "16_ASSETS",
  "COMPLIANCE": "17_COMPLIANCE",
  "CLOSE": "18_MONTHLY_CLOSE",
  "ANALYTICS": "19_ANALYTICS",
  "QA": "20_QA_CHECKS",
  "GUIDE": "21_SYSTEM_GUIDE",
  "CALC": "99_CALC"
} as const;
export type SheetKey = keyof typeof SHEETS;
export type SheetName = (typeof SHEETS)[SheetKey];

export const SHEET_META = {
  "DASHBOARD": {
    "key": "DASHBOARD",
    "name": "01_DASHBOARD",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": null,
    "lastDataRow": null
  },
  "SETTINGS": {
    "key": "SETTINGS",
    "name": "02_SETTINGS",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": null,
    "lastDataRow": null
  },
  "PROPERTIES": {
    "key": "PROPERTIES",
    "name": "03_PROPERTIES",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": 25,
    "lastDataRow": 28
  },
  "RESERVATIONS": {
    "key": "RESERVATIONS",
    "name": "04_RESERVATIONS",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": 700,
    "lastDataRow": 703
  },
  "REVENUE": {
    "key": "REVENUE",
    "name": "05_REVENUE",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": 700,
    "lastDataRow": 703
  },
  "EXPENSES": {
    "key": "EXPENSES",
    "name": "06_EXPENSES",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": 1000,
    "lastDataRow": 1003
  },
  "CAPEX": {
    "key": "CAPEX",
    "name": "07_CAPEX_SETUP",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": 300,
    "lastDataRow": 303
  },
  "RENT": {
    "key": "RENT",
    "name": "08_RENT_FIXED_COSTS",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": 60,
    "lastDataRow": 63
  },
  "CASHFLOW": {
    "key": "CASHFLOW",
    "name": "09_CASH_FLOW",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": 1000,
    "lastDataRow": 1003
  },
  "PNL": {
    "key": "PNL",
    "name": "10_MONTHLY_PNL",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": null,
    "lastDataRow": null
  },
  "INVESTORS": {
    "key": "INVESTORS",
    "name": "11_INVESTORS",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": 25,
    "lastDataRow": 28
  },
  "DIST": {
    "key": "DIST",
    "name": "12_INVESTOR_DISTRIBUTIONS",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": null,
    "lastDataRow": null
  },
  "HOUSEKEEPING": {
    "key": "HOUSEKEEPING",
    "name": "13_HOUSEKEEPING",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": 500,
    "lastDataRow": 503
  },
  "MAINTENANCE": {
    "key": "MAINTENANCE",
    "name": "14_MAINTENANCE",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": 300,
    "lastDataRow": 303
  },
  "INVENTORY": {
    "key": "INVENTORY",
    "name": "15_INVENTORY",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": 150,
    "lastDataRow": 153
  },
  "ASSETS": {
    "key": "ASSETS",
    "name": "16_ASSETS",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": 200,
    "lastDataRow": 203
  },
  "COMPLIANCE": {
    "key": "COMPLIANCE",
    "name": "17_COMPLIANCE",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": 60,
    "lastDataRow": 63
  },
  "CLOSE": {
    "key": "CLOSE",
    "name": "18_MONTHLY_CLOSE",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": 24,
    "lastDataRow": 27
  },
  "ANALYTICS": {
    "key": "ANALYTICS",
    "name": "19_ANALYTICS",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": null,
    "lastDataRow": null
  },
  "QA": {
    "key": "QA",
    "name": "20_QA_CHECKS",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": null,
    "lastDataRow": null
  },
  "GUIDE": {
    "key": "GUIDE",
    "name": "21_SYSTEM_GUIDE",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": null,
    "lastDataRow": null
  },
  "CALC": {
    "key": "CALC",
    "name": "99_CALC",
    "dataRow": 4,
    "headerRow": 3,
    "preparedRows": null,
    "lastDataRow": null
  }
} as const;
export const TAB_ORDER = [
  "01_DASHBOARD",
  "02_SETTINGS",
  "03_PROPERTIES",
  "04_RESERVATIONS",
  "05_REVENUE",
  "06_EXPENSES",
  "07_CAPEX_SETUP",
  "08_RENT_FIXED_COSTS",
  "09_CASH_FLOW",
  "10_MONTHLY_PNL",
  "11_INVESTORS",
  "12_INVESTOR_DISTRIBUTIONS",
  "13_HOUSEKEEPING",
  "14_MAINTENANCE",
  "15_INVENTORY",
  "16_ASSETS",
  "17_COMPLIANCE",
  "18_MONTHLY_CLOSE",
  "19_ANALYTICS",
  "20_QA_CHECKS",
  "21_SYSTEM_GUIDE",
  "99_CALC"
] as const;

export interface ColumnSpec {
  readonly key: string;
  readonly header: string;
  readonly index: number;
  readonly a1: string;
  readonly type: string;
  /** `in` = user input (writable by the app). `calc` = workbook formula (NEVER writable). */
  readonly role: "in" | "calc";
  readonly list: string | null;
  readonly range: string | null;
  readonly note: string | null;
}

export const COLUMNS: Readonly<Record<string, readonly ColumnSpec[]>> = {
  "PROPERTIES": [
    {
      "key": "PropertyID",
      "header": "Property ID",
      "index": 1,
      "a1": "A",
      "type": "id",
      "role": "in",
      "list": null,
      "range": null,
      "note": "Permanent ID, e.g. HYD-501. Never reuse."
    },
    {
      "key": "Floor",
      "header": "Floor",
      "index": 2,
      "a1": "B",
      "type": "int",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Unit",
      "header": "Unit",
      "index": 3,
      "a1": "C",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": "e.g. 5th Floor — 2 BHK"
    },
    {
      "key": "BHKType",
      "header": "BHK Type",
      "index": 4,
      "a1": "D",
      "type": "list",
      "role": "in",
      "list": "BHK",
      "range": null,
      "note": null
    },
    {
      "key": "Bedrooms",
      "header": "Bedrooms",
      "index": 5,
      "a1": "E",
      "type": "int",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "MaxGuests",
      "header": "Max Guests",
      "index": 6,
      "a1": "F",
      "type": "int",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PropertyStatus",
      "header": "Base Status",
      "index": 7,
      "a1": "G",
      "type": "list",
      "role": "in",
      "list": "PROPERTY_STATUS",
      "range": null,
      "note": "Manual base status (Available / Blocked / Maintenance). Live occupancy is derived on the Dashboard."
    },
    {
      "key": "ListingStatus",
      "header": "Listing Status",
      "index": 8,
      "a1": "H",
      "type": "list",
      "role": "in",
      "list": "LISTING_STATUS",
      "range": null,
      "note": null
    },
    {
      "key": "AirbnbListingID",
      "header": "Airbnb Listing ID",
      "index": 9,
      "a1": "I",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "BookingComListingID",
      "header": "Booking.com Listing ID",
      "index": 10,
      "a1": "J",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "MonthlyRent",
      "header": "Monthly Rent",
      "index": 11,
      "a1": "K",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": "Blank until lease terms are final (TBD)."
    },
    {
      "key": "SecurityDeposit",
      "header": "Security Deposit",
      "index": 12,
      "a1": "L",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "LeaseStart",
      "header": "Lease Start",
      "index": 13,
      "a1": "M",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "LeaseEnd",
      "header": "Lease End",
      "index": 14,
      "a1": "N",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Landlord",
      "header": "Landlord",
      "index": 15,
      "a1": "O",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "MaintenanceCharge",
      "header": "Society Maint. Charge",
      "index": 16,
      "a1": "P",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Notes",
      "header": "Notes",
      "index": 17,
      "a1": "Q",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    }
  ],
  "RESERVATIONS": [
    {
      "key": "BookingID",
      "header": "Booking ID",
      "index": 1,
      "a1": "A",
      "type": "id",
      "role": "in",
      "list": null,
      "range": null,
      "note": "BK-2026-0001 — use menu ▸ Generate IDs."
    },
    {
      "key": "Platform",
      "header": "Platform",
      "index": 2,
      "a1": "B",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "TBL_PLATFORM_NAMES",
      "note": null
    },
    {
      "key": "PlatformResID",
      "header": "Platform Res. ID",
      "index": 3,
      "a1": "C",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": "OTA confirmation code — duplicates are flagged in QA."
    },
    {
      "key": "PropertyID",
      "header": "Property ID",
      "index": 4,
      "a1": "D",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_PROPERTY_IDS",
      "note": null
    },
    {
      "key": "BookingDate",
      "header": "Booking Date",
      "index": 5,
      "a1": "E",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "BookingStatus",
      "header": "Booking Status",
      "index": 6,
      "a1": "F",
      "type": "list",
      "role": "in",
      "list": "BOOKING_STATUS",
      "range": null,
      "note": null
    },
    {
      "key": "GuestID",
      "header": "Guest ID",
      "index": 7,
      "a1": "G",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "GuestName",
      "header": "Guest Name",
      "index": 8,
      "a1": "H",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Adults",
      "header": "Adults",
      "index": 9,
      "a1": "I",
      "type": "int",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Children",
      "header": "Children",
      "index": 10,
      "a1": "J",
      "type": "int",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "TotalGuests",
      "header": "Guests",
      "index": 11,
      "a1": "K",
      "type": "int",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "CheckInDate",
      "header": "Check-in",
      "index": 12,
      "a1": "L",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "CheckInTime",
      "header": "In Time",
      "index": 13,
      "a1": "M",
      "type": "time",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "CheckOutDate",
      "header": "Check-out",
      "index": 14,
      "a1": "N",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "CheckOutTime",
      "header": "Out Time",
      "index": 15,
      "a1": "O",
      "type": "time",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Nights",
      "header": "Nights",
      "index": 16,
      "a1": "P",
      "type": "int",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "EarlyCheckIn",
      "header": "Early In",
      "index": 17,
      "a1": "Q",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "LateCheckout",
      "header": "Late Out",
      "index": 18,
      "a1": "R",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "BaseRate",
      "header": "Base Rate / night",
      "index": 19,
      "a1": "S",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "RoomRevenue",
      "header": "Room Revenue",
      "index": 20,
      "a1": "T",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "CleaningFee",
      "header": "Cleaning Fee",
      "index": 21,
      "a1": "U",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ExtraGuestFee",
      "header": "Extra Guest Fee",
      "index": 22,
      "a1": "V",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "OtherCharges",
      "header": "Other Charges",
      "index": 23,
      "a1": "W",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Discount",
      "header": "Discount",
      "index": 24,
      "a1": "X",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "GrossBookingValue",
      "header": "Gross Value",
      "index": 25,
      "a1": "Y",
      "type": "cur",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Taxes",
      "header": "Taxes",
      "index": 26,
      "a1": "Z",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PlatformFee",
      "header": "Platform Fee (actual)",
      "index": 27,
      "a1": "AA",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": "Actual OTA fee if known. Leave blank to estimate from the commission % in Settings."
    },
    {
      "key": "OtherDeductions",
      "header": "Other Deductions",
      "index": 28,
      "a1": "AB",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "EstPlatformFee",
      "header": "Fee (est.)",
      "index": 29,
      "a1": "AC",
      "type": "cur",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ExpectedPayout",
      "header": "Expected Payout",
      "index": 30,
      "a1": "AD",
      "type": "cur",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ActualPayout",
      "header": "Actual Payout",
      "index": 31,
      "a1": "AE",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PayoutDate",
      "header": "Payout Date",
      "index": 32,
      "a1": "AF",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PayoutStatus",
      "header": "Payout Status",
      "index": 33,
      "a1": "AG",
      "type": "text",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PayoutVariance",
      "header": "Payout Δ",
      "index": 34,
      "a1": "AH",
      "type": "cur",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "GuestVerification",
      "header": "Guest Verification",
      "index": 35,
      "a1": "AI",
      "type": "list",
      "role": "in",
      "list": "VERIFY",
      "range": null,
      "note": null
    },
    {
      "key": "CleaningStatus",
      "header": "Cleaning",
      "index": 36,
      "a1": "AJ",
      "type": "text",
      "role": "calc",
      "list": null,
      "range": null,
      "note": "Latest 13_HOUSEKEEPING task status for this booking."
    },
    {
      "key": "InspectionStatus",
      "header": "Inspection",
      "index": 37,
      "a1": "AK",
      "type": "text",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "DamageReport",
      "header": "Damage Report",
      "index": 38,
      "a1": "AL",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "MaintenanceRequired",
      "header": "Maint. Req.",
      "index": 39,
      "a1": "AM",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Notes",
      "header": "Notes",
      "index": 40,
      "a1": "AN",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "RowIssues",
      "header": "⚠ Row Issues",
      "index": 41,
      "a1": "AO",
      "type": "text",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    }
  ],
  "REVENUE": [
    {
      "key": "RevenueID",
      "header": "Revenue ID",
      "index": 1,
      "a1": "A",
      "type": "id",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "BookingID",
      "header": "Booking ID",
      "index": 2,
      "a1": "B",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_BOOKING_IDS",
      "note": "Link to 04_RESERVATIONS. Leave blank only for non-booking revenue."
    },
    {
      "key": "PropertyID",
      "header": "Property ID",
      "index": 3,
      "a1": "C",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_PROPERTY_IDS",
      "note": null
    },
    {
      "key": "Date",
      "header": "Date",
      "index": 4,
      "a1": "D",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": "Revenue recognition date — drives the P&L month."
    },
    {
      "key": "RevenueType",
      "header": "Revenue Type",
      "index": 5,
      "a1": "E",
      "type": "list",
      "role": "in",
      "list": "REVENUE_TYPE",
      "range": null,
      "note": null
    },
    {
      "key": "Platform",
      "header": "Platform",
      "index": 6,
      "a1": "F",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "TBL_PLATFORM_NAMES",
      "note": null
    },
    {
      "key": "GrossAmount",
      "header": "Gross Amount",
      "index": 7,
      "a1": "G",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Discount",
      "header": "Discount",
      "index": 8,
      "a1": "H",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Tax",
      "header": "Tax",
      "index": 9,
      "a1": "I",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PlatformFee",
      "header": "Platform Fee",
      "index": 10,
      "a1": "J",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "OtherDeduction",
      "header": "Other Deduction",
      "index": 11,
      "a1": "K",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "NetRevenue",
      "header": "Net Revenue",
      "index": 12,
      "a1": "L",
      "type": "cur",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PayoutStatus",
      "header": "Payout Status",
      "index": 13,
      "a1": "M",
      "type": "list",
      "role": "in",
      "list": "PAYOUT_STATUS",
      "range": null,
      "note": null
    },
    {
      "key": "PayoutDate",
      "header": "Payout Date",
      "index": 14,
      "a1": "N",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PaymentAccount",
      "header": "Account",
      "index": 15,
      "a1": "O",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_ACCOUNTS",
      "note": null
    },
    {
      "key": "ReconCheck",
      "header": "Reconciliation",
      "index": 16,
      "a1": "P",
      "type": "text",
      "role": "calc",
      "list": null,
      "range": null,
      "note": "Compares this row + siblings against the linked booking’s expected payout. Damage Recovery rows are excluded from the comparison (they sit outside the OTA payout)."
    },
    {
      "key": "Notes",
      "header": "Notes",
      "index": 17,
      "a1": "Q",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    }
  ],
  "EXPENSES": [
    {
      "key": "ExpenseID",
      "header": "Expense ID",
      "index": 1,
      "a1": "A",
      "type": "id",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Date",
      "header": "Date",
      "index": 2,
      "a1": "B",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PropertyID",
      "header": "Property",
      "index": 3,
      "a1": "C",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_PROPERTY_IDS_ALL",
      "note": "Use COMMON for shared/whole-building costs."
    },
    {
      "key": "ExpenseCategory",
      "header": "Category",
      "index": 4,
      "a1": "D",
      "type": "list",
      "role": "in",
      "list": "EXPENSE_CATEGORY",
      "range": null,
      "note": null
    },
    {
      "key": "ExpenseSubcategory",
      "header": "Subcategory",
      "index": 5,
      "a1": "E",
      "type": "list",
      "role": "in",
      "list": "EXPENSE_SUBCATEGORY",
      "range": null,
      "note": null
    },
    {
      "key": "Description",
      "header": "Description",
      "index": 6,
      "a1": "F",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Vendor",
      "header": "Vendor",
      "index": 7,
      "a1": "G",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Amount",
      "header": "Amount",
      "index": 8,
      "a1": "H",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Tax",
      "header": "Tax (GST etc.)",
      "index": 9,
      "a1": "I",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "TotalAmount",
      "header": "Total",
      "index": 10,
      "a1": "J",
      "type": "cur",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PaymentMethod",
      "header": "Payment Method",
      "index": 11,
      "a1": "K",
      "type": "list",
      "role": "in",
      "list": "PAYMENT_METHOD",
      "range": null,
      "note": null
    },
    {
      "key": "PaymentStatus",
      "header": "Payment Status",
      "index": 12,
      "a1": "L",
      "type": "list",
      "role": "in",
      "list": "PAYMENT_STATUS",
      "range": null,
      "note": null
    },
    {
      "key": "PaidDate",
      "header": "Paid Date",
      "index": 13,
      "a1": "M",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Recurring",
      "header": "Recurring?",
      "index": 14,
      "a1": "N",
      "type": "list",
      "role": "in",
      "list": "RECURRING",
      "range": null,
      "note": null
    },
    {
      "key": "ExpenseType",
      "header": "Type",
      "index": 15,
      "a1": "O",
      "type": "list",
      "role": "in",
      "list": "EXPENSE_TYPE",
      "range": null,
      "note": "Operating only. If this is CAPEX it belongs in 07_CAPEX_SETUP — QA will flag it."
    },
    {
      "key": "InvoiceRef",
      "header": "Invoice Ref",
      "index": 16,
      "a1": "P",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "DriveLink",
      "header": "Receipt Link",
      "index": 17,
      "a1": "Q",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ApprovedBy",
      "header": "Approved By",
      "index": 18,
      "a1": "R",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "RowIssues",
      "header": "⚠ Row Issues",
      "index": 19,
      "a1": "S",
      "type": "text",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Notes",
      "header": "Notes",
      "index": 20,
      "a1": "T",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    }
  ],
  "CAPEX": [
    {
      "key": "CapexID",
      "header": "CAPEX ID",
      "index": 1,
      "a1": "A",
      "type": "id",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PropertyID",
      "header": "Property",
      "index": 2,
      "a1": "B",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_PROPERTY_IDS_ALL",
      "note": null
    },
    {
      "key": "Date",
      "header": "Date",
      "index": 3,
      "a1": "C",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Category",
      "header": "Category",
      "index": 4,
      "a1": "D",
      "type": "list",
      "role": "in",
      "list": "CAPEX_CATEGORY",
      "range": null,
      "note": null
    },
    {
      "key": "Subcategory",
      "header": "Subcategory",
      "index": 5,
      "a1": "E",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Item",
      "header": "Item",
      "index": 6,
      "a1": "F",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Description",
      "header": "Description",
      "index": 7,
      "a1": "G",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Quantity",
      "header": "Qty",
      "index": 8,
      "a1": "H",
      "type": "num",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "UnitCost",
      "header": "Unit Cost",
      "index": 9,
      "a1": "I",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "TotalCost",
      "header": "Total Cost",
      "index": 10,
      "a1": "J",
      "type": "cur",
      "role": "calc",
      "list": null,
      "range": null,
      "note": "Qty × Unit Cost (blank Qty counts as 1)."
    },
    {
      "key": "Vendor",
      "header": "Vendor",
      "index": 11,
      "a1": "K",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PaymentStatus",
      "header": "Payment Status",
      "index": 12,
      "a1": "L",
      "type": "list",
      "role": "in",
      "list": "PAYMENT_STATUS",
      "range": null,
      "note": null
    },
    {
      "key": "Warranty",
      "header": "Warranty",
      "index": 13,
      "a1": "M",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "WarrantyExpiry",
      "header": "Warranty Expiry",
      "index": 14,
      "a1": "N",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "UsefulLifeMonths",
      "header": "Useful Life (mo)",
      "index": 15,
      "a1": "O",
      "type": "int",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "AssetID",
      "header": "Asset ID",
      "index": 16,
      "a1": "P",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": "Link to 16_ASSETS for durable items."
    },
    {
      "key": "InvoiceRef",
      "header": "Invoice Ref",
      "index": 17,
      "a1": "Q",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "DriveLink",
      "header": "Invoice Link",
      "index": 18,
      "a1": "R",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Notes",
      "header": "Notes",
      "index": 19,
      "a1": "S",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    }
  ],
  "RENT": [
    {
      "key": "RecordID",
      "header": "Record ID",
      "index": 1,
      "a1": "A",
      "type": "id",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PropertyID",
      "header": "Property",
      "index": 2,
      "a1": "B",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_PROPERTY_IDS_ALL",
      "note": null
    },
    {
      "key": "CostType",
      "header": "Cost Type",
      "index": 3,
      "a1": "C",
      "type": "list",
      "role": "in",
      "list": "COST_TYPE",
      "range": null,
      "note": null
    },
    {
      "key": "LandlordVendor",
      "header": "Landlord / Vendor",
      "index": 4,
      "a1": "D",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "MonthlyAmount",
      "header": "Monthly Amount",
      "index": 5,
      "a1": "E",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": "Blank until terms final (TBD)."
    },
    {
      "key": "DueDay",
      "header": "Due Day (1–28)",
      "index": 6,
      "a1": "F",
      "type": "int",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "AgreementStart",
      "header": "Agreement Start",
      "index": 7,
      "a1": "G",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "AgreementEnd",
      "header": "Agreement End",
      "index": 8,
      "a1": "H",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "EscalationPct",
      "header": "Escalation %",
      "index": 9,
      "a1": "I",
      "type": "pct",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "LastPaidDate",
      "header": "Last Paid",
      "index": 10,
      "a1": "J",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": "Actual transfer date (audit trail). Update every time you pay."
    },
    {
      "key": "PaidForMonth",
      "header": "Paid For (month)",
      "index": 11,
      "a1": "K",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": "Any date in the month this payment COVERS (July rent paid 3-Aug ⇒ enter 01-Jul). Drives Next Due + overdue alerts. Blank = assumed same month as Last Paid."
    },
    {
      "key": "NextDueDate",
      "header": "Next Due",
      "index": 12,
      "a1": "L",
      "type": "date",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PaymentStatus",
      "header": "Status",
      "index": 13,
      "a1": "M",
      "type": "text",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PaymentRef",
      "header": "Payment Ref",
      "index": 14,
      "a1": "N",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Notes",
      "header": "Notes",
      "index": 15,
      "a1": "O",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    }
  ],
  "CASHFLOW": [
    {
      "key": "TxnID",
      "header": "Txn ID",
      "index": 1,
      "a1": "A",
      "type": "id",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Date",
      "header": "Date",
      "index": 2,
      "a1": "B",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Type",
      "header": "Type",
      "index": 3,
      "a1": "C",
      "type": "list",
      "role": "in",
      "list": "CASH_TYPE",
      "range": null,
      "note": "Keeps revenue / OpEx / CAPEX / capital / distributions / deposits / loans separate. Never mix."
    },
    {
      "key": "Category",
      "header": "Category / Detail",
      "index": 4,
      "a1": "D",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PropertyID",
      "header": "Property",
      "index": 5,
      "a1": "E",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_PROPERTY_IDS_ALL",
      "note": null
    },
    {
      "key": "RefID",
      "header": "Reference ID",
      "index": 6,
      "a1": "F",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": "BK-/EXP-/CAP-/INV- id this cash movement settles."
    },
    {
      "key": "Description",
      "header": "Description",
      "index": 7,
      "a1": "G",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "MoneyIn",
      "header": "Money In",
      "index": 8,
      "a1": "H",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "MoneyOut",
      "header": "Money Out",
      "index": 9,
      "a1": "I",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Account",
      "header": "Account",
      "index": 10,
      "a1": "J",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_ACCOUNTS",
      "note": null
    },
    {
      "key": "PaymentMethod",
      "header": "Method",
      "index": 11,
      "a1": "K",
      "type": "list",
      "role": "in",
      "list": "PAYMENT_METHOD",
      "range": null,
      "note": null
    },
    {
      "key": "RunningBalance",
      "header": "Running Balance",
      "index": 12,
      "a1": "L",
      "type": "cur",
      "role": "calc",
      "list": null,
      "range": null,
      "note": "All accounts combined, in row order."
    },
    {
      "key": "ReconStatus",
      "header": "Reconciliation",
      "index": 13,
      "a1": "M",
      "type": "list",
      "role": "in",
      "list": "RECON_STATUS",
      "range": null,
      "note": null
    },
    {
      "key": "Notes",
      "header": "Notes",
      "index": 14,
      "a1": "N",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    }
  ],
  "INVESTORS": [
    {
      "key": "InvestorID",
      "header": "Investor ID",
      "index": 1,
      "a1": "A",
      "type": "id",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "InvestorName",
      "header": "Investor Name",
      "index": 2,
      "a1": "B",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "InvestmentAmount",
      "header": "Capital Contributed",
      "index": 3,
      "a1": "C",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "InvestmentDate",
      "header": "Investment Date",
      "index": 4,
      "a1": "D",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ParticipationPct",
      "header": "Participation % (of investor pool)",
      "index": 5,
      "a1": "E",
      "type": "pct",
      "role": "in",
      "list": null,
      "range": null,
      "note": "Share WITHIN the investor pool. Active investors must total 100% — QA checks this."
    },
    {
      "key": "Status",
      "header": "Status",
      "index": 6,
      "a1": "F",
      "type": "list",
      "role": "in",
      "list": "INVESTOR_STATUS",
      "range": null,
      "note": null
    },
    {
      "key": "AgreementRef",
      "header": "Agreement Ref",
      "index": 7,
      "a1": "G",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Contact",
      "header": "Contact",
      "index": 8,
      "a1": "H",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ShareCheck",
      "header": "⚠ Share Check",
      "index": 9,
      "a1": "I",
      "type": "text",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Notes",
      "header": "Notes",
      "index": 10,
      "a1": "J",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    }
  ],
  "HOUSEKEEPING": [
    {
      "key": "TaskID",
      "header": "Task ID",
      "index": 1,
      "a1": "A",
      "type": "id",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "BookingID",
      "header": "Booking ID",
      "index": 2,
      "a1": "B",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_BOOKING_IDS",
      "note": null
    },
    {
      "key": "PropertyID",
      "header": "Property",
      "index": 3,
      "a1": "C",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_PROPERTY_IDS",
      "note": null
    },
    {
      "key": "CheckoutDate",
      "header": "Checkout Date",
      "index": 4,
      "a1": "D",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "AssignedDate",
      "header": "Assigned On",
      "index": 5,
      "a1": "E",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Cleaner",
      "header": "Cleaner",
      "index": 6,
      "a1": "F",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "StartTime",
      "header": "Started",
      "index": 7,
      "a1": "G",
      "type": "datetime",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "CompletionTime",
      "header": "Completed",
      "index": 8,
      "a1": "H",
      "type": "datetime",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "LinenChanged",
      "header": "Linen",
      "index": 9,
      "a1": "I",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ToiletriesRestocked",
      "header": "Toiletries",
      "index": 10,
      "a1": "J",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "KitchenChecked",
      "header": "Kitchen",
      "index": 11,
      "a1": "K",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "DamageChecked",
      "header": "Damage Chk",
      "index": 12,
      "a1": "L",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "InspectionStatus",
      "header": "Inspection",
      "index": 13,
      "a1": "M",
      "type": "list",
      "role": "in",
      "list": "INSPECTION",
      "range": null,
      "note": null
    },
    {
      "key": "FinalStatus",
      "header": "Final Status",
      "index": 14,
      "a1": "N",
      "type": "list",
      "role": "in",
      "list": "HK_STATUS",
      "range": null,
      "note": null
    },
    {
      "key": "TurnaroundHrs",
      "header": "Turnaround (h)",
      "index": 15,
      "a1": "O",
      "type": "num",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Notes",
      "header": "Notes",
      "index": 16,
      "a1": "P",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    }
  ],
  "MAINTENANCE": [
    {
      "key": "TicketID",
      "header": "Ticket ID",
      "index": 1,
      "a1": "A",
      "type": "id",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "DateReported",
      "header": "Reported",
      "index": 2,
      "a1": "B",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PropertyID",
      "header": "Property",
      "index": 3,
      "a1": "C",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_PROPERTY_IDS",
      "note": null
    },
    {
      "key": "IssueCategory",
      "header": "Category",
      "index": 4,
      "a1": "D",
      "type": "list",
      "role": "in",
      "list": "MAINT_CATEGORY",
      "range": null,
      "note": null
    },
    {
      "key": "Description",
      "header": "Description",
      "index": 5,
      "a1": "E",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Priority",
      "header": "Priority",
      "index": 6,
      "a1": "F",
      "type": "list",
      "role": "in",
      "list": "MAINT_PRIORITY",
      "range": null,
      "note": null
    },
    {
      "key": "AssignedTo",
      "header": "Assigned To",
      "index": 7,
      "a1": "G",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Vendor",
      "header": "Vendor",
      "index": 8,
      "a1": "H",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "EstimatedCost",
      "header": "Est. Cost",
      "index": 9,
      "a1": "I",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ActualCost",
      "header": "Actual Cost",
      "index": 10,
      "a1": "J",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Status",
      "header": "Status",
      "index": 11,
      "a1": "K",
      "type": "list",
      "role": "in",
      "list": "MAINT_STATUS",
      "range": null,
      "note": null
    },
    {
      "key": "DateResolved",
      "header": "Resolved",
      "index": 12,
      "a1": "L",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "DowntimeDays",
      "header": "Downtime (d)",
      "index": 13,
      "a1": "M",
      "type": "num",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ExpenseID",
      "header": "Expense ID",
      "index": 14,
      "a1": "N",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": "EXP- id once the cost is logged in 06_EXPENSES."
    },
    {
      "key": "PhotosLink",
      "header": "Photos Link",
      "index": 15,
      "a1": "O",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "AgeDays",
      "header": "Age (d)",
      "index": 16,
      "a1": "P",
      "type": "num",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Notes",
      "header": "Notes",
      "index": 17,
      "a1": "Q",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    }
  ],
  "INVENTORY": [
    {
      "key": "ItemID",
      "header": "Item ID",
      "index": 1,
      "a1": "A",
      "type": "id",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PropertyID",
      "header": "Property",
      "index": 2,
      "a1": "B",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_PROPERTY_IDS_ALL",
      "note": null
    },
    {
      "key": "Category",
      "header": "Category",
      "index": 3,
      "a1": "C",
      "type": "list",
      "role": "in",
      "list": "INV_CATEGORY",
      "range": null,
      "note": null
    },
    {
      "key": "Item",
      "header": "Item",
      "index": 4,
      "a1": "D",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Unit",
      "header": "Unit",
      "index": 5,
      "a1": "E",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": "pcs / kg / L / rolls…"
    },
    {
      "key": "OpeningStock",
      "header": "Opening",
      "index": 6,
      "a1": "F",
      "type": "num",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Purchased",
      "header": "Purchased",
      "index": 7,
      "a1": "G",
      "type": "num",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Used",
      "header": "Used",
      "index": 8,
      "a1": "H",
      "type": "num",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "CurrentStock",
      "header": "Current Stock",
      "index": 9,
      "a1": "I",
      "type": "num",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "MinStock",
      "header": "Min Stock",
      "index": 10,
      "a1": "J",
      "type": "num",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ReorderStatus",
      "header": "Reorder",
      "index": 11,
      "a1": "K",
      "type": "text",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "LastPurchaseDate",
      "header": "Last Purchase",
      "index": 12,
      "a1": "L",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "LastPurchaseCost",
      "header": "Last Cost",
      "index": 13,
      "a1": "M",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Vendor",
      "header": "Vendor",
      "index": 14,
      "a1": "N",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Notes",
      "header": "Notes",
      "index": 15,
      "a1": "O",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    }
  ],
  "ASSETS": [
    {
      "key": "AssetID",
      "header": "Asset ID",
      "index": 1,
      "a1": "A",
      "type": "id",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PropertyID",
      "header": "Property",
      "index": 2,
      "a1": "B",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_PROPERTY_IDS_ALL",
      "note": null
    },
    {
      "key": "Category",
      "header": "Category",
      "index": 3,
      "a1": "C",
      "type": "list",
      "role": "in",
      "list": "CAPEX_CATEGORY",
      "range": null,
      "note": null
    },
    {
      "key": "Asset",
      "header": "Asset",
      "index": 4,
      "a1": "D",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PurchaseDate",
      "header": "Purchased",
      "index": 5,
      "a1": "E",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PurchaseCost",
      "header": "Cost",
      "index": 6,
      "a1": "F",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Vendor",
      "header": "Vendor",
      "index": 7,
      "a1": "G",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "WarrantyExpiry",
      "header": "Warranty Expiry",
      "index": 8,
      "a1": "H",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "UsefulLifeMonths",
      "header": "Useful Life (mo)",
      "index": 9,
      "a1": "I",
      "type": "int",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Condition",
      "header": "Condition",
      "index": 10,
      "a1": "J",
      "type": "list",
      "role": "in",
      "list": "CONDITION",
      "range": null,
      "note": null
    },
    {
      "key": "CurrentStatus",
      "header": "Status",
      "index": 11,
      "a1": "K",
      "type": "list",
      "role": "in",
      "list": "ASSET_STATUS",
      "range": null,
      "note": null
    },
    {
      "key": "WarrantyStatus",
      "header": "Warranty",
      "index": 12,
      "a1": "L",
      "type": "text",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "MaintenanceHistory",
      "header": "Maintenance History",
      "index": 13,
      "a1": "M",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "DisposalDate",
      "header": "Disposed",
      "index": 14,
      "a1": "N",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Notes",
      "header": "Notes",
      "index": 15,
      "a1": "O",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    }
  ],
  "COMPLIANCE": [
    {
      "key": "ComplianceID",
      "header": "Compliance ID",
      "index": 1,
      "a1": "A",
      "type": "id",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Requirement",
      "header": "Requirement",
      "index": 2,
      "a1": "B",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": "Placeholders only — management must verify actual local/legal requirements."
    },
    {
      "key": "PropertyID",
      "header": "Property",
      "index": 3,
      "a1": "C",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_PROPERTY_IDS_ALL",
      "note": null
    },
    {
      "key": "Authority",
      "header": "Authority / Source",
      "index": 4,
      "a1": "D",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ResponsiblePerson",
      "header": "Responsible",
      "index": 5,
      "a1": "E",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Status",
      "header": "Status",
      "index": 6,
      "a1": "F",
      "type": "list",
      "role": "in",
      "list": "COMPLIANCE_STATUS",
      "range": null,
      "note": null
    },
    {
      "key": "IssueDate",
      "header": "Issued",
      "index": 7,
      "a1": "G",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ExpiryDate",
      "header": "Expires",
      "index": 8,
      "a1": "H",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "RenewalDate",
      "header": "Renewal Due",
      "index": 9,
      "a1": "I",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "DaysToExpiry",
      "header": "Days Left",
      "index": 10,
      "a1": "J",
      "type": "num",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "AlertStatus",
      "header": "Alert",
      "index": 11,
      "a1": "K",
      "type": "text",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "DocumentRef",
      "header": "Document Ref",
      "index": 12,
      "a1": "L",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "DriveLink",
      "header": "Drive Link",
      "index": 13,
      "a1": "M",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Notes",
      "header": "Notes",
      "index": 14,
      "a1": "N",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    }
  ],
  "CLOSE": [
    {
      "key": "Month",
      "header": "Month",
      "index": 1,
      "a1": "A",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": "First day of the month being closed."
    },
    {
      "key": "ReservationsReconciled",
      "header": "Reservations reconciled",
      "index": 2,
      "a1": "B",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "OtaPayoutsReconciled",
      "header": "OTA payouts reconciled",
      "index": 3,
      "a1": "C",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "RevenueReconciled",
      "header": "Revenue reconciled",
      "index": 4,
      "a1": "D",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ExpensesEntered",
      "header": "Expenses entered",
      "index": 5,
      "a1": "E",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "RentPaid",
      "header": "Rent paid",
      "index": 6,
      "a1": "F",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "UtilitiesEntered",
      "header": "Utilities entered",
      "index": 7,
      "a1": "G",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "CapexSeparated",
      "header": "CAPEX separated",
      "index": 8,
      "a1": "H",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "CashReconciled",
      "header": "Cash reconciled",
      "index": 9,
      "a1": "I",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PnlReviewed",
      "header": "P&L reviewed",
      "index": 10,
      "a1": "J",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "InvestorCalcReviewed",
      "header": "Investor calc reviewed",
      "index": 11,
      "a1": "K",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "InvestorPaymentsRecorded",
      "header": "Investor payments recorded",
      "index": 12,
      "a1": "L",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ReceivablesReviewed",
      "header": "Receivables reviewed",
      "index": 13,
      "a1": "M",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PayablesReviewed",
      "header": "Payables reviewed",
      "index": 14,
      "a1": "N",
      "type": "bool",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ClosingStatus",
      "header": "Closing Status",
      "index": 15,
      "a1": "O",
      "type": "text",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PreparedBy",
      "header": "Prepared By",
      "index": 16,
      "a1": "P",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ReviewedBy",
      "header": "Reviewed By",
      "index": 17,
      "a1": "Q",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ReviewDate",
      "header": "Review Date",
      "index": 18,
      "a1": "R",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Notes",
      "header": "Notes",
      "index": 19,
      "a1": "S",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    }
  ],
  "DIST": [
    {
      "key": "Period",
      "header": "Period (month)",
      "index": 1,
      "a1": "A",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": "First day of the distribution month."
    },
    {
      "key": "InvestorID",
      "header": "Investor ID",
      "index": 2,
      "a1": "B",
      "type": "listRange",
      "role": "in",
      "list": null,
      "range": "LIST_INVESTOR_IDS",
      "note": null
    },
    {
      "key": "InvestorName",
      "header": "Investor",
      "index": 3,
      "a1": "C",
      "type": "text",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "ParticipationPct",
      "header": "Allocation %",
      "index": 4,
      "a1": "D",
      "type": "pct",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PoolAmount",
      "header": "Investor Pool (period)",
      "index": 5,
      "a1": "E",
      "type": "cur",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "CalculatedDistribution",
      "header": "Calculated Distribution",
      "index": 6,
      "a1": "F",
      "type": "cur",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PaidAmount",
      "header": "Paid Amount",
      "index": 7,
      "a1": "G",
      "type": "cur",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PaidDate",
      "header": "Paid Date",
      "index": 8,
      "a1": "H",
      "type": "date",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PaymentRef",
      "header": "Payment Ref",
      "index": 9,
      "a1": "I",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "PendingAmount",
      "header": "Pending",
      "index": 10,
      "a1": "J",
      "type": "cur",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Status",
      "header": "Status",
      "index": 11,
      "a1": "K",
      "type": "text",
      "role": "calc",
      "list": null,
      "range": null,
      "note": null
    },
    {
      "key": "Notes",
      "header": "Notes",
      "index": 12,
      "a1": "L",
      "type": "text",
      "role": "in",
      "list": null,
      "range": null,
      "note": null
    }
  ]
};

export type PropertiesColumn = "PropertyID" | "Floor" | "Unit" | "BHKType" | "Bedrooms" | "MaxGuests" | "PropertyStatus" | "ListingStatus" | "AirbnbListingID" | "BookingComListingID" | "MonthlyRent" | "SecurityDeposit" | "LeaseStart" | "LeaseEnd" | "Landlord" | "MaintenanceCharge" | "Notes";
export type ReservationsColumn = "BookingID" | "Platform" | "PlatformResID" | "PropertyID" | "BookingDate" | "BookingStatus" | "GuestID" | "GuestName" | "Adults" | "Children" | "TotalGuests" | "CheckInDate" | "CheckInTime" | "CheckOutDate" | "CheckOutTime" | "Nights" | "EarlyCheckIn" | "LateCheckout" | "BaseRate" | "RoomRevenue" | "CleaningFee" | "ExtraGuestFee" | "OtherCharges" | "Discount" | "GrossBookingValue" | "Taxes" | "PlatformFee" | "OtherDeductions" | "EstPlatformFee" | "ExpectedPayout" | "ActualPayout" | "PayoutDate" | "PayoutStatus" | "PayoutVariance" | "GuestVerification" | "CleaningStatus" | "InspectionStatus" | "DamageReport" | "MaintenanceRequired" | "Notes" | "RowIssues";
export type RevenueColumn = "RevenueID" | "BookingID" | "PropertyID" | "Date" | "RevenueType" | "Platform" | "GrossAmount" | "Discount" | "Tax" | "PlatformFee" | "OtherDeduction" | "NetRevenue" | "PayoutStatus" | "PayoutDate" | "PaymentAccount" | "ReconCheck" | "Notes";
export type ExpensesColumn = "ExpenseID" | "Date" | "PropertyID" | "ExpenseCategory" | "ExpenseSubcategory" | "Description" | "Vendor" | "Amount" | "Tax" | "TotalAmount" | "PaymentMethod" | "PaymentStatus" | "PaidDate" | "Recurring" | "ExpenseType" | "InvoiceRef" | "DriveLink" | "ApprovedBy" | "RowIssues" | "Notes";
export type CapexColumn = "CapexID" | "PropertyID" | "Date" | "Category" | "Subcategory" | "Item" | "Description" | "Quantity" | "UnitCost" | "TotalCost" | "Vendor" | "PaymentStatus" | "Warranty" | "WarrantyExpiry" | "UsefulLifeMonths" | "AssetID" | "InvoiceRef" | "DriveLink" | "Notes";
export type RentColumn = "RecordID" | "PropertyID" | "CostType" | "LandlordVendor" | "MonthlyAmount" | "DueDay" | "AgreementStart" | "AgreementEnd" | "EscalationPct" | "LastPaidDate" | "PaidForMonth" | "NextDueDate" | "PaymentStatus" | "PaymentRef" | "Notes";
export type CashflowColumn = "TxnID" | "Date" | "Type" | "Category" | "PropertyID" | "RefID" | "Description" | "MoneyIn" | "MoneyOut" | "Account" | "PaymentMethod" | "RunningBalance" | "ReconStatus" | "Notes";
export type InvestorsColumn = "InvestorID" | "InvestorName" | "InvestmentAmount" | "InvestmentDate" | "ParticipationPct" | "Status" | "AgreementRef" | "Contact" | "ShareCheck" | "Notes";
export type HousekeepingColumn = "TaskID" | "BookingID" | "PropertyID" | "CheckoutDate" | "AssignedDate" | "Cleaner" | "StartTime" | "CompletionTime" | "LinenChanged" | "ToiletriesRestocked" | "KitchenChecked" | "DamageChecked" | "InspectionStatus" | "FinalStatus" | "TurnaroundHrs" | "Notes";
export type MaintenanceColumn = "TicketID" | "DateReported" | "PropertyID" | "IssueCategory" | "Description" | "Priority" | "AssignedTo" | "Vendor" | "EstimatedCost" | "ActualCost" | "Status" | "DateResolved" | "DowntimeDays" | "ExpenseID" | "PhotosLink" | "AgeDays" | "Notes";
export type InventoryColumn = "ItemID" | "PropertyID" | "Category" | "Item" | "Unit" | "OpeningStock" | "Purchased" | "Used" | "CurrentStock" | "MinStock" | "ReorderStatus" | "LastPurchaseDate" | "LastPurchaseCost" | "Vendor" | "Notes";
export type AssetsColumn = "AssetID" | "PropertyID" | "Category" | "Asset" | "PurchaseDate" | "PurchaseCost" | "Vendor" | "WarrantyExpiry" | "UsefulLifeMonths" | "Condition" | "CurrentStatus" | "WarrantyStatus" | "MaintenanceHistory" | "DisposalDate" | "Notes";
export type ComplianceColumn = "ComplianceID" | "Requirement" | "PropertyID" | "Authority" | "ResponsiblePerson" | "Status" | "IssueDate" | "ExpiryDate" | "RenewalDate" | "DaysToExpiry" | "AlertStatus" | "DocumentRef" | "DriveLink" | "Notes";
export type CloseColumn = "Month" | "ReservationsReconciled" | "OtaPayoutsReconciled" | "RevenueReconciled" | "ExpensesEntered" | "RentPaid" | "UtilitiesEntered" | "CapexSeparated" | "CashReconciled" | "PnlReviewed" | "InvestorCalcReviewed" | "InvestorPaymentsRecorded" | "ReceivablesReviewed" | "PayablesReviewed" | "ClosingStatus" | "PreparedBy" | "ReviewedBy" | "ReviewDate" | "Notes";
export type DistColumn = "Period" | "InvestorID" | "InvestorName" | "ParticipationPct" | "PoolAmount" | "CalculatedDistribution" | "PaidAmount" | "PaidDate" | "PaymentRef" | "PendingAmount" | "Status" | "Notes";

export const LISTS = {
  "BOOKING_STATUS": [
    "Inquiry",
    "Confirmed",
    "Checked In",
    "Checked Out",
    "Cancelled",
    "No Show"
  ],
  "PROPERTY_STATUS": [
    "Available",
    "Occupied",
    "Cleaning",
    "Inspection",
    "Maintenance",
    "Blocked"
  ],
  "PAYMENT_STATUS": [
    "Pending",
    "Partial",
    "Paid",
    "Failed"
  ],
  "PAYOUT_STATUS": [
    "Pending",
    "Partial",
    "Received",
    "Overdue",
    "Written Off"
  ],
  "EXPENSE_CATEGORY": [
    "Fixed Operating",
    "Variable Operating",
    "Marketing",
    "OTA / Payment",
    "Other"
  ],
  "EXPENSE_SUBCATEGORY": [
    "Rent",
    "Society Maintenance",
    "Internet",
    "Electricity",
    "Water",
    "Gas",
    "Insurance",
    "Software",
    "Accounting",
    "Housekeeping",
    "Laundry",
    "Consumables",
    "Toiletries",
    "Repairs",
    "Plumbing",
    "Electrical",
    "Pest Control",
    "Emergency",
    "Advertising",
    "Photography",
    "Promotions",
    "Digital Marketing",
    "Airbnb Fee",
    "Booking.com Fee",
    "Other OTA Fee",
    "Payment Gateway Fee",
    "Other"
  ],
  "EXPENSE_TYPE": [
    "Operating",
    "CAPEX"
  ],
  "PAYMENT_METHOD": [
    "Bank Transfer",
    "UPI",
    "Credit Card",
    "Debit Card",
    "Cash",
    "Cheque",
    "Auto-debit",
    "Other"
  ],
  "MAINT_CATEGORY": [
    "Plumbing",
    "Electrical",
    "AC / Appliance",
    "Furniture",
    "Painting",
    "Pest Control",
    "Internet",
    "Security",
    "Structural",
    "Other"
  ],
  "MAINT_PRIORITY": [
    "Critical",
    "High",
    "Medium",
    "Low"
  ],
  "MAINT_STATUS": [
    "Open",
    "Assigned",
    "In Progress",
    "Waiting",
    "Resolved",
    "Closed"
  ],
  "HK_STATUS": [
    "Pending",
    "Assigned",
    "In Progress",
    "Completed",
    "Failed Inspection"
  ],
  "INSPECTION": [
    "Pending",
    "Passed",
    "Failed"
  ],
  "INVESTOR_STATUS": [
    "Active",
    "Pending Agreement",
    "Exited"
  ],
  "CAPEX_CATEGORY": [
    "Painting",
    "Furniture",
    "Mattress / Bed",
    "Sofa",
    "Dining",
    "TV",
    "Refrigerator",
    "Washing Machine",
    "AC",
    "Kitchen",
    "Curtains",
    "Décor",
    "Electrical",
    "Plumbing",
    "Security / Smart Lock",
    "Linen",
    "Appliances",
    "Other"
  ],
  "COMPLIANCE_STATUS": [
    "Pending",
    "In Progress",
    "Active",
    "Expired",
    "Not Applicable"
  ],
  "REVENUE_TYPE": [
    "Room",
    "Cleaning Fee",
    "Extra Guest Fee",
    "Early/Late Fee",
    "Damage Recovery",
    "Other"
  ],
  "CASH_TYPE": [
    "Booking Payout",
    "Direct Booking Receipt",
    "Other Income",
    "Operating Expense",
    "CAPEX",
    "Rent / Fixed Cost",
    "Investor Capital In",
    "Investor Distribution",
    "Security Deposit Paid",
    "Security Deposit Refunded",
    "Owner Capital In",
    "Owner Drawing",
    "Loan Received",
    "Loan Repayment",
    "Tax Payment",
    "Other"
  ],
  "RECON_STATUS": [
    "Unreconciled",
    "Reconciled",
    "Disputed"
  ],
  "CONDITION": [
    "New",
    "Good",
    "Fair",
    "Poor",
    "Broken"
  ],
  "ASSET_STATUS": [
    "In Use",
    "In Storage",
    "Under Repair",
    "Disposed"
  ],
  "BHK": [
    "1 BHK",
    "2 BHK",
    "3 BHK",
    "Studio"
  ],
  "LISTING_STATUS": [
    "Draft",
    "Live",
    "Paused",
    "Delisted"
  ],
  "COST_TYPE": [
    "Rent",
    "Society Maintenance",
    "Internet",
    "Electricity",
    "Water",
    "Gas",
    "Insurance",
    "Software Subscription",
    "Other"
  ],
  "INV_CATEGORY": [
    "Toiletries",
    "Cleaning Supplies",
    "Kitchen / Pantry",
    "Linen",
    "Guest Amenities",
    "Other"
  ],
  "RECURRING": [
    "One-time",
    "Recurring"
  ],
  "VERIFY": [
    "Pending",
    "Verified",
    "Issue"
  ],
  "PROFIT_DEFINITION": [
    "TBD",
    "Operating Profit",
    "Operating Profit after Reserve",
    "Custom (see agreement)"
  ],
  "CAPEX_RECOVERY": [
    "TBD",
    "No recovery",
    "Recover before distribution",
    "Amortize monthly"
  ],
  "LOSS_TREATMENT": [
    "TBD",
    "Carry forward",
    "No carry-forward"
  ],
  "DIST_FREQUENCY": [
    "TBD",
    "Monthly",
    "Quarterly",
    "Half-yearly",
    "Annual"
  ]
} as const;

export type BookingStatus = "Inquiry" | "Confirmed" | "Checked In" | "Checked Out" | "Cancelled" | "No Show";
export type PropertyStatus = "Available" | "Occupied" | "Cleaning" | "Inspection" | "Maintenance" | "Blocked";
export type PaymentStatus = "Pending" | "Partial" | "Paid" | "Failed";
export type PayoutStatus = "Pending" | "Partial" | "Received" | "Overdue" | "Written Off";
export type ExpenseCategory = "Fixed Operating" | "Variable Operating" | "Marketing" | "OTA / Payment" | "Other";
export type ExpenseSubcategory = "Rent" | "Society Maintenance" | "Internet" | "Electricity" | "Water" | "Gas" | "Insurance" | "Software" | "Accounting" | "Housekeeping" | "Laundry" | "Consumables" | "Toiletries" | "Repairs" | "Plumbing" | "Electrical" | "Pest Control" | "Emergency" | "Advertising" | "Photography" | "Promotions" | "Digital Marketing" | "Airbnb Fee" | "Booking.com Fee" | "Other OTA Fee" | "Payment Gateway Fee" | "Other";
export type ExpenseType = "Operating" | "CAPEX";
export type PaymentMethod = "Bank Transfer" | "UPI" | "Credit Card" | "Debit Card" | "Cash" | "Cheque" | "Auto-debit" | "Other";
export type MaintCategory = "Plumbing" | "Electrical" | "AC / Appliance" | "Furniture" | "Painting" | "Pest Control" | "Internet" | "Security" | "Structural" | "Other";
export type MaintPriority = "Critical" | "High" | "Medium" | "Low";
export type MaintStatus = "Open" | "Assigned" | "In Progress" | "Waiting" | "Resolved" | "Closed";
export type HkStatus = "Pending" | "Assigned" | "In Progress" | "Completed" | "Failed Inspection";
export type Inspection = "Pending" | "Passed" | "Failed";
export type InvestorStatus = "Active" | "Pending Agreement" | "Exited";
export type CapexCategory = "Painting" | "Furniture" | "Mattress / Bed" | "Sofa" | "Dining" | "TV" | "Refrigerator" | "Washing Machine" | "AC" | "Kitchen" | "Curtains" | "Décor" | "Electrical" | "Plumbing" | "Security / Smart Lock" | "Linen" | "Appliances" | "Other";
export type ComplianceStatus = "Pending" | "In Progress" | "Active" | "Expired" | "Not Applicable";
export type RevenueType = "Room" | "Cleaning Fee" | "Extra Guest Fee" | "Early/Late Fee" | "Damage Recovery" | "Other";
export type CashType = "Booking Payout" | "Direct Booking Receipt" | "Other Income" | "Operating Expense" | "CAPEX" | "Rent / Fixed Cost" | "Investor Capital In" | "Investor Distribution" | "Security Deposit Paid" | "Security Deposit Refunded" | "Owner Capital In" | "Owner Drawing" | "Loan Received" | "Loan Repayment" | "Tax Payment" | "Other";
export type ReconStatus = "Unreconciled" | "Reconciled" | "Disputed";
export type Condition = "New" | "Good" | "Fair" | "Poor" | "Broken";
export type AssetStatus = "In Use" | "In Storage" | "Under Repair" | "Disposed";
export type Bhk = "1 BHK" | "2 BHK" | "3 BHK" | "Studio";
export type ListingStatus = "Draft" | "Live" | "Paused" | "Delisted";
export type CostType = "Rent" | "Society Maintenance" | "Internet" | "Electricity" | "Water" | "Gas" | "Insurance" | "Software Subscription" | "Other";
export type InvCategory = "Toiletries" | "Cleaning Supplies" | "Kitchen / Pantry" | "Linen" | "Guest Amenities" | "Other";
export type Recurring = "One-time" | "Recurring";
export type Verify = "Pending" | "Verified" | "Issue";
export type ProfitDefinition = "TBD" | "Operating Profit" | "Operating Profit after Reserve" | "Custom (see agreement)";
export type CapexRecovery = "TBD" | "No recovery" | "Recover before distribution" | "Amortize monthly";
export type LossTreatment = "TBD" | "Carry forward" | "No carry-forward";
export type DistFrequency = "TBD" | "Monthly" | "Quarterly" | "Half-yearly" | "Annual";

export const ID_RULES = {
  "04_RESERVATIONS": {
    "col": "BookingID",
    "prefix": "BK-{y}-",
    "pad": 4
  },
  "05_REVENUE": {
    "col": "RevenueID",
    "prefix": "REV-{y}-",
    "pad": 4
  },
  "06_EXPENSES": {
    "col": "ExpenseID",
    "prefix": "EXP-{y}-",
    "pad": 4
  },
  "07_CAPEX_SETUP": {
    "col": "CapexID",
    "prefix": "CAP-{y}-",
    "pad": 4
  },
  "09_CASH_FLOW": {
    "col": "TxnID",
    "prefix": "CSH-{y}-",
    "pad": 4
  },
  "13_HOUSEKEEPING": {
    "col": "TaskID",
    "prefix": "HK-{y}-",
    "pad": 4
  },
  "14_MAINTENANCE": {
    "col": "TicketID",
    "prefix": "MNT-{y}-",
    "pad": 4
  },
  "08_RENT_FIXED_COSTS": {
    "col": "RecordID",
    "prefix": "RNT-",
    "pad": 3
  },
  "11_INVESTORS": {
    "col": "InvestorID",
    "prefix": "INV-",
    "pad": 3
  },
  "15_INVENTORY": {
    "col": "ItemID",
    "prefix": "ITM-",
    "pad": 3
  },
  "16_ASSETS": {
    "col": "AssetID",
    "prefix": "AST-",
    "pad": 3
  },
  "17_COMPLIANCE": {
    "col": "ComplianceID",
    "prefix": "CMP-",
    "pad": 3
  }
} as const;

/**
 * 99_CALC addressing.
 * `monthlyRows` is FY-indexed (keyed by CFG_FY_START) and is SAFE to read.
 * Everything under `reportMonthDependent` keys off the shared CFG_REPORT_MONTH cell;
 * per Decision D1 the web app must NOT read those blocks and must NEVER write that
 * cell — those figures are computed server-side instead.
 */
export const CALC = {
  "sheet": "99_CALC",
  "firstMonthCol": 2,
  "firstMonthColA1": "B",
  "months": 12,
  "lastMonthColA1": "M",
  "totalCol": 14,
  "totalColA1": "N",
  "monthlyRows": {
    "MonthStart": 3,
    "MonthEnd": 4,
    "DaysInMonth": 5,
    "ActiveUnits": 6,
    "AvailableNights": 7,
    "OccupiedNights": 8,
    "OccupancyPct": 9,
    "RoomRevenue": 10,
    "CleaningRevenue": 11,
    "OtherRevenue": 12,
    "GrossRevenue": 13,
    "Discounts": 14,
    "PlatformFees": 15,
    "Taxes": 16,
    "NetRevenue": 17,
    "OperatingExpenses": 18,
    "OperatingProfit": 19,
    "OperatingMarginPct": 20,
    "ADR": 21,
    "RevPAR": 22,
    "BookingsCount": 23,
    "CancelledCount": 24,
    "CancellationRatePct": 25,
    "ALOS": 26,
    "CapexTotal": 27,
    "ReserveAmt": 28,
    "MgmtFeeAmt": 29,
    "CarryForwardApplied": 30,
    "DistributableProfit": 31,
    "InvestorPoolAmt": 32,
    "DistributionsPaid": 33,
    "CashIn": 34,
    "CashOut": 35,
    "NetCash": 36,
    "CarryForwardBalance": 37
  },
  "monthlyBlockRange": "B3:N37",
  "reportMonthDependent": {
    "kpiValueColA1": "Q",
    "kpiRows": {
      "ReportMonthStart": 3,
      "TotalUnits": 4,
      "AvailableUnits": 5,
      "OccupiedUnits": 6,
      "CleaningUnits": 7,
      "MaintenanceUnits": 8,
      "BlockedUnits": 9,
      "MTDNetRevenue": 10,
      "MTDExpenses": 11,
      "MTDOperatingProfit": 12,
      "OccupancyPct": 13,
      "ADR": 14,
      "RevPAR": 15,
      "PendingReceivables": 16,
      "PendingPayables": 17,
      "OpenMaintTickets": 18,
      "PendingCleanings": 19,
      "LowStockItems": 20,
      "ComplianceDue": 21,
      "PendingInvestorDistributions": 22,
      "UpcomingCheckins": 23,
      "UpcomingCheckouts": 24
    },
    "propertyBlock": {
      "headerRow": 40,
      "firstRow": 41,
      "lastRow": 65,
      "cols": {
        "PropertyID": 1,
        "Unit": 2,
        "BHKType": 3,
        "StatusNow": 4,
        "CurrentGuest": 5,
        "CurrentBookingID": 6,
        "CheckIn": 7,
        "CheckOut": 8,
        "CleaningStatus": 9,
        "OpenMaint": 10,
        "RevenueMTD": 11,
        "ExpensesMTD": 12,
        "ProfitMTD": 13,
        "OccNightsMTD": 14,
        "OccPctMTD": 15,
        "ADR": 16,
        "RevPAR": 17,
        "BookingsMTD": 18
      }
    },
    "platformBlock": {
      "headerRow": 70,
      "firstRow": 71,
      "lastRow": 78,
      "cols": {
        "Platform": 1,
        "Bookings": 2,
        "GrossRevenue": 3,
        "Fees": 4,
        "NetRevenue": 5
      }
    },
    "expenseCategoryBlock": {
      "headerRow": 82,
      "firstRow": 83,
      "lastRow": 87,
      "cols": {
        "Category": 1,
        "Amount": 2
      }
    }
  },
  "alerts": {
    "finalColA1": "E",
    "finalRow": 121,
    "finalRows": 60,
    "range": "E121:G180"
  }
} as const;
export type MonthlyMetric = keyof typeof CALC.monthlyRows;

export const PNL = {
  "headerRow": 3,
  "rows": {
    "RoomRevenue": 4,
    "CleaningRevenue": 5,
    "OtherRevenue": 6,
    "GrossRevenue": 7,
    "Discounts": 8,
    "PlatformFees": 9,
    "Taxes": 10,
    "NetRevenue": 11,
    "OpexHeader": 13,
    "RentLine": 14,
    "Utilities": 15,
    "HousekeepingLaundry": 16,
    "Consumables": 17,
    "RepairsMaint": 18,
    "Marketing": 19,
    "SoftwareAccounting": 20,
    "Insurance": 21,
    "PaymentOtaFees": 22,
    "OtherOperating": 23,
    "TotalOpex": 24,
    "OperatingProfit": 26,
    "OperatingMarginPct": 27,
    "MemoHeader": 29,
    "MemoCapex": 30,
    "MemoDistributions": 31,
    "MemoNetCash": 32
  },
  "expenseLines": {
    "RentLine": [
      "Rent",
      "Society Maintenance"
    ],
    "Utilities": [
      "Electricity",
      "Water",
      "Gas",
      "Internet"
    ],
    "HousekeepingLaundry": [
      "Housekeeping",
      "Laundry"
    ],
    "Consumables": [
      "Consumables",
      "Toiletries"
    ],
    "RepairsMaint": [
      "Repairs",
      "Plumbing",
      "Electrical",
      "Pest Control",
      "Emergency"
    ],
    "Marketing": [
      "Advertising",
      "Photography",
      "Promotions",
      "Digital Marketing"
    ],
    "SoftwareAccounting": [
      "Software",
      "Accounting"
    ],
    "Insurance": [
      "Insurance"
    ],
    "PaymentOtaFees": [
      "Airbnb Fee",
      "Booking.com Fee",
      "Other OTA Fee",
      "Payment Gateway Fee"
    ]
  }
} as const;
export const DIST = {
  "periodCell": "B5",
  "waterfallRows": {
    "GrossRevenue": 7,
    "Discounts": 8,
    "PlatformFees": 9,
    "Taxes": 10,
    "NetRevenue": 11,
    "OperatingExpenses": 12,
    "OperatingProfit": 13,
    "Reserve": 14,
    "MgmtFee": 15,
    "CarryForward": 16,
    "DistributableProfit": 17,
    "InvestorPoolPct": 18,
    "InvestorPoolAmt": 19,
    "OperatorShare": 20,
    "ConfigStatus": 21
  },
  "table": {
    "headerRow": 23,
    "firstRow": 24,
    "rows": 120
  }
} as const;
export const ANALYTICS_MAP = {
  "FILTER_MONTH": "C3",
  "FILTER_PROPERTY": "F3",
  "FILTER_PLATFORM": "I3",
  "KPI_BLOCK": {
    "firstRow": 6,
    "lastRow": 27,
    "labelCol": 2,
    "valueCol": 3
  },
  "TREND_BLOCK": {
    "headerRow": 30,
    "firstRow": 31,
    "lastRow": 44
  },
  "PROP_BLOCK": {
    "headerRow": 48,
    "firstRow": 49,
    "lastRow": 73
  },
  "PLATFORM_BLOCK": {
    "headerRow": 77,
    "firstRow": 78,
    "lastRow": 85
  }
} as const;
export const QA_MAP = {
  "HEADER_ROW": 3,
  "FIRST_ROW": 4,
  "LAST_ROW": 35,
  "SCRIPT_HEADER_ROW": 38,
  "SCRIPT_CAPTION_ROW": 39,
  "SCRIPT_FIRST_ROW": 40,
  "SCRIPT_LAST_ROW": 70
} as const;
export const DASHBOARD_MAP = {
  "reportMonthCell": "C3"
} as const;

/** Cell the web app must never write (Decision D1). */
export const FORBIDDEN_WRITE_CELL = "C3";
/** Sheets the web app must never write to (calculated / reporting surfaces). */
export const READ_ONLY_SHEETS = [
  "CALC",
  "PNL",
  "ANALYTICS",
  "QA",
  "GUIDE",
  "DASHBOARD"
] as const;

export const BUSINESS_RULES = [
  {
    "name": "CFG_INVESTOR_POOL_PCT",
    "label": "Investor pool % of distributable profit",
    "format": "pct",
    "settingsCell": "B25",
    "recordedOnly": false
  },
  {
    "name": "CFG_OPERATOR_POOL_PCT",
    "label": "Operator pool % of distributable profit",
    "format": "pct",
    "settingsCell": "B26",
    "recordedOnly": false
  },
  {
    "name": "CFG_PROFIT_DEFINITION",
    "label": "Profit definition for distribution",
    "format": "list",
    "settingsCell": "B27",
    "recordedOnly": true
  },
  {
    "name": "CFG_RESERVE_PCT",
    "label": "Reserve % withheld from profit",
    "format": "pct",
    "settingsCell": "B28",
    "recordedOnly": false
  },
  {
    "name": "CFG_CAPEX_RECOVERY",
    "label": "Setup/CAPEX recovery policy",
    "format": "list",
    "settingsCell": "B29",
    "recordedOnly": true
  },
  {
    "name": "CFG_LOSS_TREATMENT",
    "label": "Loss treatment",
    "format": "list",
    "settingsCell": "B30",
    "recordedOnly": false
  },
  {
    "name": "CFG_DIST_FREQUENCY",
    "label": "Distribution frequency",
    "format": "list",
    "settingsCell": "B31",
    "recordedOnly": true
  },
  {
    "name": "CFG_MIN_CASH_RESERVE",
    "label": "Minimum cash reserve (₹)",
    "format": "cur",
    "settingsCell": "B32",
    "recordedOnly": true
  },
  {
    "name": "CFG_MGMT_FEE_PCT",
    "label": "Management fee %",
    "format": "pct",
    "settingsCell": "B33",
    "recordedOnly": false
  },
  {
    "name": "CFG_TAX_TREATMENT",
    "label": "Tax treatment",
    "format": "text",
    "settingsCell": "B34",
    "recordedOnly": false
  },
  {
    "name": "CFG_DEDUCTIBLE_NOTE",
    "label": "Deductible-expense definition",
    "format": "text",
    "settingsCell": "B35",
    "recordedOnly": false
  }
] as const;
export const REQUIRED_NAMED_RANGES = [
  "CFG_BIZ_NAME",
  "CFG_CAPEX_RECOVERY",
  "CFG_CHECKIN_LOOKAHEAD",
  "CFG_CITY",
  "CFG_COMPLIANCE_DAYS",
  "CFG_COUNTRY",
  "CFG_CURRENCY",
  "CFG_DEDUCTIBLE_NOTE",
  "CFG_DIST_FREQUENCY",
  "CFG_FY_START",
  "CFG_INVESTOR_POOL_PCT",
  "CFG_LOSS_TREATMENT",
  "CFG_MAINT_STALE_DAYS",
  "CFG_MGMT_FEE_PCT",
  "CFG_MIN_CASH_RESERVE",
  "CFG_OPERATOR_POOL_PCT",
  "CFG_PAYMENT_REMINDER_DAYS",
  "CFG_PAYOUT_OVERDUE_DAYS",
  "CFG_PAYOUT_TOLERANCE",
  "CFG_PROFIT_DEFINITION",
  "CFG_RECON_DAYS",
  "CFG_RENT_DUE_DAYS",
  "CFG_RESERVE_PCT",
  "CFG_TAX_TREATMENT",
  "LIST_ACCOUNTS",
  "LIST_ASSET_STATUS",
  "LIST_BHK",
  "LIST_BOOKING_IDS",
  "LIST_BOOKING_STATUS",
  "LIST_CAPEX_CATEGORY",
  "LIST_CASH_TYPE",
  "LIST_COMPLIANCE_STATUS",
  "LIST_CONDITION",
  "LIST_COST_TYPE",
  "LIST_EXPENSE_CATEGORY",
  "LIST_EXPENSE_SUBCATEGORY",
  "LIST_EXPENSE_TYPE",
  "LIST_HK_STATUS",
  "LIST_INSPECTION",
  "LIST_INVESTOR_IDS",
  "LIST_INVESTOR_STATUS",
  "LIST_INV_CATEGORY",
  "LIST_LISTING_STATUS",
  "LIST_MAINT_CATEGORY",
  "LIST_MAINT_PRIORITY",
  "LIST_MAINT_STATUS",
  "LIST_PAYMENT_METHOD",
  "LIST_PAYMENT_STATUS",
  "LIST_PAYOUT_STATUS",
  "LIST_PROPERTY_IDS",
  "LIST_PROPERTY_IDS_ALL",
  "LIST_PROPERTY_STATUS",
  "LIST_RECON_STATUS",
  "LIST_RECURRING",
  "LIST_REVENUE_TYPE",
  "LIST_VERIFY",
  "TBL_PLATFORMS",
  "TBL_PLATFORM_COMM",
  "TBL_PLATFORM_LAG",
  "TBL_PLATFORM_NAMES"
] as const;
export const INITIAL_PROPERTIES = [
  {
    "PropertyID": "HYD-501",
    "Floor": 5,
    "Unit": "5th Floor — 2 BHK",
    "BHKType": "2 BHK",
    "Bedrooms": 2,
    "MaxGuests": 6,
    "PropertyStatus": "Available",
    "ListingStatus": "Draft"
  },
  {
    "PropertyID": "HYD-502",
    "Floor": 5,
    "Unit": "5th Floor — 1 BHK",
    "BHKType": "1 BHK",
    "Bedrooms": 1,
    "MaxGuests": 3,
    "PropertyStatus": "Available",
    "ListingStatus": "Draft"
  },
  {
    "PropertyID": "HYD-601",
    "Floor": 6,
    "Unit": "6th Floor — 2 BHK",
    "BHKType": "2 BHK",
    "Bedrooms": 2,
    "MaxGuests": 6,
    "PropertyStatus": "Available",
    "ListingStatus": "Draft"
  },
  {
    "PropertyID": "HYD-602",
    "Floor": 6,
    "Unit": "6th Floor — 1 BHK",
    "BHKType": "1 BHK",
    "Bedrooms": 1,
    "MaxGuests": 3,
    "PropertyStatus": "Available",
    "ListingStatus": "Draft"
  }
] as const;

/** Column spec lookup. Throws on unknown keys so drift fails loudly, not silently. */
export function column(sheet: SheetKey, key: string): ColumnSpec {
  const found = COLUMNS[sheet]?.find((c) => c.key === key);
  if (!found) throw new Error(`Unknown column ${sheet}.${key} — regenerate the contract`);
  return found;
}

/** Zero-based position of a column in a row array read from the sheet. */
export function columnIndex(sheet: SheetKey, key: string): number {
  return column(sheet, key).index - 1;
}

/** Full data range for a sheet, e.g. "'04_RESERVATIONS'!A4:AP703". */
export function dataRange(sheet: SheetKey): string {
  const meta = SHEET_META[sheet];
  const cols = COLUMNS[sheet];
  if (!cols || !meta.lastDataRow) throw new Error(`No tabular data range for ${sheet}`);
  const last = cols[cols.length - 1];
  if (!last) throw new Error(`No columns registered for ${sheet}`);
  return `'${meta.name}'!A${DATA_ROW}:${last.a1}${meta.lastDataRow}`;
}

/** The FY monthly block in 99_CALC — the only KPI block safe to read directly. */
export function monthlyBlockRange(): string {
  return `'${CALC.sheet}'!A${Math.min(...Object.values(CALC.monthlyRows))}:${CALC.totalColA1}${Math.max(...Object.values(CALC.monthlyRows))}`;
}

/** Input (writable) columns only — calculated columns are excluded by construction. */
export function inputColumns(sheet: SheetKey): readonly ColumnSpec[] {
  return (COLUMNS[sheet] ?? []).filter((c) => c.role === "in");
}

