import "dotenv/config";
import { v2 as cloudinary } from "cloudinary";

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

console.log("========== CLOUDINARY CONFIG ==========");
console.log("Cloud Name:", cloudName || "MISSING");
console.log("API Key:", apiKey ? "LOADED" : "MISSING");
console.log("API Secret:", apiSecret ? "LOADED" : "MISSING");
console.log("=======================================");

if (!cloudName || !apiKey || !apiSecret) {
  console.error("❌ Cloudinary environment variables are missing.");
}

cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret,
});

export default cloudinary;