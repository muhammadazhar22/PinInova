import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "PinPulse", template: "%s · PinPulse" },
  description: "Pinterest account health, diagnosis and protection. Not affiliated with Pinterest.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
