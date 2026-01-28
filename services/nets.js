const axios = require("axios");

const NETS_QR_REQUEST_URL =
  process.env.NETS_QR_REQUEST_URL ||
  "https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets-qr/request";
const NETS_QR_QUERY_URL =
  process.env.NETS_QR_QUERY_URL ||
  "https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets-qr/query";

const fs = require("fs");
const path = require("path");

const getCourseInitId = () => {
  if (process.env.COURSE_INIT_ID) return `${process.env.COURSE_INIT_ID}`;

  const filePath = path.join(__dirname, "..", "course_init_id.js");
  if (!fs.existsSync(filePath)) return "";

  try {
    const loaded = require(filePath);
    const value =
      loaded?.courseInitId || loaded?.default?.courseInitId || loaded;
    if (typeof value === "string") return value;
    if (typeof value?.courseInitId === "string") return value.courseInitId;
  } catch (error) {
    // Fall through to regex parse (ESM export or read-only file)
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const match = raw.match(/courseInitId\s*=\s*['"]([^'"]+)['"]/);
    return match ? match[1] : "";
  } catch (error) {
    return "";
  }
};

const requestQrCode = async (amount) => {
  const amtInDollars = Number(amount || 0).toFixed(2);
  const requestBody = {
    txn_id:
      process.env.NETS_TXN_ID ||
      "sandbox_nets|m|8ff8e5b6-d43e-4786-8ac5-7accf8c5bd9b",
    amt_in_dollars: amtInDollars,
    notify_mobile: 0,
  };

  const response = await axios.post(NETS_QR_REQUEST_URL, requestBody, {
    headers: {
      "api-key": process.env.API_KEY,
      "project-id": process.env.PROJECT_ID,
    },
  });

  const qrData = response?.data?.result?.data || {};
  return {
    qrData,
    fullResponse: response.data,
    txnRetrievalRef: qrData.txn_retrieval_ref,
    courseInitId: getCourseInitId(),
    qrCode: qrData.qr_code,
  };
};

const queryPaymentStatus = async ({ txnRetrievalRef, courseInitId }) => {
  const requestBody = {
    txn_retrieval_ref: txnRetrievalRef,
  };

  if (courseInitId) requestBody.course_init_id = courseInitId;

  const headers = {
    "api-key": process.env.API_KEY,
    "project-id": process.env.PROJECT_ID,
  };

  try {
    const response = await axios.post(NETS_QR_QUERY_URL, requestBody, {
      headers,
    });
    return response.data;
  } catch (error) {
    const params = new URLSearchParams(requestBody);
    const url = NETS_QR_QUERY_URL.includes("?")
      ? `${NETS_QR_QUERY_URL}&${params.toString()}`
      : `${NETS_QR_QUERY_URL}?${params.toString()}`;
    const response = await axios.get(url, { headers });
    return response.data;
  }
};

const normalizePaymentStatus = (rawResponse) => {
  const data =
    rawResponse?.result?.data || rawResponse?.data || rawResponse || {};
  const statusValue =
    data.txn_status ??
    data.transaction_status ??
    data.payment_status ??
    data.status ??
    data.txnStatus;
  const statusText = String(statusValue || data.status_desc || "").toLowerCase();

  const success =
    statusValue === 1 ||
    statusText.includes("success") ||
    statusText.includes("completed");
  const fail =
    statusText.includes("fail") ||
    statusText.includes("declin") ||
    statusText.includes("reject") ||
    statusText.includes("cancel") ||
    statusText.includes("expire") ||
    statusValue === 3 ||
    statusValue === 4;

  return {
    success,
    fail,
    status: statusValue ?? null,
    raw: rawResponse,
  };
};

module.exports = {
  requestQrCode,
  queryPaymentStatus,
  normalizePaymentStatus,
};
