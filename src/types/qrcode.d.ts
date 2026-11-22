declare module "qrcode" {
  interface QRCodeModel {
    modules: { size: number; data: ArrayLike<number | boolean> };
  }
  const QRCode: {
    create(text: string, options?: { errorCorrectionLevel?: "L" | "M" | "Q" | "H" }): QRCodeModel;
  };
  export default QRCode;
}
