// Scannable QR code for the Receive screen: dark on light, with a quiet zone.
import React from "react";
import QRCode from "qrcode";

const cache = new Map<string, React.ReactElement>();
// Public addresses (32-44 characters) and Rings private addresses (about 140), both base58.
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,160}$/;

export function qrSvg(text: string): React.ReactElement {
  const hit = cache.get(text);
  if (hit) return hit;
  if (!ADDRESS.test(text)) return <svg viewBox="0 0 1 1" width="100%" height="100%" aria-hidden="true" />;
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const q = 2;
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.data[y * n + x]) d += `M${x + q} ${y + q}h1v1h-1z`;
  const el = (
    <svg viewBox={`0 0 ${n + 2 * q} ${n + 2 * q}`} width="100%" height="100%" role="img" aria-label="QR code for this address" shapeRendering="crispEdges" style={{ display: "block" }}>
      <rect width="100%" height="100%" fill="#F4F1EA" />
      <path d={d} fill="#0E0E0E" />
    </svg>
  );
  cache.set(text, el);
  return el;
}
